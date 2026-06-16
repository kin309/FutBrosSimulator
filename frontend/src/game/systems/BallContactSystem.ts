import { Ball } from '../entities/Ball';
import { Player } from '../entities/Player';
import { Team } from '../entities/Team';
import { Scoreboard } from './Scoreboard';
import { StatsTracker } from './StatsTracker';
import { GoalkeeperSystem } from './GoalkeeperSystem';
import { PlayerKickSystem } from './PlayerKickSystem';
import { EventResolver } from './EventResolver';
import { PlayerRole } from '../data/PlayerRole';
import { PlayerState } from '../data/PlayerState';
import { FieldBounds, GoalBounds } from '../types';
import { dist, clamp, distancePointToSegment } from '../utils/MathUtils';
import { BALL_PHYSICS } from '../physics/BallPhysics';
import { projectBallIntercept, planReceptionTarget } from '../physics/BallProjection';
import type { MatchContext } from './MatchContext';

const CONTACT_RADIUS: number = BALL_PHYSICS.contactRadius;
const BALL_FRICTION: number = BALL_PHYSICS.groundFrictionPerFrame;
const BALL_PICKUP_RADIUS: number = BALL_PHYSICS.pickupRadius;

export class BallContactSystem {
  private ball: Ball;
  private teamA: Team;
  private teamB: Team;
  private scoreboard: Scoreboard;
  private stats: StatsTracker;
  private gkSystem: GoalkeeperSystem;
  private kickSystem: PlayerKickSystem;
  private resolver: EventResolver;
  private field: FieldBounds;
  private goalLeft: GoalBounds;
  private goalRight: GoalBounds;
  private getAllPlayers: () => Player[];
  private recalculateRoutes: (previousTarget?: Player | null) => void;
  private _shouldSprintForRace: (player: Player, opponent: Player, targetX: number, targetY: number) => boolean;
  private _isBallInDangerArea: () => boolean;

  constructor(ctx: MatchContext) {
    this.ball = ctx.ball;
    this.teamA = ctx.teamA;
    this.teamB = ctx.teamB;
    this.scoreboard = ctx.scoreboard;
    this.stats = ctx.stats;
    this.gkSystem = ctx.gkSystem!;
    this.kickSystem = ctx.kickSystem!;
    this.resolver = ctx.resolver;
    this.field = ctx.field;
    this.goalLeft = ctx.goalLeft;
    this.goalRight = ctx.goalRight;
    this.getAllPlayers = ctx.allPlayers;
    this.recalculateRoutes = ctx.recalculateRoutesAfterBallTrajectoryChange;
    this._shouldSprintForRace = ctx.shouldSprintForRace;
    this._isBallInDangerArea = ctx.isBallInDangerArea;
  }

  // Handles physical ball contact for the INTENDED receiver (targeted pass arrival).
  // Opponent interception and teammate deflection are handled by checkBallPlayerContacts().
  checkPassArrival(): void {
    if (!this.ball.targetPlayer || this.ball.owner) return;

    const target = this.ball.targetPlayer as Player;
    const ballDist = dist(this.ball.x, this.ball.y, target.x, target.y);

    // Abandon pass if ball stopped far from target (deflected / friction killed it)
    if (this.ball.getSpeed() < 1.5 && ballDist > 80) {
      this.ball.targetPlayer = null;
      target.state = PlayerState.FindSpace;
      this.recalculateRoutes(target);
      return;
    }

    // Abandon if ball is clearly heading away from target or a teammate is much better placed
    if (ballDist > 110 && this.ball.getSpeed() > 1.0) {
      const toTargetX = target.x - this.ball.x;
      const toTargetY = target.y - this.ball.y;
      const len = Math.sqrt(toTargetX * toTargetX + toTargetY * toTargetY);
      const dot = (this.ball.velocity.x * toTargetX + this.ball.velocity.y * toTargetY)
        / (this.ball.getSpeed() * len);
      if (dot < -0.15) {
        this.ball.targetPlayer = null;
        target.state = PlayerState.FindSpace;
        this.recalculateRoutes(target);
        return;
      }

      const projFrames = 35;
      const dispFactor = (1 - Math.pow(BALL_FRICTION, projFrames)) / (1 - BALL_FRICTION);
      const projX = clamp(this.ball.x + this.ball.velocity.x * dispFactor, this.field.left + 15, this.field.right - 15);
      const projY = clamp(this.ball.y + this.ball.velocity.y * dispFactor, this.field.top + 15, this.field.bottom - 15);
      const targetDistToProj = dist(target.x, target.y, projX, projY);
      const ownTeam = target.teamId === 'teamA' ? this.teamA : this.teamB;
      for (const p of ownTeam.players) {
        if (p === target || p.role === PlayerRole.Goalkeeper || p.hasBall) continue;
        if (dist(p.x, p.y, projX, projY) < targetDistToProj * 0.5) {
          this.ball.targetPlayer = null;
          target.state = PlayerState.FindSpace;
          this.recalculateRoutes(target);
          return;
        }
      }
    }

    // Keep receiver preparing for the first touch, not only chasing the ball center.
    if (target.state === PlayerState.ReceivePass) {
      const oppTeam = target.teamId === 'teamA' ? this.teamB : this.teamA;
      const nearestOpp = oppTeam.getNearestPlayerTo(target.x, target.y);
      const reception = planReceptionTarget(this.ball, target, nearestOpp, this.field);
      target.setTarget(reception.x, reception.y);

      if (reception.urgency > 0.58 || this._isBallInDangerArea()) {
        target.requestSprint(300, 52);
      } else if (ballDist < 58) {
        target.sprintMs = Math.min(target.sprintMs, 80);
      }
    }

    // Arrival: ball physically reaches receiver. Diving GKs need swept contact because
    // fast shots can cross their body between two rendered frames.
    const arrivalRadius = this.gkSystem.getBallArrivalRadius(target);
    const arrivalDist = target.role === PlayerRole.Goalkeeper
      ? Math.min(
        ballDist,
        distancePointToSegment(target.x, target.y, this.ball.previousX, this.ball.previousY, this.ball.x, this.ball.y),
      )
      : ballDist;
    if (arrivalDist >= arrivalRadius) return;

    this.ball.targetPlayer = null;

    // Aerial duel: when a cross arrives, nearest opponent contests in the air
    if (this.gkSystem.lastPassWasCross && target.role !== PlayerRole.Goalkeeper) {
      this.gkSystem.lastPassWasCross = false;
      const oppTeamForDuel = target.teamId === 'teamA' ? this.teamB : this.teamA;
      let closestDef: Player | null = null;
      let closestDist = Infinity;
      for (const p of oppTeamForDuel.players) {
        if (p.role === PlayerRole.Goalkeeper) continue;
        const d = dist(p.x, p.y, target.x, target.y);
        if (d < 65 && d < closestDist) { closestDist = d; closestDef = p; }
      }
      if (closestDef) {
        const winner = this.resolver.resolveAerialDuel(target, closestDef);
        const loser  = winner === target ? closestDef : target;
        loser.state = PlayerState.FindSpace;
        loser.aiCooldown = 500;
        if (winner === closestDef) {
          closestDef.hasBall = true;
          closestDef.state = PlayerState.CarryBall;
          this.ball.attachToPlayer(closestDef);
          this.kickSystem.applyFirstTouchMovement(closestDef, target);
          this.scoreboard.logEvent(`${closestDef.playerName} ganhou o duelo aéreo!`);
          return;
        }
        this.scoreboard.logEvent(`${target.playerName} ganhou o duelo aéreo!`);
      }
    } else {
      this.gkSystem.lastPassWasCross = false;
    }

    const isGKCatch = target.role === PlayerRole.Goalkeeper;

    if (isGKCatch) {
      // stretchSave: GK dived visually but has comfortable reach — resolve as routine save
      const isDive  = target.state === PlayerState.GkDive && !target.stretchSave;
      target.stretchSave = false;
      const result  = this.resolver.resolveGkSave(target, isDive, this.ball.getSpeed());

      if (result === 'catch') {
        target.hasBall = true;
        target.state = PlayerState.Clearance;
        this.ball.attachToPlayer(target);
        this.stats.recordSave(target.teamId);
        this.scoreboard.logEvent(`${target.playerName} segurou!`);
      } else if (result === 'parry') {
        target.state = PlayerState.ReturnToShape;
        target.aiCooldown = 650;
        this.kickSystem.doParry(target);
        this.stats.recordSave(target.teamId);
        this.scoreboard.logEvent(`${target.playerName} espalmou!`);
      } else {
        target.state = PlayerState.ReturnToShape;
        target.aiCooldown = 900;
        this.scoreboard.logEvent(
          isDive ? `${target.playerName} não alcançou!` : `${target.playerName} soltou!`,
        );
      }
      return;
    }

    const oppTeam = target.teamId === 'teamA' ? this.teamB : this.teamA;
    const nearestOpp = oppTeam.getNearestPlayerTo(target.x, target.y);
    const passer = this.ball.kickedById
      ? this.getAllPlayers().find(p => p.id === this.ball.kickedById) ?? target
      : target;
    const success = this.resolver.resolveFirstTouch(target, passer, nearestOpp, this.ball.getSpeed());

    if (success) {
      this.stats.recordPassCompleted(target.teamId);
      target.hasBall = true;
      target.state = PlayerState.CarryBall;
      target.aiCooldown = this.kickSystem.settleTime(target, nearestOpp);
      this.ball.attachToPlayer(target);
      this.kickSystem.applyFirstTouchMovement(target, nearestOpp);
    } else {
      target.state = PlayerState.FindSpace;
      this.kickSystem.applyFailedFirstTouchDeflection(target);
      this.recalculateRoutes(target);
      this.scoreboard.logEvent(`${target.playerName} não dominou!`);
    }
  }

  // Physical ball collision for non-target players while ball is in flight.
  // Opponents within contact range attempt an interception; teammates deflect the ball.
  checkBallPlayerContacts(): void {
    if (this.ball.owner) return;

    const targetId = this.ball.targetPlayer ? (this.ball.targetPlayer as Player).id : null;
    const ballMoving = this.ball.getSpeed() > 1.5;

    for (const player of this.getAllPlayers()) {
      if (this.ball.isPickupBlocked(player.id)) continue;
      const gkClaimRadius = this.gkSystem.getGkPhysicalClaimRadius(player);
      if (player.id === targetId) continue;

      const contactRadius = Math.max(CONTACT_RADIUS, gkClaimRadius);
      if (this.getBallPlayerContactDistance(player) >= contactRadius) continue;

      if (player.role === PlayerRole.Goalkeeper && gkClaimRadius > CONTACT_RADIUS) {
        this.ball.targetPlayer = null;
        this.ball.attachToPlayer(player);
        player.hasBall = true;
        player.state = PlayerState.Clearance;
        player.aiCooldown = 650;
        this.scoreboard.logEvent(`${player.playerName} saiu e segurou!`);
        return;
      }

      if (!this.ball.targetPlayer) {
        break;
      }

      const target = this.ball.targetPlayer as Player;
      const isOpponent = player.teamId !== target.teamId;

      if (isOpponent && ballMoving) {
        const isShot = this.ball.getSpeed() > 6.5;

        // 1. Clean intercept — defender controls the ball.
        const interceptTrait = player.playstyles.includes('Intercept') || player.playstylesPlus.includes('Intercept')
          ? (player.playstylesPlus.includes('Intercept') ? 0.10 : 0.06)
          : 0;
        const interceptChance = 0.22
          + (player.stats.defending / 100) * 0.38
          + (player.stats.reactions / 100) * 0.14
          + interceptTrait;
        if (Math.random() < interceptChance) {
          this.stats.recordInterception(player.teamId);
          this.ball.targetPlayer = null;
          target.state = PlayerState.FindSpace;
          this.ball.attachToPlayer(player);
          player.hasBall = true;
          player.state = PlayerState.CarryBall;
          this.kickSystem.applyFirstTouchMovement(player, target);
          this.scoreboard.logEvent(`${player.playerName} interceptou!`);
          return;
        }

        // 2. Deflection — ball hits defender body. Absorbed/scattered, not elastic bounce.
        const ballSpeedFactor = clamp((this.ball.getSpeed() - 4.5) / 7.5, 0, 1);
        const deflectChance = 0.28 + (player.stats.defending / 100) * 0.18 + ballSpeedFactor * 0.22;
        if (Math.random() < deflectChance) {
          const spd = this.ball.getSpeed() * (isShot ? 0.58 : 0.64);
          if (Math.random() < 0.50) {
            const currentAngle = Math.atan2(this.ball.velocity.y, this.ball.velocity.x);
            const deviation = (Math.random() - 0.5) * 1.60;
            this.rotateBallVelocity(currentAngle + deviation, spd);
          } else {
            this.deflectBallOffPlayer(player, spd, 1.10);
          }
          this.ball.targetPlayer = null;
          target.state = PlayerState.FindSpace;
          this.ball.markTouchedBy(player.id, 280);
          this.recalculateRoutes(target);
          this.scoreboard.logEvent(`${player.playerName} desviou!`);
          return;
        }

        // 3. Glance — barely touches, pass continues with a noticeable deviation
        const spd = this.ball.getSpeed() * 0.87;
        this.glanceBallOffPlayer(player, spd, 0.55);
        this.ball.markTouchedBy(player.id, 220);
        this.recalculateRoutes(target);

      } else if (!isOpponent && ballMoving) {
        // Teammate in the way: poor-touch players may accidentally receive the ball;
        // technically skilled players deflect it without interrupting the pass.
        // Chance scales with poor reactions/first touch and drops for faster balls
        // (a fast cross is hard to accidentally trap; a slow ground pass is easy).
        const firstTouch = (player.stats.dribbling * 0.5 + player.stats.reactions * 0.5) / 100;
        const speedFactor = clamp(1 - this.ball.getSpeed() / 10, 0, 1);
        const accidentChance = clamp((1 - firstTouch) * 0.45 * speedFactor, 0, 0.40);
        if (Math.random() < accidentChance) {
          this.ball.targetPlayer = null;
          target.state = PlayerState.FindSpace;
          const oppTeamForAccident = player.teamId === 'teamA' ? this.teamB : this.teamA;
          this.ball.attachToPlayer(player);
          player.hasBall = true;
          player.state = PlayerState.CarryBall;
          player.aiCooldown = this.kickSystem.settleTime(player, oppTeamForAccident.getNearestPlayerTo(player.x, player.y));
          this.kickSystem.applyFirstTouchMovement(player, oppTeamForAccident.getNearestPlayerTo(player.x, player.y));
          this.recalculateRoutes(target);
          this.scoreboard.logEvent(`${player.playerName} tomou a bola sem querer!`);
          return;
        }

        // Normal deflection — skilled player steps aside / lets it ricochet
        const spd = this.ball.getSpeed() * 0.82;
        if (Math.random() < 0.30) {
          const currentAngle = Math.atan2(this.ball.velocity.y, this.ball.velocity.x);
          const deviation = (Math.random() - 0.5) * 0.70;
          this.rotateBallVelocity(currentAngle + deviation, spd * 1.04);
        } else {
          this.deflectBallOffPlayer(player, spd, 0.42);
        }
        target.state = PlayerState.FindSpace;
        this.ball.targetPlayer = null;
        this.ball.markTouchedBy(player.id, 220);
        this.recalculateRoutes(target);
        this.scoreboard.logEvent(`Desvio em ${player.playerName}!`);
      }

      break;
    }
  }

  chaseFreeeBall(): void {
    if (this.ball.owner || this.ball.targetPlayer) return;

    for (const team of [this.teamA, this.teamB]) {
      const ownGoal = team.attackDirection > 0 ? this.goalLeft : this.goalRight;

      let best: Player | null = null;
      let bestScore = Infinity;
      for (const p of team.players) {
        if (p.role === PlayerRole.Goalkeeper) continue;
        if (p.hasBall || p.state === PlayerState.ReceivePass) continue;
        const d = p.distanceToBall(this.ball);
        let penalty = 0;
        if (p.state === PlayerState.MarkOpponent && p.markingTarget) {
          const threatGoalDist = Math.abs(p.markingTarget.x - ownGoal.centerX);
          penalty = threatGoalDist < 260
            ? 130 + (260 - threatGoalDist) * 0.9
            : 55;
        }
        const score = d + penalty;
        if (score < bestScore) { bestScore = score; best = p; }
      }
      if (best) {
        const ballDist = best.distanceToBall(this.ball);
        const intercept = projectBallIntercept(this.ball, best, this.field);
        best.setTarget(intercept.x, intercept.y);
        best.state = PlayerState.PressBall;
        const oppTeam = team === this.teamA ? this.teamB : this.teamA;
        const opponentRunner = oppTeam.players
          .filter(p => p.role !== PlayerRole.Goalkeeper && !p.hasBall)
          .reduce<Player | null>((closest, p) => {
            if (!closest) return p;
            return p.distanceToBall(this.ball) < closest.distanceToBall(this.ball) ? p : closest;
          }, null);
        const contested = opponentRunner
          ? Math.abs(ballDist - opponentRunner.distanceToBall(this.ball)) < 80
          : false;
        const difficult = ballDist > 85 || this.ball.getSpeed() > 2.2 || this._isBallInDangerArea();
        if (opponentRunner && this._shouldSprintForRace(best, opponentRunner, this.ball.x, this.ball.y)) {
          best.forceSprint(380);
        } else if (contested || difficult) {
          best.requestSprint(350, 85);
        }
      }
    }
  }

  checkFreeBall(): void {
    if (this.ball.owner || this.ball.targetPlayer) return;

    let nearest: Player | null = null;
    let nearestDist = BALL_PICKUP_RADIUS;

    for (const p of this.getAllPlayers()) {
      if (this.ball.isPickupBlocked(p.id)) continue;
      const d = p.distanceToBall(this.ball);
      if (d < nearestDist) { nearestDist = d; nearest = p; }
    }
    if (!nearest) return;

    const oppTeam = nearest.teamId === 'teamA' ? this.teamB : this.teamA;
    const contestor = oppTeam.players.find(
      p => !this.ball.isPickupBlocked(p.id) && p.distanceToBall(this.ball) < BALL_PICKUP_RADIUS,
    ) ?? null;
    if (contestor) {
      if (this._shouldSprintForRace(nearest, contestor, this.ball.x, this.ball.y)) {
        nearest.forceSprint(280);
      } else {
        nearest.requestSprint(250, 80);
      }
      if (this._shouldSprintForRace(contestor, nearest, this.ball.x, this.ball.y)) {
        contestor.forceSprint(280);
      } else {
        contestor.requestSprint(250, 80);
      }
    }
    const winner = contestor
      ? this.resolver.resolveDuel(nearest, contestor)
      : nearest;

    winner.hasBall = true;
    winner.state = PlayerState.CarryBall;
    this.ball.attachToPlayer(winner);
    this.kickSystem.applyFirstTouchMovement(winner, oppTeam.getNearestPlayerTo(winner.x, winner.y));
  }

  private getBallPlayerContactDistance(player: Player): number {
    if (this.ball.getSpeed() <= 0.05) return dist(this.ball.x, this.ball.y, player.x, player.y);
    return Math.min(
      dist(this.ball.x, this.ball.y, player.x, player.y),
      distancePointToSegment(player.x, player.y, this.ball.previousX, this.ball.previousY, this.ball.x, this.ball.y),
    );
  }

  private getBallContactNormalFrom(player: Player): { x: number; y: number } {
    const segX = this.ball.x - this.ball.previousX;
    const segY = this.ball.y - this.ball.previousY;
    const segLenSq = segX * segX + segY * segY;
    const t = segLenSq > 0
      ? clamp(((player.x - this.ball.previousX) * segX + (player.y - this.ball.previousY) * segY) / segLenSq, 0, 1)
      : 1;
    const contactX = this.ball.previousX + segX * t;
    const contactY = this.ball.previousY + segY * t;
    let nx = contactX - player.x;
    let ny = contactY - player.y;
    let len = Math.sqrt(nx * nx + ny * ny);

    if (len < 0.001) {
      const speed = this.ball.getSpeed();
      if (speed > 0.001) {
        nx = -this.ball.velocity.x / speed;
        ny = -this.ball.velocity.y / speed;
        len = 1;
      } else {
        nx = 1;
        ny = 0;
        len = 1;
      }
    }

    return { x: nx / len, y: ny / len };
  }

  private rotateBallVelocity(angle: number, speed: number): void {
    this.ball.velocity.x = Math.cos(angle) * speed;
    this.ball.velocity.y = Math.sin(angle) * speed;
    this.ball.spin = 0;
  }

  private deflectBallOffPlayer(player: Player, speed: number, maxNoiseRad: number): void {
    const normal = this.getBallContactNormalFrom(player);
    const vx = this.ball.velocity.x;
    const vy = this.ball.velocity.y;
    const dot = vx * normal.x + vy * normal.y;
    // Absorption factor 1.1 (not 2.0) — ball is partially absorbed by body, not elastic
    const absorb = dot < 0 ? 1.1 : 0;
    let outX = vx - absorb * dot * normal.x;
    let outY = vy - absorb * dot * normal.y;
    const outLen = Math.sqrt(outX * outX + outY * outY) || 1;
    outX /= outLen;
    outY /= outLen;
    const angle = Math.atan2(outY, outX) + (Math.random() - 0.5) * maxNoiseRad;
    this.rotateBallVelocity(angle, speed);
  }

  private glanceBallOffPlayer(player: Player, speed: number, maxNoiseRad: number): void {
    const normal = this.getBallContactNormalFrom(player);
    const vx = this.ball.velocity.x;
    const vy = this.ball.velocity.y;
    const dot = vx * normal.x + vy * normal.y;
    const outX = vx - Math.min(dot, 0) * normal.x * 0.45;
    const outY = vy - Math.min(dot, 0) * normal.y * 0.45;
    const angle = Math.atan2(outY, outX) + (Math.random() - 0.5) * maxNoiseRad;
    this.rotateBallVelocity(angle, speed);
  }
}

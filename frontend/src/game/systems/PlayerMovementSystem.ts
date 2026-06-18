import { Ball } from '../entities/Ball';
import { Player } from '../entities/Player';
import { Team } from '../entities/Team';
import { Scoreboard } from './Scoreboard';
import { StatsTracker } from './StatsTracker';
import { EventResolver } from './EventResolver';
import { PlayerRole } from '../data/PlayerRole';
import { PlayerState } from '../data/PlayerState';
import { FieldBounds, GoalBounds } from '../types';
import { dist, clamp, distancePointToSegment } from '../utils/MathUtils';
import { traitBonus, TRAITS } from '../data/PlayerTraits';
import type { MatchContext } from './MatchContext';
import type { DebugCollector } from '../debug/DebugCollector';

const TACKLE_RANGE = 20;
const TACKLE_COOLDOWN_MS = 1400;
const PENALTY_AREA_H = 396;
const PENALTY_AREA_W = 182;

export class PlayerMovementSystem {
  private ball: Ball;
  private teamA: Team;
  private teamB: Team;
  private scoreboard: Scoreboard;
  private stats: StatsTracker;
  private resolver: EventResolver;
  private tackleCooldowns: Map<string, number>;
  private field: FieldBounds;
  private goalLeft: GoalBounds;
  private goalRight: GoalBounds;
  private getAllPlayers: () => Player[];
  private debugCollector?: DebugCollector;

  constructor(ctx: MatchContext) {
    this.ball = ctx.ball;
    this.teamA = ctx.teamA;
    this.teamB = ctx.teamB;
    this.scoreboard = ctx.scoreboard;
    this.stats = ctx.stats;
    this.resolver = ctx.resolver;
    this.tackleCooldowns = ctx.tackleCooldowns;
    this.field = ctx.field;
    this.goalLeft = ctx.goalLeft;
    this.goalRight = ctx.goalRight;
    this.getAllPlayers = ctx.allPlayers;
    this.debugCollector = ctx.debugCollector;
  }

  separateTeamTargets(team: Team): void {
    const MIN_T = 45;
    const eligible = team.players.filter(
      p => !p.hasBall
        && p.state !== PlayerState.ReceivePass
        && p.state !== PlayerState.Pass,
    );

    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i];
        const b = eligible[j];
        const dx = b.targetX - a.targetX;
        const dy = b.targetY - a.targetY;
        const dSq = dx * dx + dy * dy;
        if (dSq >= MIN_T * MIN_T || dSq === 0) continue;

        const d = Math.sqrt(dSq);
        const push = (MIN_T - d) / 2;
        const nx = dx / d;
        const ny = dy / d;

        a.targetX = clamp(a.targetX - nx * push, this.field.left + 15, this.field.right - 15);
        a.targetY = clamp(a.targetY - ny * push, this.field.top + 15, this.field.bottom - 15);
        b.targetX = clamp(b.targetX + nx * push, this.field.left + 15, this.field.right - 15);
        b.targetY = clamp(b.targetY + ny * push, this.field.top + 15, this.field.bottom - 15);
      }
    }
  }

  checkTackles(): void {
    for (const team of [this.teamA, this.teamB]) {
      const oppTeam = team === this.teamA ? this.teamB : this.teamA;
      const carrier = oppTeam.getBallCarrier();
      if (!carrier) continue;

      for (const defender of team.players) {
        if (defender.role === PlayerRole.Goalkeeper) continue;
        if ((this.tackleCooldowns.get(defender.id) ?? 0) > 0) continue;
        if (defender.distanceTo(carrier) > TACKLE_RANGE) continue;
        if (defender.state !== PlayerState.MarkOpponent && defender.state !== PlayerState.PressBall) continue;

        // MarkOpponent defenders must be closing in — velocity must point roughly toward carrier.
        // Very close contact (< 18px) skips the check: at that distance the defender is essentially on top.
        // PressBall defenders are already committed to pressing, so no extra check needed.
        if (defender.state === PlayerState.MarkOpponent && defender.distanceTo(carrier) >= 18) {
          const toCarrierX = carrier.x - defender.x;
          const toCarrierY = carrier.y - defender.y;
          const speed = Math.sqrt(defender.vx * defender.vx + defender.vy * defender.vy);
          const dot = defender.vx * toCarrierX + defender.vy * toCarrierY;
          if (dot <= -speed * 0.3) continue;
        }

        this.tackleCooldowns.set(defender.id, TACKLE_COOLDOWN_MS);
        this.tackleCooldowns.set(carrier.id, TACKLE_COOLDOWN_MS * 0.7);

        if (this.resolver.resolveTackle(defender, carrier, this.tacklePositioningBonus(defender, carrier, team))) {
          this.stats.recordTackleWon(defender.teamId);
          carrier.hasBall = false;
          this.ball.release();
          carrier.state = PlayerState.FindSpace;
          const approachX = carrier.x - defender.x;
          const approachY = carrier.y - defender.y;
          const approachLen = Math.max(Math.sqrt(approachX * approachX + approachY * approachY), 1);
          const r = Math.random();
          if (r < 0.22) {
            // Ball squirts backward past the carrier — loose ball behind the play
            const backDir = -carrier.attackDirection;
            this.ball.velocity.x = backDir * (1.8 + Math.random() * 1.8);
            this.ball.velocity.y = (Math.random() - 0.5) * 3.2;
          } else if (r < 0.40) {
            // Ball squirts sideways — neither player has immediate advantage
            const side = Math.random() < 0.5 ? 1 : -1;
            this.ball.velocity.x = (approachX / approachLen) * 1.0;
            this.ball.velocity.y = side * (2.0 + Math.random() * 2.0);
          } else {
            // Ball squirts forward toward the tackling defender
            const scatter = (Math.random() - 0.5) * 2.0;
            this.ball.velocity.x = (approachX / approachLen) * 2.5 + scatter;
            this.ball.velocity.y = (approachY / approachLen) * 2.5 + scatter;
          }
          this.debugCollector?.recordAction({
            player: defender,
            kind: 'tackle-won',
            reason: `won tackle on ${carrier.playerName}`,
            targetPlayer: carrier,
          });
          this.scoreboard.logEvent(`${defender.playerName} roubou de ${carrier.playerName}!`);
        } else {
          const dx = carrier.x - defender.x;
          const dy = carrier.y - defender.y;
          defender.setTarget(defender.x - dx * 0.4, defender.y - dy * 0.4);
          // Failed tackle disrupts the carrier's route — they don't glide through untouched.
          // Push their target perpendicular to the tackle approach so they must re-route.
          const len = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const perpX = -dy / len;
          const perpY = dx / len;
          const side = Math.random() < 0.5 ? 1 : -1;
          const disruption = 18 + Math.random() * 22;
          carrier.setTarget(
            clamp(carrier.targetX + perpX * side * disruption, this.field.left + 15, this.field.right - 15),
            clamp(carrier.targetY + perpY * side * disruption, this.field.top + 15, this.field.bottom - 15),
          );
          if (carrier.aiCooldown < 180) carrier.aiCooldown = 180;
          this.debugCollector?.recordAction({
            player: defender,
            kind: 'tackle-missed',
            reason: `missed tackle on ${carrier.playerName}`,
            targetPlayer: carrier,
          });
        }
        break;
      }
    }

    // GK tackle: inside own penalty area the goalkeeper can dispossess a carrier.
    // Unlike outfield tackles, a successful GK tackle gives them ball possession.
    for (const team of [this.teamA, this.teamB]) {
      const gk = team.players.find(p => p.role === PlayerRole.Goalkeeper);
      if (!gk || (this.tackleCooldowns.get(gk.id) ?? 0) > 0) continue;
      if (gk.state !== PlayerState.PressBall) continue;

      const oppTeam = team === this.teamA ? this.teamB : this.teamA;
      const carrier = oppTeam.getBallCarrier();
      if (!carrier) continue;

      const ownGoal = team.attackDirection > 0 ? this.goalLeft : this.goalRight;
      const goalCenterY = (ownGoal.top + ownGoal.bottom) / 2;
      if (Math.abs(carrier.x - ownGoal.centerX) > PENALTY_AREA_W + 50) continue;
      if (Math.abs(carrier.y - goalCenterY) > PENALTY_AREA_H / 2) continue;

      if (gk.distanceTo(carrier) > TACKLE_RANGE) continue;

      this.tackleCooldowns.set(gk.id, TACKLE_COOLDOWN_MS);
      this.tackleCooldowns.set(carrier.id, TACKLE_COOLDOWN_MS * 0.7);

      if (this.resolver.resolveTackle(gk, carrier, this.tacklePositioningBonus(gk, carrier, team))) {
        this.stats.recordTackleWon(gk.teamId);
        carrier.hasBall = false;
        carrier.state = PlayerState.FindSpace;
        this.ball.release();
        this.ball.attachToPlayer(gk);
        gk.hasBall = true;
        gk.state = PlayerState.Clearance;
        gk.aiCooldown = 650;
        this.debugCollector?.recordAction({
          player: gk,
          kind: 'tackle-won',
          reason: `GK won tackle on ${carrier.playerName}`,
          targetPlayer: carrier,
        });
        this.scoreboard.logEvent(`${gk.playerName} roubou de ${carrier.playerName}!`);
      } else {
        const dx = carrier.x - gk.x;
        const dy = carrier.y - gk.y;
        gk.setTarget(gk.x - dx * 0.4, gk.y - dy * 0.4);
        this.debugCollector?.recordAction({
          player: gk,
          kind: 'tackle-missed',
          reason: `GK missed tackle on ${carrier.playerName}`,
          targetPlayer: carrier,
        });
      }
    }
  }

  // Gentle drift-apart: apply only 20 % of the overlap per frame so players
  // smoothly glide away from each other instead of snapping/jittering.
  // Hard collision is handled mechanically only via tackles.
  applyPlayerTrafficAvoidance(): void {
    const players = this.getAllPlayers();
    const LOOKAHEAD = 86;
    const LANE_WIDTH = 42;
    const AVOID_STRENGTH = 48;

    for (const p of players) {
      p.avoidanceX = 0;
      p.avoidanceY = 0;
    }

    for (const p of players) {
      if (p.state === PlayerState.GkDive) continue;

      const tx = p.targetX - p.x;
      const ty = p.targetY - p.y;
      const targetDist = Math.sqrt(tx * tx + ty * ty);
      if (targetDist < 12) continue;

      const dirX = tx / targetDist;
      const dirY = ty / targetDist;
      const perpX = -dirY;
      const perpY = dirX;

      // Navigating players (off-ball, seeking space) scan farther ahead and
      // react more strongly to opponents so they find gaps instead of barging
      // straight through defensive clusters.
      const isNavigating = !p.hasBall
        && p.role !== PlayerRole.Goalkeeper
        && (p.state === PlayerState.FindSpace || p.state === PlayerState.ReturnToShape);

      for (const blocker of players) {
        if (blocker === p) continue;

        const isOpp = blocker.teamId !== p.teamId;
        const lookahead = isNavigating && isOpp ? LOOKAHEAD * 1.65 : LOOKAHEAD;
        const laneWidth = isNavigating && isOpp ? LANE_WIDTH * 1.35 : LANE_WIDTH;

        const relX = blocker.x - p.x;
        const relY = blocker.y - p.y;
        const forward = relX * dirX + relY * dirY;
        if (forward < -6 || forward > lookahead) continue;

        const lateral = relX * perpX + relY * perpY;
        const lateralAbs = Math.abs(lateral);
        if (lateralAbs > laneWidth) continue;

        const side = lateralAbs < 2
          ? (p.id < blocker.id ? -1 : 1)
          : (lateral > 0 ? -1 : 1);
        const forwardWeight = 1 - Math.max(0, forward) / lookahead;
        const lateralWeight = 1 - lateralAbs / laneWidth;
        const navOppMult = isNavigating && isOpp ? 2.1 : 1.0;
        const strength = AVOID_STRENGTH * forwardWeight * lateralWeight * navOppMult;

        p.avoidanceX += perpX * side * strength;
        p.avoidanceY += perpY * side * strength;
      }

      // Wider cap for navigating players so the larger forces don't get clipped.
      const cap = isNavigating ? 82 : 55;
      p.avoidanceX = clamp(p.avoidanceX, -cap, cap);
      p.avoidanceY = clamp(p.avoidanceY, -cap, cap);
    }
  }

  resolvePlayerCollisions(): void {
    const players = this.getAllPlayers();
    const MIN_DIST = 22;
    const PUSH = 0.20; // fraction of overlap corrected per frame
    const ITERATIONS = 3;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          const a = players[i];
          const b = players[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dSq = dx * dx + dy * dy;
          if (dSq >= MIN_DIST * MIN_DIST || dSq === 0) continue;

          const d = Math.sqrt(dSq);
          const nudge = (MIN_DIST - d) * PUSH;
          const nx = dx / d;
          const ny = dy / d;
          const aDiving = a.state === PlayerState.GkDive;
          const bDiving = b.state === PlayerState.GkDive;
          const massA = a.getBodyMassFactor();
          const massB = b.getBodyMassFactor();
          const massTotal = massA + massB;
          const aShare = aDiving ? 0 : bDiving ? 1 : massB / massTotal;
          const bShare = bDiving ? 0 : aDiving ? 1 : massA / massTotal;

          // Light velocity deflection — just enough to make players curve around
          // each other; heavy deflection caused visible stumbling/direction changes
          const velocityNudge = nudge * 0.4;
          if (!a.hasBall && !aDiving) {
            a.vx -= nx * velocityNudge * aShare;
            a.vy -= ny * velocityNudge * aShare;
          }
          if (!b.hasBall && !bDiving) {
            b.vx += nx * velocityNudge * bShare;
            b.vy += ny * velocityNudge * bShare;
          }

          // Stronger positional correction to actually separate overlapping bodies
          const posNudge = nudge * 1.2;
          if (!a.hasBall && !aDiving) {
            a.x = clamp(a.x - nx * posNudge * aShare, this.field.left + 15, this.field.right - 15);
            a.y = clamp(a.y - ny * posNudge * aShare, this.field.top + 15, this.field.bottom - 15);
          }
          if (!b.hasBall && !bDiving) {
            b.x = clamp(b.x + nx * posNudge * bShare, this.field.left + 15, this.field.right - 15);
            b.y = clamp(b.y + ny * posNudge * bShare, this.field.top + 15, this.field.bottom - 15);
          }
        }
      }
    }
  }

  shouldSprintForRace(player: Player, opponent: Player, targetX: number, targetY: number): boolean {
    const playerDist = dist(player.x, player.y, targetX, targetY);
    const opponentDist = dist(opponent.x, opponent.y, targetX, targetY);
    if (playerDist > 210 || opponentDist > 230) return false;

    const playerTime = this.estimatedArrivalFrames(player, playerDist, false);
    const opponentTime = this.estimatedArrivalFrames(opponent, opponentDist, opponent.isSprinting());
    const closeRace = playerTime < opponentTime + 18;
    const opponentThreat = opponent.isSprinting() || opponentTime < playerTime + 12;

    return closeRace && opponentThreat && player.currentStamina > 18;
  }

  estimatedArrivalFrames(player: Player, distance: number, sprinting: boolean): number {
    const baseSpeed = Math.max(0.35, (player.stats.sprintSpeed / 100) * 1.85 * player.getStaminaFactor());
    const sprintMult = sprinting ? 1.28 : 1.0;
    return distance / (baseSpeed * sprintMult);
  }

  private tacklePositioningBonus(defender: Player, carrier: Player, defendingTeam: Team): number {
    const run = this.playerMovementVector(carrier);
    const futureX = clamp(carrier.x + run.x * 58, this.field.left + 15, this.field.right - 15);
    const futureY = clamp(carrier.y + run.y * 58, this.field.top + 15, this.field.bottom - 15);
    const pathDist = distancePointToSegment(defender.x, defender.y, carrier.x, carrier.y, futureX, futureY);
    const fromCarrierX = defender.x - carrier.x;
    const fromCarrierY = defender.y - carrier.y;
    const aheadDot = fromCarrierX * run.x + fromCarrierY * run.y;
    const laneBlock = clamp((42 - pathDist) / 42, 0, 1);
    const ahead = clamp((aheadDot + 18) / 76, 0, 1);

    const ownGoal = defendingTeam.attackDirection > 0 ? this.goalLeft : this.goalRight;
    const carrierGoalDist = Math.abs(carrier.x - ownGoal.centerX);
    const defenderGoalDist = Math.abs(defender.x - ownGoal.centerX);
    const betweenCarrierAndGoal = defenderGoalDist < carrierGoalDist + 8;
    const goalSideBonus = betweenCarrierAndGoal ? 4 : -5;
    const jockeyBonus = traitBonus(defender, TRAITS.JOCKEY, 5, 4);
    const readBonus = (defender.stats.defending * 0.045 + defender.stats.reactions * 0.035) * laneBlock * ahead;
    const recoveryPenalty = aheadDot < -18 ? clamp((-aheadDot - 18) / 70, 0, 1) * 12 : 0;

    return clamp(laneBlock * 14 + ahead * 7 + readBonus + goalSideBonus + jockeyBonus - recoveryPenalty, -14, 24);
  }

  private playerMovementVector(player: Player): { x: number; y: number } {
    const speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
    if (speed > 0.18) return { x: player.vx / speed, y: player.vy / speed };

    const tx = player.targetX - player.x;
    const ty = player.targetY - player.y;
    const targetDist = Math.sqrt(tx * tx + ty * ty);
    if (targetDist > 8) return { x: tx / targetDist, y: ty / targetDist };

    return { x: player.attackDirection, y: 0 };
  }
}

import { Ball } from '../entities/Ball';
import { Player } from '../entities/Player';
import { Team } from '../entities/Team';
import { Scoreboard } from './Scoreboard';
import { PlayerRole } from '../data/PlayerRole';
import { PlayerState } from '../data/PlayerState';
import { FieldBounds, GoalBounds } from '../types';
import { dist, clamp } from '../utils/MathUtils';
import { gkShotStoppingQuality, gkDistributionQuality } from '../ai/DecisionUtils';
import { traitBonus, TRAITS } from '../data/PlayerTraits';
import { BALL_PHYSICS } from '../physics/BallPhysics';
import { projectBallAtFrames, findBallFramesToX, findClosestBallFrameToPlayer } from '../physics/BallProjection';
import type { MatchContext } from './MatchContext';

const CONTACT_RADIUS: number = BALL_PHYSICS.contactRadius;
const PENALTY_AREA_H = 396;
const PENALTY_AREA_W = 182;

const GK_DIVE_MIN_DISTANCE = 52;
const GK_DIVE_BASE_REACH = 100;
const GK_DIVE_MAX_REACH = 196;
const GK_DIVE_MIN_DISPLACEMENT = 50;
const GK_DIVE_OVERSHOOT = 18;
const GK_DIVE_MIN_REACTION_FRAMES = 2;
const GK_DIVE_MAX_REACTION_FRAMES = 90;
const GK_DIVE_MIN_TARGETED_THREAT_SPEED = 4.8;
const GK_DIVE_MIN_CROSS_THREAT_SPEED = 4.8;
const GK_DIVE_CATCH_RADIUS = 26;
const GK_DIVE_GOAL_LINE_MARGIN = 2;
const GK_DIVE_PARALLEL_BIAS = 0.62;

export class GoalkeeperSystem {
  public gkDiveHoldoffMs = 0;
  public lastPassWasCross = false;

  private ball: Ball;
  private teamA: Team;
  private teamB: Team;
  private scoreboard: Scoreboard;
  private field: FieldBounds;
  private goalLeft: GoalBounds;
  private goalRight: GoalBounds;

  constructor(ctx: MatchContext) {
    this.ball = ctx.ball;
    this.teamA = ctx.teamA;
    this.teamB = ctx.teamB;
    this.scoreboard = ctx.scoreboard;
    this.field = ctx.field;
    this.goalLeft = ctx.goalLeft;
    this.goalRight = ctx.goalRight;
  }

  updateGoalkeeperDives(): void {
    if (this.gkDiveHoldoffMs > 0) return;
    if (this.ball.owner) return;

    const speed = this.ball.getSpeed();
    if (speed < 3.8) return;
    const target = this.ball.targetPlayer as Player | null;

    const targetedThreat = !!target
      && (speed >= GK_DIVE_MIN_TARGETED_THREAT_SPEED
        || (this.lastPassWasCross && speed >= GK_DIVE_MIN_CROSS_THREAT_SPEED));
    if (target && !targetedThreat) return;

    this.tryGoalkeeperDive(this.teamA, this.teamA.attackDirection > 0 ? this.goalLeft : this.goalRight, target);
    this.tryGoalkeeperDive(this.teamB, this.teamB.attackDirection > 0 ? this.goalLeft : this.goalRight, target);
  }

  private tryGoalkeeperDive(team: Team, ownGoal: GoalBounds, previousTarget: Player | null = null): void {
    const gk = team.players.find(p => p.role === PlayerRole.Goalkeeper);
    if (!gk || gk.hasBall || gk.state === PlayerState.GkDive || gk.currentStamina < 10) return;

    const lineX = ownGoal.centerX < this.field.centerX ? this.field.left : this.field.right;
    const vx = this.ball.velocity.x;
    if ((lineX < this.field.centerX && vx >= -0.7) || (lineX > this.field.centerX && vx <= 0.7)) return;

    const framesToGoal = findBallFramesToX(this.ball, lineX, 140);
    if (framesToGoal === null || framesToGoal <= 0 || framesToGoal > 118) return;

    const projectedAtGoal = projectBallAtFrames(this.ball, framesToGoal);
    const projectedGoalY = projectedAtGoal.y;
    if (projectedGoalY < ownGoal.top + 4 || projectedGoalY > ownGoal.bottom - 4) return;

    const speedSq = this.ball.velocity.x * this.ball.velocity.x + this.ball.velocity.y * this.ball.velocity.y;
    if (speedSq < 60) return;
    const ballSpeed = Math.sqrt(speedSq);
    const kickDistance = dist(this.ball.lastKickX, this.ball.lastKickY, lineX, projectedGoalY);
    const closeKickPressure = clamp((260 - kickDistance) / 210, 0, 1);
    const farKickRead = clamp((kickDistance - 360) / 420, 0, 1);
    const speedPressure = clamp((ballSpeed - 7.4) / 6.2, 0, 1);
    const ballInOwnTerritory = ownGoal.centerX < this.field.centerX
      ? this.ball.x < this.field.centerX
      : this.ball.x > this.field.centerX;
    const closestFrames = findClosestBallFrameToPlayer(this.ball, gk, framesToGoal);
    const rawQuality = gkShotStoppingQuality(gk) / 100;
    const quality = ballInOwnTerritory ? rawQuality : 0.18;
    const farReachReactionBonus = ballInOwnTerritory ? traitBonus(gk, TRAITS.FAR_REACH, 1.2, 0.8) : 0;
    const reactionFrames = clamp(
      12 - quality * 8 - farReachReactionBonus,
      GK_DIVE_MIN_REACTION_FRAMES,
      12,
    );
    if (closestFrames > GK_DIVE_MAX_REACTION_FRAMES) return;

    const intercept = projectBallAtFrames(this.ball, closestFrames);
    const interceptX = intercept.x;
    const interceptY = intercept.y;
    const diveDistance = dist(gk.x, gk.y, interceptX, interceptY);
    const reach = clamp(
      GK_DIVE_BASE_REACH + gk.stats.sprintSpeed * 0.42 + gk.stats.defending * 0.28 + traitBonus(gk, TRAITS.FAR_REACH, 24, 14),
      GK_DIVE_BASE_REACH,
      GK_DIVE_MAX_REACH,
    ) * gk.getStaminaFactor();

    if (diveDistance < GK_DIVE_MIN_DISTANCE || diveDistance > reach) return;

    const cutDirX = (interceptX - gk.x) / diveDistance;
    const cutDirY = (interceptY - gk.y) / diveDistance;
    const parallelDirY = cutDirY === 0 ? 0 : Math.sign(cutDirY);
    let dirX = cutDirX * (1 - GK_DIVE_PARALLEL_BIAS);
    let dirY = cutDirY * (1 - GK_DIVE_PARALLEL_BIAS) + parallelDirY * GK_DIVE_PARALLEL_BIAS;
    const biasedLen = Math.sqrt(dirX * dirX + dirY * dirY);
    if (biasedLen > 0.001) {
      dirX /= biasedLen;
      dirY /= biasedLen;
    } else {
      dirX = cutDirX;
      dirY = cutDirY;
    }
    const displacement = Math.max(diveDistance + GK_DIVE_OVERSHOOT, GK_DIVE_MIN_DISPLACEMENT);
    const minDiveX = lineX < this.field.centerX ? this.field.left - GK_DIVE_GOAL_LINE_MARGIN : this.field.left + 15;
    const maxDiveX = lineX > this.field.centerX ? this.field.right + GK_DIVE_GOAL_LINE_MARGIN : this.field.right - 15;
    const saveX = clamp(gk.x + dirX * displacement, minDiveX, maxDiveX);
    const saveY = clamp(gk.y + dirY * displacement, this.field.top + 8, this.field.bottom - 8);
    const actualDisplacement = dist(gk.x, gk.y, saveX, saveY);
    const diveDurationMs = this.estimateGkDiveDurationMs(gk, actualDisplacement);
    const diveFrames = diveDurationMs / 16.67;
    const interceptTravelRatio = clamp(diveDistance / Math.max(actualDisplacement, 1), 0.42, 0.88);
    const framesToReachIntercept = diveFrames * interceptTravelRatio;
    const timingLeadFrames = clamp(
      0.3
        + quality * 1.8
        + farKickRead * 0.7
        + (ballInOwnTerritory ? traitBonus(gk, TRAITS.FAR_REACH, 0.35, 0.2) : 0)
        - reactionFrames * 0.12
        - closeKickPressure * 0.7
        - speedPressure * 0.45,
      0.1,
      2.4,
    );
    if (closestFrames > framesToReachIntercept + timingLeadFrames) return;

    const lateGraceFrames = clamp(3 + quality * 7 - closeKickPressure * 1.4 - speedPressure * 1.1, 1.4, 9.5);
    const emergencyCloseShot = framesToGoal < 18 && diveDistance < reach * (0.72 + quality * 0.20);
    if (closestFrames + lateGraceFrames < framesToReachIntercept && !emergencyCloseShot) return;

    if (previousTarget && previousTarget !== gk && !previousTarget.hasBall) {
      previousTarget.state = PlayerState.FindSpace;
      previousTarget.aiCooldown = 0;
    }
    this.ball.targetPlayer = gk;
    gk.stretchSave = false;
    gk.diveToward(saveX, saveY, this.ball.x, this.ball.y, this.ball.velocity.x, this.ball.velocity.y, diveDurationMs);
    gk.aiCooldown = Math.max(gk.aiCooldown, 520);
    this.scoreboard.logEvent(`${gk.playerName} mergulha na bola!`);
  }

  private estimateGkDiveDurationMs(gk: Player, displacement: number): number {
    return clamp(205 + displacement * 1.75 - gk.stats.sprintSpeed * 0.10, 225, 460);
  }

  getGkPhysicalClaimRadius(player: Player): number {
    if (player.role !== PlayerRole.Goalkeeper) return CONTACT_RADIUS;

    const team = player.teamId === 'teamA' ? this.teamA : this.teamB;
    const ownGoal = team.attackDirection > 0 ? this.goalLeft : this.goalRight;
    const goalCenterY = (ownGoal.top + ownGoal.bottom) / 2;
    const ballGoalDist = Math.abs(this.ball.x - ownGoal.centerX);
    const ballCentralDist = Math.abs(this.ball.y - goalCenterY);

    if (ballGoalDist > PENALTY_AREA_W + 10 || ballCentralDist > PENALTY_AREA_H / 2) return CONTACT_RADIUS;

    const depthFactor = clamp(1 - ballGoalDist / 250, 0, 1);
    const skillBonus = gkShotStoppingQuality(player) * 0.035;
    const depthBonus = depthFactor * 3;
    return CONTACT_RADIUS + skillBonus + depthBonus;
  }

  getBallArrivalRadius(target: Player): number {
    if (target.role !== PlayerRole.Goalkeeper) return CONTACT_RADIUS;

    const physicalClaimRadius = this.getGkPhysicalClaimRadius(target);
    if (target.state !== PlayerState.GkDive) return Math.max(CONTACT_RADIUS, physicalClaimRadius);

    const diveSkillBonus = gkShotStoppingQuality(target) * 0.025;
    return Math.max(physicalClaimRadius, GK_DIVE_CATCH_RADIUS + diveSkillBonus);
  }

  findGkControlledOutlet(
    gk: Player,
    ownTeam: Team,
    oppTeam: Team,
    dir: 1 | -1,
  ): { target: Player; blocker: Player | null } | null {
    let best: { target: Player; blocker: Player | null; score: number } | null = null;
    const distribution = gkDistributionQuality(gk);

    for (const p of ownTeam.players) {
      if (p.role === PlayerRole.Goalkeeper) continue;

      const d = dist(gk.x, gk.y, p.x, p.y);
      if (d < 28 || d > 360) continue;

      const isDefender = p.role === PlayerRole.Defender;
      const isMid = p.role === PlayerRole.Midfielder || p.role === PlayerRole.Winger;
      if (!isDefender && !isMid) continue;
      if (distribution < 52 && !isDefender && d > 220) continue;

      const nearOpp = oppTeam.getNearestPlayerTo(p.x, p.y);
      const nearOppDist = nearOpp ? nearOpp.distanceTo(p) : 999;
      const minSpace = (isDefender ? 36 : 48) + clamp(60 - distribution, 0, 35) * 0.28;
      if (nearOppDist < minSpace) continue;

      const blocker = this.findShortLaneBlocker(gk, p, oppTeam);
      if (blocker && d < 175 + distribution * 1.1) continue;

      const advance = (p.x - gk.x) * dir;
      const roleScore = isDefender ? 34 : 20;
      const spaceScore = clamp((nearOppDist - minSpace) / 120, 0, 1) * 34;
      const distanceScore = isDefender
        ? clamp((260 - d) / 230, 0, 1) * 24
        : clamp((360 - d) / 300, 0, 1) * 14;
      const progressScore = clamp(advance / 240, -0.35, 1) * 16;
      const lanePenalty = blocker ? 18 : 0;
      const score = roleScore + spaceScore + distanceScore + progressScore + distribution * 0.08 - lanePenalty;

      if (!best || score > best.score) best = { target: p, blocker, score };
    }

    return best && best.score > 60 - distribution * 0.20 ? best : null;
  }

  findShortLaneBlocker(gk: Player, target: Player, oppTeam: Team): Player | null {
    const ldx = target.x - gk.x;
    const ldy = target.y - gk.y;
    const lenSq = ldx * ldx + ldy * ldy;
    if (lenSq < 1) return null;

    let nearest: Player | null = null;
    let nearestDist = Infinity;
    for (const opp of oppTeam.players) {
      const od = dist(gk.x, gk.y, opp.x, opp.y);
      if (od > 145) continue;
      const t = clamp(((opp.x - gk.x) * ldx + (opp.y - gk.y) * ldy) / lenSq, 0, 1);
      const cx = gk.x + ldx * t;
      const cy = gk.y + ldy * t;
      if (dist(opp.x, opp.y, cx, cy) < 32 && od < nearestDist) {
        nearest = opp;
        nearestDist = od;
      }
    }
    return nearest;
  }
}

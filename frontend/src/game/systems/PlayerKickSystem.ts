import Phaser from 'phaser';
import { Ball } from '../entities/Ball';
import { Player } from '../entities/Player';
import { Team } from '../entities/Team';
import { Scoreboard } from './Scoreboard';
import { StatsTracker } from './StatsTracker';
import { GoalkeeperSystem } from './GoalkeeperSystem';
import { AIContext, findAttackingOpenSpace, gkShotStoppingQuality } from '../ai/DecisionUtils';
import { PlayerRole } from '../data/PlayerRole';
import { PlayerState } from '../data/PlayerState';
import { FieldBounds, GoalBounds } from '../types';
import { dist, clamp, distancePointToSegment } from '../utils/MathUtils';
import { traitBonus, TRAITS } from '../data/PlayerTraits';
import { BALL_PHYSICS } from '../physics/BallPhysics';
import { planReceptionTarget } from '../physics/BallProjection';
import { GOAL_HEIGHT } from '../constants';
import type { MatchContext } from './MatchContext';
import type { AudioManager } from './AudioManager';
import type { DebugCollector } from '../debug/DebugCollector';

const CONTACT_RADIUS: number = BALL_PHYSICS.contactRadius;
const BALL_FRICTION: number = BALL_PHYSICS.groundFrictionPerFrame;
const SHOT_BASE_POWER = 8.5;
const SHOT_STAT_POWER = 4.0;
const SHOT_DISTANCE_POWER = 5.5;
const SHOT_MIN_POWER = 8.5;
const SHOT_MAX_POWER = 15.0;
const SHOT_ELITE_MAX_POWER_BONUS = 3.8;
const SHOT_DISTANCE_POWER_START = 190;
const SHOT_DISTANCE_POWER_FULL = 420;
const CLEARANCE_BASE_POWER = 7.0;
const CLEARANCE_STAT_POWER = 2.6;

interface BallLaneAnalysis {
  risk: number;
  blockers: number;
  nearestDist: number;
  blocker: Player | null;
  blockerT: number;
  openSide: -1 | 1;
}

export class PlayerKickSystem {
  private ball: Ball;
  private teamA: Team;
  private teamB: Team;
  private scoreboard: Scoreboard;
  private stats: StatsTracker;
  private gkSystem: GoalkeeperSystem;
  private field: FieldBounds;
  private goalLeft: GoalBounds;
  private goalRight: GoalBounds;
  private getAllPlayers: () => Player[];
  private recalculateRoutes: (previousTarget?: Player | null) => void;
  private audio: AudioManager;
  private debugCollector?: DebugCollector;

  constructor(ctx: MatchContext) {
    this.ball = ctx.ball;
    this.teamA = ctx.teamA;
    this.teamB = ctx.teamB;
    this.scoreboard = ctx.scoreboard;
    this.stats = ctx.stats;
    this.gkSystem = ctx.gkSystem!;
    this.field = ctx.field;
    this.goalLeft = ctx.goalLeft;
    this.goalRight = ctx.goalRight;
    this.getAllPlayers = ctx.allPlayers;
    this.recalculateRoutes = ctx.recalculateRoutesAfterBallTrajectoryChange;
    this.audio = ctx.audio;
    this.debugCollector = ctx.debugCollector;
  }

  doPass(passer: Player, receiver: Player): void {
    this.stats.recordPass(passer.teamId);
    passer.hasBall = false;
    this.ball.release();
    passer.state = PlayerState.FindSpace;
    passer.aiCooldown = 600;

    let intendedX = passer.passTargetX ?? receiver.x;
    let intendedY = passer.passTargetY ?? receiver.y;
    const passKind = passer.passKind;
    const isThroughPass = passKind === 'through';
    const isCross = passKind === 'cross';
    const isCutback = passKind === 'cutback';
    const isLofted = passKind === 'lofted';

    // Lofted / cross passes: aim at the receiver's PREDICTED position at ball landing,
    // not their current position. Each pass type has its own airborne frame budget.
    const crossLift  = 4.1;
    const loftedLift = 2.8;
    const crossAirFrames  = (crossLift  * 2) / BALL_PHYSICS.verticalGravityPerFrame; // ≈ 24.1
    const loftedAirFrames = (loftedLift * 2) / BALL_PHYSICS.verticalGravityPerFrame; // ≈ 16.5
    if (isCross || isLofted) {
      const airFrames = isCross ? crossAirFrames : loftedAirFrames;
      const toTargetX = receiver.targetX - receiver.x;
      const toTargetY = receiver.targetY - receiver.y;
      const toTargetLen = Math.sqrt(toTargetX * toTargetX + toTargetY * toTargetY);
      if (toTargetLen > 8) {
        const rxSpeed = (receiver.stats.sprintSpeed / 100) * 1.85 * receiver.getStaminaFactor();
        const rxTravel = rxSpeed * airFrames * 0.55;
        intendedX = clamp(receiver.x + (toTargetX / toTargetLen) * rxTravel, this.field.left + 20, this.field.right - 20);
        intendedY = clamp(receiver.y + (toTargetY / toTargetLen) * rxTravel, this.field.top  + 20, this.field.bottom - 20);
      }
    }

    const passDist = dist(passer.x, passer.y, intendedX, intendedY);
    const passLane = this.analyzeBallLane(
      passer.x,
      passer.y,
      intendedX,
      intendedY,
      this.getAllPlayers().filter(p => p !== passer && p !== receiver),
      passer.teamId,
    );
    // Aerial passes use air-time as frame budget; flat passes use distance-based estimate.
    const targetFrames = isCross ? crossAirFrames : isLofted ? loftedAirFrames : clamp(passDist / 9.2, 18, 44);
    // Blend shortPassing↔longPassing based on distance; crosses use crossing stat; lofted uses longPassing
    const passSkill = isCross || isCutback
      ? passer.stats.crossing
      : isLofted
        ? passer.stats.longPassing
        : passDist < 160
          ? passer.stats.shortPassing
          : passDist > 280
            ? passer.stats.longPassing
            : Math.round(passer.stats.shortPassing * (280 - passDist) / 120 + passer.stats.longPassing * (passDist - 160) / 120);
    // Power accuracy: poor passers still underhit, but competent passers should send
    // the ball close enough to the planned reception point for the pass outcome logic
    // to judge the delivery, not an accidental underpowered roll.
    const statMult = 0.78 + (passSkill / 100) * 0.20;
    // Whipped Pass: harder, faster crosses and cutbacks (+0.14 power regular, +0.10 extra for Plus)
    const whippedBoost = (isCross || isCutback) ? traitBonus(passer, TRAITS.WHIPPED_PASS, 0.14, 0.10) : 0;
    const servicePower = (isCutback ? 0.96 : isThroughPass ? 1.14 : 1.0) + whippedBoost;
    const lanePowerBoost = 1 + passLane.risk * (isCross ? 0.05 : isCutback ? 0.04 : 0.09);

    const baseVelocity = passDist * (1 - BALL_FRICTION) / (1 - Math.pow(BALL_FRICTION, targetFrames));
    const power = clamp(baseVelocity * statMult * servicePower * lanePowerBoost, 2.1, 16.0);

    // Angular accuracy: same angular error = larger positional miss at distance.
    // passing reduces base error; pressure and stamina add noise; pass kind adds extra spread.
    const opponents = passer.teamId === 'teamA' ? this.teamB.players : this.teamA.players;
    let minOppDist = Infinity;
    for (const opp of opponents) {
      const d = dist(opp.x, opp.y, passer.x, passer.y);
      if (d < minOppDist) minOppDist = d;
    }
    const pressure = clamp((60 - minOppDist) / 60, 0, 1);
    // Through-pass extra error decreases with long passing: stat=60→1.30°, stat=91→0.68°, stat=100→0.5°
    const throughExtra = Math.max(0.5, 2.5 - (passer.stats.longPassing / 100) * 2.0);
    const loftedExtra = Math.max(0.4, 2.0 - traitBonus(passer, TRAITS.LONG_BALL_PASS, 0.8, 0.6));
    const kindExtra = isThroughPass ? throughExtra : isCross ? 2.5 : isCutback ? 0.5 : isLofted ? loftedExtra : 0;
    const laneExtra = passLane.risk * (isCutback ? 1.2 : 2.4) * (1 - passSkill / 140);
    const maxDevDeg = (1 - passSkill / 100) * 4.5
      + pressure * 3.5
      + (1 - passer.getStaminaFactor()) * 3.5
      + kindExtra
      + laneExtra;
    const maxDevRad = Phaser.Math.DegToRad(maxDevDeg);
    const deviation = (Math.random() - 0.5) * 2 * maxDevRad;
    const baseAngle = Math.atan2(intendedY - passer.y, intendedX - passer.x);
    const laneAvoidDeg = passLane.blocker
      ? clamp((CONTACT_RADIUS + 18 - passLane.nearestDist) / 18, 0, 1)
          * clamp(4.2 - passSkill * 0.018, 1.2, 4.2)
          * (0.6 + passLane.risk * 0.4)
      : 0;
    const actualAngle = baseAngle + deviation + Phaser.Math.DegToRad(laneAvoidDeg) * passLane.openSide;
    const destX = clamp(passer.x + Math.cos(actualAngle) * passDist, this.field.left + 15, this.field.right - 15);
    const destY = clamp(passer.y + Math.sin(actualAngle) * passDist, this.field.top  + 15, this.field.bottom - 15);
    const kickAngle = Math.atan2(destY - passer.y, destX - passer.x);

    // Lift: timing-aware interception threat. Only lift if an opponent can actually
    // reach the ball's path before it passes them — not just whether they're nearby.
    const liftOpponents = (passer.teamId === 'teamA' ? this.teamB.players : this.teamA.players)
      .filter(p => p !== receiver);
    const estimatedFrames = clamp(passDist / 9.2, 18, 44);
    const interceptionThreat = this.computeInterceptionThreat(
      passer.x, passer.y, intendedX, intendedY, liftOpponents, estimatedFrames,
      passer.stats.vision, passer.stats.reactions,
    );
    const distFraction = clamp((passDist - 120) / 290, 0, 1); // 0 at ≤120px, 1 at ≥410px
    const normalLift = clamp(0.25 + distFraction * (0.32 + interceptionThreat * 1.10), 0.22, 1.45);
    const lift = isCross ? crossLift : isLofted ? loftedLift : isThroughPass ? 2.0 : isCutback ? 0.35 : normalLift;
    // Crosses use inswinger spin; regular passes curve around lane blockers when skilled.
    const crossingSkill = passer.stats.crossing / 100;
    const crosserSide = Math.sign(passer.y - this.field.centerY) || 1;
    const inswingerSign = (-crosserSide * passer.attackDirection) as -1 | 1;
    // footSign > 0 = right foot used; footSign < 0 = left foot used.
    const footSign = crosserSide * passer.attackDirection;
    const crossOnNaturalSide = (footSign > 0 && passer.stats.preferredFoot === 1)
      || (footSign < 0 && passer.stats.preferredFoot === 2);
    const crossWeakFootFactor = crossOnNaturalSide ? 1.0 : 0.5 + (passer.stats.weakFootAbility / 5) * 0.5;
    const crossSkillBonus = (passer.stats.skillMoves / 5) * 0.030;
    const crossSpin = inswingerSign * (0.040 + power * 0.012 + crossingSkill * 0.030 + crossSkillBonus) * crossWeakFootFactor;
    // Intentional curve on regular passes: skilled passers bend the ball around a lane blocker.
    // Curve Ball: amplifies blocked-lane curve AND adds natural inswing on all passes.
    let curveSpin = 0;
    if (!isCross) {
      const spinTech = (passer.stats.vision * 0.40 + passSkill * 0.45 + (passer.stats.skillMoves / 5) * 15) / 100;
      const curveBallMult = 1 + traitBonus(passer, TRAITS.FINESSE_SHOT, 0.55, 0.45);
      if (passLane.blocker !== null && passLane.risk > 0.18) {
        curveSpin = passLane.openSide * (0.022 + spinTech * 0.062 + power * 0.004) * curveBallMult;
      } else if (curveBallMult > 1) {
        // Finesse Shot / Whipped Pass: natural inswing on every pass even with a clear lane
        curveSpin = inswingerSign * (0.014 + spinTech * 0.028 + power * 0.0018) * (curveBallMult - 1);
      }
      // Whipped Pass also adds extra inswing on top of any existing curve
      const whippedPassSpin = traitBonus(passer, TRAITS.WHIPPED_PASS, 0.018, 0.014);
      if (whippedPassSpin > 0) {
        curveSpin += inswingerSign * (whippedPassSpin + power * 0.0015);
      }
    }
    const spin = isCross ? crossSpin : curveSpin;
    this.ball.kickTo(destX, destY, power, passer.id, { lift, spin });
    const executionError = dist(intendedX, intendedY, destX, destY);
    this.ball.passAttempt = {
      id: `${passer.id}:${receiver.id}:${Math.round(this.ball.lastKickX)}:${Math.round(this.ball.lastKickY)}`,
      passerId: passer.id,
      receiverId: receiver.id,
      kind: passKind,
      intendedTarget: { x: intendedX, y: intendedY },
      actualTarget: { x: destX, y: destY },
      startedAt: { x: this.ball.lastKickX, y: this.ball.lastKickY },
      distance: passDist,
      executionError,
      pressure,
      laneRisk: passLane.risk,
      power,
    };
    this.debugCollector?.recordAction({
      player: passer,
      kind: 'pass-executed',
      reason: `${passKind} pass executed, error ${Math.round(executionError)}px, power ${power.toFixed(1)}`,
      target: { x: destX, y: destY },
      targetPlayer: receiver,
    });
    this.audio.playKick(power);
    passer.showShotPulse(this.ball.x, this.ball.y, power);
    this.ball.targetPlayer = receiver;
    receiver.state = PlayerState.ReceivePass;
    receiver.recentPassFromId = passer.id;
    receiver.recentPassCooldownMs = 1900;
    const receiverOppTeam = receiver.teamId === 'teamA' ? this.teamB : this.teamA;
    const receiverReception = planReceptionTarget(this.ball, receiver, receiverOppTeam.getNearestPlayerTo(receiver.x, receiver.y), this.field);
    receiver.setTarget(receiverReception.x, receiverReception.y);
    this.applyKickFollowThrough(passer, kickAngle, 0.75);
    const attackDir = passer.attackDirection;
    const peelSide = passer.y < this.field.centerY ? -1 : 1;
    const space = this.findOpenSpaceAfterPass(passer);
    if (space) {
      passer.setTarget(space.tx, space.ty);
      // Wall-pass positioning: outfield passers sprint into space so they're ready
      // to receive the return (1-2 combination). Skip for GK and defenders recycling.
      const isAttackingRole = passer.role === PlayerRole.Striker
        || passer.role === PlayerRole.Winger
        || passer.role === PlayerRole.Midfielder;
      const runningForward = (space.tx - passer.x) * attackDir > 40;
      if (isAttackingRole && runningForward) {
        passer.requestSprint(520, 50);
      }
    } else {
      passer.setTarget(
        clamp(passer.x - attackDir * 34, this.field.left + 15, this.field.right - 15),
        clamp(passer.y + peelSide * 78, this.field.top + 20, this.field.bottom - 20),
      );
    }
    if (isThroughPass || isCross || isCutback) receiver.requestSprint(isCross ? 650 : 900, 60);
    this.gkSystem.lastPassWasCross = isCross;
    passer.passTargetX = null;
    passer.passTargetY = null;
    passer.passKind = 'normal';

    this.scoreboard.logEvent(
      isThroughPass
        ? `${passer.playerName} enfia para ${receiver.playerName}`
        : isCross
          ? `${passer.playerName} cruza para ${receiver.playerName}`
          : isCutback
            ? `${passer.playerName} toca atrás para ${receiver.playerName}`
        : `${passer.playerName} → ${receiver.playerName}`,
    );
  }

  doShot(shooter: Player): void {
    const isTeamA = shooter.teamId === 'teamA';
    const ownTeamShooter = isTeamA ? this.teamA : this.teamB;
    const targetGoal = ownTeamShooter.attackDirection > 0 ? this.goalRight : this.goalLeft;
    const oppTeam   = isTeamA ? this.teamB  : this.teamA;
    const goalkeeper = oppTeam.players.find(p => p.role === PlayerRole.Goalkeeper);
    if (!goalkeeper) return;

    shooter.hasBall = false;
    this.ball.release();
    shooter.state = PlayerState.FindSpace;
    shooter.aiCooldown = 700;

    const shotDist = dist(shooter.x, shooter.y, targetGoal.centerX, this.field.centerY);
    const shootingSkill = shooter.stats.shotPower / 100;
    const physicalPower = shooter.stats.physical / 100;
    // Inside the box: finishing/composure; mid-range: shotPower; long: longShots blend
    const finishingSkill = shooter.stats.finishing / 100;
    const longShotSkill  = shooter.stats.longShots / 100;
    const executionSkill = shotDist < 190
      ? finishingSkill * 0.65 + shootingSkill * 0.35
      : shotDist > 250
        ? longShotSkill * 0.60 + shootingSkill * 0.40
        : shootingSkill;
    const elitePowerBonus = Math.pow(shootingSkill, 1.7) * 1.85
      + Math.pow(physicalPower, 1.45) * 1.35;
    const maxShotPower = SHOT_MAX_POWER + clamp(elitePowerBonus, 0, SHOT_ELITE_MAX_POWER_BONUS);
    const distanceFactor = clamp(
      (shotDist - SHOT_DISTANCE_POWER_START) / (SHOT_DISTANCE_POWER_FULL - SHOT_DISTANCE_POWER_START),
      0,
      1,
    );
    const powerShotBonus = traitBonus(shooter, TRAITS.POWER_SHOT, 1.0, 0.6);
    let power = clamp(
      SHOT_BASE_POWER
        + shootingSkill * SHOT_STAT_POWER
        + physicalPower * 1.15
        + distanceFactor * SHOT_DISTANCE_POWER
        + powerShotBonus,
      SHOT_MIN_POWER,
      maxShotPower + powerShotBonus,
    );

    // Pressure from nearest opponent
    const nearestOpp = oppTeam.getNearestPlayerTo(shooter.x, shooter.y);
    const normalPressure = nearestOpp
      ? clamp((60 - nearestOpp.distanceTo(shooter)) / 60, 0, 1)
      : 0;
    const gkClosePressure = clamp((155 - goalkeeper.distanceTo(shooter)) / 155, 0, 1)
      * clamp((230 - shotDist) / 230, 0, 1);
    const pressure = clamp(normalPressure + gkClosePressure * 0.85, 0, 1.35);

    // How wide the shooter's angle is: lateral/forward ratio (0=straight, >1=very wide)
    const shooterLateral = Math.abs(shooter.y - this.field.centerY);
    const shooterDepth   = Math.abs(shooter.x - targetGoal.centerX) + 1;
    const wideness = clamp(shooterLateral / shooterDepth, 0, 2.5);
    // From a tight angle only the near-post half of the goal is realistically reachable.
    // narrowFactor: 0 = straight on (full goal), 0.72 = extreme byline (near-post quarter).
    const narrowFactor = clamp((wideness - 0.4) / 1.6, 0, 0.72);
    const nearPostY = shooter.y < this.field.centerY ? targetGoal.top : targetGoal.bottom;
    const farPostY  = shooter.y < this.field.centerY ? targetGoal.bottom : targetGoal.top;
    const goalMid   = (targetGoal.top + targetGoal.bottom) / 2;
    // Compress the aim window toward the near post for wide shots
    const aimLow  = Math.min(nearPostY, farPostY) + 5 + (nearPostY > farPostY ? narrowFactor * (goalMid - targetGoal.top) : 0);
    const aimHigh = Math.max(nearPostY, farPostY) - 5 - (nearPostY < farPostY ? narrowFactor * (targetGoal.bottom - goalMid) : 0);
    // GK-aware aiming: read the open side of the goal and aim there.
    // Reactions controls how accurately the player reads the GK's position.
    const intelligenceFactor = shooter.stats.reactions / 100;
    const gkInWindow = clamp(goalkeeper.y, aimLow, aimHigh);
    const topGap = gkInWindow - aimLow;   // open space above GK
    const botGap = aimHigh - gkInWindow;  // open space below GK
    const betterTopGap = topGap >= botGap;
    const bestGap = Math.max(topGap, botGap);
    const cornerIntent = clamp(
      0.16
        + executionSkill * 0.52
        + intelligenceFactor * 0.26
        + shooter.stats.physical / 100 * 0.08
        - pressure * 0.18
        - (1 - shooter.getStaminaFactor()) * 0.38
        + traitBonus(shooter, TRAITS.LOW_DRIVEN_SHOT, 0.14, 0.10),
      0.10,
      0.92,
    );
    const minimumCornerGap = 22;
    const cornerPadding = clamp(7 + (1 - shootingSkill) * 12 + pressure * 7, 6, 24);
    const cornerOffset = clamp(
      bestGap * (1 - cornerIntent),
      cornerPadding,
      Math.max(cornerPadding, bestGap - minimumCornerGap),
    );
    const openSideAimY = betterTopGap
      ? aimLow + cornerOffset
      : aimHigh - cornerOffset;
    const centerGapAimY = betterTopGap
      ? aimLow + bestGap * 0.48
      : aimHigh - bestGap * 0.48;
    const deliberateCornerChance = clamp(
      0.18 + executionSkill * 0.50 + intelligenceFactor * 0.22 - pressure * 0.20
        + traitBonus(shooter, TRAITS.LOW_DRIVEN_SHOT, 0.15, 0.10),
      0.08,
      0.88,
    );
    const isDeliberateCorner = Math.random() < deliberateCornerChance;
    const smartAimY = isDeliberateCorner ? openSideAimY : centerGapAimY;
    // Low intelligence → drifts toward a naive random aim; high → stays on the open side
    // blendWeight: 0.18 (int=0) → 0.83 (int=100)
    const naiveAimY = aimLow + Math.random() * (aimHigh - aimLow);
    const blendWeight = clamp(0.14 + executionSkill * 0.46 + intelligenceFactor * 0.34 - pressure * 0.12, 0.12, 0.90);
    let aimY = smartAimY * blendWeight + naiveAimY * (1 - blendWeight);
    const shotBlockers = this.getAllPlayers().filter(p => p !== shooter && p !== goalkeeper);
    let selectedShotLane = this.analyzeBallLane(
      shooter.x,
      shooter.y,
      targetGoal.centerX,
      aimY,
      shotBlockers,
      shooter.teamId,
    );
    let bestAimScore = -selectedShotLane.risk * 42 - selectedShotLane.blockers * 4;
    const candidateAimYs = [
      openSideAimY,
      centerGapAimY,
      aimLow + (aimHigh - aimLow) * 0.22,
      aimLow + (aimHigh - aimLow) * 0.50,
      aimLow + (aimHigh - aimLow) * 0.78,
    ];
    for (const candidateY of candidateAimYs) {
      const candidateLane = this.analyzeBallLane(
        shooter.x,
        shooter.y,
        targetGoal.centerX,
        candidateY,
        shotBlockers,
        shooter.teamId,
      );
      const aimCost = Math.abs(candidateY - aimY) * (0.030 + (1 - executionSkill) * 0.020);
      const cornerValue = Math.abs(candidateY - goalMid) / (GOAL_HEIGHT / 2) * (4 + executionSkill * 4);
      const score = -candidateLane.risk * 42 - candidateLane.blockers * 4 - aimCost + cornerValue;
      if (score > bestAimScore) {
        bestAimScore = score;
        aimY = candidateY;
        selectedShotLane = candidateLane;
      }
    }

    // Angular accuracy: same angular error produces larger positional miss at distance
    // composure + physical reduce how much pressure disturbs the shot
    const pressureResist = clamp(
      shooter.stats.composure * 0.003 + shooter.stats.physical * 0.002,
      0, 0.40,
    );
    // Clinical: tighter finish in the box (−1.8° regular, −1.2° extra for Plus)
    const clinicalBonus = shotDist < 220 ? traitBonus(shooter, TRAITS.CLINICAL, 1.8, 1.2) : 0;
    // Long Shot: better accuracy on attempts beyond normal range (−1.4° regular, −1.0° extra for Plus)
    const longShotBonus = shotDist > 250 ? traitBonus(shooter, TRAITS.LONG_SHOT, 1.4, 1.0) : 0;
    // Low Driven Shot: precision bonus only when the player chose to go for the corner
    const lowDrivenBonus = isDeliberateCorner ? traitBonus(shooter, TRAITS.LOW_DRIVEN_SHOT, 1.2, 0.8) : 0;
    // Precision Header: shooter just won an aerial duel — directs the header with accuracy
    const headerBonus = shooter.wonAerialHeader ? traitBonus(shooter, TRAITS.PRECISION_HEADER, 1.8, 1.2) : 0;
    shooter.wonAerialHeader = false;
    const maxDevDeg = Math.max(0.4,
      (1 - executionSkill) * 7.5
      + pressure * 5.5 * (1 - pressureResist)
      + selectedShotLane.risk * 3.2 * (1 - executionSkill * 0.55)
      + (1 - shooter.getStaminaFactor()) * 4.5
      - clinicalBonus
      - longShotBonus
      - lowDrivenBonus
      - headerBonus,
    );
    const maxDevRad = Phaser.Math.DegToRad(maxDevDeg);
    const baseAngle = Math.atan2(aimY - shooter.y, targetGoal.centerX - shooter.x);
    const deviation = (Math.random() - 0.5) * 2 * maxDevRad;
    const actualY   = shooter.y + (targetGoal.centerX - shooter.x) * Math.tan(baseAngle + deviation);

    // Physical save check: can the GK cross |actualY – gk.y| before ball arrives?
    // Use actual shot distance (to actualY, not FIELD.centerY) for accuracy on corner shots.
    const actualShotDist = dist(shooter.x, shooter.y, targetGoal.centerX, actualY);
    // GK rushes at sprint speed — include stamina so tired GKs cover less ground.
    const gkSpeed = (goalkeeper.stats.sprintSpeed / 100) * 1.85 * 1.28
                  * (0.9 + goalkeeper.stats.defending / 100 * 0.2)
                  * goalkeeper.getStaminaFactor();
    const gkDistNeeded   = Math.abs(actualY - goalkeeper.y);
    const inGoal = actualY > targetGoal.top && actualY < targetGoal.bottom;
    const safeY  = clamp(actualY, this.field.top + 20, this.field.bottom - 20);
    const finalShotLane = this.analyzeBallLane(
      shooter.x,
      shooter.y,
      targetGoal.centerX,
      safeY,
      shotBlockers,
      shooter.teamId,
    );
    power = clamp(power * (1 + finalShotLane.risk * 0.06), SHOT_MIN_POWER, maxShotPower + 0.7);
    const travelFrames = actualShotDist / (power * 0.82);
    const gkCanCover = gkSpeed * travelFrames * (1 + gkClosePressure * 0.55);

    // Low Driven Shot: ball stays near the ground only when the player chose to aim for the corner
    const lowDrivenReduction = isDeliberateCorner ? traitBonus(shooter, TRAITS.LOW_DRIVEN_SHOT, 1.6, 0.8) : 0;
    const shotLift = clamp(1.0 + distanceFactor * 1.45 + finalShotLane.risk * 0.55 - lowDrivenReduction, 0.4, 3.1);
    // Spin only on angled shots — central shots go straight.
    // angleRatio: 0 when directly in front of goal, 1 when 200px+ off-center.
    // Curve Ball lowers the threshold so the trait kicks in from closer to center.
    const goalCenterY = (targetGoal.top + targetGoal.bottom) / 2;
    const angleRatio = clamp(Math.abs(shooter.y - goalCenterY) / 200, 0, 1);
    const curveBallAngleThreshold = 0.15 - traitBonus(shooter, TRAITS.FINESSE_SHOT, 0.09, 0.05);
    const curveBallSpinBonus = traitBonus(shooter, TRAITS.FINESSE_SHOT, 0.055, 0.045);
    let shotSpin = 0;
    if (angleRatio > curveBallAngleThreshold) {
      // Technique stat: longShots outside the box, blend with finishing inside.
      const spinTechSkill = shotDist > 220
        ? shooter.stats.longShots / 100
        : shooter.stats.finishing * 0.6 / 100 + shooter.stats.longShots * 0.4 / 100;
      const spinSkillBonus = (shooter.stats.skillMoves / 5) * 0.020;
      // Weak foot: same foot-side logic as crosses.
      const shooterSide = Math.sign(shooter.y - goalCenterY) || 1;
      const shotFootSign = shooterSide * shooter.attackDirection;
      const shotOnNaturalSide = (shotFootSign > 0 && shooter.stats.preferredFoot === 1)
        || (shotFootSign < 0 && shooter.stats.preferredFoot === 2);
      const shotWeakFootFactor = shotOnNaturalSide ? 1.0 : 0.5 + (shooter.stats.weakFootAbility / 5) * 0.5;
      shotSpin = finalShotLane.openSide
        * (0.035 + power * 0.010 + spinTechSkill * 0.025 + spinSkillBonus + curveBallSpinBonus)
        * angleRatio * shotWeakFootFactor;
    }
    this.ball.kickTo(targetGoal.centerX, safeY, inGoal ? power : power * 0.9, shooter.id, {
      lift: shotLift,
      spin: shotSpin,
    });
    this.ball.shotAttempt = {
      id: `${shooter.id}:${Math.round(this.ball.lastKickX)}:${Math.round(this.ball.lastKickY)}`,
      shooterId: shooter.id,
      teamId: shooter.teamId,
      targetGoalX: targetGoal.centerX,
      intendedTarget: { x: targetGoal.centerX, y: aimY },
      actualTarget: { x: targetGoal.centerX, y: actualY },
      startedAt: { x: this.ball.lastKickX, y: this.ball.lastKickY },
      distance: actualShotDist,
      onTarget: inGoal,
      power,
      result: inGoal ? null : 'Missed',
    };
    this.debugCollector?.recordAction({
      player: shooter,
      kind: 'shot-executed',
      reason: `shot ${inGoal ? 'on target' : 'off target'}, power ${power.toFixed(1)}`,
      target: { x: targetGoal.centerX, y: safeY },
      targetPlayer: goalkeeper,
    });
    if (!inGoal) {
      this.debugCollector?.recordAction({
        player: shooter,
        kind: 'shot-missed',
        reason: `shot missed the goal at y=${Math.round(actualY)}`,
        target: { x: targetGoal.centerX, y: safeY },
        targetPlayer: goalkeeper,
      });
    }
    this.audio.playKick(power);
    this.gkSystem.gkDiveHoldoffMs = 18;
    this.applyKickFollowThrough(shooter, Math.atan2(safeY - shooter.y, targetGoal.centerX - shooter.x), 1.05);
    shooter.showShotPulse(this.ball.x, this.ball.y, power);

    const easySaveRange = 24 + (gkShotStoppingQuality(goalkeeper) / 100) * 18;
    const normalSave = inGoal && gkDistNeeded < Math.min(gkCanCover, easySaveRange);
    this.stats.recordShot(shooter.teamId, inGoal, false);

    if (normalSave) {
      // saveX anchored to the GK's CURRENT position (not baseX) so the dive is purely lateral.
      const saveX  = clamp(goalkeeper.x, this.field.left + 15, this.field.right - 15);
      const saveY = clamp(actualY, targetGoal.top + 10, targetGoal.bottom - 10);
      this.ball.targetPlayer = goalkeeper;
      goalkeeper.stretchSave = false;
      goalkeeper.state = PlayerState.ReceivePass;
      goalkeeper.setTarget(saveX, saveY);
      goalkeeper.requestSprint(travelFrames * 16.67 + 500);

      this.scoreboard.logEvent(`${shooter.playerName} chuta — Defesa!`);
    } else if (inGoal) {
      this.scoreboard.logEvent(`${shooter.playerName} chuta!`);
    } else {
      this.scoreboard.logEvent(`${shooter.playerName} chuta — Fora!`);
    }
  }

  doClearance(gk: Player): void {
    gk.hasBall = false;
    this.ball.release();
    gk.state = PlayerState.ReturnToShape;
    gk.aiCooldown = 900;

    const isTeamA = gk.teamId === 'teamA';
    const ownTeam = isTeamA ? this.teamA : this.teamB;
    const oppTeam = isTeamA ? this.teamB : this.teamA;
    const dir     = ownTeam.attackDirection; // forward direction (changes after halftime swap)

    const controlledOutlet = this.gkSystem.findGkControlledOutlet(gk, ownTeam, oppTeam, dir);
    if (controlledOutlet) {
      const { target, blocker } = controlledOutlet;
      const passErr = 1 - gk.stats.shortPassing / 100;
      const maxOff = passErr * 34 + 16;
      const destX = clamp(target.x + (Math.random() - 0.5) * maxOff, this.field.left + 15, this.field.right - 15);
      const destY = clamp(target.y + (Math.random() - 0.5) * maxOff * 1.25, this.field.top + 15, this.field.bottom - 15);
      const kickDist = dist(gk.x, gk.y, destX, destY);
      const power = clamp(3.1 + kickDist / 92 + (gk.stats.longPassing / 100) * 1.4, 3.8, 8.4);

      this.ball.targetPlayer = target;
      this.ball.kickTo(destX, destY, power, gk.id, {
        lift: blocker ? 2.8 : 1.2,
        spin: 0,
      });
      this.debugCollector?.recordAction({
        player: gk,
        kind: 'clearance-executed',
        reason: `controlled GK outlet, power ${power.toFixed(1)}`,
        target: { x: destX, y: destY },
        targetPlayer: target,
      });
      this.audio.playKick(power);
      target.state = PlayerState.ReceivePass;
      const reception = planReceptionTarget(this.ball, target, oppTeam.getNearestPlayerTo(target.x, target.y), this.field);
      target.setTarget(reception.x, reception.y);
      gk.showShotPulse(this.ball.x, this.ball.y, power);
      if (blocker) this.ball.preventPickup(blocker.id, 400);
      this.applyKickFollowThrough(gk, Math.atan2(destY - gk.y, destX - gk.x), 0.85);
      this.scoreboard.logEvent(`${gk.playerName} sai jogando!`);
      return;
    }

    // Returns the closest opponent blocking the kick lane within 120 px of the GK,
    // or null if the lane is clear. Beyond 120 px a lofted kick clears any blocker.
    const findLaneBlocker = (tx: number, ty: number): Player | null => {
      const ldx = tx - gk.x, ldy = ty - gk.y;
      const lenSq = ldx * ldx + ldy * ldy;
      if (lenSq < 1) return null;
      let nearest: Player | null = null;
      let nearestDist = Infinity;
      for (const opp of oppTeam.players) {
        const od = dist(gk.x, gk.y, opp.x, opp.y);
        if (od > 120) continue;
        const t = clamp(((opp.x - gk.x) * ldx + (opp.y - gk.y) * ldy) / lenSq, 0, 1);
        const cx = gk.x + ldx * t, cy = gk.y + ldy * t;
        if (dist(opp.x, opp.y, cx, cy) < 30 && od < nearestDist) {
          nearest = opp; nearestDist = od;
        }
      }
      return nearest;
    };

    // Chance the GK lofts the ball over a blocker.
    // Scales with blocker distance (closer = harder) and GK passing stat.
    const loftChance = (blocker: Player): number => {
      const d = dist(gk.x, gk.y, blocker.x, blocker.y);
      const distFactor = clamp((d - 15) / 105, 0, 1); // 0 at ≤15 px, 1 at ≥120 px
      return distFactor * 0.50 + (gk.stats.longPassing / 100) * 0.45;
    };

    // Find the most advanced free midfielder/striker — loft over nearby blockers when able
    let clearTarget: Player | null = null;
    let clearTargetBlocker: Player | null = null;
    let bestAdvance = -Infinity;
    for (const p of ownTeam.players) {
      if (p.role === PlayerRole.Goalkeeper || p.role === PlayerRole.Defender) continue;
      const advance = p.x * dir;
      const nearOpp = oppTeam.getNearestPlayerTo(p.x, p.y);
      if (nearOpp && nearOpp.distanceTo(p) < 55) continue; // too marked
      const blocker = findLaneBlocker(p.x, p.y);
      if (blocker && Math.random() >= loftChance(blocker)) continue; // failed to loft
      if (advance > bestAdvance) {
        bestAdvance = advance;
        clearTarget = p;
        clearTargetBlocker = blocker ?? null;
      }
    }

    const passErr  = 1 - gk.stats.longPassing / 100;
    const maxOff   = passErr * 70 + 55; // clearances always carry some spread

    let destX: number;
    let destY: number;

    if (clearTarget) {
      const ox = (Math.random() - 0.5) * maxOff;
      const oy = (Math.random() - 0.5) * maxOff * 1.4;
      destX = clamp(clearTarget.x + ox, this.field.left + 15, this.field.right - 15);
      destY = clamp(clearTarget.y + oy, this.field.top  + 15, this.field.bottom - 15);
      clearTarget.state = PlayerState.ReceivePass;
      this.ball.targetPlayer = clearTarget;
    } else {
      // No free target — boot to flank, angled away from nearest pressing opponent
      const pressOpp = oppTeam.getNearestPlayerTo(gk.x, gk.y);
      const sideShift = pressOpp && Math.abs(pressOpp.y - gk.y) < 80
        ? (pressOpp.y > gk.y ? -130 : 130)   // kick to opposite flank from presser
        : (Math.random() > 0.5 ? 100 : -100); // random flank when presser is off-center
      const oy = sideShift + (Math.random() - 0.5) * maxOff;
      destX = clamp(this.field.centerX + dir * 80, this.field.left + 15, this.field.right - 15);
      destY = clamp(this.field.centerY + oy, this.field.top + 15, this.field.bottom - 15);
    }

    const power = CLEARANCE_BASE_POWER + (gk.stats.longPassing / 100) * CLEARANCE_STAT_POWER;
    this.ball.kickTo(destX, destY, power, gk.id, {
      lift: clearTargetBlocker ? 4.2 : 3.4,
      spin: 0,
    });
    this.debugCollector?.recordAction({
      player: gk,
      kind: 'clearance-executed',
      reason: clearTarget ? `long distribution, power ${power.toFixed(1)}` : `clearance to space, power ${power.toFixed(1)}`,
      target: { x: destX, y: destY },
      targetPlayer: clearTarget,
    });
    this.audio.playKick(power);
    if (clearTarget) {
      const reception = planReceptionTarget(this.ball, clearTarget, oppTeam.getNearestPlayerTo(clearTarget.x, clearTarget.y), this.field);
      clearTarget.setTarget(reception.x, reception.y);
    }
    gk.showShotPulse(this.ball.x, this.ball.y, power);
    // If the GK lofted over a blocker, block that player from immediately
    // intercepting without replacing the GK as the recent kicker.
    if (clearTargetBlocker) this.ball.preventPickup(clearTargetBlocker.id, 400);
    this.applyKickFollowThrough(gk, Math.atan2(destY - gk.y, destX - gk.x), 0.85);
    this.scoreboard.logEvent(`${gk.playerName} distribui!`);
  }

  doParry(gk: Player): void {
    // Better GKs push rebounds wide; weak GKs spill more centrally and unpredictably.
    const dir = gk.attackDirection;
    const quality = gkShotStoppingQuality(gk) / 100;
    const awaySide = Math.abs(gk.y - this.field.centerY) < 18
      ? (Math.random() < 0.5 ? -1 : 1)
      : (gk.y < this.field.centerY ? -1 : 1);
    const controlledWide = awaySide * (0.28 + quality * 0.72);
    const randomSpread = (Math.random() - 0.5) * (1.9 - quality * 1.35);
    const outAngle = Math.atan2(controlledWide + randomSpread, dir);
    const power = 2.2 + quality * 2.4 + Math.random() * (2.4 - quality * 1.1);
    const distance = 58 + quality * 62;
    const destX = clamp(gk.x + Math.cos(outAngle) * distance, this.field.left + 15, this.field.right - 15);
    const destY = clamp(gk.y + Math.sin(outAngle) * distance, this.field.top  + 15, this.field.bottom - 15);
    this.ball.kickTo(destX, destY, power, gk.id, {
      lift: 1.7 + (1 - quality) * 0.7,
      spin: awaySide * (0.060 + power * 0.016),
    });
    this.recalculateRoutes();
  }

  applyKickFollowThrough(player: Player, angle: number, impulse: number): void {
    const targetDistance = 38 + player.stats.sprintSpeed * 0.22;
    player.vx += Math.cos(angle) * impulse;
    player.vy += Math.sin(angle) * impulse;
    player.setTarget(
      clamp(player.x + Math.cos(angle) * targetDistance, this.field.left + 15, this.field.right - 15),
      clamp(player.y + Math.sin(angle) * targetDistance, this.field.top + 20, this.field.bottom - 20),
    );
  }

  applyFirstTouchMovement(player: Player, nearestOpp: Player | null): void {
    const attackDir = player.attackDirection;
    if (nearestOpp && nearestOpp.distanceTo(player) < 75) {
      const dx = player.x - nearestOpp.x;
      const dy = player.y - nearestOpp.y;
      const dlen = Math.sqrt(dx * dx + dy * dy) || 1;
      player.setTarget(
        clamp(player.x + (dx / dlen) * 28 + attackDir * 10, this.field.left + 15, this.field.right - 15),
        clamp(player.y + (dy / dlen) * 20, this.field.top + 15, this.field.bottom - 15),
      );
      player.vx += ((dx / dlen) * 0.85 + attackDir * 0.25) * player.getStaminaFactor();
      player.vy += (dy / dlen) * 0.65 * player.getStaminaFactor();
    } else {
      player.setTarget(
        clamp(player.x + attackDir * 26, this.field.left + 15, this.field.right - 15),
        player.y,
      );
      player.vx += attackDir * 0.9 * player.getStaminaFactor();
    }
    if (player.currentStamina > 18) player.forceSprint(180);
  }

  applyFailedFirstTouchDeflection(player: Player): void {
    const speed = this.ball.getSpeed();
    const incomingX = speed > 0.05 ? this.ball.velocity.x / speed : player.attackDirection;
    const incomingY = speed > 0.05 ? this.ball.velocity.y / speed : 0;
    const lateralX = -incomingY;
    const lateralY = incomingX;

    const cushion = 0.16 + Math.random() * 0.30;
    const carryOn = clamp(speed * cushion, 0.55, 3.4);
    const heavyTouch = Math.random() < clamp((speed - 4.0) / 8.0, 0.08, 0.36);
    const extraPush = heavyTouch ? 0.6 + Math.random() * 1.2 : Math.random() * 0.35;
    const touchNoise = (Math.random() - 0.5) * (1.1 + speed * 0.10);

    this.ball.velocity.x = incomingX * (carryOn + extraPush) + lateralX * touchNoise;
    this.ball.velocity.y = incomingY * (carryOn + extraPush) + lateralY * touchNoise;
    this.ball.markTouchedBy(player.id, 260);
  }

  settleTime(player: Player, nearestOpp: Player | null): number {
    const skill = (player.stats.dribbling * 0.6 + player.stats.reactions * 0.4) / 100; // 0–1
    const oppDist = nearestOpp ? nearestOpp.distanceTo(player) : 999;
    const pressure = clamp((85 - oppDist) / 85, 0, 1); // 0 = free, 1 = opponent right on you
    const base = 220 - skill * 165;           // 55 ms (elite) to 220 ms (poor)
    const urgency = pressure * 85;            // up to 85 ms faster under pressure
    const noise = (Math.random() - 0.5) * 44; // +/-22 ms variation, less visible stutter
    return clamp(Math.round(base - urgency + noise), 20, 260);
  }

  private findOpenSpaceAfterPass(player: Player): { tx: number; ty: number } | null {
    const ownTeam = player.teamId === 'teamA' ? this.teamA : this.teamB;
    const oppTeam = player.teamId === 'teamA' ? this.teamB : this.teamA;
    const ownGoal = player.teamId === 'teamA' ? this.goalLeft : this.goalRight;
    const oppGoal = player.teamId === 'teamA' ? this.goalRight : this.goalLeft;
    const ctx: AIContext = {
      ball: this.ball,
      ownTeam,
      oppTeam,
      ownGoal,
      oppGoal,
      field: this.field,
    };
    return findAttackingOpenSpace(player, ctx);
  }

  // Returns 0–1: how likely an opponent intercepts this pass given ball travel timing.
  // Passer perception is imperfect: low vision assumes a generic average speed for all
  // opponents; high vision + reactions reads each opponent more accurately.
  private computeInterceptionThreat(
    fromX: number, fromY: number,
    toX: number, toY: number,
    opponents: Player[],
    ballTotalFrames: number,
    passerVision: number,
    passerReactions: number,
  ): number {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1) return 0;

    // perception 0–1: how accurately the passer reads opponent movement capability.
    // vision=30+reactions=30 → ~0.32; vision=70+reactions=70 → ~0.62; both=90 → ~0.77
    const perception = clamp((passerVision * 0.55 + passerReactions * 0.45) / 100, 0.20, 0.85);

    // Assumed opponent speed when perception is low: ~68% of max sprint (generic average).
    // Better perception blends toward each opponent's real speed.
    const baselineSpeed = 1.85 * 0.68;

    let maxThreat = 0;

    for (const opp of opponents) {
      const relX = opp.x - fromX;
      const relY = opp.y - fromY;
      const t = (relX * dx + relY * dy) / lenSq;
      if (t < 0.05 || t > 0.95) continue;

      // Perpendicular distance from opponent to the pass line
      const closestX = fromX + t * dx;
      const closestY = fromY + t * dy;
      const lateralDist = dist(opp.x, opp.y, closestX, closestY);

      // Frames until ball reaches this projection point
      const framesUntil = t * ballTotalFrames;

      // Perceived opponent speed: blend between generic baseline and actual speed
      const actualSpeed = (opp.stats.sprintSpeed / 100) * 1.85 * opp.getStaminaFactor();
      const perceivedSpeed = baselineSpeed + (actualSpeed - baselineSpeed) * perception;

      // Reaction lag also perceived imprecisely: low vision assumes more lag (easier to ignore)
      const perceivedReactionFrames = 4 + (1 - perception) * 4; // 4–8 frames
      const reachable = perceivedSpeed * Math.max(0, framesUntil - perceivedReactionFrames);

      // Threat only if the opponent can physically close the lateral gap.
      // Use half the contact radius as clearance — avoids flagging opponents who are
      // barely reachable in theory but would never actually get there in time.
      const margin = reachable + CONTACT_RADIUS * 0.5 - lateralDist;
      if (margin > 0) {
        const threat = clamp(margin / (CONTACT_RADIUS * 2.5), 0, 1);
        if (threat > maxThreat) maxThreat = threat;
      }
    }

    return maxThreat;
  }

  private analyzeBallLane(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    players: Player[],
    owningTeamId: string,
  ): BallLaneAnalysis {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 0.001) {
      return {
        risk: 0,
        blockers: 0,
        nearestDist: Infinity,
        blocker: null,
        blockerT: 0,
        openSide: 1,
      };
    }

    const len = Math.sqrt(lenSq);
    const perpX = -dy / len;
    const perpY = dx / len;
    let risk = 0;
    let blockers = 0;
    let nearestDist = Infinity;
    let blocker: Player | null = null;
    let blockerT = 0;
    let openSide: -1 | 1 = 1;

    for (const player of players) {
      const relX = player.x - fromX;
      const relY = player.y - fromY;
      const t = (relX * dx + relY * dy) / lenSq;
      if (t < 0.07 || t > 0.98) continue;

      const laneDist = distancePointToSegment(player.x, player.y, fromX, fromY, toX, toY);
      const lateralSpeed = Math.abs(player.vx * perpX + player.vy * perpY);
      const blockReach = player.teamId !== owningTeamId ? traitBonus(player, TRAITS.BLOCK, 5, 3) : 0;
      const dangerRadius = CONTACT_RADIUS + 5 + clamp(lateralSpeed * 3.0, 0, 10) + blockReach;
      const warningRadius = dangerRadius + 18;
      if (laneDist > warningRadius) continue;

      blockers++;
      const closeness = clamp((warningRadius - laneDist) / Math.max(warningRadius - dangerRadius + 1, 1), 0, 1);
      const opponentWeight = player.teamId === owningTeamId ? 0.55 : 1.0;
      const roleWeight = player.role === PlayerRole.Goalkeeper ? 1.12 : 1.0;
      const pathWeight = 1 - t * 0.28;
      risk = Math.max(risk, closeness * opponentWeight * roleWeight * pathWeight);

      if (laneDist < nearestDist) {
        nearestDist = laneDist;
        blocker = player;
        blockerT = t;
        const lateral = relX * perpX + relY * perpY;
        openSide = lateral >= 0 ? -1 : 1;
      }
    }

    return {
      risk: clamp(risk, 0, 1),
      blockers,
      nearestDist,
      blocker,
      blockerT,
      openSide,
    };
  }
}


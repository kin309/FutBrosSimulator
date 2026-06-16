import { Player } from '../entities/Player';
import { Ball } from '../entities/Ball';
import { Team } from '../entities/Team';
import { traitBonus, TRAITS } from '../data/PlayerTraits';
import { PlayerState } from '../data/PlayerState';
import { PlayerRole } from '../data/PlayerRole';
import { GoalBounds, FieldBounds } from '../types';
import { dist, clamp, distancePointToSegment } from '../utils/MathUtils';
import { TacticalDirective } from './TacticalAI';
import { FieldHeatMap } from './FieldHeatMap';
import { TacticalProfile } from '../data/TacticalProfile';
import {
  PlayerInstructions,
  attackSupportMultiplier,
  pressRangeMultiplier,
  shootRangeBonus,
  dribbleAbilityMult,
  passAdvantageBonus,
  crossThresholdBonus,
  positioningPull,
} from '../data/PlayerInstructions';
import { projectBallWithBounce } from '../physics/BallProjection';

export interface AIContext {
  ball: Ball;
  ownTeam: Team;
  oppTeam: Team;
  ownGoal: GoalBounds;
  oppGoal: GoalBounds;
  field: FieldBounds;
  directive?: TacticalDirective;
  heatMap?: FieldHeatMap;
  tacticalProfile?: TacticalProfile;
  /** Instruções individuais por jogador (chave: player.id) */
  playerInstructions?: Map<string, PlayerInstructions>;
}

// ─── With-ball decisions ──────────────────────────────────────────────────────

export function computeGoalViewAngle(x: number, y: number, ctx: AIContext): number {
  const a = Math.atan2(ctx.oppGoal.top - y, ctx.oppGoal.centerX - x);
  const b = Math.atan2(ctx.oppGoal.bottom - y, ctx.oppGoal.centerX - x);
  let diff = Math.abs(a - b);
  if (diff > Math.PI) diff = Math.PI * 2 - diff;
  return diff;
}

export function canShoot(player: Player, ctx: AIContext): boolean {
  const d = dist(player.x, player.y, ctx.oppGoal.centerX, ctx.field.centerY);
  // Long Shot: attempts from further out (+55px regular, +35px extra for Plus)
  // longShotWeight > 0.25 (neutral) expands the maximum range — Park-the-Bus chuta de longe mais
  // shootRangeBonus: instrução individual 'Finalizar mais' adiciona +50px
  const longShotRange = traitBonus(player, TRAITS.LONG_SHOT, 55, 35);
  const tacticalLongShotBonus = ((ctx.tacticalProfile?.longShotWeight ?? 0.25) - 0.25) * 80;
  const instrShootBonus = shootRangeBonus(ctx.playerInstructions?.get(player.id));
  if (d > 335 + longShotRange + tacticalLongShotBonus + instrShootBonus) return false;
  // Poor finishers only attempt from close range: fin=40 → max 175px, fin=90 → max 335px
  const maxRangeForSkill = 85 + player.stats.finishing * 2.5 + longShotRange;
  if (d > maxRangeForSkill) return false;
  const nearestOpp = ctx.oppTeam.getNearestPlayerTo(player.x, player.y);
  if (nearestOpp && nearestOpp.distanceTo(player) < 35) return false;
  // Angle check: extreme byline shots are blocked; narrow angles need shooting skill
  // angle < 0.13 rad (~7°): never shoot regardless of skill
  // angle 0.13–0.26 rad: needs shooting 80 → 50 (scales linearly)
  const angle = computeGoalViewAngle(player.x, player.y, ctx);
  if (angle < 0.13) return false;
  if (angle < 0.26) {
    const minSkill = 80 - clamp((angle - 0.13) / 0.13, 0, 1) * 30;
    if (player.stats.finishing < minSkill) return false;
  }
  return true;
}

export function evaluatePassOption(
  passer: Player,
  receiver: Player,
  opponents: Player[],
  oppGoalX: number,
  receiverHeat = 0,
  possessionBias = 0,
  shortPassPreference = 0.4,
): number {
  const d = dist(passer.x, passer.y, receiver.x, receiver.y);
  if (d > 540 || d < 30) return 0;

  let nearestOppDist = Infinity;
  let laneBlock = Infinity;
  for (const opp of opponents) {
    const od = dist(opp.x, opp.y, receiver.x, receiver.y);
    if (od < nearestOppDist) nearestOppDist = od;
    if (opp.role !== PlayerRole.Goalkeeper) {
      const ld = distancePointToSegment(opp.x, opp.y, passer.x, passer.y, receiver.x, receiver.y);
      if (ld < laneBlock) laneBlock = ld;
    }
  }

  // High shortPassPreference penalizes long passes more; low values favor direct balls
  const distScale = 0.5 + shortPassPreference; // 0.1→0.6  0.4→0.9  0.9→1.4
  const distPenalty = clamp((d - 250) / 320, 0, 1) * 17 * distScale;
  const pressPenalty = clamp((80 - nearestOppDist) / 80, 0, 1) * 25;
  const lanePenalty = clamp((46 - laneBlock) / 46, 0, 1) * 34;
  const laneBonus = clamp((laneBlock - 54) / 90, 0, 1) * 12;

  const attackDir = oppGoalX > 500 ? 1 : -1;
  const progress = (receiver.x - passer.x) * attackDir;
  const progressBonus = clamp(progress / 10, -5, 10);
  const shortPenaltyScale = 1 - possessionBias * 0.7;
  const shortPassPenalty = d < 95 && progress < 35
    ? (clamp((95 - d) / 65, 0, 1) * 28 + clamp((35 - progress) / 55, 0, 1) * 18) * shortPenaltyScale
    : 0;
  // Wall pass (parede): when the receiver just passed to the passer and the passer has
  // run forward into open space, turn the return penalty into a bonus — this rewards
  // the 1-2 combination instead of punishing it.
  const recentlyReceivedFromReceiver = passer.recentPassFromId === receiver.id && passer.recentPassCooldownMs > 0;
  const isWallPass = recentlyReceivedFromReceiver && progress > 60;
  const returnPenaltyScale = 1 - possessionBias * 0.6;
  const immediateReturnPenalty = recentlyReceivedFromReceiver && !isWallPass
    ? (progress < 55 ? 42 : 18) * returnPenaltyScale
    : 0;
  const wallPassBonus = isWallPass ? 26 : 0;

  // Congestion penalty: avoid passing into zones crowded by own teammates.
  // Forward passes (progress > 60 px) get a 65 % discount so attacking runs
  // into occupied areas aren't unfairly punished — defenders converge there too,
  // making the opponent press penalty already reflect real danger.
  const heatPenalty = receiverHeat > 0
    ? clamp(receiverHeat / 3.5, 0, 1) * 14 * (progress > 60 ? 0.35 : 1.0)
    : 0;

  // Backward ball: Strikers and Wingers should not route the ball back to the defensive line.
  // A progressive penalty kicks in past 50 px backward so the option scores below the
  // selection threshold, pushing the attacker toward ProtectBall instead of booting it back.
  const backwardBallPenalty = progress < -50
    && (passer.role === PlayerRole.Striker || passer.role === PlayerRole.Winger)
    ? clamp((-progress - 50) / 120, 0, 1) * 55
    : 0;

  // Free space bonus: a receiver with a lot of room (80px+) is a prime outlet — scale up
  // proportionally so very free options clearly stand out from barely-free ones.
  const freeSpaceBonus = nearestOppDist > 80 ? clamp((nearestOppDist - 80) / 160, 0, 1) * 16 : 0;

  // Tired passers make noisier evaluations — kept subtle so fatigue doesn't cause random bad choices
  const staminaNoise = (1 - passer.getStaminaFactor()) * (Math.random() * 10 - 3);
  // Low composure adds decision error independent of fatigue (pressure situations, temperament)
  const composureNoise = (1 - passer.stats.composure / 100) * (Math.random() * 8 - 3);

  return receiver.stats.reactions * 0.4
    + passer.stats.shortPassing * 0.14 + passer.stats.longPassing * 0.14
    + passer.stats.vision * 0.22   // vision: seeing the right option, passing: executing it
    + progressBonus
    + laneBonus
    + wallPassBonus
    + freeSpaceBonus
    - distPenalty
    - pressPenalty
    - lanePenalty
    - shortPassPenalty
    - immediateReturnPenalty
    - heatPenalty
    - backwardBallPenalty
    + staminaNoise
    + composureNoise;
}

// When GK is under pressure, smart GKs (passing+intelligence avg > 55) look for a nearby
// defender whose passing lane is not blocked by the presser, avoiding kicking into them.
function findGkPressurePassTarget(gk: Player, ctx: AIContext, presser: Player): Player | null {
  const smartness = (gk.stats.shortPassing + gk.stats.reactions) / 2;
  if (smartness < 55) return null;

  let best: Player | null = null;
  let bestScore = -Infinity;

  for (const p of ctx.ownTeam.players) {
    if (p === gk || p.role === PlayerRole.Goalkeeper) continue;
    const isDefender = p.role === PlayerRole.Defender;
    const isMid = p.role === PlayerRole.Midfielder || p.role === PlayerRole.Winger;
    if (!isDefender && !isMid) continue;

    const d = dist(gk.x, gk.y, p.x, p.y);
    if (d > (isDefender ? 255 : 315) || d < 20) continue;

    // Reject if the presser is sitting in the passing lane
    if (distancePointToSegment(presser.x, presser.y, gk.x, gk.y, p.x, p.y) < 34) continue;

    const nearOpp = ctx.oppTeam.getNearestPlayerTo(p.x, p.y);
    const nearOppDist = nearOpp ? nearOpp.distanceTo(p) : 999;
    const minSpace = isDefender ? 38 : 52;
    if (nearOppDist < minSpace) continue;

    const roleBonus = isDefender ? 18 : 6;
    const progress = (p.x - gk.x) * ctx.ownTeam.attackDirection;
    const score = nearOppDist * 0.35 - d * 0.16 + smartness * 0.08 + roleBonus + clamp(progress / 180, -0.3, 1) * 10;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// GK distributes to the best unmarked outfield player — defenders preferred (shorter range,
// lower marking threshold) with midfielders as fallback when defenders are all covered.
function findGkPassTarget(gk: Player, ctx: AIContext): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  const composure = gkDistributionQuality(gk);
  for (const p of ctx.ownTeam.players) {
    if (p === gk || p.role === PlayerRole.Goalkeeper) continue;

    const isDefender = p.role === PlayerRole.Defender;
    const reachMult = 0.78 + (composure / 100) * 0.35;
    const maxDist = (isDefender ? 230 : 310) * reachMult;
    const markingThreshold = (isDefender ? 45 : 65) + clamp(65 - composure, 0, 35) * 0.35;
    const roleBonus = isDefender ? 18 : 0; // prefer short safe pass to defender

    const d = dist(gk.x, gk.y, p.x, p.y);
    if (d > maxDist || d < 25) continue;

    const nearestOpp = ctx.oppTeam.getNearestPlayerTo(p.x, p.y);
    const nearOppDist = nearestOpp ? nearestOpp.distanceTo(p) : 999;
    if (nearOppDist < markingThreshold) continue;

    const score = nearOppDist * 0.4
      - d * 0.25
      + p.stats.vision * 0.15
      + roleBonus
      + composure * 0.08;
    if (score > bestScore) { bestScore = score; best = p; }
  }

  const threshold = 32 + clamp(60 - composure, 0, 40) * 0.45;
  return bestScore > threshold ? best : null;
}

export function findBestPassTarget(player: Player, ctx: AIContext): Player | null {
  const teammates = ctx.ownTeam.players.filter(p => p !== player);
  const opponents = ctx.oppTeam.players;
  const teamIdx = player.teamId === 'teamA' ? 0 : 1;
  const bias = ctx.tacticalProfile?.possessionBias ?? 0;
  const spref = ctx.tacticalProfile?.shortPassPreference ?? 0.4;
  let best: Player | null = null;
  // Defenders/GKs accept lower-quality passes. Possession style also lowers the threshold.
  const baseMin = player.role === PlayerRole.Defender || player.role === PlayerRole.Goalkeeper ? 8 : 30;
  const minScore = baseMin - bias * 18;
  let bestScore = minScore;
  // Vision factor: high-vision passers better recognise danger positions (0.4→1.3 range)
  const visionFactor = 0.4 + (player.stats.vision / 100) * 0.9;
  const goalHalfH = (ctx.oppGoal.bottom - ctx.oppGoal.top) / 2;
  for (const receiver of teammates) {
    const receiverHeat = ctx.heatMap?.getHeat(receiver.x, receiver.y, teamIdx) ?? 0;
    let score = evaluatePassOption(player, receiver, opponents, ctx.oppGoal.centerX, receiverHeat, bias, spref);

    // Danger position bonus: receiver free AND in a threatening area near the opponent goal.
    // computeGoalViewAngle approximated inline to avoid passing ctx — uses goal top/bottom.
    const goalDist = Math.abs(receiver.x - ctx.oppGoal.centerX);
    if (goalDist < 320 && receiver.role !== PlayerRole.Goalkeeper) {
      const shotAngle = 2 * Math.atan2(goalHalfH, goalDist + 1);
      if (shotAngle > 0.16) {
        const nearestToReceiver = ctx.oppTeam.getNearestPlayerTo(receiver.x, receiver.y);
        const freedom = nearestToReceiver ? dist(nearestToReceiver.x, nearestToReceiver.y, receiver.x, receiver.y) : 999;
        if (freedom > 55) {
          const dangerBonus = clamp((freedom - 55) / 130, 0, 1)
            * clamp(shotAngle / 0.65, 0, 1)
            * clamp((320 - goalDist) / 320, 0, 1)
            * 32 * visionFactor;
          score += dangerBonus;
        }
      }
    }

    if (score > bestScore) { bestScore = score; best = receiver; }
  }
  return best;
}

interface ThroughPassOption {
  receiver: Player;
  tx: number;
  ty: number;
  score: number;
}

interface ServicePassOption {
  receiver: Player;
  tx: number;
  ty: number;
  score: number;
  kind: 'cross' | 'cutback';
}

function findBestThroughPassOption(player: Player, ctx: AIContext): ThroughPassOption | null {
  const dir = ctx.ownTeam.attackDirection;
  let best: ThroughPassOption | null = null;

  // Find last outfield defender for offside check (most advanced toward opponent goal)
  let lastDefenderX = ctx.oppGoal.centerX;
  for (const opp of ctx.oppTeam.players) {
    if (opp.role === PlayerRole.Goalkeeper) continue;
    if ((opp.x - lastDefenderX) * dir < 0) lastDefenderX = opp.x;
  }

  for (const receiver of ctx.ownTeam.players) {
    if (receiver === player || receiver.role === PlayerRole.Goalkeeper || receiver.role === PlayerRole.Defender) {
      continue;
    }

    const receiverAhead = (receiver.x - player.x) * dir;
    // Vision extends how far ahead a passer can spot a runner: vision=60→360px, vision=91→392px
    const lookRange = 300 + (player.stats.vision / 100) * 90;
    if (receiverAhead < 15 || receiverAhead > lookRange) continue;

    // Offside: skip if receiver is already past the last outfield defender at kick moment
    if ((receiver.x - lastDefenderX) * dir > 5) continue;

    // Dynamic lead: estimate where the receiver will be when the ball arrives.
    // Approximate ball travel time from passer to receiver's current position, then
    // project receiver forward using their current velocity plus sprint acceleration.
    const roughDist = dist(player.x, player.y, receiver.x, receiver.y);
    const approxFrames = clamp(roughDist / 10.2, 18, 48);
    const fwdVel = Math.max(0, receiver.vx * dir);
    // Lead distance uses acceleration (burst off the line) rather than top-end speed
    const sprintSpeed = (0.55 + (receiver.stats.acceleration / 100) * 0.45) * 1.85 * 1.28;
    // 0.38 factor accounts for acceleration ramp from current velocity toward sprint speed
    const lead = clamp(
      fwdVel * approxFrames + (sprintSpeed - fwdVel) * approxFrames * 0.38,
      28,
      140,
    );

    const centerPull = (ctx.field.centerY - receiver.y) * (receiver.role === PlayerRole.Striker ? 0.16 : 0.06);
    const tx = clamp(receiver.x + dir * lead, ctx.field.left + 24, ctx.field.right - 24);
    const ty = clamp(receiver.y + centerPull, ctx.field.top + 28, ctx.field.bottom - 28);
    const passDistance = dist(player.x, player.y, tx, ty);
    if (passDistance < 130 || passDistance > 610) continue;

    let nearestToTarget = Infinity;
    let nearestBehindReceiver = Infinity;
    for (const opp of ctx.oppTeam.players) {
      if (opp.role === PlayerRole.Goalkeeper) continue;
      const targetDist = dist(opp.x, opp.y, tx, ty);
      if (targetDist < nearestToTarget) nearestToTarget = targetDist;

      const behindReceiver = (receiver.x - opp.x) * dir;
      if (behindReceiver > -25) {
        const d = dist(opp.x, opp.y, receiver.x, receiver.y);
        if (d < nearestBehindReceiver) nearestBehindReceiver = d;
      }
    }

    const progress = (tx - player.x) * dir;
    const targetSpace = clamp((nearestToTarget - 42) / 120, 0, 1) * 35;
    const separation = clamp((nearestBehindReceiver - 24) / 130, 0, 1) * 22;
    // Vision drives through-ball recognition; passing drives execution quality
    const ability = receiver.stats.sprintSpeed * 0.24 + receiver.stats.reactions * 0.20
      + player.stats.longPassing * 0.22 + player.stats.vision * 0.24;
    const roleBonus = receiver.role === PlayerRole.Striker ? 12 : receiver.role === PlayerRole.Winger ? 8 : 2;
    const distancePenalty = clamp((passDistance - 320) / 320, 0, 1) * 18;
    const goalBonus = clamp((520 - Math.abs(tx - ctx.oppGoal.centerX)) / 520, 0, 1) * 16;

    const score = ability
      + roleBonus
      + targetSpace
      + separation
      + clamp(progress / 12, 0, 22)
      + goalBonus
      - distancePenalty;

    if (!best || score > best.score) {
      best = { receiver, tx, ty, score };
    }
  }

  // Incisive Pass: sees the through-ball sooner and scores it higher
  const incisiveBonus = traitBonus(player, TRAITS.INCISIVE_PASS, 10, 6);
  if (best) best = { ...best, score: best.score + incisiveBonus };
  // Vision lowers the detection threshold: vision=60→75, vision=91→68
  // throughBallWeight > 0.25 (neutral) abaixa o threshold → time tenta mais passes em profundidade
  const throughW = ctx.tacticalProfile?.throughBallWeight ?? 0.25;
  const threshold = 86 - (player.stats.vision / 100) * 18 - traitBonus(player, TRAITS.INCISIVE_PASS, 8, 4) - (throughW - 0.25) * 60;
  return best && best.score > threshold ? best : null;
}

function findBestServicePassOption(player: Player, ctx: AIContext): ServicePassOption | null {
  const dir = ctx.ownTeam.attackDirection;
  const distToGoal = Math.abs(player.x - ctx.oppGoal.centerX);
  const wide = Math.abs(player.y - ctx.field.centerY) > 105;
  if (distToGoal > 310 || !wide) return null;

  let best: ServicePassOption | null = null;
  for (const receiver of ctx.ownTeam.players) {
    if (receiver === player || receiver.role === PlayerRole.Goalkeeper || receiver.role === PlayerRole.Defender) {
      continue;
    }

    const receiverAhead = (receiver.x - player.x) * dir;
    const receiverCentral = 1 - clamp(Math.abs(receiver.y - ctx.field.centerY) / 220, 0, 1);
    const boxX = clamp(ctx.oppGoal.centerX - dir * 145, ctx.field.left + 28, ctx.field.right - 28);
    const cutbackX = clamp(ctx.oppGoal.centerX - dir * 235, ctx.field.left + 28, ctx.field.right - 28);

    // Cutback: only from very close to byline, receiver arriving from behind and staying central
    const useCutback = playerInDeepWideArea(player, ctx)
      && receiverAhead < -10
      && distToGoal < 185
      && Math.abs(receiver.y - ctx.field.centerY) < 115;

    const kind: 'cross' | 'cutback' = useCutback ? 'cutback' : 'cross';

    // Cross: lead the receiver forward — target where they're heading, capped at penalty area
    const crossTX = dir > 0
      ? clamp(receiver.x + 75, ctx.field.left + 28, boxX)
      : clamp(receiver.x - 75, boxX, ctx.field.right - 28);
    const tx = kind === 'cutback' ? cutbackX : crossTX;
    const ty = kind === 'cutback'
      ? clamp(ctx.field.centerY + (receiver.y - ctx.field.centerY) * 0.30, ctx.field.top + 36, ctx.field.bottom - 36)
      : clamp(ctx.field.centerY + (receiver.y - ctx.field.centerY) * 0.55, ctx.field.top + 36, ctx.field.bottom - 36);

    const passDistance = dist(player.x, player.y, tx, ty);
    if (passDistance < 85 || passDistance > 520) continue;

    let nearestToTarget = Infinity;
    for (const opp of ctx.oppTeam.players) {
      if (opp.role === PlayerRole.Goalkeeper) continue;
      const d = dist(opp.x, opp.y, tx, ty);
      if (d < nearestToTarget) nearestToTarget = d;
    }

    // Hard reject: target zone is too closely guarded to be useful
    if (nearestToTarget < 50) continue;

    const targetSpace = clamp((nearestToTarget - 50) / 95, 0, 1) * 28;
    const receiverFit = receiver.stats.reactions * 0.18
      + receiver.stats.finishing * 0.18
      + receiver.stats.physical * (kind === 'cross' ? 0.12 : 0.04);
    const passerFit = player.stats.shortPassing * 0.16 + player.stats.crossing * 0.16 + player.stats.dribbling * 0.06;
    const roleBonus = receiver.role === PlayerRole.Striker ? 16 : receiver.role === PlayerRole.Midfielder ? 8 : 5;
    const centralBonus = receiverCentral * (kind === 'cutback' ? 16 : 10);
    const depthBonus = clamp((310 - distToGoal) / 310, 0, 1) * 14;
    // Cross: bonus for a receiver making a forward run into the box
    const runBonus = kind === 'cross' && receiverAhead > 30
      ? clamp((receiverAhead - 30) / 130, 0, 1) * 16
      : 0;
    const backwardCutbackBonus = kind === 'cutback' ? clamp((-receiverAhead + 80) / 180, 0, 1) * 16 : 0;

    const score = receiverFit
      + passerFit
      + roleBonus
      + centralBonus
      + targetSpace
      + depthBonus
      + runBonus
      + backwardCutbackBonus
      - clamp((passDistance - 300) / 280, 0, 1) * 12;

    if (!best || score > best.score) {
      best = { receiver, tx, ty, score, kind };
    }
  }

  // Crosser: more willing to attempt service passes (lower threshold)
  // crossWeight > 0.25 (neutral) abaixa o threshold → time cruza mais
  // crossThresholdBonus: instrução individual 'Cruzar mais' abaixa ainda mais (-16)
  const crossW = ctx.tacticalProfile?.crossWeight ?? 0.25;
  const instrCrossBonus = crossThresholdBonus(ctx.playerInstructions?.get(player.id));
  const crosserThreshold = 76 - traitBonus(player, TRAITS.CROSSER, 12, 8) - (crossW - 0.25) * 60 - instrCrossBonus;
  return best && best.score > crosserThreshold ? best : null;
}

function playerInDeepWideArea(player: Player, ctx: AIContext): boolean {
  return Math.abs(player.x - ctx.oppGoal.centerX) < 210
    && Math.abs(player.y - ctx.field.centerY) > 120;
}

function ballInWideFinalThird(ball: Ball, ctx: AIContext): boolean {
  return Math.abs(ball.x - ctx.oppGoal.centerX) < 335
    && Math.abs(ball.y - ctx.field.centerY) > 105;
}

// Returns the nearest outfield opponent who is blocking the path forward.
function findBlockingDefender(player: Player, ctx: AIContext): Player | null {
  const dir = ctx.ownTeam.attackDirection;
  let nearest: Player | null = null;
  let nearestDist = Infinity;
  for (const opp of ctx.oppTeam.players) {
    if (opp.role === PlayerRole.Goalkeeper) continue;
    const ahead = (opp.x - player.x) * dir;
    if (ahead < 10) continue;
    const d = dist(opp.x, opp.y, player.x, player.y);
    if (d >= 95 || d >= nearestDist) continue;
    // Cone check: opponent must be within ~40° of the attack direction.
    // tan(40°) ≈ 0.84 — defenders wide to the side don't count as blockers.
    const lateral = Math.abs(opp.y - player.y);
    if (lateral > ahead * 0.84) continue;
    nearestDist = d;
    nearest = opp;
  }
  return nearest;
}

// Projects the pass target ahead of the receiver when the space in front of them
// is clearer than their feet — enables "pass into run" on normal forward passes.
function findSpaceProjection(
  passer: Player,
  receiver: Player,
  ctx: AIContext,
): { tx: number; ty: number } | null {
  const dir = ctx.ownTeam.attackDirection;
  if ((receiver.x - passer.x) * dir < 20) return null; // backward/lateral → feet only

  const leadDist = 55 + receiver.stats.sprintSpeed * 0.55;
  const tx = clamp(receiver.x + dir * leadDist, ctx.field.left + 20, ctx.field.right - 20);
  const ty = clamp(receiver.y, ctx.field.top + 20, ctx.field.bottom - 20);

  let nearestToSpace = Infinity;
  let nearestToFeet  = Infinity;
  for (const opp of ctx.oppTeam.players) {
    if (opp.role === PlayerRole.Goalkeeper) continue;
    const dSpace = dist(opp.x, opp.y, tx, ty);
    const dFeet  = dist(opp.x, opp.y, receiver.x, receiver.y);
    if (dSpace < nearestToSpace) nearestToSpace = dSpace;
    if (dFeet  < nearestToFeet)  nearestToFeet  = dFeet;
  }

  // Vision sees the run sooner; passing skills project to the right spot
  const threshold = 26 - passer.stats.longPassing * 0.05 - passer.stats.vision * 0.09; // vision=91 → 8px margin
  return nearestToSpace - nearestToFeet > threshold ? { tx, ty } : null;
}

export function decideWithBall(player: Player, ctx: AIContext): PlayerState {
  // GK never shoots, dribbles or carries — dedicated distribution logic.
  if (player.role === PlayerRole.Goalkeeper) {
    const nearestOpp = ctx.oppTeam.getNearestPlayerTo(player.x, player.y);
    const underPressure = nearestOpp ? nearestOpp.distanceTo(player) < 85 : false;
    if (!underPressure) {
      const defTarget = findGkPassTarget(player, ctx);
      if (defTarget) {
        player.passTarget = defTarget;
        player.passTargetX = null;
        player.passTargetY = null;
        player.passKind = 'normal';
        return PlayerState.Pass;
      }
    } else if (nearestOpp) {
      // Under pressure — smart GKs find a side pass whose lane isn't blocked by the presser
      const safePass = findGkPressurePassTarget(player, ctx, nearestOpp);
      if (safePass) {
        player.passTarget = safePass;
        player.passTargetX = null;
        player.passTargetY = null;
        player.passKind = 'normal';
        return PlayerState.Pass;
      }
    }
    return PlayerState.Clearance;
  }

  // Absolute priority: past all defenders with only GK left — never pass backward.
  if (isOneVsGK(player, ctx)) {
    const dir = ctx.ownTeam.attackDirection;
    const boundary = dir > 0 ? ctx.field.right : ctx.field.left;
    // Force shoot if near the end line — no room to carry, any angle beats being stuck
    const nearBoundary = Math.abs(player.x - boundary) < 55;
    return (canShoot(player, ctx) || nearBoundary) ? PlayerState.Shoot : PlayerState.CarryBall;
  }

  const servicePass = findBestServicePassOption(player, ctx);
  if (servicePass) {
    player.passTarget = servicePass.receiver;
    player.passTargetX = servicePass.tx;
    player.passTargetY = servicePass.ty;
    player.passKind = servicePass.kind;
    return PlayerState.Pass;
  }

  // Angle-seeking: attacker close to goal but with a narrow sight-line carries to
  // find a better position rather than shooting or crossing from a dead angle.
  if (shouldSeekBetterAngle(player, ctx)) return PlayerState.CarryBall;

  const risk = carryRiskFactor(player);
  // riskTolerance: 0=muito seguro → prefere passe; 1=muito arriscado → carrega/dribla mais
  const riskTol = ctx.tacticalProfile?.riskTolerance ?? 0.5;
  const riskTolBias = (riskTol - 0.5) * 8; // -4 = very safe, +4 = very risky
  if (canShoot(player, ctx) || shouldForceRiskyShot(player, ctx, risk)) return PlayerState.Shoot;

  // Through pass first: a free runner in behind beats forcing a dribble.
  const carry = scoreCarry(player, ctx);
  const throughPass = findBestThroughPassOption(player, ctx);
  if (throughPass && throughPass.score > carry + 8 - risk * 16 - riskTolBias) {
    player.passTarget = throughPass.receiver;
    player.passTargetX = throughPass.tx;
    player.passTargetY = throughPass.ty;
    player.passKind = 'through';
    return PlayerState.Pass;
  }

  // Instruções individuais: modificadores de decisão com a bola
  const inst = ctx.playerInstructions?.get(player.id);
  const instrDribbleMult   = dribbleAbilityMult(inst);
  const instrPassAdvBonus  = passAdvantageBonus(inst);

  // Dribble: only after ruling out a through ball — skilled attackers beat a blocker
  // that's directly in the forward path (cone-filtered by findBlockingDefender).
  const blocker = findBlockingDefender(player, ctx);
  if (blocker) {
    const d = dist(player.x, player.y, blocker.x, blocker.y);
    const dribbleRange = 72 + player.stats.dribbling * 0.22 + traitBonus(player, TRAITS.TECHNICAL, 15, 8);
    if (d < dribbleRange && d > 28) {
      const dribbleAbility = player.stats.dribbling * 0.55 + player.stats.sprintSpeed * 0.18;
      const roleMult = (player.role === PlayerRole.Striker || player.role === PlayerRole.Winger) ? 1.2
        : player.role === PlayerRole.Midfielder ? 0.95
        : 0.55;
      // instrDribbleMult: 'Driblar mais' amplia habilidade efetiva; 'Reter posse' reduz
      if (dribbleAbility * roleMult * instrDribbleMult > 46 - risk * 9 - riskTolBias * 0.8) {
        player.dribbleTarget = blocker;
        return PlayerState.Dribble;
      }
    }
  }

  const passTarget = findBestPassTarget(player, ctx);
  const bias = ctx.tacticalProfile?.possessionBias ?? 0;
  const spref = ctx.tacticalProfile?.shortPassPreference ?? 0.4;

  if (passTarget) {
    const teamIdx = player.teamId === 'teamA' ? 0 : 1;
    const passScore = evaluatePassOption(
      player, passTarget, ctx.oppTeam.players, ctx.oppGoal.centerX,
      ctx.heatMap?.getHeat(passTarget.x, passTarget.y, teamIdx) ?? 0,
      bias,
      spref,
    );
    // Attackers need a clear pass advantage to override running into open space
    // instrPassAdvBonus: 'Passar mais'/'Reter posse' aumenta preferência por passe; 'Driblar mais' reduz
    const passAdvantage = (player.role === PlayerRole.Striker || player.role === PlayerRole.Winger) ? 22 : 14;
    if (passScore > carry + passAdvantage + instrPassAdvBonus - risk * 22 - bias * 20) {
      player.passTarget = passTarget;
      const proj = findSpaceProjection(player, passTarget, ctx);
      player.passTargetX = proj?.tx ?? null;
      player.passTargetY = proj?.ty ?? null;
      player.passKind = 'normal';
      return PlayerState.Pass;
    }
  }

  const carryThreshold = (player.role === PlayerRole.Defender ? 12 : 18) - riskTolBias;
  if (carry > carryThreshold + risk * 10) return PlayerState.CarryBall;

  // Modest pass beats protecting the ball
  if (passTarget) {
    player.passTarget = passTarget;
    const proj = findSpaceProjection(player, passTarget, ctx);
    player.passTargetX = proj?.tx ?? null;
    player.passTargetY = proj?.ty ?? null;
    player.passKind = 'normal';
    return PlayerState.Pass;
  }

  return PlayerState.ProtectBall;
}

// True when every outfield opponent is behind the player or more than 200 px away.
function isOneVsGK(player: Player, ctx: AIContext): boolean {
  const dir = ctx.ownTeam.attackDirection;
  return ctx.oppTeam.players
    .filter(p => p.role !== PlayerRole.Goalkeeper)
    .every(opp => {
      const ahead = (opp.x - player.x) * dir;
      return ahead < 20 || dist(opp.x, opp.y, player.x, player.y) > 200;
    });
}

function carryRiskFactor(player: Player): number {
  // Pressure/stall risk
  const pressureRisk = clamp((player.carryRiskMs - 450) / 1350, 0, 1);
  // Time-based urgency: defenders start at 0.9s (max 1.8s), outfield at 1.6s (max 3.2s)
  const isDefender = player.role === PlayerRole.Defender;
  const urgencyStart = isDefender ? 900 : 1600;
  const urgencyWindow = isDefender ? 900 : 1600;
  const timeUrgency = clamp((player.carryDurationMs - urgencyStart) / urgencyWindow, 0, 1);
  return Math.max(pressureRisk, timeUrgency);
}

function shouldSeekBetterAngle(player: Player, ctx: AIContext): boolean {
  if (player.role !== PlayerRole.Striker && player.role !== PlayerRole.Winger) return false;
  const distToGoal = dist(player.x, player.y, ctx.oppGoal.centerX, ctx.field.centerY);
  if (distToGoal > 265 || distToGoal < 55) return false;
  const nearestOpp = ctx.oppTeam.getNearestPlayerTo(player.x, player.y);
  if (nearestOpp && nearestOpp.distanceTo(player) < 55) return false;
  return computeGoalViewAngle(player.x, player.y, ctx) < 0.22;
}

function shouldForceRiskyShot(player: Player, ctx: AIContext, risk: number): boolean {
  if (risk < 0.48 || player.stats.finishing < 48) return false;

  const d = dist(player.x, player.y, ctx.oppGoal.centerX, ctx.field.centerY);
  const range = 210 + player.stats.longShots * 1.9 + traitBonus(player, TRAITS.LONG_SHOT, 45, 30);
  if (d > range) return false;

  // Desperate shots still need at least some angle — extreme byline is futile
  if (computeGoalViewAngle(player.x, player.y, ctx) < 0.10) return false;

  const nearestOpp = ctx.oppTeam.getNearestPlayerTo(player.x, player.y);
  const pressure = nearestOpp ? clamp((72 - nearestOpp.distanceTo(player)) / 72, 0, 1) : 0;
  const attackerBonus = player.role === PlayerRole.Striker || player.role === PlayerRole.Winger ? 0.18 : 0;
  const riskTolBoost = ((ctx.tacticalProfile?.riskTolerance ?? 0.5) - 0.5) * 0.22;
  const composureBoost = (player.stats.composure / 100 - 0.5) * 0.12;
  return risk + pressure * 0.35 + attackerBonus + riskTolBoost + composureBoost > 0.78;
}

// Score the opportunity to carry the ball forward.
// Factors: space ahead, player ability (dribbling / pace), role, pitch position.
function scoreCarry(player: Player, ctx: AIContext): number {
  const dir = ctx.ownTeam.attackDirection;

  // No room to carry — already at the attacking boundary
  const boundary = dir > 0 ? ctx.field.right - 15 : ctx.field.left + 15;
  if (Math.abs(player.x - boundary) < 45) return 0;

  // Nearest outfield opponent who is in front of the player
  let nearestThreat = Infinity;
  for (const opp of ctx.oppTeam.players) {
    if (opp.role === PlayerRole.Goalkeeper) continue;
    if ((opp.x - player.x) * dir < 0) continue; // behind — not blocking carry
    const d = dist(opp.x, opp.y, player.x, player.y);
    if (d < nearestThreat) nearestThreat = d;
  }

  if (nearestThreat < 40) return 0; // immediately blocked

  // Space: 0 pts at 40 px → 46 pts at 200 px+
  const spaceBonus = clamp((nearestThreat - 40) / 160, 0, 1) * 46;

  // In tight space dribbling wins; in open space pure pace is decisive.
  // openSpaceFactor: 0 at 60 px gap → 1 at 200 px gap.
  const openSpaceFactor = clamp((nearestThreat - 60) / 140, 0, 1);
  const technicalAbility = (player.stats.dribbling * 0.55 + player.stats.sprintSpeed * 0.25) / 100;
  const paceAbility      = (player.stats.sprintSpeed * 0.60 + player.stats.acceleration * 0.40) / 100;
  const ability = technicalAbility + (paceAbility - technicalAbility) * openSpaceFactor;

  // Role: attackers carry far more willingly than defenders
  const roleFactor =
    player.role === PlayerRole.Striker || player.role === PlayerRole.Winger ? 1.35
    : player.role === PlayerRole.Midfielder ? 1.05
    : 0.60;

  // Raised floor: a fast attacker at midfield with open space should still want to run
  const distToGoal = Math.abs(player.x - ctx.oppGoal.centerX);
  const posFactor  = clamp(1 - distToGoal / 800, 0.45, 1.0);

  return (spaceBonus * roleFactor + ability * 42 * roleFactor * posFactor) * player.getStaminaFactor();
}

// ─── Without-ball decisions ───────────────────────────────────────────────────

export function decideWithoutBall(
  player: Player,
  ctx: AIContext,
): { state: PlayerState; tx: number; ty: number } {
  const ownHasBall = ctx.ownTeam.hasPossession();
  const ball = ctx.ball;
  const attackDir = ctx.ownTeam.attackDirection;
  const { field } = ctx;

  if (player.role === PlayerRole.Goalkeeper) {
    return decideGkWithoutBall(player, ctx, ownHasBall);
  }

  // Repel from ALL nearby teammates — not just the nearest — so the full squad spreads out.
  const rep = computeRepelAll(player, ctx.ownTeam.players);

  return ownHasBall
    ? attackingPosition(player, ctx, attackDir, ball, field, rep)
    : defendingPosition(player, ctx, attackDir, ball, field, rep);
}

// ─── Repulsion helpers ────────────────────────────────────────────────────────

function computeRepel(
  px: number, py: number,
  ox: number, oy: number,
  radius: number,
): { rx: number; ry: number } {
  const dx = px - ox;
  const dy = py - oy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0 || d >= radius) return { rx: 0, ry: 0 };
  const strength = (1 - d / radius) * 48;
  return { rx: (dx / d) * strength, ry: (dy / d) * strength };
}

// Sum repulsion from every teammate within radius, capped to avoid overshooting.
function computeRepelAll(
  player: Player,
  teammates: Player[],
  radius = 90,
): { rx: number; ry: number } {
  let rx = 0, ry = 0;
  for (const t of teammates) {
    if (t === player) continue;
    const r = computeRepel(player.x, player.y, t.x, t.y, radius);
    rx += r.rx;
    ry += r.ry;
  }
  return { rx: clamp(rx, -65, 65), ry: clamp(ry, -65, 65) };
}

function findOpenSpaceTarget(
  player: Player,
  ctx: AIContext,
  attackDir: number,
  rep: { rx: number; ry: number },
): { tx: number; ty: number } | null {
  const carrier = ctx.ownTeam.getBallCarrier();
  if (!carrier || carrier === player) return null;

  // Higher supportRunIntensity = players seek space further and more aggressively
  const intensity = ctx.tacticalProfile?.supportRunIntensity ?? 0.5;
  const intensityScale = 0.6 + intensity * 0.8; // 0.2→0.76  0.5→1.0  0.9→1.32
  const roleDepth = (
    player.role === PlayerRole.Striker ? 150
    : player.role === PlayerRole.Winger ? 125
    : player.role === PlayerRole.Midfielder ? 95
    : 45
  ) * intensityScale;
  // widthBias amplifica o quanto os jogadores buscam espaço lateral
  // 0=estreita(×0.72) 0.5=normal(×1.0) 1=aberta(×1.28)
  const widthScale = 0.72 + (ctx.tacticalProfile?.widthBias ?? 0.5) * 0.56;
  const lateralStep = (
    player.role === PlayerRole.Striker ? 82
    : player.role === PlayerRole.Midfielder ? 118
    : 150
  ) * intensityScale * widthScale;
  const supportX = clamp(carrier.x - attackDir * 95, ctx.field.left + 24, ctx.field.right - 24);
  const carrierAngle = Math.atan2(player.y - carrier.y, player.x - carrier.x);
  const escapeAngleA = carrierAngle + Math.PI / 2;
  const escapeAngleB = carrierAngle - Math.PI / 2;

  const candidates = [
    { x: player.x + attackDir * roleDepth, y: player.y },
    { x: player.x + attackDir * (roleDepth * 0.85), y: player.y - lateralStep },
    { x: player.x + attackDir * (roleDepth * 0.85), y: player.y + lateralStep },
    { x: carrier.x + attackDir * (roleDepth * 0.9), y: carrier.y - lateralStep },
    { x: carrier.x + attackDir * (roleDepth * 0.9), y: carrier.y + lateralStep },
    { x: player.x + Math.cos(escapeAngleA) * 92 + attackDir * 38, y: player.y + Math.sin(escapeAngleA) * 92 },
    { x: player.x + Math.cos(escapeAngleB) * 92 + attackDir * 38, y: player.y + Math.sin(escapeAngleB) * 92 },
    { x: carrier.x + attackDir * 155, y: carrier.y - lateralStep * 0.62 },
    { x: carrier.x + attackDir * 155, y: carrier.y + lateralStep * 0.62 },
    { x: supportX, y: player.baseY },
  ];

  // High-vision players weight pass-lane quality and danger zones more heavily.
  // visFactor: vis=30 → 0.79, vis=60 → 1.03, vis=90 → 1.27
  const intFactor = 0.55 + (player.stats.vision / 100) * 0.80;
  // High-vision players proactively seek space (lower acceptance threshold).
  const spaceThreshold = 52 - player.stats.vision * 0.08;
  // positioningPull: 'Ficar na posição' (1.0) aumenta o peso de idealScore vs. exploração livre
  // 'Movimentação livre' (0.15) libera o jogador da posição base
  const posPull = positioningPull(ctx.playerInstructions?.get(player.id));

  // Detect the opponent who is marking this player (if any)
  const myMarker = ctx.oppTeam.players.find(p => p.markingTarget === player) ?? null;

  // Add escape candidates perpendicular to the marker's approach direction.
  // These complement the carrier-angle escape candidates and give the player
  // a genuine route to break the shadow of a tight man-marker.
  if (myMarker) {
    const mDx = myMarker.x - player.x;
    const mDy = myMarker.y - player.y;
    const mLen = Math.sqrt(mDx * mDx + mDy * mDy) || 1;
    const perpX = -mDy / mLen;
    const perpY = mDx / mLen;
    for (const side of [1, -1]) {
      for (const escDist of [80, 125]) {
        candidates.push({
          x: player.x + perpX * side * escDist + attackDir * 36,
          y: player.y + perpY * side * escDist,
        });
      }
    }
  }

  // Gap runs: positions between pairs of nearby opponents — corridor runs between defenders
  const oppOutfield = ctx.oppTeam.players.filter(p => p.role !== PlayerRole.Goalkeeper);
  for (let i = 0; i < oppOutfield.length; i++) {
    for (let j = i + 1; j < oppOutfield.length; j++) {
      const a = oppOutfield[i];
      const b = oppOutfield[j];
      const gapDist = dist(a.x, a.y, b.x, b.y);
      if (gapDist < 80 || gapDist > 220) continue;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if ((midX - player.x) * attackDir < 25) continue;
      candidates.push({ x: midX + attackDir * 40, y: midY });
    }
  }

  // Coolest-cell candidate: least-covered zone in the attacking third
  if (ctx.heatMap) {
    const oppTeamIdx = player.teamId === 'teamA' ? 1 : 0;
    const searchX = ctx.oppGoal.centerX - attackDir * 185;
    const cool = ctx.heatMap.findCoolestCell(searchX, ctx.field.centerY, oppTeamIdx, 4);
    if (cool) candidates.push({ x: cool.x, y: cool.y });
  }

  const roleMinGoalDist = player.role === PlayerRole.Striker ? 145
    : player.role === PlayerRole.Winger ? 155 : 175;

  let best: { tx: number; ty: number; score: number } | null = null;
  for (const c of candidates) {
    const tx = clamp(c.x + rep.rx * 0.35, ctx.field.left + 24, ctx.field.right - 24);
    const ty = clamp(c.y + rep.ry * 0.35, ctx.field.top + 28, ctx.field.bottom - 28);
    // Hard cap: skip candidates within the minimum safe distance from the opponent goal.
    // Prevents attackers from seeking space right on the goal line.
    if (Math.abs(tx - ctx.oppGoal.centerX) < roleMinGoalDist) continue;
    const moveDist = dist(player.x, player.y, tx, ty);
    if (moveDist < 55 || moveDist > 260) continue;

    let nearestOpp = Infinity;
    let passLane = Infinity;
    for (const opp of ctx.oppTeam.players) {
      if (opp.role === PlayerRole.Goalkeeper) continue;
      const d = dist(opp.x, opp.y, tx, ty);
      if (d < nearestOpp) nearestOpp = d;
      const laneDist = distancePointToSegment(opp.x, opp.y, carrier.x, carrier.y, tx, ty);
      if (laneDist < passLane) passLane = laneDist;
    }

    let nearestMate = Infinity;
    for (const mate of ctx.ownTeam.players) {
      if (mate === player) continue;
      const d = dist(mate.x, mate.y, tx, ty);
      if (d < nearestMate) nearestMate = d;
    }

    const progress = (tx - player.x) * attackDir;
    const carrierDistance = dist(carrier.x, carrier.y, tx, ty);
    const aheadOfCarrier = (tx - carrier.x) * attackDir;
    const currentLane = nearestPassLaneBlockerDistance(carrier, player, ctx);
    const laneImprovement = passLane - currentLane;
    const spaceScore = clamp((nearestOpp - 45) / 150, 0, 1) * 42;
    const teammateSpace = clamp((nearestMate - 42) / 110, 0, 1) * 22;
    const progressScore = clamp(progress / 135, -0.4, 1) * 20;
    const receiveScore = clamp((390 - carrierDistance) / 300, 0, 1) * 18;
    const supportScore = aheadOfCarrier < -20 ? 10 : 0;
    const wideBonus = Math.abs(ty - ctx.field.centerY) > 110 ? 8 : 0;
    // Intelligence scales the "smart positioning" metrics: pass-lane quality, danger, and unshadowing.
    // Danger: shooting angle to goal posts for central positions; crossing proximity for wide wingers.
    const gDx = Math.abs(tx - ctx.oppGoal.centerX) + 1;
    const shootingAngle = Math.abs(
      Math.atan2(ctx.oppGoal.bottom - ty, gDx) - Math.atan2(ctx.oppGoal.top - ty, gDx),
    );
    const isWide = Math.abs(ty - ctx.field.centerY) > 95;
    const crossingValue = (player.role === PlayerRole.Winger && isWide)
      ? clamp((310 - gDx) / 310, 0, 1)
      : 0;
    const dangerBonus = clamp(Math.max(shootingAngle / 1.1, crossingValue), 0, 1) * 12 * intFactor;
    const laneScore = clamp((passLane - 42) / 100, 0, 1) * 30 * intFactor;
    const unshadowScore = clamp(laneImprovement / 70, 0, 1) * 18 * intFactor;
    const angleScore = scorePassingAngle(carrier, player, tx, ty) * 12 * intFactor;
    // Marker escape: prefer positions that increase separation from the marking defender.
    // Scales with intelligence — smart attackers read the defender and time the run.
    const markerEscape = myMarker
      ? clamp(
          (dist(tx, ty, myMarker.x, myMarker.y) - dist(player.x, player.y, myMarker.x, myMarker.y)) / 80,
          0, 1,
        ) * 32 * intFactor
      : 0;
    const crowdPenalty = nearestOpp < 42 ? 34 : 0;
    const blockedLanePenalty = passLane < 34 ? 30 : 0;
    // Penalize positions too deep — Strikers should hover at penalty spot, not park on GK.
    // Non-Strikers should stay outside the box entirely.
    const boxDepth = Math.max(0, 190 - gDx);
    const tooDeepPenalty = player.role === PlayerRole.Striker
      ? clamp((145 - gDx) / 145, 0, 1) * 36
      : clamp(boxDepth / 190, 0, 1) * 52;

    // posPull: 'Ficar na posição' (1) bonifica posições próximas à base;
    //          'Movimentação livre' (0.15) penaliza levemente (incentiva exploração)
    const baseDist = dist(tx, ty, player.baseX, player.baseY);
    const baseProximityBonus = clamp(1 - baseDist / 220, 0, 1) * (posPull - 0.55) * 32;

    const score = spaceScore
      + teammateSpace
      + progressScore
      + receiveScore
      + supportScore
      + wideBonus
      + dangerBonus
      + laneScore
      + unshadowScore
      + angleScore
      + markerEscape
      + baseProximityBonus
      - crowdPenalty
      - blockedLanePenalty
      - tooDeepPenalty;

    if (!best || score > best.score) best = { tx, ty, score };
  }

  return best && best.score > spaceThreshold ? { tx: best.tx, ty: best.ty } : null;
}

function nearestPassLaneBlockerDistance(carrier: Player, receiver: Player, ctx: AIContext): number {
  let nearest = Infinity;
  for (const opp of ctx.oppTeam.players) {
    if (opp.role === PlayerRole.Goalkeeper) continue;
    const d = distancePointToSegment(opp.x, opp.y, carrier.x, carrier.y, receiver.x, receiver.y);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

function scorePassingAngle(carrier: Player, receiver: Player, tx: number, ty: number): number {
  const oldAngle = Math.atan2(receiver.y - carrier.y, receiver.x - carrier.x);
  const newAngle = Math.atan2(ty - carrier.y, tx - carrier.x);
  let diff = Math.abs(newAngle - oldAngle);
  if (diff > Math.PI) diff = Math.PI * 2 - diff;
  return clamp(diff / 1.15, 0, 1);
}

export function findAttackingOpenSpace(player: Player, ctx: AIContext): { tx: number; ty: number } | null {
  const rep = computeRepelAll(player, ctx.ownTeam.players);
  return findOpenSpaceTarget(player, ctx, ctx.ownTeam.attackDirection, rep);
}

// ─── Attacking positioning ────────────────────────────────────────────────────

function attackingPosition(
  player: Player,
  ctx: AIContext,
  attackDir: number,
  ball: Ball,
  field: FieldBounds,
  rep: { rx: number; ry: number },
): { state: PlayerState; tx: number; ty: number } {
  // Positioning is anchored to each player's baseX — not ball.x — so roles
  // maintain their depth on the pitch even when the ball is in center.
  // Only y-axis pulls lightly toward ball.y to keep width realistic.

  // Loose ball during attack: closest outfield player claims it immediately.
  // Mirrors the same check in defendingPosition so a deflection or bad touch is
  // contested by the nearest attacker rather than ignored until their cooldown expires.
  const looseBallAtk = !ball.owner && !ball.targetPlayer;
  if (looseBallAtk && player.role !== PlayerRole.Goalkeeper) {
    const dToBall = dist(player.x, player.y, ball.x, ball.y);
    const mateIsCloser = ctx.ownTeam.players.some(
      m => m !== player
        && m.role !== PlayerRole.Goalkeeper
        && dist(m.x, m.y, ball.x, ball.y) < dToBall - 15,
    );
    if (!mateIsCloser) {
      player.markingTarget = null;
      player.forceSprint(400);
      return {
        state: PlayerState.PressBall,
        tx: clamp(ball.x, field.left + 15, field.right - 15),
        ty: clamp(ball.y, field.top + 20, field.bottom - 20),
      };
    }
  }

  // Moving loose ball: intercept if reachable, same as in defendingPosition.
  if (player.role !== PlayerRole.Goalkeeper) {
    const intercept = findBallInterceptPoint(player, ctx);
    if (intercept) {
      player.markingTarget = null;
      player.forceSprint(720);
      return { state: PlayerState.PressBall, tx: intercept.tx, ty: intercept.ty };
    }
  }

  switch (player.role) {
    case PlayerRole.Defender: {
      // Fullbacks (wide baseY) respondem ao fullbackAttackBias; zagueiros centrais mantêm push fixo.
      const fieldHeight = field.bottom - field.top;
      const isFullback = Math.abs(player.baseY - field.centerY) > fieldHeight * 0.26;
      const instrAtkSupport = attackSupportMultiplier(ctx.playerInstructions?.get(player.id));
      const fwdPush = isFullback
        ? (16 + (ctx.tacticalProfile?.fullbackAttackBias ?? 0.5) * 68) * instrAtkSupport
        : 35 * Math.min(instrAtkSupport, 1.2); // CBs têm headroom menor
      const tx = clamp(player.baseX + attackDir * fwdPush + rep.rx, field.left + 20, field.right - 20);
      // Low y-pull: defenders keep their vertical lane rather than drifting toward the ball
      const ty = clamp(player.baseY + (ball.y - player.baseY) * 0.07 + rep.ry, field.top + 20, field.bottom - 20);
      return { state: PlayerState.FindSpace, tx, ty };
    }

    case PlayerRole.Midfielder: {
      const carrier = ctx.ownTeam.getBallCarrier();
      if (carrier && carrier !== player && ballInWideFinalThird(ball, ctx)) {
        const tx = clamp(ctx.oppGoal.centerX - attackDir * 245 + rep.rx * 0.25, field.left + 20, field.right - 20);
        const ty = clamp(field.centerY + (player.baseY - field.centerY) * 0.35 + rep.ry * 0.25, field.top + 24, field.bottom - 24);
        return { state: PlayerState.FindSpace, tx, ty };
      }

      const openSpace = findOpenSpaceTarget(player, ctx, attackDir, rep);
      if (openSpace) {
        return { state: PlayerState.FindSpace, tx: openSpace.tx, ty: openSpace.ty };
      }

      // Midfielders push into the attacking third from their base
      // attackFocusBias > 0 (pontas): meia mantém largura; < 0 (centro): puxa para o miolo
      const attackFocusBiasMid = ctx.tacticalProfile?.attackFocusBias ?? 0;
      const focusLateralMid = (field.centerY - player.baseY) * (-attackFocusBiasMid) * 0.20;
      const instrAtkSupportMid = attackSupportMultiplier(ctx.playerInstructions?.get(player.id));
      const midPush = 55 * instrAtkSupportMid;
      const tx = clamp(player.baseX + attackDir * midPush + rep.rx, field.left + 20, field.right - 20);
      const ty = clamp(player.baseY + focusLateralMid + (ball.y - player.baseY) * 0.06 + rep.ry, field.top + 20, field.bottom - 20);
      return { state: PlayerState.FindSpace, tx, ty };
    }

    case PlayerRole.Winger:
    case PlayerRole.Striker: {
      const carrier = ctx.ownTeam.getBallCarrier();
      if (carrier && carrier !== player) {
        if (ballInWideFinalThird(ball, ctx)) {
          // Split near-post / far-post runs so attackers don't cluster in the same area.
          // Ball side: the side of the pitch the cross is coming from.
          // Near-post runner (same side as ball): attacks the space closest to the cross.
          // Far-post runner (opposite side): arrives late at the back post.
          const ballSide = ball.y < field.centerY ? -1 : 1;
          const playerSide = player.baseY < field.centerY ? -1 : 1;
          const isSameSideAsBall = ballSide === playerSide;

          if (isSameSideAsBall) {
            // Near-post run: arrive at the near post area aggressively
            const targetDepth = player.role === PlayerRole.Striker ? 140 : 155;
            const tx = clamp(ctx.oppGoal.centerX - attackDir * targetDepth + rep.rx * 0.25, field.left + 20, field.right - 20);
            const ty = clamp(field.centerY + ballSide * 46 + rep.ry * 0.25, field.top + 28, field.bottom - 28);
            return { state: PlayerState.FindSpace, tx, ty };
          } else {
            // Far-post run: diagonal run to the back post (wider and deeper)
            const targetDepth = player.role === PlayerRole.Striker ? 168 : 152;
            const tx = clamp(ctx.oppGoal.centerX - attackDir * targetDepth + rep.rx * 0.25, field.left + 20, field.right - 20);
            const ty = clamp(field.centerY + playerSide * 76 + rep.ry * 0.25, field.top + 28, field.bottom - 28);
            return { state: PlayerState.FindSpace, tx, ty };
          }
        }

        const aheadOfCarrier = (player.x - carrier.x) * attackDir;
        const distToOppGoal = Math.abs(player.x - ctx.oppGoal.centerX);
        // Minimum safe distance from goal per role — keeps striker near penalty spot, not on GK
        const minGoalDist = player.role === PlayerRole.Striker ? 145 : 188;
        // wingerDepthBias: attack-depth (1) corre mais fundo e mais cedo; receive-feet (0) fica
        const depthBias = player.role === PlayerRole.Winger
          ? (ctx.tacticalProfile?.wingerDepthBias ?? 0.5)
          : 0.5;
        // Com alto depthBias, o ponta começa a correr antes (aheadOfCarrier > -35 → > -80)
        // e pode ir até mais longe (215 → 260)
        const runStartOffset = -35 - depthBias * 45;
        const runEndOffset   = 215 + depthBias * 45;
        const canRunBeyond = aheadOfCarrier > runStartOffset
          && aheadOfCarrier < runEndOffset
          && distToOppGoal > minGoalDist;
        const ballCanFeedRun = (ball.x - carrier.x) * attackDir > -20 || carrier.distanceTo(player) < 360;
        if (canRunBeyond && ballCanFeedRun) {
          const attackIntensity = ctx.tacticalProfile?.supportRunIntensity ?? 0.5;
          const attackIntensityScale = 0.6 + attackIntensity * 0.8;
          const runDepth = (player.role === PlayerRole.Striker ? 128 : 102) * attackIntensityScale;
          const goalCenterY = (ctx.oppGoal.top + ctx.oppGoal.bottom) / 2;
          const toCenterY = goalCenterY - player.baseY;
          // Three run directions: straight, diagonal (cut inside), channel (hold wide)
          const runOptions = [
            { fwd: runDepth,        lat: toCenterY * (player.role === PlayerRole.Striker ? 0.24 : 0.08) },
            { fwd: runDepth * 0.80, lat: toCenterY * (player.role === PlayerRole.Striker ? 0.55 : 0.48) },
            { fwd: runDepth * 0.90, lat: toCenterY * -0.12 },
          ];
          let bestTX = player.x;
          let bestTY = player.baseY;
          let bestRunScore = -Infinity;
          const oppRunIdx = player.teamId === 'teamA' ? 1 : 0;
          for (const opt of runOptions) {
            const rawX = player.x + attackDir * opt.fwd + rep.rx * 0.35;
            const cappedX = attackDir > 0
              ? Math.min(rawX, ctx.oppGoal.centerX - minGoalDist)
              : Math.max(rawX, ctx.oppGoal.centerX + minGoalDist);
            const cx = clamp(cappedX, field.left + 20, field.right - 20);
            const cy = clamp(player.baseY + opt.lat + rep.ry * 0.35, field.top + 24, field.bottom - 24);
            let nearestOpp = Infinity;
            for (const opp of ctx.oppTeam.players) {
              if (opp.role === PlayerRole.Goalkeeper) continue;
              const d = dist(opp.x, opp.y, cx, cy);
              if (d < nearestOpp) nearestOpp = d;
            }
            const oppHeat = ctx.heatMap?.getHeat(cx, cy, oppRunIdx) ?? 0;
            const score = nearestOpp - oppHeat * 10;
            if (score > bestRunScore) { bestRunScore = score; bestTX = cx; bestTY = cy; }
          }
          return { state: PlayerState.FindSpace, tx: bestTX, ty: bestTY };
        }
      }

      const openSpace = findOpenSpaceTarget(player, ctx, attackDir, rep);
      if (openSpace) {
        return { state: PlayerState.FindSpace, tx: openSpace.tx, ty: openSpace.ty };
      }

      // Fallback: posição base ajustada por comportamento de papel + instruções individuais
      const isWinger = player.role === PlayerRole.Winger;
      const instrFallback = ctx.playerInstructions?.get(player.id);
      const instrMovement  = instrFallback?.movement;
      const instrAtkFallback = attackSupportMultiplier(instrFallback);

      // Movimento lateral: instrução individual sobrescreve o default de papel
      let cutInsideDrift = 0;
      if (instrMovement === 'cut-inside') {
        cutInsideDrift = 0.45;
      } else if (instrMovement === 'open-space') {
        cutInsideDrift = 0;
      } else if (isWinger) {
        // Fallback para o comportamento de papel do TacticalProfile
        const winWidthBias = ctx.tacticalProfile?.wingerWidthBias ?? 0.5;
        const attackFocusBiasW = ctx.tacticalProfile?.attackFocusBias ?? 0;
        // Foco pelas pontas (> 0): ponta fica mais aberto; foco central (< 0): ponta corta mais
        cutInsideDrift = clamp((1 - winWidthBias) * 0.45 - attackFocusBiasW * 0.15, 0, 0.65);
      }
      const anchorY = player.baseY + (field.centerY - player.baseY) * cutInsideDrift;

      // Profundidade: atacante: falso-9 recua; 'come-short' força recuo; finalizador fica alto
      const strikerDropBase = !isWinger ? (ctx.tacticalProfile?.strikerDropBias ?? 0.3) : 0;
      const strikerDrop = instrMovement === 'come-short' ? 0.85
        : instrMovement === 'attack-depth'               ? 0.0
        : strikerDropBase;
      const fwdOffset = (75 - strikerDrop * 110) * instrAtkFallback;

      const tx = clamp(player.baseX + attackDir * fwdOffset + rep.rx, field.left + 20, field.right - 20);
      const ty = clamp(anchorY + (ball.y - anchorY) * 0.04 + rep.ry, field.top + 20, field.bottom - 20);
      return { state: PlayerState.FindSpace, tx, ty };
    }
  }

  return { state: PlayerState.ReturnToShape, tx: player.baseX, ty: player.baseY };
}

// ─── Defending positioning ────────────────────────────────────────────────────

function defendingPosition(
  player: Player,
  ctx: AIContext,
  attackDir: number,
  ball: Ball,
  field: FieldBounds,
  rep: { rx: number; ry: number },
): { state: PlayerState; tx: number; ty: number } {
  // Universal: any outfield player sprints to cut the ball's trajectory when closest.
  // Sprint is forced so the player commits immediately regardless of remaining sprint budget.
  const intercept = findBallInterceptPoint(player, ctx);
  if (intercept) {
    player.markingTarget = null;
    player.forceSprint(720);
    return { state: PlayerState.PressBall, tx: intercept.tx, ty: intercept.ty };
  }

  // Universal: any outfield player claims a loose ball when they're the closest.
  // Moved before the role switch so midfielders and forwards also compete for it.
  const looseBall = !ball.owner && !ball.targetPlayer;
  if (looseBall) {
    const dToBall = dist(player.x, player.y, ball.x, ball.y);
    const mateIsCloser = ctx.ownTeam.players.some(
      m => m !== player
        && m.role !== PlayerRole.Goalkeeper
        && dist(m.x, m.y, ball.x, ball.y) < dToBall - 15,
    );
    if (!mateIsCloser) {
      player.markingTarget = null;
      player.forceSprint(400);
      return {
        state: PlayerState.PressBall,
        tx: clamp(ball.x, field.left + 15, field.right - 15),
        ty: clamp(ball.y, field.top + 20, field.bottom - 20),
      };
    }
  }

  switch (player.role) {
    case PlayerRole.Defender: {
      const carrier = ctx.oppTeam.getBallCarrier();

      // Immediate reflex press when carrier is right on top of defender
      if (carrier) {
        const dClose = player.distanceTo(carrier);
        const pressCount = ctx.ownTeam.players.filter(
          p => p !== player && p.state === PlayerState.PressBall && !p.hasBall,
        ).length;
        const canReflex = pressCount === 0 || (pressCount === 1 && shouldDoublePress(player, carrier, ctx));
        if (dClose < 105 && dClose >= 22 && pressCount < 2 && canReflex) {
          player.markingTarget = carrier;
          return defensiveEngageTarget(player, carrier, ctx, rep, 32);
        }
      }

      if (carrier && shouldStepOutForTackle(player, carrier, ctx)) {
        player.markingTarget = carrier;
        return defensiveEngageTarget(player, carrier, ctx, rep, 54);
      }

      const threat = chooseMarkingTarget(player, ctx);
      if (threat) {
        player.markingTarget = threat;
        const run = playerMovementVector(threat);
        const anticipation = clamp(18 + player.stats.reactions * 0.34 + player.stats.defending * 0.18, 22, 64);
        const futureX = threat.x + run.x * anticipation;
        const futureY = threat.y + run.y * anticipation;
        const rawMarkX = futureX + (ctx.ownGoal.centerX - futureX) * 0.3 + rep.rx;
        // Never follow the threat past 55px from the own goal line — avoids wall sticking
        // and prevents the back line from collapsing into the 6-yard box.
        const cappedMarkX = attackDir > 0
          ? Math.max(rawMarkX, field.left + 55)
          : Math.min(rawMarkX, field.right - 55);
        const tx = clamp(cappedMarkX, field.left + 15, field.right - 15);
        const ty = clamp(futureY + (ctx.field.centerY - futureY) * 0.04 + rep.ry, field.top + 20, field.bottom - 20);
        return { state: PlayerState.MarkOpponent, tx, ty };
      }
      player.markingTarget = null;
      return { state: PlayerState.ReturnToShape, tx: player.baseX + rep.rx, ty: player.baseY + rep.ry };
    }

    case PlayerRole.Midfielder: {
      // High-press: midfielders close from a wider range, but cap total pressers at 2
      // so they don't all pile onto the carrier and leave runners uncovered.
      // Aggressive players press from further away; base stays the same at aggression≈60
      const aggrBonus = (player.stats.aggression - 60) * 0.5;
      const pressRange = (ctx.directive?.phase === 'high-press' ? 290 : 210) + aggrBonus;
      const dToBall = dist(player.x, player.y, ball.x, ball.y);
      const pressCount = ctx.ownTeam.players.filter(
        p => p !== player && p.state === PlayerState.PressBall && !p.hasBall,
      ).length;
      const midCarrier = ctx.oppTeam.getBallCarrier();
      const canMidPress = pressCount === 0
        || (pressCount === 1 && midCarrier != null && shouldDoublePress(player, midCarrier, ctx));
      if (dToBall < pressRange && pressCount < 2 && canMidPress) {
        // Approach from slightly ahead of the carrier (between carrier and own goal),
        // not behind — attackDir points away from own goal, so subtract to cut the path.
        const tx = clamp(ball.x - attackDir * 20 + rep.rx, field.left + 15, field.right - 15);
        const ty = clamp(ball.y + rep.ry, field.top + 20, field.bottom - 20);
        return { state: PlayerState.PressBall, tx, ty };
      }
      const tx = clamp(player.baseX + rep.rx, field.left + 15, field.right - 15);
      const ty = clamp(player.baseY + (ball.y - player.baseY) * 0.07 + rep.ry, field.top + 20, field.bottom - 20);
      return { state: PlayerState.ReturnToShape, tx, ty };
    }

    case PlayerRole.Winger:
    case PlayerRole.Striker: {
      // Pressão para frente: ativada pela diretiva high-press OU pelo strikerPressBias (atacantes)
      const instrPressWS = ctx.playerInstructions?.get(player.id);
      const strikerPressBias = player.role === PlayerRole.Striker
        ? (ctx.tacticalProfile?.strikerPressBias ?? 0.4)
        : 0; // pontas usam apenas a diretiva de high-press
      const isHighPress = ctx.directive?.phase === 'high-press';
      // pressRange: 0 (sem press) → 120px (sem bias); 1 (sempre) → 340px; high-press sempre 320px
      // Instrução individual sobrescreve via pressRangeMultiplier
      const basePressRange = isHighPress ? 320 : 120 + strikerPressBias * 220;
      const pressRange = basePressRange * pressRangeMultiplier(instrPressWS);
      const dToBall = dist(player.x, player.y, ball.x, ball.y);
      if (dToBall < pressRange) {
        const tx = clamp(ball.x + attackDir * 30 + rep.rx, field.left + 15, field.right - 15);
        const ty = clamp(ball.y + rep.ry, field.top + 20, field.bottom - 20);
        return { state: PlayerState.PressBall, tx, ty };
      }
      // Retreat toward base but stay threat on transition; hold wide lane
      const tx = clamp(player.baseX - attackDir * 20 + rep.rx, field.left + 15, field.right - 15);
      const ty = clamp(player.baseY + (ball.y - player.baseY) * 0.04 + rep.ry, field.top + 20, field.bottom - 20);
      return { state: PlayerState.ReturnToShape, tx, ty };
    }
  }

  return { state: PlayerState.ReturnToShape, tx: player.baseX, ty: player.baseY };
}

function chooseMarkingTarget(defender: Player, ctx: AIContext): Player | null {
  const threats = ctx.oppTeam.players.filter(
    p => p.role === PlayerRole.Striker || p.role === PlayerRole.Winger || p.role === PlayerRole.Midfielder,
  );

  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const threat of threats) {
    const alreadyMarked = ctx.ownTeam.players.filter(
      p => p !== defender
        && p.role === PlayerRole.Defender
        && p.state === PlayerState.MarkOpponent
        && p.markingTarget === threat,
    ).length;

    const laneDistance = Math.abs(threat.y - defender.baseY);
    const travelDistance = dist(defender.x, defender.y, threat.x, threat.y);
    const goalDistance = Math.abs(threat.x - ctx.ownGoal.centerX);
    const centrality = 1 - clamp(Math.abs(threat.y - ctx.field.centerY) / (ctx.field.bottom - ctx.field.top), 0, 1);
    const run = playerMovementVector(threat);
    // Higher reactions → read the threat's run further ahead: reactions=50→60px, reactions=91→73px
    const lookAhead = 44 + (defender.stats.reactions / 100) * 32;
    const nextX = threat.x + run.x * lookAhead;
    const nextY = threat.y + run.y * lookAhead;
    const movingTowardGoal = clamp((goalDistance - Math.abs(nextX - ctx.ownGoal.centerX)) / lookAhead, -1, 1);
    const laneFit = 1 - clamp(Math.abs(nextY - defender.baseY) / 260, 0, 1);
    const currentTargetBonus = defender.markingTarget === threat ? 10 : 0;
    const roleThreat =
      threat.role === PlayerRole.Striker ? 26
      : threat.role === PlayerRole.Winger ? 18
      : 12;

    const score = roleThreat
      + centrality * 10
      + clamp((520 - goalDistance) / 520, 0, 1) * 22
      + movingTowardGoal * 16
      + laneFit * 8
      + currentTargetBonus
      - laneDistance * 0.22
      - travelDistance * 0.10
      - alreadyMarked * 38;

    if (score > bestScore) {
      bestScore = score;
      best = threat;
    }
  }

  // manMarkingBias: 0=zona (threshold alto → difícil comprometer individualmente)
  //                 1=individual (threshold baixo → sempre segue o adversário)
  const manBias = ctx.tacticalProfile?.manMarkingBias ?? 0.5;
  const markingThreshold = -18 + (1 - manBias) * 28;
  return bestScore > markingThreshold ? best : null;
}

// Returns the point on the ball's current trajectory where this player can arrive
// before (or at the same time as) the ball, enabling a sprint interception.
// Uses the actual ball velocity direction so angular pass deviation is respected.
// The closest eligible player wins — others yield via the betterMateExists check.
function findBallInterceptPoint(
  player: Player,
  ctx: AIContext,
): { tx: number; ty: number } | null {
  const { ball } = ctx;

  // Moving loose ball (deflection / rebound): no owner, no designated target, but rolling.
  // Project where it will land and let the closest eligible player sprint to intercept.
  if (!ball.owner && !ball.targetPlayer && ball.getSpeed() > 1.5) {
    const ballSpeed = ball.getSpeed();
    const pathDirX = ball.velocity.x / ballSpeed;
    const pathDirY = ball.velocity.y / ballSpeed;
    const totalEstDist = ballSpeed * 28; // rough rolling distance estimate
    const toPlayerX = player.x - ball.x;
    const toPlayerY = player.y - ball.y;
    const projScalar = toPlayerX * pathDirX + toPlayerY * pathDirY;
    const t = clamp(projScalar, 20, totalEstDist * 0.85);
    const estFrames = t / ballSpeed;
    const { x: ix, y: iy } = projectBallWithBounce(ball, estFrames, ctx.field);
    const playerDistToPoint = dist(player.x, player.y, ix, iy);
    const playerSprintSpeed = (0.55 + (player.stats.sprintSpeed / 100) * 0.45) * 1.85 * 1.28 * player.getStaminaFactor();
    const ballTimeToPoint   = estFrames;
    const playerTimeToPoint = playerDistToPoint / playerSprintSpeed;
    const margin = 1.0 + player.stats.reactions * 0.014 + player.stats.interceptions * 0.008;
    if (playerTimeToPoint > ballTimeToPoint + margin) return null;
    const laneRelevant = Math.abs(iy - player.baseY) < 195 || Math.abs(ix - ctx.ownGoal.centerX) < 370;
    if (!laneRelevant) return null;
    const betterMateExists = ctx.ownTeam.players.some(
      mate => mate !== player
        && mate.role !== PlayerRole.Goalkeeper
        && dist(mate.x, mate.y, ix, iy) < playerDistToPoint - 18,
    );
    if (betterMateExists) return null;
    return {
      tx: clamp(ix, ctx.field.left + 15, ctx.field.right - 15),
      ty: clamp(iy, ctx.field.top + 20, ctx.field.bottom - 20),
    };
  }

  if (ball.owner || !ball.targetPlayer || ball.getSpeed() < 1.5) return null;

  const target = ball.targetPlayer as Player;
  if (target.teamId === player.teamId) return null; // don't intercept own passes

  const ballSpeed = ball.getSpeed();
  const pathDirX = ball.velocity.x / ballSpeed;
  const pathDirY = ball.velocity.y / ballSpeed;

  // Use the receiver's run target as the ball's landing point (set by doPass)
  const destX = target.targetX;
  const destY = target.targetY;
  const totalPathLen = dist(ball.x, ball.y, destX, destY);
  if (totalPathLen < 40) return null;

  // Project player onto ball path to find the nearest intercept candidate
  const toPlayerX = player.x - ball.x;
  const toPlayerY = player.y - ball.y;
  const projScalar = toPlayerX * pathDirX + toPlayerY * pathDirY;
  const t = clamp(projScalar, totalPathLen * 0.05, totalPathLen * 0.90);
  const ix = ball.x + pathDirX * t;
  const iy = ball.y + pathDirY * t;

  const ballDistToPoint   = t;
  const playerDistToPoint = dist(player.x, player.y, ix, iy);

  // Compare arrival times. Ball decelerates slightly; player sprints from rest —
  // use sprint speed as an optimistic estimate for the player.
  // Must match the speed floor added in Player.ts: (0.55 + stat*0.45) * 1.85
  const playerSprintSpeed = (0.55 + (player.stats.sprintSpeed / 100) * 0.45) * 1.85 * 1.28 * player.getStaminaFactor();
  const ballTimeToPoint   = ballDistToPoint  / ballSpeed;
  const playerTimeToPoint = playerDistToPoint / playerSprintSpeed;

  // Intercept trait: reads the trajectory sooner, expands the time window
  const interceptBonus = traitBonus(player, TRAITS.INTERCEPT, 1.2, 0.8);
  const margin = 1.0
    + player.stats.reactions * 0.018
    + player.stats.defending * 0.010
    + player.stats.interceptions * 0.012
    + interceptBonus;
  if (playerTimeToPoint > ballTimeToPoint + margin) return null;

  // Zone relevance: stay in own lane or defend dangerous areas
  const laneRelevant = Math.abs(iy - player.baseY) < 195
    || Math.abs(ix - ctx.ownGoal.centerX) < 370;
  if (!laneRelevant) return null;

  // Only the closest eligible player attempts — others yield
  const betterMateExists = ctx.ownTeam.players.some(
    mate => mate !== player
      && mate.role !== PlayerRole.Goalkeeper
      && dist(mate.x, mate.y, ix, iy) < playerDistToPoint - 18,
  );
  if (betterMateExists) return null;

  return {
    tx: clamp(ix, ctx.field.left + 15, ctx.field.right - 15),
    ty: clamp(iy, ctx.field.top + 20, ctx.field.bottom - 20),
  };
}

function shouldStepOutForTackle(defender: Player, carrier: Player, ctx: AIContext): boolean {
  const d = defender.distanceTo(carrier);
  if (d < 38 || d > 270) return false;

  // First presser always goes; second presser evaluates contextually
  const pressCount = ctx.ownTeam.players.filter(
    p => p !== defender && p.state === PlayerState.PressBall && !p.hasBall,
  ).length;
  if (pressCount >= 2) return false;
  if (pressCount === 1 && !shouldDoublePress(defender, carrier, ctx)) return false;

  const towardOwnGoal = Math.abs(carrier.x - ctx.ownGoal.centerX);
  const carrierRun = playerMovementVector(carrier);
  const carrierNextGoalDistance = Math.abs((carrier.x + carrierRun.x * 70) - ctx.ownGoal.centerX);
  const drivingAtGoal = carrierNextGoalDistance < towardOwnGoal - 6;
  const drivingAcrossLane = Math.abs((carrier.y + carrierRun.y * 62) - defender.baseY) < 170;
  const danger = towardOwnGoal < 560 || Math.abs(carrier.y - ctx.field.centerY) < 165 || drivingAtGoal;
  const closeToLane = Math.abs(carrier.y - defender.baseY) < 220;
  if (!danger || (!closeToLane && !drivingAcrossLane)) return false;

  // Jockey: steps out more aggressively to engage carriers (+10 aggression, +6 for Plus)
  const aggressionScore = defender.stats.defending * 0.30
    + defender.stats.physical * 0.18
    + defender.stats.reactions * 0.10
    + defender.stats.aggression * 0.22   // aggressive players commit to tackles more readily
    + clamp((270 - d) / 270, 0, 1) * 28
    + (drivingAtGoal ? 10 : 0)
    + (drivingAcrossLane ? 6 : 0)
    + traitBonus(defender, TRAITS.JOCKEY, 10, 6);

  return aggressionScore > 44 && Math.random() < 0.88;
}

function playerMovementVector(player: Player): { x: number; y: number } {
  const speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
  if (speed > 0.18) return { x: player.vx / speed, y: player.vy / speed };

  const tx = player.targetX - player.x;
  const ty = player.targetY - player.y;
  const targetDist = Math.sqrt(tx * tx + ty * ty);
  if (targetDist > 8) return { x: tx / targetDist, y: ty / targetDist };

  return { x: player.attackDirection, y: 0 };
}

/**
 * Evaluates whether a second presser should join an ongoing press.
 * The decision is probability-based: proximity to goal, carrier threat, ability, direction,
 * and coverage cost all shift the likelihood — no hard cap.
 */
function shouldDoublePress(presser: Player, carrier: Player, ctx: AIContext): boolean {
  const goalDist = Math.abs(carrier.x - ctx.ownGoal.centerX);

  // Danger rises as carrier approaches goal (~560px = half-field)
  const dangerScore = clamp((560 - goalDist) / 560, 0, 1) * 40;

  // High-threat roles warrant more aggressive double-teaming
  const roleScore = carrier.role === PlayerRole.Striker ? 20
    : carrier.role === PlayerRole.Winger ? 15
    : carrier.role === PlayerRole.Midfielder ? 8
    : 3;

  // Skilled/fast carriers are harder for one defender to stop alone
  const abilityScore = ((carrier.stats.dribbling * 0.6 + carrier.stats.sprintSpeed * 0.4) / 100) * 14;

  // Bonus when carrier is actively running at goal
  const run = playerMovementVector(carrier);
  const nextGoalDist = Math.abs((carrier.x + run.x * 70) - ctx.ownGoal.centerX);
  const drivingBonus = nextGoalDist < goalDist - 6 ? 16 : 0;

  // Penalty when presser has a dangerous nearby mark that would be left free
  const markTarget = presser.markingTarget;
  const coveragePenalty = markTarget
    && (markTarget.role === PlayerRole.Striker || markTarget.role === PlayerRole.Winger)
    && presser.distanceTo(markTarget) < 140
    ? 28 : 0;

  // Aggressive pressers join double-press more readily
  const aggressionBonus = (presser.stats.aggression / 100) * 10;
  // High pressCoordination teams are more willing to double-press as a unit
  const pressCoordination = ctx.tacticalProfile?.pressCoordination ?? 0.4;
  const coordinationBonus = (pressCoordination - 0.4) * 20; // -4 to +10
  const urgency = dangerScore + roleScore + abilityScore + drivingBonus + aggressionBonus + coordinationBonus - coveragePenalty;

  // Probability scales from ~15% (low risk) to ~85% (very high risk)
  const chance = clamp(0.15 + urgency / 90, 0.15, 0.85);
  return Math.random() < chance;
}

function defensiveEngageTarget(
  defender: Player,
  carrier: Player,
  ctx: AIContext,
  rep: { rx: number; ry: number },
  lead: number,
): { state: PlayerState; tx: number; ty: number } {
  const run = playerMovementVector(carrier);
  const readQuality = (defender.stats.defending * 0.55 + defender.stats.reactions * 0.45) / 100;
  // When very close, target the carrier directly so the tackle range is actually reachable.
  const closeFactor = clamp(1 - (defender.distanceTo(carrier) - 28) / 32, 0, 1);
  const anticipation = lead * (0.70 + readQuality * 0.55) * (1 - closeFactor * 0.85);
  const predictedX = carrier.x + run.x * anticipation;
  const predictedY = carrier.y + run.y * anticipation;
  const goalCut = clamp(0.10 + readQuality * 0.12, 0.10, 0.22);
  const centerCut = carrier.role === PlayerRole.Winger ? 0.03 : 0.07;

  const tx = clamp(
    predictedX + (ctx.ownGoal.centerX - predictedX) * goalCut + rep.rx * 0.22,
    ctx.field.left + 15,
    ctx.field.right - 15,
  );
  const ty = clamp(
    predictedY + (ctx.field.centerY - predictedY) * centerCut + rep.ry * 0.22,
    ctx.field.top + 20,
    ctx.field.bottom - 20,
  );

  if (dist(defender.x, defender.y, tx, ty) > 58) defender.requestSprint(420, 42);
  return { state: PlayerState.PressBall, tx, ty };
}

function decideGkWithoutBall(
  player: Player,
  ctx: AIContext,
  ownHasBall: boolean,
): { state: PlayerState; tx: number; ty: number } {
  const { ball, field, ownGoal } = ctx;
  const goalCenterY = (ownGoal.top + ownGoal.bottom) / 2;
  const dir         = ctx.ownTeam.attackDirection;
  const positioningQuality = gkPositioningQuality(player);
  // Anchor all X-positioning to the actual goal line (field boundary), NOT to
  // ownGoal.centerX (which is off-field) or player.baseX (formation slot, ~85 px out).
  const goalLineX   = ownGoal.centerX < field.centerX ? field.left : field.right;

  if (ownHasBall) {
    const tx = clamp(goalLineX + dir * 22, field.left + 15, field.right - 15);
    const ty = clamp(
      goalCenterY + (ball.y - goalCenterY) * 0.20,
      ownGoal.top + 12, ownGoal.bottom - 12,
    );
    return { state: PlayerState.ReturnToShape, tx, ty };
  }

  const carrier = ctx.oppTeam.getBallCarrier();
  if (carrier) {
    const carrierGoalDist = Math.abs(carrier.x - goalLineX);
    const lateralOffset   = Math.abs(carrier.y - goalCenterY);
    const centralThreat   = lateralOffset < 155;

    if (carrierGoalDist < 235 && centralThreat) {
      // Central close threat: step out to narrow angle
      const pressureDepth = clamp(102 - carrierGoalDist * 0.22, 42, 96)
        * (0.82 + positioningQuality * 0.003);
      const tx = clamp(goalLineX + dir * pressureDepth, field.left + 15, field.right - 15);
      const yRead = 0.46 + positioningQuality * 0.0022;
      const error = gkPositioningError(player, ball, 42);
      const ty = clamp(goalCenterY + (carrier.y - goalCenterY) * yRead + error, ownGoal.top - 52, ownGoal.bottom + 52);
      return { state: PlayerState.PressBall, tx, ty };
    }

    if (carrierGoalDist < 260 && !centralThreat) {
      // Wide close threat: stay near the goal line inside the small area,
      // on the near-post side — closing the angle without exposing far post.
      const nearPostY = carrier.y < goalCenterY ? ownGoal.top : ownGoal.bottom;
      const tx = clamp(goalLineX + dir * 18, field.left + 15, field.right - 15);
      const nearPostRead = 0.12 + positioningQuality * 0.0012;
      const error = gkPositioningError(player, ball, 30);
      const ty = clamp(
        nearPostY + (goalCenterY - nearPostY) * nearPostRead + error,
        ownGoal.top, ownGoal.bottom,
      );
      return { state: PlayerState.PressBall, tx, ty };
    }
  }

  const claim = getGkClaimTarget(player, ctx, goalCenterY);
  if (claim) return claim;

  // ── Geometry ──────────────────────────────────────────────────────────────
  const nearPost = ball.y < goalCenterY ? ownGoal.top : ownGoal.bottom;
  const farPost  = ball.y < goalCenterY ? ownGoal.bottom : ownGoal.top;
  const ballFwd  = Math.abs(ball.x - goalLineX);   // depth from goal line: 0 = on line
  const ballPerp = Math.abs(ball.y - goalCenterY); // lateral: 0 = dead center

  // ── Step-out depth ────────────────────────────────────────────────────────
  // Reduced for wide angles: stepping out on a tight angle only exposes the near post.
  const defensiveLineX = getDefensiveLineX(ctx);
  const lineDepth = Math.abs(defensiveLineX - goalLineX);
  const sweeperDepth = clamp(lineDepth * 0.24, 18, 78);
  const ballDist = dist(ball.x, ball.y, goalLineX, goalCenterY);
  const rawStepOut = clamp(14 + (520 - ballDist) * 0.07 + sweeperDepth * 0.35, 10, 96);
  const wideAngleFactor = clamp(ballFwd / (ballFwd + ballPerp + 1), 0.15, 1.0);
  const stepOut = rawStepOut * wideAngleFactor * (0.82 + positioningQuality * 0.003);
  const tx = clamp(goalLineX + dir * stepOut, field.left + 15, field.right - 15);

  // ── Y: near-post sight line ↔ bisector blend ──────────────────────────────
  // stepT: fraction of the GK depth along the ball–goal axis (0 = on goal line, 1 = at ball).
  const stepT = ballFwd > 1 ? clamp(stepOut / ballFwd, 0, 0.85) : 0;

  // Near-post sight line: GK stands on the line from the near post to the ball.
  // This closes the near-post angle completely — the shooter can only aim far post.
  const nearPostLineY = nearPost + stepT * (ball.y - nearPost);

  // Angle bisector: covers both posts equally — correct for dead-center balls.
  const distNear = dist(ball.x, ball.y, goalLineX, nearPost);
  const distFar  = dist(ball.x, ball.y, goalLineX, farPost);
  const bisectorGoalY = (distFar * nearPost + distNear * farPost) / (distNear + distFar);
  const bisectorLineY = bisectorGoalY + stepT * (ball.y - bisectorGoalY);

  // wideness: 0 = straight-on, ≥2.5 = extreme byline
  // nearPostWeight: 0 (central) → 0.82 (very wide) — blends toward near-post line
  const wideness = clamp(ballPerp / (ballFwd + 1), 0, 2.5);
  const nearPostWeight = clamp((wideness - 0.15) / 1.2, 0, 0.55);
  const readWeight = clamp(0.66 + positioningQuality * 0.004, 0.66, 1);
  const idealY = nearPostLineY * nearPostWeight * readWeight
    + bisectorLineY * (1 - nearPostWeight * readWeight)
    + gkPositioningError(player, ball, 34);

  // y-limits: stay between posts (small buffer only when well stepped out)
  const postBuffer = clamp((stepOut - 18) * 0.5, 0, 16);
  const ty = clamp(idealY, ownGoal.top - postBuffer, ownGoal.bottom + postBuffer);

  return { state: PlayerState.ReturnToShape, tx, ty };
}

function getDefensiveLineX(ctx: AIContext): number {
  const defenders = ctx.ownTeam.players.filter(p => p.role === PlayerRole.Defender);
  if (defenders.length === 0) return ctx.ownGoal.centerX;
  return defenders.reduce((sum, p) => sum + p.x, 0) / defenders.length;
}

export function gkShotStoppingQuality(gk: Player): number {
  return (gk.stats.defending   / 100) * 55
    + (gk.stats.sprintSpeed / 100) * 20
    + (gk.stats.reactions   / 100) * 20
    + (gk.stats.physical    / 100) * 5;
}

function gkPositioningQuality(gk: Player): number {
  return (gk.stats.defending   / 100) * 45
    + (gk.stats.reactions   / 100) * 35
    + (gk.stats.sprintSpeed / 100) * 20;
}

export function gkDistributionQuality(gk: Player): number {
  return (gk.stats.shortPassing / 100) * 62
    + (gk.stats.reactions       / 100) * 28
    + (gk.stats.physical        / 100) * 10;
}

function gkPositioningError(gk: Player, ball: Ball, maxError: number): number {
  const quality = gkPositioningQuality(gk);
  // quality ranges ~55–95 in absolute terms (weighted /100). Map to error: 95→0, 55→1.
  const errorScale = clamp(1 - (quality - 55) / 40, 0, 1);
  const seed = gk.id.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return Math.sin(ball.x * 0.013 + ball.y * 0.017 + seed) * maxError * errorScale;
}

function getGkClaimTarget(
  gk: Player,
  ctx: AIContext,
  goalCenterY: number,
): { state: PlayerState; tx: number; ty: number } | null {
  const { ball, ownGoal, field } = ctx;
  const dir = ctx.ownTeam.attackDirection;
  const target = ball.targetPlayer as Player | null;
  const projectedX = clamp(ball.x + ball.velocity.x * 10, field.left + 15, field.right - 15);
  const projectedY = clamp(ball.y + ball.velocity.y * 10, field.top + 20, field.bottom - 20);
  const ballInClaimZone = Math.abs(projectedX - ownGoal.centerX) < 240
    && Math.abs(projectedY - goalCenterY) < 200;
  const targetIsOpponent = target && target.teamId !== gk.teamId;
  const targetIsSelf = target === gk;
  const looseBall = !ball.owner && !ball.targetPlayer;

  if (!ballInClaimZone || (!targetIsOpponent && !looseBall && !targetIsSelf)) return null;

  const gkDist = dist(gk.x, gk.y, projectedX, projectedY);
  const attackerDist = targetIsOpponent && target
    ? dist(target.x, target.y, projectedX, projectedY)
    : nearestOpponentDistance(ctx, projectedX, projectedY);
  // Deeper in the box → GK has more authority
  const deepAreaBonus = Math.abs(projectedX - ownGoal.centerX) < 165 ? 52 : 0;
  const centralBonus  = Math.abs(projectedY - goalCenterY) < 100 ? 36 : 0;
  // Better GKs reach faster balls and have more spatial advantage over attackers
  const claimQuality = gkShotStoppingQuality(gk);
  const speedTolerance = 7 + claimQuality * 0.075;
  const distAdvantage  = 45 + claimQuality * 0.52;
  // Self-targeted ball (backpass): GK always claims if in range — skip speed/competition check
  const canClaim = gkDist < 130 + claimQuality * 1.12 + deepAreaBonus + centralBonus
    && (targetIsSelf || ball.getSpeed() < speedTolerance || gkDist < attackerDist + distAdvantage);

  if (!canClaim) return null;

  return {
    state: PlayerState.PressBall,
    tx: clamp(projectedX - dir * 8, field.left + 15, field.right - 15),
    ty: projectedY,
  };
}

function nearestOpponentDistance(ctx: AIContext, x: number, y: number): number {
  let nearest = Infinity;
  for (const p of ctx.oppTeam.players) {
    const d = dist(p.x, p.y, x, y);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

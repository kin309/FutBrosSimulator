import { Player } from '../entities/Player';
import { PlayerState } from '../data/PlayerState';
import { PlayerRole } from '../data/PlayerRole';
import { AIContext, decideWithBall, decideWithoutBall, findBestPassTarget } from './DecisionUtils';
import { clamp, dist, distancePointToSegment } from '../utils/MathUtils';
import { computeGoalViewAngle } from './DecisionUtils';
import { SetPlayKind, SetPlayRole } from './TacticalAI';

const BALL_CARRIER_COOLDOWN = 260;
const OFF_BALL_COOLDOWN = 600;
const DEFENDER_PRESS_SPRINT_MIN_DISTANCE = 145;
const DEFENDER_MARK_SPRINT_MIN_DISTANCE = 185;
const DEFAULT_DEFENSIVE_SPRINT_MIN_DISTANCE = 105;

// px to move toward receiver before releasing the ball
const PRE_PASS_STEP = 40;

// Applies a set-play role immediately, bypassing the normal AI decision tree.
// Off-ball players move to their assigned coordinate; press-trap roles stay in PressBall.
function applySetPlayRole(player: Player, role: SetPlayRole, kind: SetPlayKind): void {
  player.state = kind === 'press-trap' ? PlayerState.PressBall : PlayerState.FindSpace;
  player.setTarget(role.targetX, role.targetY);
  if (role.sprint) player.requestSprint(resolveSprintMs(player, 600, 0.4));
  player.aiCooldown = 0;
}

export function updatePlayerAI(player: Player, ctx: AIContext, delta: number): void {
  updateCarryRisk(player, ctx, delta);

  if (player.state === PlayerState.GkDive) return;

  // Set-play roles override the normal off-ball AI entirely — no cooldown check
  if (!player.hasBall && ctx.directive?.setPlay) {
    const role = ctx.directive.setPlay.roles.get(player.id);
    if (role) {
      applySetPlayRole(player, role, ctx.directive.setPlay.kind);
      return;
    }
  }

  if (player.aiCooldown > 0) {
    const bypass = player.hasBall
      ? isCarrierUnderUrgentPressure(player, ctx)
      : shouldBypassCooldownForDefensiveReaction(player, ctx);
    if (!bypass) return;
  }

  // tempoBias: 0=muito lento → 1.4× cooldown; 0.5=normal → ~1.0×; 1=muito rápido → 0.65×
  const tempoScale = 1.4 - (ctx.tacticalProfile?.tempoBias ?? 0.5) * 0.75;

  if (player.hasBall) {
    player.markingTarget = null;

    // If already committed to a pass and still moving toward pre-pass target, wait
    if (player.state === PlayerState.Pass && player.passTarget) return;
    // Once committed to a clearance, let it execute without re-evaluating
    if (player.state === PlayerState.Clearance) return;
    // Maintain dribble approach while the escape waypoint is still ahead. If the
    // player already reached the jink point, let the AI re-evaluate instead of
    // freezing in Dribble with no contact.
    if (player.state === PlayerState.Dribble && player.dribbleTarget) {
      const d = dist(player.x, player.y, player.dribbleTarget.x, player.dribbleTarget.y);
      const targetDist = dist(player.x, player.y, player.targetX, player.targetY);
      const maxDribbleSeparation = player.dribbleCommitMs > 0 ? 130 : 100;
      if (d < maxDribbleSeparation && d > 20 && (targetDist > 10 || player.dribbleCommitMs > 0)) return;
      if (targetDist <= 10 || d >= maxDribbleSeparation) {
        player.dribbleTarget = null;
        player.dribbleCommitMs = 0;
        player.dribbleContactRadius = 38;
        player.state = PlayerState.CarryBall;
        player.aiCooldown = 0;
      }
    }

    player.aiCooldown = Math.round(BALL_CARRIER_COOLDOWN * tempoScale);
    const newState = decideWithBall(player, ctx);
    player.state = newState;
    if (newState !== PlayerState.Pass) {
      player.passTargetX = null;
      player.passTargetY = null;
      player.passKind = 'normal';
    }
    // CarryBall is a light, repositioning decision — shorten the window so the
    // player re-evaluates and can switch to pass/shoot sooner.
    if (newState === PlayerState.CarryBall) {
      player.aiCooldown = Math.round(BALL_CARRIER_COOLDOWN * 0.65 * tempoScale);
    }

    if (newState === PlayerState.CarryBall) {
      const distToTarget = dist(player.x, player.y, player.targetX, player.targetY);
      const reachedTarget = distToTarget < 28;
      const staleTarget = distToTarget > 200;
      const underPressure = isCarrierUnderUrgentPressure(player, ctx);
      if (reachedTarget || staleTarget || underPressure) {
        const carryTarget = chooseCarryTarget(player, ctx);
        player.setTarget(carryTarget.x, carryTarget.y);
        if (carryTarget.burst) player.requestSprint(resolveSprintMs(player, 360, 0.2), 55);
      }

    } else if (newState === PlayerState.Pass && player.passTarget) {
      // Step toward receiver before releasing — gives visible intent
      const rx = player.passTargetX ?? player.passTarget.x;
      const ry = player.passTargetY ?? player.passTarget.y;
      const angle = Math.atan2(ry - player.y, rx - player.x);
      const tx = clamp(player.x + Math.cos(angle) * PRE_PASS_STEP, ctx.field.left + 15, ctx.field.right - 15);
      const ty = clamp(player.y + Math.sin(angle) * PRE_PASS_STEP, ctx.field.top + 15, ctx.field.bottom - 15);
      player.setTarget(tx, ty);

    } else if (newState === PlayerState.ProtectBall) {
      // Shield the ball by moving away from the nearest pressing opponent.
      // If no pressure is close, fall back to a safe backward drift with lateral jink.
      const backDir = -ctx.ownTeam.attackDirection;
      const nearestOpp = ctx.oppTeam.getNearestPlayerTo(player.x, player.y);
      if (nearestOpp && nearestOpp.distanceTo(player) < 80) {
        // Predict where the opponent will be in ~7 frames to shield from their approach direction,
        // not just their current position.
        const predOppX = nearestOpp.x + nearestOpp.vx * 7;
        const predOppY = nearestOpp.y + nearestOpp.vy * 7;
        const dx = player.x - predOppX;
        const dy = player.y - predOppY;
        const dlen = Math.sqrt(dx * dx + dy * dy) || 1;
        player.setTarget(
          clamp(player.x + (dx / dlen) * 32 + backDir * 14, ctx.field.left + 15, ctx.field.right - 15),
          clamp(player.y + (dy / dlen) * 24, ctx.field.top + 15, ctx.field.bottom - 15),
        );
      } else {
        const lateral = (Math.random() - 0.5) * 35;
        player.setTarget(
          clamp(player.x + backDir * 28, ctx.field.left + 15, ctx.field.right - 15),
          clamp(player.y + lateral, ctx.field.top + 15, ctx.field.bottom - 15),
        );
      }

    } else if (newState === PlayerState.Clearance) {
      // Step slightly forward for wind-up before kicking
      const dir = ctx.ownTeam.attackDirection;
      player.setTarget(
        clamp(player.x + dir * 22, ctx.field.left + 15, ctx.field.right - 15),
        player.y,
      );

    } else if (newState === PlayerState.Dribble && player.dribbleTarget) {
      const blocker = player.dribbleTarget;
      const dir = ctx.ownTeam.attackDirection;
      const skill = (player.stats.dribbling * 0.72 + player.stats.sprintSpeed * 0.28) / 100;

      const pastDistance = 66 + skill * 34 + Math.random() * 24;
      const lateralDistance = 46 + skill * 24 + Math.random() * 22;
      const pastX = blocker.x + dir * pastDistance;
      const leftY  = blocker.y - lateralDistance;
      const rightY = blocker.y + lateralDistance;

      // Scan both escape lanes with a wider net: check defenders near the corridor
      // between player and escape point, not just at the destination.
      const scanThreat = (ey: number) => ctx.oppTeam.players.filter(p => {
        if (p === blocker) return false;
        const dToLane = distancePointToSegment(p.x, p.y, player.x, player.y, pastX, ey);
        return dToLane < 58 || dist(p.x, p.y, pastX, ey) < 80;
      }).length;
      const leftThreat  = scanThreat(leftY);
      const rightThreat = scanThreat(rightY);

      const escapeY = leftThreat <= rightThreat ? leftY : rightY;

      // Approach target: arrive alongside the blocker from the escape side rather
      // than charging head-on. The carrier angles toward the blocker's flank during
      // the commit window; the burst in doDribble carries them past.
      const approachX = blocker.x + dir * (pastDistance * 0.20);
      player.setTarget(
        clamp(approachX, ctx.field.left + 15, ctx.field.right - 15),
        clamp(escapeY, ctx.field.top + 15, ctx.field.bottom - 15),
      );
      player.dribbleCommitMs = Math.round(95 + skill * 165 + Math.random() * 140);
      player.dribbleContactRadius = 32 + Math.random() * 13;
      player.requestSprint(resolveSprintMs(player, 760 + Math.round(skill * 360), 0.7));
    }

    if (newState === PlayerState.CarryBall) {
      if (isDangerousArea(player, ctx.oppGoal.centerX)) {
        player.requestSprint(resolveSprintMs(player, 500, 0.5));
      } else if (player.carryRiskMs < 350) {
        // Free carrier with no pressure — sprint to cover ground
        player.requestSprint(resolveSprintMs(player, 300, 0.1));
      }
    }

  } else {
    // If the expected pass never arrives (ball abandoned / intercepted), escape ReceivePass.
    // Without this the player freezes permanently since the AI branch never fires for ReceivePass.
    if (player.state === PlayerState.ReceivePass && ctx.ball.targetPlayer !== player) {
      player.state = PlayerState.FindSpace;
    }
    if (player.state !== PlayerState.ReceivePass) {
      // GK repositions much more frequently — wide threats can appear in < 300 ms
      player.aiCooldown = player.role === PlayerRole.Goalkeeper ? 180 : Math.round(OFF_BALL_COOLDOWN * tempoScale);
      const { state, tx, ty } = decideWithoutBall(player, ctx);
      player.state = state;
      if (state !== PlayerState.MarkOpponent) player.markingTarget = null;
      player.setTarget(tx, ty);

      // Heat-map positioning: score every cell in a radius around the tactically
      // suggested target (tx, ty) by three factors:
      //   coldScore    — prefer zones with few teammates (spread out)
      //   progressScore — prefer cells forward in the attack direction
      //                  so cold-but-backward never beats warm-but-forward,
      //                  and a cold cell BEHIND a defensive line (heat cluster)
      //                  wins because it scores high on both axes simultaneously
      //   idealScore   — stay reasonably close to the tactical suggestion
      if (state === PlayerState.FindSpace && ctx.heatMap) {
        const teamIdx = player.teamId === 'teamA' ? 0 : 1;
        const attackDir = ctx.ownTeam.attackDirection;
        const { cols, rows, cellW, cellH } = ctx.heatMap;

        const centerCol = Math.floor((tx - ctx.field.left) / cellW);
        const centerRow = Math.floor((ty - ctx.field.top) / cellH);
        const radius = 4;

        let bestScore = -Infinity;
        let bestX = tx;
        let bestY = ty;

        for (let dr = -radius; dr <= radius; dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            const c = centerCol + dc;
            const r = centerRow + dr;
            if (c < 0 || c >= cols || r < 0 || r >= rows) continue;

            const wx = ctx.field.left + (c + 0.5) * cellW;
            const wy = ctx.field.top  + (r + 0.5) * cellH;

            const heat        = ctx.heatMap.getHeat(wx, wy, teamIdx);
            const coldScore   = 1 / (1 + heat);

            // Progress measured from the player's current position so "run behind"
            // targets far past a defensive cluster score well on this axis.
            const progress     = (wx - player.x) * attackDir;
            const progressScore = clamp(progress / 350, -0.4, 1.0);

            // Personal heatmap: Gaussian weight peaking at the player's formation
            // center. Tight spread = stay in position; wide spread = roam freely.
            const homeScore = player.positionHeatMap?.getWeight(wx, wy) ?? 1.0;

            // Proximity to the tactically computed target (minor pull).
            const dFromIdeal  = dist(wx, wy, tx, ty);
            const idealScore  = clamp(1 - dFromIdeal / (radius * Math.max(cellW, cellH) * 1.5), 0, 1);

            const score = coldScore * 0.40 + progressScore * 0.30 + homeScore * 0.20 + idealScore * 0.10;
            if (score > bestScore) {
              bestScore = score;
              bestX = wx;
              bestY = wy;
            }
          }
        }

        // Only apply if the winner differs meaningfully from the original target.
        if (dist(bestX, bestY, tx, ty) > cellW * 0.5) {
          player.setTarget(
            clamp(bestX, ctx.field.left + 15, ctx.field.right - 15),
            clamp(bestY, ctx.field.top  + 15, ctx.field.bottom - 15),
          );
        }
      }

      // Path corridor: sample global heat at two points in the first half of the
      // path toward the final target. If a hot zone (opponent cluster) is found,
      // insert a lateral detour waypoint to the cooler side so the player curves
      // around the cluster instead of running straight through it.
      // Attackers running at the opponent goal should not be rerouted around the GK/defenders —
      // they are supposed to run into defended space. Skip path detours when a Striker or Winger
      // is already targeting the final third (within 340px of the opponent goal).
      const isAttackerRunningAtGoal =
        (player.role === PlayerRole.Striker || player.role === PlayerRole.Winger)
        && Math.abs(player.targetX - ctx.oppGoal.centerX) < 340;

      if ((state === PlayerState.FindSpace || state === PlayerState.ReturnToShape)
          && ctx.heatMap && player.role !== PlayerRole.Goalkeeper
          && !isAttackerRunningAtGoal) {
        const fx = player.targetX;
        const fy = player.targetY;
        const pathDist = dist(player.x, player.y, fx, fy);

        if (pathDist > 95) {
          const dx = (fx - player.x) / pathDist;
          const dy = (fy - player.y) / pathDist;

          // Sample at 25 % and 45 % — first half only so the waypoint leads
          // the player past the nearest obstacle, not to a midpoint past it.
          let blockDist = -1;
          let blockHeat = 0;
          for (const t of [0.25, 0.45]) {
            const sx = player.x + dx * pathDist * t;
            const sy = player.y + dy * pathDist * t;
            const gh = ctx.heatMap.getHeat(sx, sy, 2); // global (both teams)
            if (gh > 2.2 && gh > blockHeat) { blockHeat = gh; blockDist = pathDist * t; }
          }

          if (blockDist > 0) {
            const perpX = -dy;
            const perpY =  dx;
            const offset = clamp(58 + blockHeat * 7, 58, 100);
            const hotX = player.x + dx * blockDist;
            const hotY = player.y + dy * blockDist;

            const leftHeat  = ctx.heatMap.getHeat(hotX + perpX * offset, hotY + perpY * offset, 2);
            const rightHeat = ctx.heatMap.getHeat(hotX - perpX * offset, hotY - perpY * offset, 2);
            const sign = leftHeat <= rightHeat ? 1 : -1;

            player.setTarget(
              clamp(hotX + perpX * sign * offset, ctx.field.left + 15, ctx.field.right - 15),
              clamp(hotY + perpY * sign * offset, ctx.field.top  + 15, ctx.field.bottom - 15),
            );
          }
        }
      }

      if (state === PlayerState.FindSpace || state === PlayerState.ReturnToShape) {
        const targetDist = dist(player.x, player.y, tx, ty);
        let nearestMateDist = Infinity;
        for (const mate of ctx.ownTeam.players) {
          if (mate === player) continue;
          const d = player.distanceTo(mate);
          if (d < nearestMateDist) nearestMateDist = d;
        }
        if (nearestMateDist < 44 && targetDist > 50) {
          // Too close to a teammate — sprint to create separation
          player.requestSprint(resolveSprintMs(player, 360, 0.1), 50);
        } else if (state === PlayerState.FindSpace && targetDist > 125) {
          // High-value open space far away — sprint to arrive before defenders adjust
          player.requestSprint(resolveSprintMs(player, 460, 0.15), 125);
        }
      }

      if (isDangerousArea(player, ctx.ownGoal.centerX)) {
        if (state === PlayerState.PressBall) {
          player.requestSprint(
            resolveSprintMs(player, 450, 0.85),
            player.role === PlayerRole.Defender
              ? DEFENDER_PRESS_SPRINT_MIN_DISTANCE
              : DEFAULT_DEFENSIVE_SPRINT_MIN_DISTANCE,
          );
        } else if (state === PlayerState.MarkOpponent && player.role === PlayerRole.Defender) {
          player.requestSprint(resolveSprintMs(player, 450, 0.75), DEFENDER_MARK_SPRINT_MIN_DISTANCE);
        }
      }

      // GK-specific sprint logic — the generic blocks above are too conservative for goalkeepers.
      if (player.role === PlayerRole.Goalkeeper && player.currentStamina > 25) {
        const targetDist = dist(player.x, player.y, tx, ty);
        // Repositioning sprint: after a save/dive/clearance the GK may be significantly
        // displaced. Sprint threshold scales with sprintSpeed — faster GKs react sooner.
        const repoSprintFrom = 125 - player.stats.sprintSpeed * 0.60;
        if (state === PlayerState.ReturnToShape && targetDist > repoSprintFrom) {
          player.requestSprint(resolveSprintMs(player, 540, 0.5), repoSprintFrom);
        }
        // Rush-out sprint: forceSprint overrides the 105 px floor of the generic block,
        // so the GK also bursts when closing the last 55–100 px in a 1v1 or loose-ball claim.
        if (state === PlayerState.PressBall && targetDist > 55) {
          player.forceSprint(resolveSprintMs(player, 420, 1.0));
        }
      }
    }
  }
}

function isDangerousArea(player: Player, goalX: number): boolean {
  return Math.abs(player.x - goalX) < 260;
}

function updateCarryRisk(player: Player, ctx: AIContext, delta: number): void {
  if (!player.hasBall || player.role === PlayerRole.Goalkeeper) {
    player.carryRiskMs = 0;
    player.carryDurationMs = 0;
    player.carryRiskAnchorX = player.x;
    player.carryRiskAnchorY = player.y;
    return;
  }

  const cappedDelta = Math.min(delta, 50);
  player.carryDurationMs += cappedDelta;

  const dir = ctx.ownTeam.attackDirection;
  const progress = (player.x - player.carryRiskAnchorX) * dir;
  const drift = dist(player.x, player.y, player.carryRiskAnchorX, player.carryRiskAnchorY);
  const nearestOpp = ctx.oppTeam.getNearestPlayerTo(player.x, player.y);
  const nearestOppDist = nearestOpp ? nearestOpp.distanceTo(player) : 999;
  const pressure = clamp((92 - nearestOppDist) / 92, 0, 1);
  const stalled = progress < 10 && drift < 46;
  const movingBackward = progress < -8;

  if (pressure > 0.18 || stalled || movingBackward) {
    const stallWeight = stalled ? 0.55 : 0;
    const backwardWeight = movingBackward ? 0.35 : 0;
    // Strength+balance resist being muscled off the ball.
    const physShield = 1 - ((player.stats.strength + player.stats.balance) / 200) * 0.32;
    player.carryRiskMs = clamp(
      player.carryRiskMs + cappedDelta * (0.45 + pressure * 1.15 + stallWeight + backwardWeight) * physShield,
      0,
      2200,
    );
  } else {
    player.carryRiskMs = Math.max(0, player.carryRiskMs - cappedDelta * 1.6);
  }

  if (progress > 28 || drift > 92) {
    player.carryRiskAnchorX = player.x;
    player.carryRiskAnchorY = player.y;
    player.carryRiskMs = Math.max(0, player.carryRiskMs - 260);
  }
}

function chooseCarryTarget(player: Player, ctx: AIContext): { x: number; y: number; burst: boolean } {
  const dir = ctx.ownTeam.attackDirection;
  const goalCenterY = (ctx.oppGoal.top + ctx.oppGoal.bottom) / 2;
  const oppIdx = player.teamId === 'teamA' ? 1 : 0;
  const nearestOpp = ctx.oppTeam.getNearestPlayerTo(player.x, player.y);
  const nearestOppDist = nearestOpp ? nearestOpp.distanceTo(player) : 999;
  const underPressure = nearestOppDist < 72;
  const closeToGoal = Math.abs(player.x - ctx.oppGoal.centerX) < 310;
  const attacker = player.role === PlayerRole.Striker || player.role === PlayerRole.Winger;
  const myMarker = ctx.oppTeam.players.find(p => p.markingTarget === player) ?? null;
  const anglePassTarget = findBestPassTarget(player, ctx);
  const currentPassLane = anglePassTarget
    ? nearestLaneBlockerDistance(player.x, player.y, anglePassTarget.x, anglePassTarget.y, ctx)
    : Infinity;
  const currentShotAngle = computeGoalViewAngle(player.x, player.y, ctx);
  const angleOpeningWanted =
    (anglePassTarget && currentPassLane < 52)
    || (closeToGoal && player.stats.finishing > 52 && currentShotAngle < 0.58);

  // Include forward=0 so pure lateral runs are always in the candidate set.
  const forwardDistances = underPressure ? [34, 58, 82] : [0, 62, 92, 126];
  const lateralOptions = underPressure
    ? [-96, -64, -34, 34, 64, 96, 0]
    : [-110, -80, -50, -22, 0, 22, 50, 80, 110];
  const candidates: Array<{ x: number; y: number; burst: boolean }> = [];

  for (const forward of forwardDistances) {
    for (const lateral of lateralOptions) {
      candidates.push({
        x: player.x + dir * forward,
        y: player.y + lateral,
        burst: forward > 88 && Math.abs(lateral) < 45,
      });
    }
  }

  if (angleOpeningWanted) {
    const lateralBase = player.y < goalCenterY ? -1 : 1;
    for (const side of [lateralBase, -lateralBase]) {
      for (const forward of [18, 36, 54]) {
        for (const lateral of [58, 86, 114]) {
          candidates.push({
            x: player.x + dir * forward,
            y: player.y + side * lateral,
            burst: forward >= 36 && lateral <= 86,
          });
        }
      }
    }
  }

  if (underPressure && nearestOpp) {
    // Use predicted opp position to escape toward where the steal threat is NOT heading.
    const predOppX = nearestOpp.x + nearestOpp.vx * 7;
    const predOppY = nearestOpp.y + nearestOpp.vy * 7;
    const awayX = player.x - predOppX;
    const awayY = player.y - predOppY;
    const len = Math.sqrt(awayX * awayX + awayY * awayY) || 1;
    candidates.push({
      x: player.x + (awayX / len) * 46 + dir * 18,
      y: player.y + (awayY / len) * 54,
      burst: false,
    });
  }

  // Lateral escape from a tracking marker: generate candidates perpendicular to the
  // marker's approach direction so the carrier can sidestep into open space.
  if (myMarker) {
    // Blend marker's current position with their velocity to get true approach direction.
    const mDx = (myMarker.x + myMarker.vx * 7) - player.x;
    const mDy = (myMarker.y + myMarker.vy * 7) - player.y;
    const mLen = Math.sqrt(mDx * mDx + mDy * mDy) || 1;
    const perpX = -mDy / mLen;
    const perpY = mDx / mLen;
    for (const side of [1, -1]) {
      for (const escDist of [60, 95, 130]) {
        candidates.push({
          x: player.x + perpX * side * escDist + dir * 22,
          y: player.y + perpY * side * escDist,
          burst: escDist >= 95,
        });
      }
    }
  }

  // Wide lateral probing for attackers: even without a marker, explore large open
  // pockets on either flank so wingers and strikers can shift the play into space.
  if (attacker && !underPressure) {
    for (const lat of [-145, -115, 115, 145]) {
      candidates.push({ x: player.x + dir * 28, y: player.y + lat, burst: false });
    }
  }

  let best = {
    x: clamp(player.x + dir * 70, ctx.field.left + 15, ctx.field.right - 15),
    y: clamp(player.y + (goalCenterY - player.y) * 0.12, ctx.field.top + 15, ctx.field.bottom - 15),
    burst: false,
    score: -Infinity,
  };

  for (const candidate of candidates) {
    const x = clamp(candidate.x, ctx.field.left + 15, ctx.field.right - 15);
    const y = clamp(candidate.y, ctx.field.top + 15, ctx.field.bottom - 15);
    const moveDist = dist(player.x, player.y, x, y);
    if (moveDist < 22) continue;

    let nearestAtTarget = Infinity;
    let laneBlock = Infinity;
    let frontBlock = Infinity;
    for (const opp of ctx.oppTeam.players) {
      if (opp.role === PlayerRole.Goalkeeper) continue;
      const targetDist = dist(opp.x, opp.y, x, y);
      if (targetDist < nearestAtTarget) nearestAtTarget = targetDist;

      const laneDist = distancePointToSegment(opp.x, opp.y, player.x, player.y, x, y);
      if (laneDist < laneBlock) laneBlock = laneDist;

      const ahead = (opp.x - player.x) * dir;
      if (ahead > -10 && ahead < 125) {
        const lateralGap = Math.abs(opp.y - y);
        if (lateralGap < frontBlock) frontBlock = lateralGap;
      }
    }

    let teammateAtTarget = Infinity;
    for (const mate of ctx.ownTeam.players) {
      if (mate === player) continue;
      const mateDist = dist(mate.x, mate.y, x, y);
      if (mateDist < teammateAtTarget) teammateAtTarget = mateDist;
    }

    const progress = (x - player.x) * dir;
    const goalDistance = Math.abs(x - ctx.oppGoal.centerX);
    const goalYBias = -Math.abs(y - goalCenterY) * (closeToGoal ? 0.025 : 0.008);
    const oppHeat = ctx.heatMap?.getHeat(x, y, oppIdx) ?? 0;
    const candidateShotAngle = computeGoalViewAngle(x, y, ctx);
    const shotAngleGain = candidateShotAngle - currentShotAngle;
    const shotAngleScore = closeToGoal && player.stats.finishing > 48
      ? clamp(shotAngleGain / 0.24, -0.35, 1) * (12 + player.stats.finishing * 0.18)
      : 0;
    const candidatePassLane = anglePassTarget
      ? nearestLaneBlockerDistance(x, y, anglePassTarget.x, anglePassTarget.y, ctx)
      : Infinity;
    const passLaneGain = anglePassTarget ? candidatePassLane - currentPassLane : 0;
    const passAngleScore = anglePassTarget
      ? clamp(passLaneGain / 64, -0.35, 1) * (13 + player.stats.shortPassing * 0.18)
      : 0;
    const openTarget = clamp((nearestAtTarget - 34) / 125, 0, 1) * 40;
    const clearLane = clamp((laneBlock - 24) / 95, 0, 1) * 28;
    const avoidFront = clamp((frontBlock - 24) / 86, 0, 1) * 22;
    const progressScore = clamp(progress / 115, -0.45, 1) * (attacker ? 26 : 18);
    const goalScore = clamp((520 - goalDistance) / 520, 0, 1) * (closeToGoal ? 18 : 8);
    const teammateSpace = clamp((teammateAtTarget - 38) / 105, 0, 1) * 12;
    const pressureEscape = underPressure && nearestOpp
      ? clamp((dist(x, y, nearestOpp.x, nearestOpp.y) - nearestOppDist) / 60, -1, 1) * 18
      : 0;
    // Reward positions that increase separation from the player tracking this carrier.
    const markerEscape = myMarker
      ? clamp(
          (dist(x, y, myMarker.x, myMarker.y) - dist(player.x, player.y, myMarker.x, myMarker.y)) / 70,
          -0.3, 1,
        ) * 26
      : 0;
    const boundaryPenalty = (x <= ctx.field.left + 18 || x >= ctx.field.right - 18) ? 30 : 0;
    // Near the opponent goal the GK always contributes heat to the grid, but the explicit
    // opponent-distance checks already exclude them (line above). Discount the heat-based
    // congestion penalty proportionally to goal proximity so the GK's presence doesn't
    // cancel the goalScore that should attract attackers into the box.
    // At 310px (closeToGoal edge): full weight. At 0px (on goal line): 25% weight.
    const heatWeight = closeToGoal ? clamp(goalDistance / 310, 0.25, 1.0) : 1.0;
    const congestionPenalty = oppHeat * 9 * heatWeight;
    const hardBlockPenalty = nearestAtTarget < 28 || laneBlock < 18 ? 38 : 0;
    const overDribblePenalty = player.role === PlayerRole.Defender && progress > 90 ? 16 : 0;

    const score = openTarget
      + clearLane
      + avoidFront
      + progressScore
      + goalScore
      + shotAngleScore
      + passAngleScore
      + teammateSpace
      + pressureEscape
      + markerEscape
      + goalYBias
      - boundaryPenalty
      - congestionPenalty
      - hardBlockPenalty
      - overDribblePenalty;

    if (score > best.score) {
      best = { x, y, burst: candidate.burst && score > 54, score };
    }
  }

  return { x: best.x, y: best.y, burst: best.burst };
}


// Returns the sprint duration the player will actually request, or 0 if fatigue wins out.
// urgency (0–1): how critical the situation is. Higher urgency lets tired players push through.
//   0.0 = voluntary movement (find space, cover ground)
//   0.5 = tactical effort (carry ball, dribble escape)
//   1.0 = defensive emergency (last-ditch tackle, GK rush)
// Probability model: Math.pow(s/70, 1.5 - urgency)
//   urgency=0 → exponent 1.5: voluntary sprints drop off quickly with fatigue
//   urgency=1 → exponent 0.5: urgent sprints stay likely even when exhausted
// Duration also scales with remaining stamina; urgency adds a small adrenaline boost.
function resolveSprintMs(player: Player, baseDurationMs: number, urgency = 0): number {
  const s = player.currentStamina;
  if (s >= 80) return baseDurationMs;
  if (s < 12) return 0; // MIN_STAMINA_TO_SPRINT enforced by requestSprint too
  if (Math.random() > Math.pow(s / 80, 1.5 - urgency)) return 0;
  const durationFactor = clamp(0.35 + (s / 80) * 0.65 + urgency * 0.10, 0.35, 1.10);
  const ms = Math.round(baseDurationMs * durationFactor);
  return ms < 120 ? 0 : ms;
}

function nearestLaneBlockerDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ctx: AIContext,
): number {
  let laneBlock = Infinity;
  for (const opp of ctx.oppTeam.players) {
    if (opp.role === PlayerRole.Goalkeeper) continue;
    const laneDist = distancePointToSegment(opp.x, opp.y, ax, ay, bx, by);
    if (laneDist < laneBlock) laneBlock = laneDist;
  }
  return laneBlock;
}


// Ball carriers bypass their cooldown when an opponent closes within 42 px so
// they react immediately instead of waiting the full 400 ms decision window.
function isCarrierUnderUrgentPressure(player: Player, ctx: AIContext): boolean {
  const nearestOpp = ctx.oppTeam.getNearestPlayerTo(player.x, player.y);
  return !!nearestOpp && nearestOpp.distanceTo(player) < 58;
}

function shouldBypassCooldownForDefensiveReaction(player: Player, ctx: AIContext): boolean {
  if (player.hasBall) return false;

  if (player.role === PlayerRole.Goalkeeper) {
    const goalCenterY = (ctx.ownGoal.top + ctx.ownGoal.bottom) / 2;
    const target = ctx.ball.targetPlayer as Player | null;
    // Backpass directly to this GK: bypass cooldown so they react immediately, wherever the ball is.
    if (target === player && !ctx.ball.owner) return true;
    const projectedX = ctx.ball.x + ctx.ball.velocity.x * 10;
    const projectedY = ctx.ball.y + ctx.ball.velocity.y * 10;
    const ballInClaimZone = Math.abs(projectedX - ctx.ownGoal.centerX) < 220
      && Math.abs(projectedY - goalCenterY) < 165;
    if (ballInClaimZone && (!ctx.ball.owner || (target && target.teamId !== player.teamId))) return true;

    const carrier = ctx.oppTeam.getBallCarrier();
    return !!carrier
      && Math.abs(carrier.x - ctx.ownGoal.centerX) < 250
      && Math.abs(carrier.y - goalCenterY) < 140;
  }

  // Any player can bypass cooldown when a ball in flight is close — enables sprint interception.
  const flyingTarget = ctx.ball.targetPlayer as Player | null;
  if (!ctx.ball.owner && flyingTarget && flyingTarget.teamId !== player.teamId && ctx.ball.getSpeed() > 1.5) {
    if (player.distanceToBall(ctx.ball) < 195) return true;
  }

  // Truly loose ball (no owner, no target) rolling nearby — any outfield player reacts immediately.
  if (!ctx.ball.owner && !ctx.ball.targetPlayer && ctx.ball.getSpeed() > 1.5) {
    if (player.distanceToBall(ctx.ball) < 150) return true;
  }

  // Ball in flight toward a teammate: attackers and midfielders reposition immediately
  // to arrive in space as the new carrier controls it (third-man timing).
  if (!ctx.ball.owner && flyingTarget && flyingTarget.teamId === player.teamId
      && flyingTarget !== player && ctx.ball.getSpeed() > 1.5) {
    if (player.role === PlayerRole.Striker || player.role === PlayerRole.Winger
        || player.role === PlayerRole.Midfielder) {
      return true;
    }
  }

  // Midfielders re-evaluate quickly when a carrier enters their zone
  if (player.role === PlayerRole.Midfielder) {
    const carrier = ctx.oppTeam.getBallCarrier();
    return !!carrier && player.distanceTo(carrier) < 175 && isDangerousArea(carrier, ctx.ownGoal.centerX);
  }

  if (player.role !== PlayerRole.Defender) return false;

  const target = ctx.ball.targetPlayer as Player | null;
  if (target && target.teamId !== player.teamId && ctx.ball.getSpeed() > 1.3) {
    return player.distanceToBall(ctx.ball) < 230;
  }

  const carrier = ctx.oppTeam.getBallCarrier();
  return !!carrier && player.distanceTo(carrier) < 170 && isDangerousArea(carrier, ctx.ownGoal.centerX);
}

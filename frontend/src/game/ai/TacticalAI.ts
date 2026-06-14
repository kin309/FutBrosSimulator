import { Ball } from '../entities/Ball';
import { Team } from '../entities/Team';
import { Player } from '../entities/Player';
import { PlayerRole } from '../data/PlayerRole';
import { FieldBounds, GoalBounds } from '../types';
import { clamp } from '../utils/MathUtils';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TacticalPhase = 'build-up' | 'hold-shape' | 'high-press' | 'counterattack';

export type SetPlayKind = 'press-trap' | 'overlap' | 'counter-launch';

export interface SetPlayRole {
  targetX: number;
  targetY: number;
  sprint: boolean;
}

export interface ActiveSetPlay {
  kind: SetPlayKind;
  roles: Map<string, SetPlayRole>;
  timeLeftMs: number;
}

export interface TacticalDirective {
  phase: TacticalPhase;
  setPlay: ActiveSetPlay | null;
}

export interface GameContext {
  scoreOwn: number;
  scoreOpp: number;
  elapsedMs: number;
  halfLengthMs: number;
}

// ─── Phase detection ──────────────────────────────────────────────────────────

export function detectPhase(
  ownTeam: Team,
  oppTeam: Team,
  ball: Ball,
  field: FieldBounds,
  gameCtx: GameContext,
  manualPhase: TacticalPhase | null,
): TacticalPhase {
  if (manualPhase !== null) return manualPhase;

  const dir = ownTeam.attackDirection;

  if (ownTeam.hasPossession()) {
    const carrier = ownTeam.getBallCarrier();
    if (carrier) {
      const inOwnHalf = (carrier.x - field.centerX) * dir < 0;
      if (inOwnHalf) {
        const runnersAhead = ownTeam.players.filter(p =>
          p !== carrier &&
          (p.role === PlayerRole.Striker || p.role === PlayerRole.Winger) &&
          (p.x - carrier.x) * dir > 60,
        ).length;
        if (runnersAhead >= 1) return 'counterattack';
      }
    }
    return 'build-up';
  }

  const carrier = oppTeam.getBallCarrier();
  if (carrier) {
    const avgStamina = ownTeam.players.reduce((s, p) => s + p.currentStamina, 0) / ownTeam.players.length;
    const losingLate = gameCtx.scoreOwn < gameCtx.scoreOpp
      && gameCtx.elapsedMs > gameCtx.halfLengthMs * 0.55;
    const energyOk = avgStamina > 28 || losingLate;

    if (energyOk) {
      // Opponent carrier in their own half → press them back
      const carrierInOppHalf = (carrier.x - field.centerX) * (-dir) < 60;
      if (carrierInOppHalf) return 'high-press';
    }
  }

  return 'hold-shape';
}

// ─── Set play triggers ────────────────────────────────────────────────────────

export function tryTriggerSetPlay(
  ownTeam: Team,
  oppTeam: Team,
  ball: Ball,
  oppGoal: GoalBounds,
  field: FieldBounds,
  phase: TacticalPhase,
): ActiveSetPlay | null {
  switch (phase) {
    case 'counterattack': return tryCounterLaunch(ownTeam, oppGoal, field);
    case 'high-press':    return tryPressTrap(ownTeam, oppTeam, field);
    case 'build-up':      return tryOverlap(ownTeam, field);
    default:              return null;
  }
}

// Counter-launch: strikers sprint into channels behind the defence.
function tryCounterLaunch(
  ownTeam: Team,
  oppGoal: GoalBounds,
  field: FieldBounds,
): ActiveSetPlay | null {
  const carrier = ownTeam.getBallCarrier();
  if (!carrier) return null;

  const dir = ownTeam.attackDirection;
  const runners = ownTeam.players.filter(p =>
    p !== carrier &&
    (p.role === PlayerRole.Striker || p.role === PlayerRole.Winger),
  );
  if (runners.length === 0) return null;

  const roles = new Map<string, SetPlayRole>();

  runners.slice(0, 2).forEach((runner, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const targetX = clamp(oppGoal.centerX - dir * 110, field.left + 28, field.right - 28);
    const targetY = clamp(field.centerY + side * 105, field.top + 30, field.bottom - 30);
    roles.set(runner.id, { targetX, targetY, sprint: true });
  });

  return { kind: 'counter-launch', roles, timeLeftMs: 2800 };
}

// Press-trap: three outfield players fan out to block the ball carrier's escape routes.
function tryPressTrap(
  ownTeam: Team,
  oppTeam: Team,
  field: FieldBounds,
): ActiveSetPlay | null {
  const carrier = oppTeam.getBallCarrier();
  if (!carrier) return null;

  // Only trigger when carrier is wide and away from either goal — good trapping ground
  const wide = Math.abs(carrier.y - field.centerY) > 90;
  const reachable = Math.abs(carrier.x - field.centerX) < 420;
  if (!wide || !reachable) return null;

  const closestThree = ownTeam.players
    .filter(p => p.role !== PlayerRole.Goalkeeper)
    .sort((a, b) => a.distanceTo(carrier) - b.distanceTo(carrier))
    .slice(0, 3);

  if (closestThree.length < 2) return null;

  const dir = ownTeam.attackDirection;
  const r = 52;
  // Three angles relative to the carrier: one in front, two from the sides
  const angles = [0, Math.PI * 0.70, -Math.PI * 0.70];
  const roles = new Map<string, SetPlayRole>();

  closestThree.forEach((p, i) => {
    const angle = angles[i] + (dir > 0 ? 0 : Math.PI);
    const targetX = clamp(carrier.x + Math.cos(angle) * r, field.left + 15, field.right - 15);
    const targetY = clamp(carrier.y + Math.sin(angle) * r, field.top + 15, field.bottom - 15);
    roles.set(p.id, { targetX, targetY, sprint: true });
  });

  return { kind: 'press-trap', roles, timeLeftMs: 2200 };
}

// Overlap: when a winger has the ball on the flank, the near fullback sprints beyond them.
function tryOverlap(
  ownTeam: Team,
  field: FieldBounds,
): ActiveSetPlay | null {
  const carrier = ownTeam.getBallCarrier();
  if (!carrier || carrier.role !== PlayerRole.Winger) return null;

  const dir = ownTeam.attackDirection;
  const isFlank = Math.abs(carrier.y - field.centerY) > 80;
  if (!isFlank) return null;

  const side = carrier.y < field.centerY ? -1 : 1;
  const overlapper = ownTeam.players.find(p =>
    p.role === PlayerRole.Defender &&
    Math.sign(p.baseY - field.centerY) === side &&
    p.distanceTo(carrier) < 280,
  );
  if (!overlapper) return null;

  const roles = new Map<string, SetPlayRole>();
  const targetX = clamp(carrier.x + dir * 148, field.left + 20, field.right - 20);
  const targetY = clamp(carrier.y + side * 28, field.top + 20, field.bottom - 20);
  roles.set(overlapper.id, { targetX, targetY, sprint: true });
  // Winger holds while the overlapper arrives
  roles.set(carrier.id, { targetX: carrier.x, targetY: carrier.y, sprint: false });

  return { kind: 'overlap', roles, timeLeftMs: 2500 };
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

export function tickSetPlay(play: ActiveSetPlay, delta: number): ActiveSetPlay | null {
  const remaining = play.timeLeftMs - delta;
  return remaining > 0 ? { ...play, timeLeftMs: remaining } : null;
}

import { PlayerRole } from '../data/PlayerRole';
import type { TacticalProfile } from '../data/TacticalProfile';

const BASE_SPREAD = 60;
const SPREAD_RANGE = 200;

const ROLE_SPREAD_MULT: Partial<Record<PlayerRole, number>> = {
  [PlayerRole.Goalkeeper]: 0, // handled separately — always minimal
  [PlayerRole.Defender]:   0.7,
  [PlayerRole.Midfielder]: 1.0,
  [PlayerRole.Winger]:     1.2,
  [PlayerRole.Striker]:    1.1,
};

// Returns the Gaussian spread in pixels for a player given their role and team profile.
export function calcPositionSpread(profile: TacticalProfile, role: PlayerRole): number {
  if (role === PlayerRole.Goalkeeper) return 40;
  const mult = ROLE_SPREAD_MULT[role] ?? 1.0;
  return BASE_SPREAD + profile.positionFreedom * SPREAD_RANGE * mult;
}

/**
 * Per-player Gaussian weight map defining their preferred zone on the pitch.
 * Peak weight (1.0) is at the formation center (cx, cy); weight decays with
 * distance according to the spread. A narrow spread keeps players close to
 * their formation spot; a wide spread allows free roaming across a zone.
 */
export class PlayerHeatMap {
  private spreadSq: number;

  constructor(
    readonly cx: number,
    readonly cy: number,
    spread: number,
  ) {
    this.spreadSq = spread * spread;
  }

  setSpread(spread: number): void {
    this.spreadSq = spread * spread;
  }

  // Returns 0–1 preference weight for world position (x, y).
  getWeight(x: number, y: number): number {
    const dx = x - this.cx;
    const dy = y - this.cy;
    return Math.exp(-(dx * dx + dy * dy) / (2 * this.spreadSq));
  }
}

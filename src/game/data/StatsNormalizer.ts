import { PlayerStats } from './PlayerStats';

const STAT_KEYS: (keyof PlayerStats)[] = [
  'overall', 'speed', 'passing', 'shooting', 'dribbling',
  'defending', 'physical', 'intelligence', 'stamina',
];

interface StatRange { min: number; max: number }

class StatsNormalizer {
  private ranges: Record<keyof PlayerStats, StatRange>;

  constructor() {
    // Default 0-100 → norm() is identity until a real pool is loaded
    const full = { min: 0, max: 100 };
    this.ranges = Object.fromEntries(STAT_KEYS.map(k => [k, { ...full }])) as Record<keyof PlayerStats, StatRange>;
  }

  computeFrom(pool: PlayerStats[]): void {
    if (pool.length === 0) return;
    for (const key of STAT_KEYS) {
      const values = pool.map(s => s[key]).filter(v => v > 0);
      if (values.length === 0) continue;
      this.ranges[key] = { min: Math.min(...values), max: Math.max(...values) };
    }
  }

  /** Maps a raw stat value to [0, 1] relative to the loaded player pool. */
  norm(value: number, stat: keyof PlayerStats): number {
    const { min, max } = this.ranges[stat];
    if (max === min) return 0.5;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }
}

export const statsNormalizer = new StatsNormalizer();

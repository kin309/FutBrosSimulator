// Shared occupancy grid updated once per frame.
// Each player contributes heat to a 3×3 neighbourhood (gaussian-like kernel)
// so nearby clusters amplify each other into visible hotspots instead of
// appearing as isolated single-cell dots.
//
// Grid index convention:  0 = teamA,  1 = teamB,  2 = global (both combined)

// Gaussian-like 3×3 kernel weights (center = 1.0)
const KERNEL: ReadonlyArray<ReadonlyArray<number>> = [
  [0.20, 0.45, 0.20],
  [0.45, 1.00, 0.45],
  [0.20, 0.45, 0.20],
];

function cellClamp(v: number, max: number): number {
  return v < 0 ? 0 : v >= max ? max - 1 : v;
}

export type HeatTeamIndex = 0 | 1 | 2; // 0=A  1=B  2=global

export class FieldHeatMap {
  readonly cols: number;
  readonly rows: number;
  readonly cellW: number;
  readonly cellH: number;

  private readonly grids: [Float32Array, Float32Array];

  constructor(
    private readonly left: number,
    private readonly top: number,
    private readonly right: number,
    private readonly bottom: number,
    cols = 20,
    rows = 12,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.cellW = (right - left) / cols;
    this.cellH = (bottom - top) / rows;
    this.grids = [
      new Float32Array(cols * rows),
      new Float32Array(cols * rows),
    ];
  }

  // Call once per frame before the AI tick.
  update(
    teamAPlayers: ReadonlyArray<{ x: number; y: number }>,
    teamBPlayers: ReadonlyArray<{ x: number; y: number }>,
    decay = 0.88,
  ): void {
    const all = [teamAPlayers, teamBPlayers] as const;
    for (let g = 0; g < 2; g++) {
      const grid = this.grids[g];
      for (let i = 0; i < grid.length; i++) grid[i] *= decay;
      for (const p of all[g]) {
        const col = Math.floor((p.x - this.left) / this.cellW);
        const row = Math.floor((p.y - this.top) / this.cellH);
        this.addKernel(grid, col, row);
      }
    }
  }

  // Occupancy at world position (x,y).
  // teamIndex 2 = sum of both teams (global density).
  getHeat(x: number, y: number, teamIndex: HeatTeamIndex): number {
    const col = Math.floor((x - this.left) / this.cellW);
    const row = Math.floor((y - this.top) / this.cellH);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return 0;
    const idx = row * this.cols + col;
    return teamIndex === 2
      ? this.grids[0][idx] + this.grids[1][idx]
      : this.grids[teamIndex][idx];
  }

  // World-center of the least-occupied cell within searchRadius cells of (x,y).
  findCoolestCell(
    x: number,
    y: number,
    teamIndex: HeatTeamIndex,
    searchRadius = 3,
  ): { x: number; y: number } | null {
    const col = cellClamp(Math.floor((x - this.left) / this.cellW), this.cols);
    const row = cellClamp(Math.floor((y - this.top) / this.cellH), this.rows);

    let bestHeat = Infinity;
    let bestCol = -1;
    let bestRow = -1;

    for (let dr = -searchRadius; dr <= searchRadius; dr++) {
      for (let dc = -searchRadius; dc <= searchRadius; dc++) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) continue;
        const wx = this.left + (c + 0.5) * this.cellW;
        const wy = this.top + (r + 0.5) * this.cellH;
        const heat = this.getHeat(wx, wy, teamIndex);
        if (heat < bestHeat) {
          bestHeat = heat;
          bestCol = c;
          bestRow = r;
        }
      }
    }

    if (bestCol < 0) return null;
    return {
      x: this.left + (bestCol + 0.5) * this.cellW,
      y: this.top + (bestRow + 0.5) * this.cellH,
    };
  }

  // ── private ──────────────────────────────────────────────────────────────────

  private addKernel(grid: Float32Array, col: number, row: number): void {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) continue;
        grid[r * this.cols + c] += KERNEL[dr + 1][dc + 1];
      }
    }
  }
}

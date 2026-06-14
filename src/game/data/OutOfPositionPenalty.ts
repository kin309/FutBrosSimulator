import { PlayerRole } from './PlayerRole';
import { PlayerStats } from './PlayerStats';

// Penalty percentages per stat (0 = no reduction, 0.30 = reduce by 30%).
// Speed and physical are never penalized — they are athletic attributes that
// don't change with positional role. Only technical/positional stats suffer.
interface StatPenalties {
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  intelligence: number;
  stamina: number;
}

const NONE: StatPenalties = {
  shooting: 0, passing: 0, dribbling: 0, defending: 0, intelligence: 0, stamina: 0,
};

// ─── Penalty matrix ────────────────────────────────────────────────────────
// PENALTY[naturalRole][slotRole] — how much each stat drops when a player of
// naturalRole is fielded in slotRole.
// Design principles:
//   • Adjacent roles (MID↔WIN, WIN↔STR) → light penalty, mainly intelligence
//   • One step apart (DEF↔MID, MID↔STR) → moderate penalty on role-specific stats
//   • Two steps apart (DEF↔STR, DEF↔WIN) → severe penalty
//   • GK ↔ any field / any field → GK → very severe (completely different skillset)
const PENALTY: Record<PlayerRole, Record<PlayerRole, StatPenalties>> = {

  [PlayerRole.Goalkeeper]: {
    [PlayerRole.Goalkeeper]: NONE,
    // GK trying to play outfield — can run but lacks all technical/positional skills
    [PlayerRole.Defender]:   { shooting: 0.42, passing: 0.32, dribbling: 0.48, defending: 0.28, intelligence: 0.40, stamina: 0.10 },
    [PlayerRole.Midfielder]: { shooting: 0.50, passing: 0.38, dribbling: 0.56, defending: 0.30, intelligence: 0.46, stamina: 0.12 },
    [PlayerRole.Winger]:     { shooting: 0.55, passing: 0.40, dribbling: 0.60, defending: 0.26, intelligence: 0.50, stamina: 0.14 },
    [PlayerRole.Striker]:    { shooting: 0.55, passing: 0.42, dribbling: 0.60, defending: 0.24, intelligence: 0.50, stamina: 0.14 },
  },

  [PlayerRole.Defender]: {
    // Defender → GK: no feel for shot-stopping, angles, footwork
    [PlayerRole.Goalkeeper]: { shooting: 0, passing: 0.28, dribbling: 0.38, defending: 0.40, intelligence: 0.44, stamina: 0.10 },
    [PlayerRole.Defender]:   NONE,
    // Defender → Midfielder: unfamiliar forward passing lanes, decision-making in tight space
    [PlayerRole.Midfielder]: { shooting: 0.14, passing: 0.14, dribbling: 0.12, defending: 0, intelligence: 0.13, stamina: 0 },
    // Defender → Winger: poor crossing, dribbling in attack, poor shooting angle reads
    [PlayerRole.Winger]:     { shooting: 0.22, passing: 0.14, dribbling: 0.24, defending: 0, intelligence: 0.20, stamina: 0.05 },
    // Defender → Striker: very poor finishing, no movement off the ball in attack
    [PlayerRole.Striker]:    { shooting: 0.34, passing: 0.14, dribbling: 0.32, defending: 0, intelligence: 0.28, stamina: 0.08 },
  },

  [PlayerRole.Midfielder]: {
    // Midfielder → GK: same as DEF→GK, lacks specialist skills
    [PlayerRole.Goalkeeper]: { shooting: 0, passing: 0.26, dribbling: 0.36, defending: 0.42, intelligence: 0.44, stamina: 0.10 },
    // Midfielder → Defender: unfamiliar defensive positioning, marking, covering
    [PlayerRole.Defender]:   { shooting: 0, passing: 0, dribbling: 0, defending: 0.16, intelligence: 0.13, stamina: 0 },
    [PlayerRole.Midfielder]: NONE,
    // Midfielder → Winger: slightly less comfortable in wide 1v1 situations
    [PlayerRole.Winger]:     { shooting: 0.09, passing: 0, dribbling: 0.07, defending: 0, intelligence: 0.07, stamina: 0 },
    // Midfielder → Striker: poor finishing and forward movement reads
    [PlayerRole.Striker]:    { shooting: 0.18, passing: 0, dribbling: 0.12, defending: 0, intelligence: 0.16, stamina: 0.05 },
  },

  [PlayerRole.Winger]: {
    [PlayerRole.Goalkeeper]: { shooting: 0, passing: 0.26, dribbling: 0.36, defending: 0.42, intelligence: 0.44, stamina: 0.10 },
    // Winger → Defender: poor defensive shape, covering runs, marking
    [PlayerRole.Defender]:   { shooting: 0, passing: 0, dribbling: 0, defending: 0.24, intelligence: 0.20, stamina: 0.06 },
    // Winger → Midfielder: slightly less comfortable in central distribution
    [PlayerRole.Midfielder]: { shooting: 0, passing: 0.07, dribbling: 0, defending: 0.06, intelligence: 0.07, stamina: 0 },
    [PlayerRole.Winger]:     NONE,
    // Winger → Striker: natural transition — minor penalty on finishing only
    [PlayerRole.Striker]:    { shooting: 0.07, passing: 0, dribbling: 0, defending: 0, intelligence: 0.07, stamina: 0 },
  },

  [PlayerRole.Striker]: {
    [PlayerRole.Goalkeeper]: { shooting: 0, passing: 0.26, dribbling: 0.36, defending: 0.45, intelligence: 0.46, stamina: 0.10 },
    // Striker → Defender: very poor defensive positioning, marking, tackling mindset
    [PlayerRole.Defender]:   { shooting: 0, passing: 0, dribbling: 0, defending: 0.32, intelligence: 0.30, stamina: 0.08 },
    // Striker → Midfielder: poor defensive contribution, unfamiliar distribution
    [PlayerRole.Midfielder]: { shooting: 0, passing: 0.13, dribbling: 0, defending: 0.13, intelligence: 0.16, stamina: 0.05 },
    // Striker → Winger: natural transition — minor penalty on wide-area decisions
    [PlayerRole.Winger]:     { shooting: 0, passing: 0, dribbling: 0, defending: 0.06, intelligence: 0.08, stamina: 0 },
    [PlayerRole.Striker]:    NONE,
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────

export function isOutOfPosition(naturalRole: PlayerRole, slotRole: PlayerRole): boolean {
  return naturalRole !== slotRole;
}

export function applyOutOfPositionPenalty(
  stats: PlayerStats,
  naturalRole: PlayerRole,
  slotRole: PlayerRole,
): PlayerStats {
  if (naturalRole === slotRole) return stats;

  const p = PENALTY[naturalRole]?.[slotRole] ?? NONE;
  const cut = (value: number, pct: number): number =>
    pct === 0 ? value : Math.max(1, Math.round(value * (1 - pct)));

  return {
    overall:      stats.overall, // display only — never touched
    speed:        stats.speed,   // physical attribute — never penalized
    physical:     stats.physical, // same
    shooting:     cut(stats.shooting,     p.shooting),
    passing:      cut(stats.passing,      p.passing),
    dribbling:    cut(stats.dribbling,    p.dribbling),
    defending:    cut(stats.defending,    p.defending),
    intelligence: cut(stats.intelligence, p.intelligence),
    stamina:      cut(stats.stamina,      p.stamina),
  };
}

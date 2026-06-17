import { PlayerRole } from './PlayerRole';
import { PlayerStats } from './PlayerStats';

// Penalty percentages per stat (0 = no reduction, 0.30 = reduce by 30%).
// Speed, physical, acceleration, agility, and aggression are athletic attributes —
// never penalized. Only technical/positional stats suffer.
// Athletic stats never penalized: speed, acceleration, sprintSpeed, physical,
// strength, balance, agility, ballControl, stamina, skillMoves, weakFootAbility, preferredFoot
interface StatPenalties {
  shooting: number; finishing: number; shotPower: number; longShots: number;
  passing: number; shortPassing: number; longPassing: number; crossing: number; vision: number;
  dribbling: number;
  defending: number; interceptions: number;
  intelligence: number; composure: number; reactions: number;
  aggression: number;
}

const NONE: StatPenalties = {
  shooting: 0, finishing: 0, shotPower: 0, longShots: 0,
  passing: 0, shortPassing: 0, longPassing: 0, crossing: 0, vision: 0,
  dribbling: 0,
  defending: 0, interceptions: 0,
  intelligence: 0, composure: 0, reactions: 0,
  aggression: 0,
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
    [PlayerRole.Defender]:   { shooting:0.42,finishing:0.50,shotPower:0.30,longShots:0.55, passing:0.32,shortPassing:0.34,longPassing:0.30,crossing:0.55,vision:0.36, dribbling:0.48, defending:0.28,interceptions:0.40, intelligence:0.40,composure:0.35,reactions:0.35, aggression:0.10 },
    [PlayerRole.Midfielder]: { shooting:0.50,finishing:0.56,shotPower:0.36,longShots:0.62, passing:0.38,shortPassing:0.40,longPassing:0.36,crossing:0.60,vision:0.42, dribbling:0.56, defending:0.30,interceptions:0.46, intelligence:0.46,composure:0.40,reactions:0.40, aggression:0.12 },
    [PlayerRole.Winger]:     { shooting:0.55,finishing:0.60,shotPower:0.40,longShots:0.65, passing:0.40,shortPassing:0.42,longPassing:0.38,crossing:0.60,vision:0.44, dribbling:0.60, defending:0.26,interceptions:0.50, intelligence:0.50,composure:0.44,reactions:0.44, aggression:0.14 },
    [PlayerRole.Striker]:    { shooting:0.55,finishing:0.60,shotPower:0.40,longShots:0.65, passing:0.42,shortPassing:0.44,longPassing:0.40,crossing:0.62,vision:0.44, dribbling:0.60, defending:0.24,interceptions:0.50, intelligence:0.50,composure:0.44,reactions:0.44, aggression:0.14 },
  },

  [PlayerRole.Defender]: {
    [PlayerRole.Goalkeeper]: { shooting:0,finishing:0,shotPower:0,longShots:0, passing:0.28,shortPassing:0.28,longPassing:0.26,crossing:0.40,vision:0.30, dribbling:0.38, defending:0.40,interceptions:0.35, intelligence:0.44,composure:0.38,reactions:0.30, aggression:0 },
    [PlayerRole.Defender]:   NONE,
    [PlayerRole.Midfielder]: { shooting:0.14,finishing:0.18,shotPower:0.10,longShots:0.20, passing:0.14,shortPassing:0.10,longPassing:0.14,crossing:0.18,vision:0.14, dribbling:0.12, defending:0,interceptions:0, intelligence:0.13,composure:0.10,reactions:0.08, aggression:0 },
    [PlayerRole.Winger]:     { shooting:0.22,finishing:0.28,shotPower:0.16,longShots:0.30, passing:0.14,shortPassing:0.10,longPassing:0.14,crossing:0.12,vision:0.18, dribbling:0.24, defending:0,interceptions:0, intelligence:0.20,composure:0.16,reactions:0.12, aggression:0.05 },
    [PlayerRole.Striker]:    { shooting:0.34,finishing:0.42,shotPower:0.26,longShots:0.40, passing:0.14,shortPassing:0.10,longPassing:0.14,crossing:0.20,vision:0.22, dribbling:0.32, defending:0,interceptions:0, intelligence:0.28,composure:0.22,reactions:0.16, aggression:0.08 },
  },

  [PlayerRole.Midfielder]: {
    [PlayerRole.Goalkeeper]: { shooting:0,finishing:0,shotPower:0,longShots:0, passing:0.26,shortPassing:0.26,longPassing:0.24,crossing:0.38,vision:0.28, dribbling:0.36, defending:0.42,interceptions:0.32, intelligence:0.44,composure:0.38,reactions:0.30, aggression:0 },
    [PlayerRole.Defender]:   { shooting:0,finishing:0,shotPower:0,longShots:0, passing:0,shortPassing:0,longPassing:0,crossing:0,vision:0, dribbling:0, defending:0.16,interceptions:0.12, intelligence:0.13,composure:0,reactions:0, aggression:0 },
    [PlayerRole.Midfielder]: NONE,
    [PlayerRole.Winger]:     { shooting:0.09,finishing:0.10,shotPower:0.06,longShots:0.12, passing:0,shortPassing:0,longPassing:0,crossing:0,vision:0, dribbling:0.07, defending:0,interceptions:0, intelligence:0.07,composure:0,reactions:0, aggression:0 },
    [PlayerRole.Striker]:    { shooting:0.18,finishing:0.22,shotPower:0.14,longShots:0.24, passing:0,shortPassing:0,longPassing:0,crossing:0.10,vision:0.08, dribbling:0.12, defending:0,interceptions:0, intelligence:0.16,composure:0.10,reactions:0.08, aggression:0.05 },
  },

  [PlayerRole.Winger]: {
    [PlayerRole.Goalkeeper]: { shooting:0,finishing:0,shotPower:0,longShots:0, passing:0.26,shortPassing:0.26,longPassing:0.24,crossing:0.38,vision:0.28, dribbling:0.36, defending:0.42,interceptions:0.32, intelligence:0.44,composure:0.38,reactions:0.30, aggression:0 },
    [PlayerRole.Defender]:   { shooting:0,finishing:0,shotPower:0,longShots:0, passing:0,shortPassing:0,longPassing:0,crossing:0,vision:0, dribbling:0, defending:0.24,interceptions:0.18, intelligence:0.20,composure:0,reactions:0, aggression:0.06 },
    [PlayerRole.Midfielder]: { shooting:0,finishing:0,shotPower:0,longShots:0, passing:0.07,shortPassing:0.06,longPassing:0.07,crossing:0,vision:0, dribbling:0, defending:0.06,interceptions:0, intelligence:0.07,composure:0,reactions:0, aggression:0 },
    [PlayerRole.Winger]:     NONE,
    [PlayerRole.Striker]:    NONE,
  },

  [PlayerRole.Striker]: {
    [PlayerRole.Goalkeeper]: { shooting:0,finishing:0,shotPower:0,longShots:0, passing:0.26,shortPassing:0.26,longPassing:0.24,crossing:0.38,vision:0.28, dribbling:0.36, defending:0.45,interceptions:0.36, intelligence:0.46,composure:0.40,reactions:0.32, aggression:0 },
    [PlayerRole.Defender]:   { shooting:0,finishing:0,shotPower:0,longShots:0, passing:0,shortPassing:0,longPassing:0,crossing:0,vision:0, dribbling:0, defending:0.32,interceptions:0.26, intelligence:0.30,composure:0,reactions:0, aggression:0.08 },
    [PlayerRole.Midfielder]: { shooting:0,finishing:0,shotPower:0,longShots:0, passing:0.13,shortPassing:0.10,longPassing:0.13,crossing:0.14,vision:0.10, dribbling:0, defending:0.13,interceptions:0.08, intelligence:0.16,composure:0.10,reactions:0.08, aggression:0.05 },
    [PlayerRole.Winger]:     NONE,
    [PlayerRole.Striker]:    NONE,
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────

const ATTACK_ROLES = new Set([PlayerRole.Winger, PlayerRole.Striker]);

export function isOutOfPosition(naturalRole: PlayerRole, slotRole: PlayerRole, alternateRoles: PlayerRole[] = []): boolean {
  if (naturalRole === slotRole || alternateRoles.includes(slotRole)) return false;
  if (ATTACK_ROLES.has(naturalRole) && ATTACK_ROLES.has(slotRole)) return false;
  return true;
}

export function applyOutOfPositionPenalty(
  stats: PlayerStats,
  naturalRole: PlayerRole,
  slotRole: PlayerRole,
  alternateRoles: PlayerRole[] = [],
): PlayerStats {
  if (naturalRole === slotRole || alternateRoles.includes(slotRole)) return stats;

  const p = PENALTY[naturalRole]?.[slotRole] ?? NONE;
  const cut = (value: number, pct: number): number =>
    pct === 0 ? value : Math.max(1, Math.round(value * (1 - pct)));

  return {
    overall:      stats.overall,
    speed:        stats.speed,
    shooting:     stats.shooting,
    passing:      stats.passing,
    intelligence: stats.intelligence,
    acceleration:     stats.acceleration,
    sprintSpeed:      stats.sprintSpeed,
    physical:         stats.physical,
    strength:         stats.strength,
    balance:          stats.balance,
    agility:          stats.agility,
    ballControl:      stats.ballControl,
    stamina:          stats.stamina,
    skillMoves:       stats.skillMoves,
    weakFootAbility:  stats.weakFootAbility,
    preferredFoot:    stats.preferredFoot,
    finishing:    cut(stats.finishing,    p.finishing),
    shotPower:    cut(stats.shotPower,    p.shotPower),
    longShots:    cut(stats.longShots,    p.longShots),
    shortPassing: cut(stats.shortPassing, p.shortPassing),
    longPassing:  cut(stats.longPassing,  p.longPassing),
    crossing:     cut(stats.crossing,     p.crossing),
    vision:       cut(stats.vision,       p.vision),
    dribbling:    cut(stats.dribbling,    p.dribbling),
    defending:    cut(stats.defending,    p.defending),
    interceptions:cut(stats.interceptions,p.interceptions),
    composure:    cut(stats.composure,    p.composure),
    reactions:    cut(stats.reactions,    p.reactions),
    aggression:   cut(stats.aggression,   p.aggression),
  };
}

/**
 * All player attributes loaded from the CSV.
 *
 * Display-only (cards/UI, not used in game physics/AI):
 *   overall, speed (pac), shooting (sho), passing (pas), intelligence
 *
 * Active in game logic — prefer these over the aggregates above:
 *   acceleration, sprintSpeed, finishing, shotPower, longShots,
 *   shortPassing, longPassing, crossing, vision,
 *   dribbling, agility, ballControl, skillMoves, weakFootAbility, preferredFoot,
 *   defending, interceptions, strength, balance, physical,
 *   intelligence → composure, reactions
 *   stamina, aggression
 */
export interface PlayerStats {
  // ── Display-only aggregates (shown on cards) ──────────────────────────────
  overall: number;
  /** pac — display only; physics use acceleration + sprintSpeed. */
  speed: number;
  /** sho — display only; execution uses finishing / shotPower / longShots. */
  shooting: number;
  /** pas — display only; execution uses shortPassing / longPassing / crossing. */
  passing: number;
  /** Composite display stat; behaviour uses composure + reactions + vision. */
  intelligence: number;

  // ── Pace ──────────────────────────────────────────────────────────────────
  /** First-step burst speed; controls how quickly players reach top speed. */
  acceleration: number;
  /** Top-end sustained speed; drives baseSpeed in physics. */
  sprintSpeed: number;

  // ── Shooting ──────────────────────────────────────────────────────────────
  /** Close-range composure and precision (< ~190 px from goal). */
  finishing: number;
  /** Raw power of the shot; drives ball velocity and GK reaction window. */
  shotPower: number;
  /** Accuracy on shots from outside the area (> ~250 px). */
  longShots: number;

  // ── Passing ───────────────────────────────────────────────────────────────
  /** Accuracy on passes ≤ ~120 px — quick exchanges, wall passes. */
  shortPassing: number;
  /** Accuracy on passes ≥ ~280 px — switches, long balls. */
  longPassing: number;
  /** Quality of wide crosses and cutbacks from wide positions. */
  crossing: number;
  /** Playmaking awareness: spotting runners and threading through balls. */
  vision: number;

  // ── Dribbling ─────────────────────────────────────────────────────────────
  /** Overall dribbling skill — ability to beat defenders. */
  dribbling: number;
  /** Sharpness of direction changes; key for tight-space dribbling. */
  agility: number;
  /** First-touch quality when receiving passes under speed or pressure. */
  ballControl: number;
  /** Skill-move repertoire (1–5); multiplies dribble attempt frequency. */
  skillMoves: number;
  /** Weak-foot quality (1–5); 5 = fully two-footed. */
  weakFootAbility: number;
  /** Dominant foot: 1 = right, 2 = left. Used with weakFootAbility. */
  preferredFoot: number;

  // ── Defending ─────────────────────────────────────────────────────────────
  /** Overall defensive quality. */
  defending: number;
  /** Reading and cutting off passes; drives intercept window. */
  interceptions: number;

  // ── Physical ──────────────────────────────────────────────────────────────
  /** Overall physical rating. */
  physical: number;
  /** Physical power in duels; determines carry-resistance shield. */
  strength: number;
  /** Stability when challenged; complements strength in duels. */
  balance: number;

  // ── Mental ────────────────────────────────────────────────────────────────
  /** Under-pressure composure; reduces pass/shot deviation from pressure. */
  composure: number;
  /** Speed of response — receiving passes, reading loose balls. */
  reactions: number;

  // ── Fitness ───────────────────────────────────────────────────────────────
  stamina: number;
  /** Pressing intensity and tackle commitment; scales press range. */
  aggression: number;
}

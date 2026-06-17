// Named playstyle constants used across the engine.
export const TRAITS = {
  RAPID: 'Rapid',
  QUICK_STEP: 'Quick Step',
  RELENTLESS: 'Relentless',
  TECHNICAL: 'Technical',
  FIRST_TOUCH: 'First Touch',
  INCISIVE_PASS: 'Incisive Pass',
  WHIPPED_PASS: 'Whipped Pass',
  INTERCEPT: 'Intercept',
  JOCKEY: 'Jockey',
  CLINICAL: 'Clinical',
  LONG_SHOT: 'Long Shot',
  CROSSER: 'Crosser',
  FAR_REACH: 'Far Reach',
  FINESSE_SHOT: 'Finesse Shot',
  BRUISER: 'Bruiser',
  AERIAL_FORTRESS: 'Aerial Fortress',
  LONG_BALL_PASS: 'Long Ball Pass',
  POWER_SHOT: 'Power Shot',
  LOW_DRIVEN_SHOT: 'Low Driven Shot',
  BLOCK: 'Block',
  PRECISION_HEADER: 'Precision Header',
  ENFORCER: 'Enforcer',
} as const;

interface WithTraits {
  readonly playstyles: readonly string[];
  readonly playstylesPlus: readonly string[];
}

export function hasPlaystyle(player: WithTraits, name: string): boolean {
  return player.playstyles.includes(name) || player.playstylesPlus.includes(name);
}

export function hasPlus(player: WithTraits, name: string): boolean {
  return player.playstylesPlus.includes(name);
}

// Returns `base` for a regular playstyle, `base + plusExtra` for Plus, 0 if absent.
export function traitBonus(player: WithTraits, name: string, base: number, plusExtra = 0): number {
  if (player.playstylesPlus.includes(name)) return base + plusExtra;
  if (player.playstyles.includes(name)) return base;
  return 0;
}

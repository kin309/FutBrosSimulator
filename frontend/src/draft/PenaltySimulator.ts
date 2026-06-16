import { DraftPlayer } from './DraftTypes';
import { PlayerRole } from '../game/data/PlayerRole';

export interface PenaltyKicker { name: string; prob: number; }
export interface PenaltyKick  { name: string; scored: boolean; }
export interface PenaltyResult {
  userKicks: PenaltyKick[];
  botKicks: PenaltyKick[];
  userScore: number;
  botScore: number;
  userWins: boolean;
}

export function penaltyProb(shooting: number, hasClinical: boolean): number {
  return Math.min(0.93, 0.60 + (shooting / 100) * 0.28 + (hasClinical ? 0.06 : 0));
}

export function simulatePenalties(userKickers: PenaltyKicker[], botKickers: PenaltyKicker[]): PenaltyResult {
  const userKicks: PenaltyKick[] = [];
  const botKicks: PenaltyKick[] = [];

  for (let i = 0; i < 5; i++) {
    userKicks.push({ name: userKickers[i % userKickers.length].name, scored: Math.random() < userKickers[i % userKickers.length].prob });
    botKicks.push({ name: botKickers[i % botKickers.length].name, scored: Math.random() < botKickers[i % botKickers.length].prob });

    const uScore = userKicks.filter((k) => k.scored).length;
    const bScore = botKicks.filter((k) => k.scored).length;
    const remaining = 4 - i;
    if (Math.abs(uScore - bScore) > remaining) break;
  }

  let uScore = userKicks.filter((k) => k.scored).length;
  let bScore = botKicks.filter((k) => k.scored).length;

  if (uScore === bScore) {
    for (let i = 5; i < 15; i++) {
      const uKicker = userKickers[i % userKickers.length];
      const bKicker = botKickers[i % botKickers.length];
      const uScored = Math.random() < uKicker.prob;
      const bScored = Math.random() < bKicker.prob;
      userKicks.push({ name: uKicker.name, scored: uScored });
      botKicks.push({ name: bKicker.name, scored: bScored });
      if (uScored !== bScored) break;
    }
    uScore = userKicks.filter((k) => k.scored).length;
    bScore = botKicks.filter((k) => k.scored).length;
  }

  return { userKicks, botKicks, userScore: uScore, botScore: bScore, userWins: uScore > bScore };
}

export function buildPenaltyKickers(
  players: Array<{ name: string; role: PlayerRole; stats: { shooting: number }; playstylesPlus?: string[] }>,
): PenaltyKicker[] {
  const outfield = players
    .filter((p) => p.role !== PlayerRole.Goalkeeper)
    .sort((a, b) => b.stats.shooting - a.stats.shooting)
    .slice(0, 8);

  const kickers = outfield.map((p) => ({
    name: shortPlayerName(p.name),
    prob: penaltyProb(p.stats.shooting, (p.playstylesPlus ?? []).includes('Clinical')),
  }));

  while (kickers.length < 5) kickers.push({ name: `Cobrador ${kickers.length + 1}`, prob: 0.72 });
  return kickers;
}

export function simulateMultiplayerPenaltyScore(): { penaltiesHome: number; penaltiesAway: number } {
  let home = 0;
  let away = 0;

  for (let i = 0; i < 5; i++) {
    if (Math.random() < 0.76) home++;
    if (Math.random() < 0.76) away++;

    const remaining = 4 - i;
    if (Math.abs(home - away) > remaining) return { penaltiesHome: home, penaltiesAway: away };
  }

  while (home === away) {
    if (Math.random() < 0.74) home++;
    if (Math.random() < 0.74) away++;
  }

  return { penaltiesHome: home, penaltiesAway: away };
}

function shortPlayerName(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  return (parts[parts.length - 1] ?? name).slice(0, 8);
}

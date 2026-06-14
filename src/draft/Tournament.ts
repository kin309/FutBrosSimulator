export type TournamentMode = 'champions-16' | 'knockout-express';

export interface TournamentCompetitor {
  id: string;
  name: string;
  kind: 'player' | 'bot';
  seed: number;
  overall: number;
  playerId?: string;
}

export interface TournamentMatch {
  id: string;
  stage: string;
  round: number;
  matchdayOrder: number;
  home: TournamentCompetitor;
  away: TournamentCompetitor;
}

export interface TournamentSetup {
  mode: TournamentMode;
  playerNames: string[];
  playerIds?: string[];
  botTeamNames?: string[];
  groupPlacement?: 'separated' | 'random';
}

export interface TournamentPlan {
  mode: TournamentMode;
  title: string;
  subtitle: string;
  competitors: TournamentCompetitor[];
  openingMatch: TournamentMatch;
  matches: TournamentMatch[];
}

export interface MatchResult {
  scoreHome: number;
  scoreAway: number;
  penaltiesHome?: number;
  penaltiesAway?: number;
}

export interface TournamentState {
  plan: TournamentPlan;
  results: Record<string, MatchResult>;
}

export interface GroupStanding {
  competitor: TournamentCompetitor;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
}

const BOT_NAMES = [
  'Bot Aurora',
  'Bot Serrano',
  'Bot Metro',
  'Bot Litoral',
  'Bot Imperial',
  'Bot Vale',
  'Bot Norte',
  'Bot Prisma',
  'Bot Cosmos',
  'Bot Atlas',
  'Bot Delta',
  'Bot Eclipse',
  'Bot Olimpo',
  'Bot Vortex',
  'Bot Zenith',
  'Bot Rubi',
];

export const TOURNAMENT_MODES: Record<TournamentMode, { title: string; subtitle: string }> = {
  'champions-16': {
    title: 'Campeonato 16 Times',
    subtitle: '4 grupos de 4, quartas, semi e final',
  },
  'knockout-express': {
    title: 'Mata-mata Express',
    subtitle: 'Oitavas direto, ideal para jogar rapido',
  },
};

// Round-robin pairings for a group of 4: indices into the group array
// Each pair is [homeIdx, awayIdx]; 2 matches per round × 3 rounds = 6 matches
const GROUP_PAIRINGS: [number, number][] = [
  [0, 3], [1, 2],  // round 1
  [0, 1], [2, 3],  // round 2
  [0, 2], [1, 3],  // round 3
];

interface HumanEntry {
  name: string;
  playerId?: string;
}

/**
 * Distribui os jogadores humanos pelos 16 slots de forma a espalhá-los entre grupos/chaveamento.
 *
 * Estratégia: os N humanos são colocados nos slots intercalados de 4 em 4.
 *   1 humano  → slot  0              (Grupo A)
 *   2 humanos → slots 0, 4           (Grupos A e B)
 *   4 humanos → slots 0, 4, 8, 12   (um por grupo)
 *   5 humanos → slots 0, 4, 8, 12, 1 (o 5º entra como 2º do Grupo A)
 *
 * Assim nenhum humano fica no mesmo grupo que outro até esgotar as posições disponíveis.
 */
function distributePlayersAcrossSlots<T>(players: T[], totalSlots: number): (T | null)[] {
  const GROUP_SIZE = 4;
  const NUM_GROUPS = totalSlots / GROUP_SIZE; // 4
  const slots: (T | null)[] = Array(totalSlots).fill(null);

  players.forEach((name, i) => {
    const groupIndex = i % NUM_GROUPS;          // qual grupo (0-3, ciclicamente)
    const posInGroup = Math.floor(i / NUM_GROUPS); // posição dentro do grupo (0-3)
    slots[groupIndex * GROUP_SIZE + posInGroup] = name;
  });

  return slots;
}

function randomPlayerSlots<T>(players: T[], totalSlots: number): (T | null)[] {
  const slots: (T | null)[] = [
    ...players,
    ...Array<T | null>(totalSlots - players.length).fill(null),
  ];
  shuffle(slots);
  return slots;
}

export function createTournamentPlan(setup: TournamentSetup): TournamentPlan {
  const mode = TOURNAMENT_MODES[setup.mode];
  const players: HumanEntry[] = setup.playerNames
    .map((name, index) => ({ name: name.trim(), playerId: setup.playerIds?.[index] }))
    .filter((player) => player.name)
    .filter(Boolean)
    .slice(0, 16);

  // Distribui humanos pelos 16 slots.
  // 'separated' (padrão): humanos espalhados em grupos distintos (0,4,8,12,...).
  // 'random': posições totalmente aleatórias — humanos podem cair no mesmo grupo.
  const slots = (setup.groupPlacement ?? 'separated') === 'random'
    ? randomPlayerSlots(players, 16)
    : distributePlayersAcrossSlots(players, 16);

  let botIndex = 0;
  const competitors: TournamentCompetitor[] = slots.map((player, index) => {
    const botName = setup.botTeamNames?.[botIndex] ?? BOT_NAMES[botIndex % BOT_NAMES.length];
    if (!player) botIndex++;
    return {
      id: player ? `player-${index + 1}` : `bot-${index + 1}`,
      name: player?.name ?? botName,
      kind: player ? 'player' : 'bot',
      seed: index + 1,
      overall: player ? 78 : randomBotOverall(),
      playerId: player?.playerId,
    };
  });

  const matches = setup.mode === 'champions-16'
    ? createGroupSchedule(competitors)
    : createKnockoutRound(competitors);
  const openingMatch = findUserOpeningMatch(matches) ?? matches[0];

  return {
    mode: setup.mode,
    title: mode.title,
    subtitle: mode.subtitle,
    competitors,
    openingMatch,
    matches,
  };
}

export function createTournamentState(plan: TournamentPlan): TournamentState {
  return { plan, results: {} };
}

export function simulateMatch(homeOvr: number, awayOvr: number): MatchResult {
  const diff = (homeOvr - awayOvr) / 10;
  // Home advantage: base 38% win, 28% draw, 34% away win at diff=0
  const homeWinP = Math.max(0.06, Math.min(0.78, 0.38 + diff * 0.07));
  const drawP    = Math.max(0.12, Math.min(0.38, 0.28 - Math.abs(diff) * 0.015));

  const rand = Math.random();
  const outcome: 'home' | 'draw' | 'away' =
    rand < homeWinP ? 'home' :
    rand < homeWinP + drawP ? 'draw' : 'away';

  if (outcome === 'draw') {
    const g = pick([0, 0, 1, 1, 2, 2, 3]);
    return { scoreHome: g, scoreAway: g };
  }

  const winner = pick([1, 1, 2, 2, 2, 3, 3, 4]);
  const loser  = pick([0, 0, 0, 1, 1, 2]);
  return outcome === 'home'
    ? { scoreHome: winner, scoreAway: loser }
    : { scoreHome: loser,  scoreAway: winner };
}

export function simulateRoundBotMatches(state: TournamentState, round: number): void {
  const botMatches = state.plan.matches.filter(
    (m) => m.round === round && m.home.kind === 'bot' && m.away.kind === 'bot',
  );
  for (const match of botMatches) {
    if (!state.results[match.id]) {
      state.results[match.id] = simulateMatch(match.home.overall, match.away.overall);
    }
  }
}

export function simulateRoundBotMatchesBefore(state: TournamentState, round: number, orderThreshold: number): void {
  const botMatches = state.plan.matches.filter(
    (m) => m.round === round && m.home.kind === 'bot' && m.away.kind === 'bot' && m.matchdayOrder < orderThreshold,
  );
  for (const match of botMatches) {
    if (!state.results[match.id]) {
      state.results[match.id] = simulateMatch(match.home.overall, match.away.overall);
    }
  }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBotOverall(): number {
  // Bots range from ~73 (weak) to ~87 (elite), centred around 79
  return 73 + Math.floor(Math.random() * 15);
}

export function getNextUserMatch(state: TournamentState): TournamentMatch | null {
  const userMatches = state.plan.matches.filter(
    (m) => m.home.kind === 'player' || m.away.kind === 'player',
  );
  return userMatches
    .filter((m) => !state.results[m.id])
    .sort((a, b) => a.round - b.round || a.matchdayOrder - b.matchdayOrder)
    [0] ?? null;
}

// True when the user played at least one knockout match and lost (no more user matches, tournament still ongoing).
export function isUserEliminated(state: TournamentState): boolean {
  if (isTournamentComplete(state)) return false;
  if (getNextUserMatch(state) !== null) return false;

  const knockoutStages = ['Oitavas', 'Quartas', 'Semi', 'Final'];
  const userKnockoutMatches = state.plan.matches.filter(
    (m) => knockoutStages.includes(m.stage)
      && (m.home.kind === 'player' || m.away.kind === 'player'),
  );

  // User was in a knockout match and there's a result — they were eliminated
  return userKnockoutMatches.some((m) => state.results[m.id]);
}

export function computeGroupStandings(
  stage: string,
  competitors: TournamentCompetitor[],
  state: TournamentState,
): GroupStanding[] {
  const rows = new Map<string, GroupStanding>(
    competitors.map((c) => [c.id, {
      competitor: c,
      played: 0, won: 0, drawn: 0, lost: 0,
      goalsFor: 0, goalsAgainst: 0, goalDiff: 0, points: 0,
    }]),
  );

  const groupMatches = state.plan.matches.filter((m) => m.stage === stage);

  for (const match of groupMatches) {
    const result = state.results[match.id];
    if (!result) continue;

    const home = rows.get(match.home.id)!;
    const away = rows.get(match.away.id)!;

    home.played++; away.played++;
    home.goalsFor += result.scoreHome; home.goalsAgainst += result.scoreAway;
    away.goalsFor += result.scoreAway; away.goalsAgainst += result.scoreHome;

    if (result.scoreHome > result.scoreAway) {
      home.won++; home.points += 3; away.lost++;
    } else if (result.scoreHome < result.scoreAway) {
      away.won++; away.points += 3; home.lost++;
    } else {
      home.drawn++; home.points++; away.drawn++; away.points++;
    }

    home.goalDiff = home.goalsFor - home.goalsAgainst;
    away.goalDiff = away.goalsFor - away.goalsAgainst;
  }

  return [...rows.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goalDiff !== a.goalDiff) return b.goalDiff - a.goalDiff;
    return b.goalsFor - a.goalsFor;
  });
}

function createGroupSchedule(competitors: TournamentCompetitor[]): TournamentMatch[] {
  const groups = ['Grupo A', 'Grupo B', 'Grupo C', 'Grupo D'];
  const matches: TournamentMatch[] = [];

  groups.forEach((stage, groupIndex) => {
    const start = groupIndex * 4;
    const group = competitors.slice(start, start + 4);

    GROUP_PAIRINGS.forEach(([homeIdx, awayIdx], pairingIndex) => {
      const round = Math.floor(pairingIndex / 2) + 1;
      matches.push({
        id: `${stage}-${pairingIndex + 1}`,
        stage,
        round,
        matchdayOrder: 0, // assigned below
        home: group[homeIdx],
        away: group[awayIdx],
      });
    });
  });

  assignMatchdayOrders(matches);
  return matches;
}

function createKnockoutRound(competitors: TournamentCompetitor[]): TournamentMatch[] {
  const matches = Array.from({ length: 8 }, (_, index) => ({
    id: `oitavas-${index + 1}`,
    stage: 'Oitavas',
    round: 1,
    matchdayOrder: 0,
    home: competitors[index],
    away: competitors[15 - index],
  }));
  assignMatchdayOrders(matches);
  return matches;
}

function assignMatchdayOrders(matches: TournamentMatch[]): void {
  const rounds = [...new Set(matches.map((m) => m.round))];
  for (const round of rounds) {
    const roundMatches = matches.filter((m) => m.round === round);
    shuffle(roundMatches);
    roundMatches.forEach((m, i) => { m.matchdayOrder = i + 1; });
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function findUserOpeningMatch(matches: TournamentMatch[]): TournamentMatch | null {
  return matches.find((match) => match.home.kind === 'player' || match.away.kind === 'player') ?? null;
}

export function getKnockoutWinner(match: TournamentMatch, state: TournamentState): TournamentCompetitor | null {
  const result = state.results[match.id];
  if (!result) return null;
  if (result.scoreHome !== result.scoreAway) {
    return result.scoreHome > result.scoreAway ? match.home : match.away;
  }
  // Draw: use penalty result if available, otherwise home wins
  if (result.penaltiesHome !== undefined && result.penaltiesAway !== undefined) {
    return result.penaltiesHome >= result.penaltiesAway ? match.home : match.away;
  }
  return match.home;
}

export function advanceKnockoutIfReady(state: TournamentState): boolean {
  if (state.plan.mode !== 'knockout-express') return false;

  const rounds = [...new Set(state.plan.matches.map((m) => m.round))].sort((a, b) => a - b);
  const maxRound = rounds[rounds.length - 1];
  const currentRoundMatches = state.plan.matches.filter((m) => m.round === maxRound);

  if (currentRoundMatches.length === 1) return false; // Final already generated
  if (!currentRoundMatches.every((m) => state.results[m.id])) return false;
  if (state.plan.matches.some((m) => m.round === maxRound + 1)) return false;

  const sorted = [...currentRoundMatches].sort((a, b) => a.matchdayOrder - b.matchdayOrder);
  const nextRound = maxRound + 1;
  const stageNames: Record<number, string> = { 2: 'Quartas', 3: 'Semi', 4: 'Final' };
  const stageName = stageNames[nextRound] ?? `Rodada ${nextRound}`;
  const half = Math.ceil(sorted.length / 2);

  const newMatches: TournamentMatch[] = [];
  for (let i = 0; i < half; i++) {
    const matchA = sorted[i];
    const matchB = sorted[sorted.length - 1 - i];
    const homeWinner = getKnockoutWinner(matchA, state);
    const awayWinner = getKnockoutWinner(matchB, state);
    if (!homeWinner || !awayWinner) return false;

    newMatches.push({
      id: `${stageName.toLowerCase()}-${i + 1}`,
      stage: stageName,
      round: nextRound,
      matchdayOrder: i + 1,
      home: homeWinner,
      away: awayWinner,
    });
  }

  assignMatchdayOrders(newMatches);
  state.plan.matches.push(...newMatches);
  return true;
}

export function advanceChampionsKnockoutIfReady(state: TournamentState): boolean {
  if (state.plan.mode !== 'champions-16') return false;

  const groupStages = ['Grupo A', 'Grupo B', 'Grupo C', 'Grupo D'];
  const knockoutStages = ['Quartas', 'Semi', 'Final'];

  const groupMatches = state.plan.matches.filter((m) => groupStages.includes(m.stage));
  if (!groupMatches.every((m) => state.results[m.id])) return false;

  const knockoutMatches = state.plan.matches.filter((m) => knockoutStages.includes(m.stage));
  const maxKnockoutRound = knockoutMatches.reduce((max, m) => Math.max(max, m.round), 3);
  const currentKnockout = knockoutMatches.filter((m) => m.round === maxKnockoutRound);

  // Generate quartas from group qualifiers
  if (currentKnockout.length === 0) {
    const groupDefs = [
      { stage: 'Grupo A', competitors: state.plan.competitors.slice(0, 4) },
      { stage: 'Grupo B', competitors: state.plan.competitors.slice(4, 8) },
      { stage: 'Grupo C', competitors: state.plan.competitors.slice(8, 12) },
      { stage: 'Grupo D', competitors: state.plan.competitors.slice(12, 16) },
    ];
    const q = groupDefs.map((g) => {
      const standings = computeGroupStandings(g.stage, g.competitors, state);
      return { winner: standings[0].competitor, runnerUp: standings[1].competitor };
    });
    const quartas: TournamentMatch[] = [
      { id: 'quartas-1', stage: 'Quartas', round: 4, matchdayOrder: 1, home: q[0].winner, away: q[1].runnerUp },
      { id: 'quartas-2', stage: 'Quartas', round: 4, matchdayOrder: 2, home: q[1].winner, away: q[0].runnerUp },
      { id: 'quartas-3', stage: 'Quartas', round: 4, matchdayOrder: 3, home: q[2].winner, away: q[3].runnerUp },
      { id: 'quartas-4', stage: 'Quartas', round: 4, matchdayOrder: 4, home: q[3].winner, away: q[2].runnerUp },
    ];
    state.plan.matches.push(...quartas);
    return true;
  }

  if (currentKnockout.length === 1) return false; // Final done
  if (!currentKnockout.every((m) => state.results[m.id])) return false;
  if (state.plan.matches.some((m) => m.round === maxKnockoutRound + 1)) return false;

  const sorted = [...currentKnockout].sort((a, b) => a.matchdayOrder - b.matchdayOrder);
  const nextRound = maxKnockoutRound + 1;
  const stageNames: Record<number, string> = { 5: 'Semi', 6: 'Final' };
  const stageName = stageNames[nextRound] ?? `Rodada ${nextRound}`;

  const newMatches: TournamentMatch[] = [];
  for (let i = 0; i < sorted.length; i += 2) {
    const matchA = sorted[i];
    const matchB = sorted[i + 1];
    const homeWinner = getKnockoutWinner(matchA, state);
    const awayWinner = getKnockoutWinner(matchB, state);
    if (!homeWinner || !awayWinner) return false;

    const idx = i / 2 + 1;
    newMatches.push({
      id: `${stageName.toLowerCase()}-${idx}`,
      stage: stageName,
      round: nextRound,
      matchdayOrder: idx,
      home: homeWinner,
      away: awayWinner,
    });
  }

  state.plan.matches.push(...newMatches);
  return true;
}

// Advance bracket and simulate bot-only matches until a user match appears or tournament ends.
export function advanceAndSimulateKnockout(state: TournamentState): void {
  const advance = state.plan.mode === 'knockout-express'
    ? advanceKnockoutIfReady
    : advanceChampionsKnockoutIfReady;

  for (let guard = 0; guard < 8; guard++) {
    if (!advance(state)) break;
    const maxRound = Math.max(...state.plan.matches.map((m) => m.round));
    simulateRoundBotMatches(state, maxRound);
    const userPending = state.plan.matches.some(
      (m) => m.round === maxRound && !state.results[m.id]
        && (m.home.kind === 'player' || m.away.kind === 'player'),
    );
    if (userPending) break;
  }
}

export function isTournamentComplete(state: TournamentState): boolean {
  const final = state.plan.matches.find((m) => m.stage === 'Final');
  return !!final && !!state.results[final.id];
}

export function getTournamentChampion(state: TournamentState): TournamentCompetitor | null {
  const final = state.plan.matches.find((m) => m.stage === 'Final');
  if (!final) return null;
  return getKnockoutWinner(final, state);
}

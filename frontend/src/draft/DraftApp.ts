import { loadDraftPlayers } from './CsvPlayerLoader';
import { DraftManager, generateRoundSequence } from './DraftManager';
import { DraftPlayer, DraftRound } from './DraftTypes';
import { buildBotTeamFromPool, pickBotTeamNamesFromPool, renderFormationScreen, SavedFormationState } from './FormationApp';
import { createGame } from '../game/FootballGame';
import { FORMATIONS, FormationDefinition, TeamData } from '../game/data/TeamFactory';
import { PlayerRole } from '../game/data/PlayerRole';
import {
  createPlayerId,
  createRoomCode,
  DEFAULT_LOBBY_SETTINGS,
  DraftVisibility,
  GroupPlacement,
  LobbyMessage,
  LobbyPlayer,
  LobbySettings,
  MultiplayerDraftState,
  MultiplayerDraftTeam,
  MultiplayerMatchLiveState,
  MultiplayerMatchState,
  normalizeRoomCode,
} from './MultiplayerLobby';
import { createTransport } from './transport/createTransport';
import { nationalityFlagCode } from './NationalityFlags';
import { positionLabel } from './PositionLabels';
import {
  advanceAndSimulateKnockout,
  createTournamentPlan,
  createTournamentState,
  getNextUserMatch,
  getTournamentChampion,
  isTournamentComplete,
  simulateRoundBotMatches,
  simulateRoundBotMatchesBefore,
  TOURNAMENT_MODES,
  TournamentMode,
  TournamentPlan,
  TournamentMatch,
  TournamentState,
} from './Tournament';

const SAVE_KEY = 'football-sim-save';
const MULTIPLAYER_HOST_SAVE_KEY = 'football-sim-multiplayer-host-save';
const MULTIPLAYER_INVITE_KEY = 'football-sim-multiplayer-invite';
const MULTIPLAYER_FORMATION_SAVE_PREFIX = 'football-sim-multiplayer-formation';

interface TournamentSave {
  state: TournamentState;
  picked: DraftPlayer[];
}

interface MultiplayerHostSave {
  roomCode: string;
  hostId: string;
  settings: LobbySettings;
  players: LobbyPlayer[];
  draftState: MultiplayerDraftState | null;
  tournamentState: TournamentState | null;
  matchState: MultiplayerMatchState;
  updatedAt: number;
}

interface MultiplayerReturnInvite {
  roomCode: string;
  hostId: string;
  playerId: string;
  playerName: string;
  hostName: string;
  updatedAt: number;
}

function saveProgress(state: TournamentState, picked: DraftPlayer[]): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ state, picked }));
  } catch {
    // quota exceeded or private mode — silently ignore
  }
}

function loadProgress(): TournamentSave | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? (JSON.parse(raw) as TournamentSave) : null;
  } catch {
    return null;
  }
}

function clearProgress(): void {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}

function saveMultiplayerHostProgress(save: MultiplayerHostSave): void {
  try {
    localStorage.setItem(MULTIPLAYER_HOST_SAVE_KEY, JSON.stringify(save));
  } catch {
    // ignore storage failures
  }
}

function loadMultiplayerHostProgress(): MultiplayerHostSave | null {
  try {
    const raw = localStorage.getItem(MULTIPLAYER_HOST_SAVE_KEY);
    return raw ? (JSON.parse(raw) as MultiplayerHostSave) : null;
  } catch {
    return null;
  }
}

function clearMultiplayerHostProgress(): void {
  try { localStorage.removeItem(MULTIPLAYER_HOST_SAVE_KEY); } catch { /* ignore */ }
}

function saveMultiplayerReturnInvite(invite: MultiplayerReturnInvite): void {
  try {
    localStorage.setItem(MULTIPLAYER_INVITE_KEY, JSON.stringify(invite));
  } catch {
    // ignore storage failures
  }
}

function loadMultiplayerReturnInvite(playerId: string): MultiplayerReturnInvite | null {
  try {
    const raw = localStorage.getItem(MULTIPLAYER_INVITE_KEY);
    if (!raw) return null;
    const invite = JSON.parse(raw) as MultiplayerReturnInvite;
    return invite.playerId === playerId ? invite : null;
  } catch {
    return null;
  }
}

function multiplayerFormationSaveKey(roomCode: string, matchId: string, playerId: string): string {
  return `${MULTIPLAYER_FORMATION_SAVE_PREFIX}:${roomCode}:${matchId}:${playerId}`;
}

function saveMultiplayerFormation(
  roomCode: string,
  matchId: string,
  playerId: string,
  formation: SavedFormationState,
): void {
  try {
    localStorage.setItem(multiplayerFormationSaveKey(roomCode, matchId, playerId), JSON.stringify(formation));
  } catch {
    // ignore storage failures
  }
}

function loadMultiplayerFormation(
  roomCode: string,
  matchId: string,
  playerId: string,
): SavedFormationState | null {
  try {
    const raw = localStorage.getItem(multiplayerFormationSaveKey(roomCode, matchId, playerId));
    return raw ? (JSON.parse(raw) as SavedFormationState) : null;
  } catch {
    return null;
  }
}
import { renderTournamentTable } from './TournamentTableApp';

const FULL_POOL_URL = '/data/ea_fc26_players.csv';
const FAMOUS_POOL_URL = '/data/ea_fc26_players_clubes_famosos.csv';
const PREVIEW_FORMATION = FORMATIONS[0];

const SQUAD_TARGETS: Array<{ role: PlayerRole; label: string; target: number }> = [
  { role: PlayerRole.Goalkeeper, label: 'GOL', target: 2 },
  { role: PlayerRole.Defender, label: 'DEF', target: 5 },
  { role: PlayerRole.Midfielder, label: 'MEI', target: 4 },
  { role: PlayerRole.Winger, label: 'ALA', target: 2 },
  { role: PlayerRole.Striker, label: 'ATA', target: 2 },
];

interface DraftPools {
  fullPool: DraftPlayer[];
  famousPool: DraftPlayer[];
}

const EMPTY_MATCH_STATE: MultiplayerMatchState = {
  phase: 'idle',
  matchId: null,
  readyPlayerIds: [],
  teams: {},
  startedAt: null,
};

function cloneEmptyMatchState(): MultiplayerMatchState {
  return {
    phase: 'idle',
    matchId: null,
    readyPlayerIds: [],
    teams: {},
    startedAt: null,
  };
}

function playerIdsForMatch(match: TournamentMatch): string[] {
  return [match.home.playerId, match.away.playerId].filter((id): id is string => Boolean(id));
}

function teamForCompetitor(
  competitor: TournamentMatch['home'],
  readyTeams: Record<string, TeamData>,
  pools: DraftPools,
): TeamData {
  if (competitor.playerId && readyTeams[competitor.playerId]) return readyTeams[competitor.playerId];
  return buildBotTeamFromPool(competitor.name, pools.fullPool);
}

function orientTeam(team: TeamData, id: string, color: number, attackDirection: 1 | -1): TeamData {
  const shouldMirror = team.attackDirection !== attackDirection;
  return {
    ...team,
    id,
    color,
    attackDirection,
    players: team.players.map((player) => ({
      ...player,
      baseX: shouldMirror ? 1200 - player.baseX : player.baseX,
    })),
  };
}

export async function startDraftApp(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#draft-root');
  if (!root) throw new Error('Missing #draft-root element.');

  root.innerHTML = loadingView();

  try {
    const [fullPool, famousPool] = await Promise.all([
      loadDraftPlayers(FULL_POOL_URL),
      loadDraftPlayers(FAMOUS_POOL_URL),
    ]);

    renderLobbyHome(root, { fullPool, famousPool });
  } catch (error) {
    root.innerHTML = `
      <main class="draft-shell">
        <section class="draft-error">
          <h1>Draft indisponível</h1>
          <p>${error instanceof Error ? error.message : 'Erro ao carregar os bancos.'}</p>
        </section>
      </main>
    `;
  }
}

export async function startDebugMode(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#draft-root');
  if (!root) throw new Error('Missing #draft-root element.');

  root.innerHTML = loadingView();

  let allPlayers: DraftPlayer[];
  try {
    allPlayers = await loadDraftPlayers(FULL_POOL_URL);
  } catch (error) {
    root.innerHTML = `
      <main class="draft-shell">
        <section class="draft-error">
          <h1>Debug indisponível</h1>
          <p>${error instanceof Error ? error.message : 'Erro ao carregar o banco de jogadores.'}</p>
        </section>
      </main>
    `;
    return;
  }

  const reroll = (): void => {
    const squad = buildDebugSquad(allPlayers, 18);
    const opponent = buildBotTeamFromPool(
      pickBotTeamNamesFromPool(1, allPlayers)[0] ?? 'Debug Bot',
      allPlayers,
    );
    renderFormationScreen(root, squad, reroll, {
      competitionName: 'Modo Debug',
      opponentName: opponent.name,
      opponentTeam: opponent,
      startButtonLabel: 'Iniciar partida',
    });
  };

  reroll();
}

function buildDebugSquad(allPlayers: DraftPlayer[], size: number): DraftPlayer[] {
  const shuffle = <T>(arr: T[]) => [...arr].sort(() => Math.random() - 0.5);
  const gks = shuffle(allPlayers.filter((p) => p.role === PlayerRole.Goalkeeper));
  const outfield = shuffle(allPlayers.filter((p) => p.role !== PlayerRole.Goalkeeper));
  return [...gks.slice(0, 2), ...outfield.slice(0, size - 2)];
}

function animatePickSelected(button: HTMLButtonElement, onDone: () => void): void {
  button.classList.add('is-picked');
  setTimeout(onDone, 220);
}

function animateBoosterExit(root: Element, onDone: () => void): void {
  root.querySelectorAll<HTMLElement>('.booster-grid .card-flip-wrapper').forEach((wrapper) => {
    wrapper.classList.add('is-exiting');
  });
  // 6 cards × 30ms delay + 130ms duration
  setTimeout(onDone, 310);
}

const FLIP_DURATION: Record<string, number> = {
  'tier-gold': 1000,
  'tier-silver': 220,
  'tier-bronze': 220,
};
const DEFAULT_FLIP_DURATION = 240;
const SPECIAL_BOOSTER_INTRO_MS = 1100;

function setupSequentialFlip(root: Element): void {
  const wrappers = root.querySelectorAll<HTMLElement>('.booster-grid .card-flip-wrapper');
  const isSpecial = root.querySelector('.round-toolbar.is-special') !== null;
  let cumulative = isSpecial ? SPECIAL_BOOSTER_INTRO_MS : 0;
  wrappers.forEach((wrapper) => {
    wrapper.style.setProperty('--flip-delay', `${cumulative}ms`);
    const dur = Object.entries(FLIP_DURATION).find(([cls]) => wrapper.classList.contains(cls))?.[1]
      ?? DEFAULT_FLIP_DURATION;
    // Gold front-face glow starts right after the flip finishes
    const frontFace = wrapper.querySelector<HTMLElement>('.player-card.tier-gold');
    if (frontFace) {
      frontFace.style.setProperty('--front-glow-delay', `${cumulative + dur}ms`);
    }
    cumulative += dur;
  });
}

const PARTICLE_COLORS = ['#fbbf24', '#f59e0b', '#fcd34d', '#ffffff', '#fef3c7'];

function spawnGoldParticles(wrapper: HTMLElement): void {
  const rect = wrapper.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const count = 16;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'card-particle';
    const angle = (i / count) * 360 + (Math.random() - 0.5) * 18;
    const dist = 45 + Math.random() * 55;
    const size = 3 + Math.random() * 4;
    const color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
    const delay = Math.random() * 80;
    p.style.cssText = `
      left:${cx}px; top:${cy}px;
      --angle:${angle}deg; --dist:${dist}px;
      --size:${size}px; --color:${color};
      --p-delay:${delay}ms;
    `;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 850);
  }
}

function setupGoldParticles(root: Element): void {
  root.querySelectorAll<HTMLElement>('.booster-grid .card-flip-wrapper.tier-gold').forEach((wrapper) => {
    wrapper.addEventListener('animationstart', (ev) => {
      if ((ev as AnimationEvent).animationName !== 'cardFlipRevealGold') return;
      // Fire particles at ~37% into the animation (shake phase ends, flip begins)
      setTimeout(() => spawnGoldParticles(wrapper), 518);
    }, { once: true });
  });
}

function render(root: HTMLDivElement, manager: DraftManager, tournament: TournamentPlan, pools: DraftPools): void {
  const round = manager.getRound();
  root.innerHTML = draftView(round, tournament);
  setupSequentialFlip(root);
  setupGoldParticles(root);

  root.querySelectorAll<HTMLButtonElement>('[data-pick-id]').forEach((button) => {
    button.addEventListener('click', () => {
      animatePickSelected(button, () => {
        manager.pick(button.dataset.pickId ?? '');
        render(root, manager, tournament, pools);
      });
    });
  });

  root.querySelector<HTMLButtonElement>('[data-action="reroll"]')?.addEventListener('click', () => {
    animateBoosterExit(root, () => {
      manager.reroll();
      render(root, manager, tournament, pools);
    });
  });

  root.querySelector<HTMLButtonElement>('[data-action="start-match"]')?.addEventListener('click', () => {
    clearProgress();
    const state = createTournamentState(tournament);
    startTournamentMatch(root, round.picked, state, pools, () => render(root, manager, tournament, pools));
  });
}

// ── Penalty Shootout ──────────────────────────────────────────────────────────

const KNOCKOUT_STAGES = new Set(['Oitavas', 'Quartas', 'Semi', 'Final']);

function simulateMultiplayerPenaltyScore(): { penaltiesHome: number; penaltiesAway: number } {
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

interface PenaltyKicker { name: string; prob: number; }
interface PenaltyKick  { name: string; scored: boolean; }
interface PenaltyResult {
  userKicks: PenaltyKick[];
  botKicks: PenaltyKick[];
  userScore: number;
  botScore: number;
  userWins: boolean;
}

function penaltyProb(shooting: number, hasClinical: boolean): number {
  return Math.min(0.93, 0.60 + (shooting / 100) * 0.28 + (hasClinical ? 0.06 : 0));
}

function simulatePenalties(userKickers: PenaltyKicker[], botKickers: PenaltyKicker[]): PenaltyResult {
  const userKicks: PenaltyKick[] = [];
  const botKicks: PenaltyKick[] = [];

  // 5 rounds — stop early when mathematically decided
  for (let i = 0; i < 5; i++) {
    userKicks.push({ name: userKickers[i % userKickers.length].name, scored: Math.random() < userKickers[i % userKickers.length].prob });
    botKicks.push({ name: botKickers[i % botKickers.length].name,   scored: Math.random() < botKickers[i % botKickers.length].prob });

    const uScore = userKicks.filter((k) => k.scored).length;
    const bScore = botKicks.filter((k) => k.scored).length;
    const remaining = 4 - i;
    if (Math.abs(uScore - bScore) > remaining) break;
  }

  let uScore = userKicks.filter((k) => k.scored).length;
  let bScore = botKicks.filter((k) => k.scored).length;

  // Sudden death if tied after 5
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

function buildPenaltyKickers(
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

  // Guarantee at least 5
  while (kickers.length < 5) kickers.push({ name: `Cobrador ${kickers.length + 1}`, prob: 0.72 });
  return kickers;
}

function showPenaltyScreen(
  root: HTMLDivElement,
  picked: DraftPlayer[],
  opponentTeam: ReturnType<typeof buildBotTeamFromPool>,
  drawScore: number,
  userIsHome: boolean,
  opponentName: string,
  onContinue: (penaltiesHome: number, penaltiesAway: number) => void,
): void {
  const userKickers = buildPenaltyKickers(picked);
  const botKickers  = buildPenaltyKickers(opponentTeam.players);
  const result      = simulatePenalties(userKickers, botKickers);

  const penHome = userIsHome ? result.userScore : result.botScore;
  const penAway = userIsHome ? result.botScore  : result.userScore;

  root.innerHTML = penaltyScreenView('Seu Time', opponentName, drawScore, result);

  root.querySelector<HTMLButtonElement>('[data-action="continue-penalty"]')?.addEventListener('click', () => {
    onContinue(penHome, penAway);
  });
}

function penaltyScreenView(
  userName: string,
  botName: string,
  drawScore: number,
  result: PenaltyResult,
): string {
  const kickLine = (kick: PenaltyKick, index: number): string => `
    <div class="pen-kick ${kick.scored ? 'pen-scored' : 'pen-missed'}">
      <span class="pen-index">${index + 1}</span>
      <span class="pen-dot">${kick.scored ? '●' : '○'}</span>
      <span class="pen-name">${escapeHtml(kick.name)}</span>
    </div>
  `;

  const isSuddenDeath = result.userKicks.length > 5;
  const verdict = result.userWins ? 'Você venceu nos pênaltis!' : 'Eliminado nos pênaltis';
  const verdictClass = result.userWins ? 'pen-win' : 'pen-loss';

  return `
    <main class="draft-shell penalty-screen">
      <section class="draft-board">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">Disputa de Pênaltis${isSuddenDeath ? ' · Morte Súbita' : ''}</p>
            <h1>${drawScore}–${drawScore} após 90 min</h1>
          </div>
          <div class="penalty-verdict-header ${verdictClass}">${escapeHtml(verdict)}</div>
        </header>

        <div class="penalty-board">
          <div class="penalty-col">
            <h2 class="penalty-team-name">${escapeHtml(userName)}</h2>
            <div class="penalty-kicks">${result.userKicks.map(kickLine).join('')}</div>
            <div class="penalty-subtotal">${result.userScore}</div>
          </div>

          <div class="penalty-center">
            <div class="penalty-total-score">${result.userScore}–${result.botScore}</div>
          </div>

          <div class="penalty-col penalty-col-right">
            <h2 class="penalty-team-name">${escapeHtml(botName)}</h2>
            <div class="penalty-kicks">${result.botKicks.map(kickLine).join('')}</div>
            <div class="penalty-subtotal">${result.botScore}</div>
          </div>
        </div>

        <div class="complete-actions" style="margin-top:32px">
          <button class="start-button" data-action="continue-penalty">Continuar</button>
        </div>
      </section>
    </main>
  `;
}

// ── Tournament Match ───────────────────────────────────────────────────────────

function startTournamentMatch(
  root: HTMLDivElement,
  picked: DraftPlayer[],
  state: TournamentState,
  pools: DraftPools,
  onBack: () => void,
  onAfterResult?: () => void,
): void {
  // Update user competitor's overall with their actual squad average
  const userComp = state.plan.competitors.find((c) => c.kind === 'player');
  if (userComp && picked.length > 0) {
    userComp.overall = Math.round(picked.reduce((s, p) => s + p.overall, 0) / picked.length);
  }

  const match = getNextUserMatch(state);
  if (!match) {
    if (isTournamentComplete(state)) clearProgress();
    renderTournamentTable(root, state, () => {}, onBack);
    return;
  }

  const userIsHome = match.home.kind === 'player';
  const opponentName = userIsHome ? match.away.name : match.home.name;
  const opponentTeam = buildBotTeamFromPool(opponentName, pools.fullPool);
  const isKnockout = KNOCKOUT_STAGES.has(match.stage);

  const goToTable = (): void => {
    renderTournamentTable(root, state, () => {
      startTournamentMatch(root, picked, state, pools, onBack, onAfterResult);
    });
  };

  const commitResult = (scoreHome: number, scoreAway: number, penHome?: number, penAway?: number): void => {
    state.results[match.id] = {
      scoreHome,
      scoreAway,
      ...(penHome !== undefined ? { penaltiesHome: penHome, penaltiesAway: penAway } : {}),
    };
    simulateRoundBotMatches(state, match.round);
    advanceAndSimulateKnockout(state);
    saveProgress(state, picked);
    onAfterResult?.();
    goToTable();
  };

  renderFormationScreen(root, picked, goToTable, {
    competitionName: state.plan.title,
    opponentName,
    opponentTeam,
    matchId: match.id,
    userIsHome,
    onMatchEnd: (scoreA, scoreB) => {
      const scoreHome = userIsHome ? scoreA : scoreB;
      const scoreAway = userIsHome ? scoreB : scoreA;

      if (isKnockout && scoreHome === scoreAway) {
        showPenaltyScreen(root, picked, opponentTeam, scoreHome, userIsHome, opponentName, (penHome, penAway) => {
          commitResult(scoreHome, scoreAway, penHome, penAway);
        });
      } else {
        commitResult(scoreHome, scoreAway);
      }
    },
  });
}

function renderLobbyHome(root: HTMLDivElement, pools: DraftPools): void {
  const playerId = createPlayerId();
  let playerName = `Jogador ${playerId.slice(-3).toUpperCase()}`;
  let joinCode = '';

  const draw = (): void => {
    const save = loadProgress();
    const rawHostSave = loadMultiplayerHostProgress();
    const hostSave = rawHostSave?.hostId === playerId ? rawHostSave : null;
    const invite = loadMultiplayerReturnInvite(playerId);
    root.innerHTML = lobbyHomeView(playerName, joinCode, save !== null, hostSave, invite);

    root.querySelector<HTMLInputElement>('[data-player-display]')?.addEventListener('input', (event) => {
      playerName = (event.currentTarget as HTMLInputElement).value;
    });

    root.querySelector<HTMLInputElement>('[data-join-code]')?.addEventListener('input', (event) => {
      joinCode = normalizeRoomCode((event.currentTarget as HTMLInputElement).value);
      (event.currentTarget as HTMLInputElement).value = joinCode;
    });

    root.querySelector<HTMLButtonElement>('[data-action="resume-save"]')?.addEventListener('click', () => {
      const save = loadProgress();
      if (!save) return;
      startTournamentMatch(root, save.picked, save.state, pools, () => renderLobbyHome(root, pools));
    });

    root.querySelector<HTMLButtonElement>('[data-action="resume-multiplayer-host"]')?.addEventListener('click', () => {
      const save = loadMultiplayerHostProgress();
      if (!save || save.hostId !== playerId) return;
      openLobby(root, pools, {
        roomCode: save.roomCode,
        isHost: true,
        player: {
          id: playerId,
          name: playerName.trim() || save.players.find((player) => player.id === playerId)?.name || 'Host',
          isHost: true,
        },
        restore: save,
      });
    });

    root.querySelector<HTMLButtonElement>('[data-action="join-host-resume"]')?.addEventListener('click', () => {
      const invite = loadMultiplayerReturnInvite(playerId);
      if (!invite) return;
      openLobby(root, pools, {
        roomCode: invite.roomCode,
        isHost: false,
        player: {
          id: playerId,
          name: playerName.trim() || invite.playerName || 'Jogador',
          isHost: false,
        },
      });
    });

    root.querySelector<HTMLButtonElement>('[data-action="create-room"]')?.addEventListener('click', () => {
      openLobby(root, pools, {
        roomCode: createRoomCode(),
        isHost: true,
        player: {
          id: playerId,
          name: playerName.trim() || 'Host',
          isHost: true,
        },
      });
    });

    root.querySelector<HTMLButtonElement>('[data-action="join-room"]')?.addEventListener('click', () => {
      const roomCode = normalizeRoomCode(joinCode);
      if (!roomCode) return;

      openLobby(root, pools, {
        roomCode,
        isHost: false,
        player: {
          id: playerId,
          name: playerName.trim() || 'Jogador',
          isHost: false,
        },
      });
    });
  };

  draw();
}

function openLobby(
  root: HTMLDivElement,
  pools: DraftPools,
  options: { roomCode: string; isHost: boolean; player: LobbyPlayer; restore?: MultiplayerHostSave },
): void {
  const channel = createTransport(options.roomCode);
  let settings: LobbySettings = options.restore?.settings ?? { ...DEFAULT_LOBBY_SETTINGS };
  let players: LobbyPlayer[] = options.restore
    ? upsertPlayer(options.restore.players.map((player) => ({ ...player, isConnected: player.id === options.player.id })), { ...options.player, isHost: true, isConnected: true })
    : [{ ...options.player, isConnected: true }];
  let draftState: MultiplayerDraftState | null = options.restore?.draftState ?? null;
  const restoredMatch = options.restore?.matchState ?? cloneEmptyMatchState();
  // Partida em andamento não pode ser retomada do meio: volta à formação com as equipes já prontas
  let matchState: MultiplayerMatchState = restoredMatch.phase === 'running'
    ? { ...restoredMatch, phase: 'formation', readyPlayerIds: Object.keys(restoredMatch.teams), startedAt: null }
    : restoredMatch;
  let liveState: MultiplayerMatchLiveState | null = null;
  const runningMatchRef: { value: string | null } = { value: null };
  const runningGameRef: { value: ReturnType<typeof createGame> | null } = { value: null };
  const spectatorPushRef: { value: ((s: MultiplayerMatchLiveState) => void) | null } = { value: null };
  const managers = new Map<string, DraftManager>();
  // Mutable ref so tournamentState persists across re-renders of renderMultiplayerDraft
  const tsRef: { value: TournamentState | null } = { value: options.restore?.tournamentState ?? null };

  const post = (message: LobbyMessage): void => {
    if (options.isHost && isHostHandledMessage(message)) {
      handleHostMessage(message);
      return;
    }

    channel.postMessage(message);
  };

  const persistMultiplayerProgress = (): void => {
    const host = players.find((player) => player.isHost) ?? players[0];
    const hostName = host?.name ?? options.player.name;

    if (options.isHost) {
      saveMultiplayerHostProgress({
        roomCode: options.roomCode,
        hostId: options.player.id,
        settings,
        players,
        draftState,
        tournamentState: tsRef.value,
        matchState,
        updatedAt: Date.now(),
      });
    }

    saveMultiplayerReturnInvite({
      roomCode: options.roomCode,
      hostId: host?.id ?? options.player.id,
      playerId: options.player.id,
      playerName: options.player.name,
      hostName,
      updatedAt: Date.now(),
    });
  };

  channel.onstatuschange = (status) => {
    const banner = document.getElementById('reconnect-banner');
    if (status === 'reconnecting') {
      if (!banner) {
        const el = document.createElement('div');
        el.id = 'reconnect-banner';
        el.className = 'reconnect-banner';
        el.textContent = 'Conexão perdida — reconectando…';
        document.body.appendChild(el);
      }
    } else {
      banner?.remove();
      // Host rebroadcasta o estado atual para os guests que reconectaram
      if (options.isHost) {
        if (draftState) {
          channel.postMessage({ type: 'draft-state', state: draftState });
          if (tsRef.value) channel.postMessage({ type: 'tournament-state', state: tsRef.value });
          channel.postMessage({ type: 'match-state', state: matchState });
        } else {
          channel.postMessage({ type: 'lobby-state', hostId: players[0].id, players, settings });
        }
      } else {
        // Guest reconectado: re-envia join para o host saber que voltou
        post({ type: 'join', player: options.player });
      }
    }
  };

  const broadcastLobby = (): void => {
    persistMultiplayerProgress();
    post({ type: 'lobby-state', hostId: players[0].id, players, settings });
    if (options.isHost && !draftState) drawHostLobby();
  };

  const broadcastDraft = (): void => {
    draftState = createMultiplayerDraftState(options.roomCode, settings, players, managers);
    persistMultiplayerProgress();
    post({ type: 'draft-state', state: draftState });
    renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, options.isHost, draftState, post, managers, tsRef, matchState, liveState, runningMatchRef, runningGameRef);
  };

  const broadcastMatch = (): void => {
    autoStartMatchIfReady();
    persistMultiplayerProgress();
    post({ type: 'match-state', state: matchState });
    if (draftState) {
      renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, options.isHost, draftState, post, managers, tsRef, matchState, liveState, runningMatchRef, runningGameRef);
    }
  };

  const getOrCreateMultiplayerTs = (): TournamentState => {
    if (!tsRef.value) {
      const playerNames = players.map((player) => player.name);
      const playerIds = players.map((player) => player.id);
      const botCount = 16 - playerNames.length;
      const botTeamNames = pickBotTeamNamesFromPool(botCount, pools.fullPool);
      const plan = createTournamentPlan({
        mode: settings.mode,
        playerNames,
        playerIds,
        botTeamNames,
        groupPlacement: settings.groupPlacement,
      });
      tsRef.value = createTournamentState(plan);
    }
    return tsRef.value;
  };

  const syncPlayerOveralls = (ts: TournamentState): void => {
    draftState?.teams.forEach((team) => {
      const competitor = ts.plan.competitors.find((entry) => entry.playerId === team.playerId);
      if (competitor && team.picked.length > 0) {
        competitor.overall = Math.round(team.picked.reduce((sum, player) => sum + player.overall, 0) / team.picked.length);
      }
    });
  };

  const prepareMatch = (matchId: string): void => {
    const ts = getOrCreateMultiplayerTs();
    syncPlayerOveralls(ts);
    const match = ts.plan.matches.find((item) => item.id === matchId);
    if (!match || ts.results[match.id]) return;
    simulateRoundBotMatchesBefore(ts, match.round, match.matchdayOrder);
    matchState = {
      phase: 'formation',
      matchId: match.id,
      readyPlayerIds: [],
      teams: {},
      startedAt: null,
    };
    post({ type: 'tournament-state', state: ts });
    broadcastMatch();
  };

  const commitMatchResult = (matchId: string, scoreHome: number, scoreAway: number): void => {
    const ts = getOrCreateMultiplayerTs();
    const match = ts.plan.matches.find((item) => item.id === matchId);
    if (!match || ts.results[match.id]) return;
    ts.results[match.id] = {
      scoreHome,
      scoreAway,
      ...(KNOCKOUT_STAGES.has(match.stage) && scoreHome === scoreAway ? simulateMultiplayerPenaltyScore() : {}),
    };
    simulateRoundBotMatches(ts, match.round);
    advanceAndSimulateKnockout(ts);
    matchState = cloneEmptyMatchState();
    liveState = null;
    runningMatchRef.value = null;
    if (isTournamentComplete(ts)) clearMultiplayerHostProgress();
    else persistMultiplayerProgress();
    post({ type: 'tournament-state', state: ts });
    broadcastMatch();
  };

  channel.onmessage = (message: LobbyMessage) => {
    if (options.isHost) {
      handleHostMessage(message);
      return;
    }

    if (message.type === 'lobby-state') {
      settings = message.settings;
      players = message.players;
      persistMultiplayerProgress();
      renderLobbyRoom(root, options.roomCode, options.player.id, false, players, settings, post, () => undefined);
    }

    if (message.type === 'draft-state') {
      draftState = message.state;
      players = message.state.players;
      settings = message.state.settings;
      persistMultiplayerProgress();
      renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, false, draftState, post, managers, tsRef, matchState, liveState, runningMatchRef, runningGameRef);
    }

    if (message.type === 'tournament-state') {
      tsRef.value = message.state;
      persistMultiplayerProgress();
      if (draftState) {
        renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, false, draftState, post, managers, tsRef, matchState, liveState, runningMatchRef, runningGameRef);
      }
    }

    if (message.type === 'match-state') {
      const previousMatchState = matchState;
      matchState = message.state;
      if (matchState.phase === 'idle') liveState = null;
      persistMultiplayerProgress();
      if (previousMatchState.phase === 'running' && matchState.phase === 'idle' && runningGameRef.value) {
        runningGameRef.value.destroy(true);
        runningGameRef.value = null;
        runningMatchRef.value = null;
        spectatorPushRef.value = null;
        document.body.classList.remove('match-running');
        if (!root.isConnected) document.body.appendChild(root);
      }
      if (draftState) {
        renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, false, draftState, post, managers, tsRef, matchState, liveState, runningMatchRef, runningGameRef);
      }
    }

    if (message.type === 'match-live-state') {
      liveState = message.state;
      if (matchState.phase === 'running') {
        if (!options.isHost) {
          // Feed the Phaser spectator scene directly
          spectatorPushRef.value?.(liveState);
        } else if (draftState) {
          renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, false, draftState, post, managers, tsRef, matchState, liveState, runningMatchRef, runningGameRef);
        }
      }
    }
  };

  window.addEventListener('beforeunload', () => {
    post({ type: 'leave', playerId: options.player.id });
    channel.close();
  });

  if (options.isHost) {
    persistMultiplayerProgress();
    if (draftState) {
      if (tsRef.value) post({ type: 'tournament-state', state: tsRef.value });
      broadcastDraft();
      broadcastMatch();
    } else {
      drawHostLobby();
    }
  } else {
    post({ type: 'join', player: options.player });
    renderLobbyWaiting(root, options.roomCode);
  }

  function drawHostLobby(): void {
    renderLobbyRoom(root, options.roomCode, options.player.id, true, players, settings, post, (nextSettings) => {
      settings = nextSettings;
      broadcastLobby();
    }, () => startHostDraft());
  }

  function handleHostMessage(message: LobbyMessage): void {
    if (message.type === 'join') {
      players = upsertPlayer(players, { ...message.player, isHost: false, isConnected: true });
      // Quando o draft já começou, envia draft-state (contém players/settings) em vez de lobby-state
      // para evitar que todos os guests sofram flicker voltando para a tela de lobby
      if (draftState) {
        broadcastDraft();
      } else {
        broadcastLobby();
      }
      if (tsRef.value) post({ type: 'tournament-state', state: tsRef.value });
      post({ type: 'match-state', state: matchState });
    }

    if (message.type === 'leave') {
      players = players.map((player) => (
        player.id === message.playerId && !player.isHost ? { ...player, isConnected: false } : player
      ));
      broadcastLobby();
    }

    if (message.type === 'update-name') {
      players = players.map((player) => (
        player.id === message.playerId ? { ...player, name: message.name || player.name } : player
      ));
      broadcastLobby();
    }

    if (message.type === 'pick') {
      managers.get(message.playerId)?.pick(message.pickId);

      // Avança a rodada para todos somente quando todos os jogadores escolheram
      const allPicked = [...managers.values()].every((m) => m.isComplete() || m.hasPickedThisRound());
      if (allPicked) managers.forEach((m) => m.advanceRound());

      broadcastDraft();
    }

    if (message.type === 'reroll') {
      managers.get(message.playerId)?.reroll();
      broadcastDraft();
    }

    if (message.type === 'tournament-state') {
      tsRef.value = message.state;
    }

    if (message.type === 'prepare-match') {
      prepareMatch(message.matchId);
    }

    if (message.type === 'formation-ready') {
      if (matchState.phase !== 'formation' || matchState.matchId !== message.matchId) return;
      matchState = {
        ...matchState,
        readyPlayerIds: [...new Set([...matchState.readyPlayerIds, message.playerId])],
        teams: { ...matchState.teams, [message.playerId]: message.team },
      };
      broadcastMatch();
    }

    if (message.type === 'host-start-match') {
      if (matchState.phase !== 'formation' || matchState.matchId !== message.matchId) return;
      if (autoStartMatchIfReady()) broadcastMatch();
    }

    if (message.type === 'match-result') {
      commitMatchResult(message.matchId, message.scoreHome, message.scoreAway);
    }
  }

  function startHostDraft(): void {
    managers.clear();
    tsRef.value = null;
    matchState = cloneEmptyMatchState();
    // Sequência gerada uma vez e compartilhada — todos veem a rodada especial no mesmo turno
    const roundKinds = generateRoundSequence(pools.famousPool);
    players.forEach((player) => {
      managers.set(player.id, new DraftManager(pools.fullPool, pools.famousPool, {}, roundKinds));
    });
    post({ type: 'start-draft' });
    broadcastDraft();
  }

  function autoStartMatchIfReady(): boolean {
    if (matchState.phase !== 'formation' || !matchState.matchId) return false;

    const ts = getOrCreateMultiplayerTs();
    const match = ts.plan.matches.find((item) => item.id === matchState.matchId);
    if (!match) return false;

    const required = playerIdsForMatch(match);
    const everyoneReady = required.length > 0 && required.every((playerId) => (
      matchState.readyPlayerIds.includes(playerId) && Boolean(matchState.teams[playerId])
    ));
    if (!everyoneReady) return false;

    matchState = { ...matchState, phase: 'running', startedAt: Date.now() };
    return true;
  }
}

function renderLobbyRoom(
  root: HTMLDivElement,
  roomCode: string,
  localPlayerId: string,
  isHost: boolean,
  players: LobbyPlayer[],
  settings: LobbySettings,
  post: (message: LobbyMessage) => void,
  onSettingsChange: (settings: LobbySettings) => void,
  onStart?: () => void,
): void {
  const plan = createTournamentPlan({
    mode: settings.mode,
    playerNames: players.map((player) => player.name),
    groupPlacement: settings.groupPlacement,
  });
  root.innerHTML = lobbyRoomView(roomCode, localPlayerId, isHost, players, settings, plan);

  const localNameInput = root.querySelector<HTMLInputElement>('[data-local-name]');
  const sendLocalName = (): void => {
    if (!localNameInput) return;
    post({ type: 'update-name', playerId: localPlayerId, name: localNameInput.value });
  };

  localNameInput?.addEventListener('change', sendLocalName);
  localNameInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    sendLocalName();
    localNameInput.blur();
  });

  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!isHost) return;
      onSettingsChange({ ...settings, mode: button.dataset.mode as TournamentMode });
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-visibility]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!isHost) return;
      onSettingsChange({ ...settings, visibility: button.dataset.visibility as DraftVisibility });
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-placement]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!isHost) return;
      onSettingsChange({ ...settings, groupPlacement: button.dataset.placement as GroupPlacement });
    });
  });

  root.querySelector<HTMLButtonElement>('[data-action="copy-code"]')?.addEventListener('click', (event) => {
    const code = (event.currentTarget as HTMLButtonElement).dataset.code ?? '';
    navigator.clipboard.writeText(code).then(() => {
      const btn = event.currentTarget as HTMLButtonElement;
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = 'Copiar'; }, 1500);
    }).catch(() => { /* clipboard indisponível */ });
  });

  root.querySelector<HTMLButtonElement>('[data-action="start-multiplayer-draft"]')?.addEventListener('click', () => {
    if (isHost) onStart?.();
  });
}

function renderMultiplayerDraft(
  root: HTMLDivElement,
  pools: DraftPools,
  roomCode: string,
  localPlayerId: string,
  isHost: boolean,
  state: MultiplayerDraftState,
  post: (message: LobbyMessage) => void,
  managers: Map<string, DraftManager>,
  tsRef: { value: TournamentState | null },
  matchState: MultiplayerMatchState,
  liveState: MultiplayerMatchLiveState | null,
  runningMatchRef: { value: string | null },
  runningGameRef: { value: ReturnType<typeof createGame> | null },
): void {
  const localTeam = state.teams.find((team) => team.playerId === localPlayerId) ?? state.teams[0];
  const localIndex = Math.max(0, state.players.findIndex((player) => player.id === localPlayerId));

  // Reuse existing plan to keep bot overalls stable; create once when first needed
  const getOrCreateTs = (): TournamentState => {
    if (!tsRef.value) {
      const playerNames = state.players.map((player) => player.name);
      const playerIds = state.players.map((player) => player.id);
      const botCount = 16 - playerNames.length;
      const botTeamNames = pickBotTeamNamesFromPool(botCount, pools.fullPool);
      const plan = createTournamentPlan({ mode: state.settings.mode, playerNames, playerIds, botTeamNames, groupPlacement: state.settings.groupPlacement });
      tsRef.value = createTournamentState(plan);
    }
    return tsRef.value;
  };

  const backToDraft = (): void => {
    renderMultiplayerDraft(root, pools, roomCode, localPlayerId, isHost, state, post, managers, tsRef, matchState, liveState, runningMatchRef, runningGameRef);
  };

  const tournament = tsRef.value?.plan ?? createTournamentPlan({
    mode: state.settings.mode,
    playerNames: state.players.map((player) => player.name),
    playerIds: state.players.map((player) => player.id),
    groupPlacement: state.settings.groupPlacement,
  });

  const allTeamsComplete = state.teams.length > 0 && state.teams.every((team) => team.isComplete);
  if (allTeamsComplete && matchState.phase === 'idle') {
    if (!isHost && !tsRef.value) {
      root.innerHTML = multiplayerSyncWaitingView(state.roomCode);
      return;
    }
    const ts = getOrCreateTs();
    if (isHost) {
      const nextMatch = getNextUserMatch(ts);
      if (nextMatch) simulateRoundBotMatchesBefore(ts, nextMatch.round, nextMatch.matchdayOrder);
      post({ type: 'tournament-state', state: ts });
    }
    renderTournamentTable(root, ts,
      (match) => {
        if (isHost) post({ type: 'prepare-match', matchId: match.id });
      },
      undefined,
      { canPlayNext: isHost },
    );
    return;
  }

  if (matchState.phase !== 'idle' && matchState.matchId) {
    if (!tsRef.value) {
      root.innerHTML = multiplayerSyncWaitingView(state.roomCode);
      return;
    }

    const match = tsRef.value.plan.matches.find((item) => item.id === matchState.matchId);
    if (!match) {
      root.innerHTML = multiplayerSyncWaitingView(state.roomCode);
      return;
    }

    const requiredPlayerIds = playerIdsForMatch(match);
    const localIsPlaying = requiredPlayerIds.includes(localPlayerId);
    const opponent = match.home.playerId === localPlayerId ? match.away : match.home;

    if (matchState.phase === 'formation') {
      if (localIsPlaying) {
        const ready = matchState.readyPlayerIds.includes(localPlayerId);
        renderFormationScreen(root, localTeam.picked, backToDraft, {
          competitionName: `${tsRef.value.plan.title} / ${match.stage}`,
          opponentName: opponent.name,
          opponentTeam: opponent.kind === 'bot' ? buildBotTeamFromPool(opponent.name, pools.fullPool) : undefined,
          savedFormation: loadMultiplayerFormation(roomCode, match.id, localPlayerId),
          onFormationChange: (formation) => {
            saveMultiplayerFormation(roomCode, match.id, localPlayerId, formation);
          },
          startButtonLabel: ready ? 'Pronto enviado' : 'Estou pronto',
          startButtonDisabled: ready,
          onReady: (team) => {
            post({ type: 'formation-ready', playerId: localPlayerId, matchId: match.id, team });
          },
        });
      } else {
        root.innerHTML = multiplayerSpectatorWaitingView(match, state, matchState);
      }
      return;
    }

    if (matchState.phase === 'running') {
      if (!isHost) {
        if (runningMatchRef.value !== match.id) {
          runningMatchRef.value = match.id;
          const home = orientTeam(teamForCompetitor(match.home, matchState.teams, pools), 'teamA', 0x38bdf8, 1);
          const away = orientTeam(teamForCompetitor(match.away, matchState.teams, pools), 'teamB', 0xef4444, -1);
          root.remove();
          document.body.classList.add('match-running');
          const game = createGame({
            teams: [home, away],
            spectatorMode: true,
            onSpectatorFrame: (push) => { spectatorPushRef.value = push; },
          });
          runningGameRef.value = game;
          // Feed any state that arrived before the scene was ready
          if (liveState) spectatorPushRef.value?.(liveState);
        }
        return;
      }

      root.innerHTML = multiplayerHostRunningView(match);
      if (runningMatchRef.value !== match.id) {
        runningMatchRef.value = match.id;
        const home = orientTeam(teamForCompetitor(match.home, matchState.teams, pools), 'teamA', 0x38bdf8, 1);
        const away = orientTeam(teamForCompetitor(match.away, matchState.teams, pools), 'teamB', 0xef4444, -1);
        root.remove();
        document.body.classList.add('match-running');
        const game = createGame({
          teams: [home, away],
          autoFinishDelayMs: 3500,
          onLiveUpdate: (live) => {
            post({
              type: 'match-live-state',
              state: {
                matchId: match.id,
                homeName: match.home.name,
                awayName: match.away.name,
                scoreHome: live.scoreA,
                scoreAway: live.scoreB,
                clock: live.clock,
                phase: live.phase,
                eventText: live.eventText,
                event: live.event,
                replay: live.replay,
                updatedAt: Date.now(),
              },
            });
          },
          onMatchEnd: (scoreHome, scoreAway) => {
            game.destroy(true);
            runningGameRef.value = null;
            document.body.classList.remove('match-running');
            document.body.appendChild(root);
            runningMatchRef.value = null;
            post({ type: 'match-result', matchId: match.id, scoreHome, scoreAway });
          },
        });
        runningGameRef.value = game;
      }
      return;
    }
  }

  const localRenderKey = multiplayerLocalRenderKey(state, localTeam, tournament, localIndex);
  if (root.dataset.multiplayerDraftScreen === 'draft' && root.dataset.multiplayerDraftLocalKey === localRenderKey) {
    const aside = root.querySelector<HTMLElement>('[data-multiplayer-draft-sidebar]');
    if (aside) {
      aside.innerHTML = multiplayerDraftSidebarView(state, localTeam);
      return;
    }
  }

  root.innerHTML = multiplayerDraftView(state, localTeam, tournament, localIndex);
  root.dataset.multiplayerDraftScreen = 'draft';
  root.dataset.multiplayerDraftLocalKey = localRenderKey;
  setupSequentialFlip(root);
  setupGoldParticles(root);

  root.querySelectorAll<HTMLButtonElement>('[data-pick-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const pickId = button.dataset.pickId ?? '';
      animatePickSelected(button, () => {
        post({ type: 'pick', playerId: localPlayerId, pickId });
      });
    });
  });

  root.querySelector<HTMLButtonElement>('[data-action="reroll"]')?.addEventListener('click', () => {
    animateBoosterExit(root, () => {
      post({ type: 'reroll', playerId: localPlayerId });
    });
  });

  const broadcastTournament = (): void => {
    if (tsRef.value) post({ type: 'tournament-state', state: tsRef.value });
  };

  root.querySelector<HTMLButtonElement>('[data-action="view-table"]')?.addEventListener('click', () => {
    const ts = getOrCreateTs();
    const nextMatch = getNextUserMatch(ts);
    if (nextMatch && isHost) simulateRoundBotMatchesBefore(ts, nextMatch.round, nextMatch.matchdayOrder);
    if (isHost) broadcastTournament();
    renderTournamentTable(root, ts,
      (match) => {
        if (isHost) post({ type: 'prepare-match', matchId: match.id });
      },
      backToDraft,
      { canPlayNext: isHost },
    );
  });

  root.querySelector<HTMLButtonElement>('[data-action="start-match"]')?.addEventListener('click', () => {
    const ts = getOrCreateTs();
    const nextMatch = getNextUserMatch(ts);
    if (isHost && nextMatch) post({ type: 'prepare-match', matchId: nextMatch.id });
  });
}

function createMultiplayerDraftState(
  roomCode: string,
  settings: LobbySettings,
  players: LobbyPlayer[],
  managers: Map<string, DraftManager>,
): MultiplayerDraftState {
  return {
    roomCode,
    settings,
    players,
    teams: players.map((player): MultiplayerDraftTeam => {
      const mgr = managers.get(player.id);
      const round = mgr?.getRound();
      return {
        playerId: player.id,
        playerName: player.name,
        picked: round?.picked ?? [],
        currentPlayers: round?.players ?? [],
        currentKind: round?.kind ?? 'normal',
        title: round?.title ?? 'Rodada Normal',
        rerollsLeft: round?.rerollsLeft ?? 0,
        isComplete: round?.isComplete ?? false,
        hasPickedThisRound: mgr?.hasPickedThisRound() ?? false,
      };
    }),
  };
}

function multiplayerSyncWaitingView(roomCode: string): string {
  return `
    <main class="draft-shell">
      <section class="draft-board">
        <div class="draft-waiting">
          <p class="draft-kicker">Sala ${escapeHtml(roomCode)}</p>
          <h2>Sincronizando partida...</h2>
          <p>Aguardando o estado do torneio chegar do host.</p>
        </div>
      </section>
    </main>
  `;
}

function multiplayerSpectatorWaitingView(
  match: TournamentMatch,
  state: MultiplayerDraftState,
  matchState: MultiplayerMatchState,
): string {
  const required = playerIdsForMatch(match);
  const playerName = (playerId: string): string => (
    state.players.find((player) => player.id === playerId)?.name ?? 'Jogador'
  );

  return `
    <main class="draft-shell">
      <section class="draft-board">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">${escapeHtml(match.stage)} / Rodada ${match.round}</p>
            <h1>${escapeHtml(match.home.name)} vs ${escapeHtml(match.away.name)}</h1>
            <p class="match-context">Aguardando formacoes dos jogadores envolvidos.</p>
          </div>
        </header>
        <div class="draft-waiting">
          <h2>Modo espectador</h2>
          <p>Voce vai assistir essa partida assim que todos estiverem prontos.</p>
          <ul class="waiting-list">
            ${required.map((playerId) => `
              <li class="${matchState.readyPlayerIds.includes(playerId) ? 'is-ready' : 'is-pending'}">
                <span class="waiting-dot"></span>
                ${escapeHtml(playerName(playerId))}
                <small>${matchState.readyPlayerIds.includes(playerId) ? 'pronto' : 'montando formacao'}</small>
              </li>
            `).join('')}
          </ul>
        </div>
      </section>
    </main>
  `;
}

function multiplayerHostRunningView(match: TournamentMatch): string {
  return `
    <main class="draft-shell">
      <section class="draft-board">
        <div class="draft-waiting">
          <p class="draft-kicker">${escapeHtml(match.stage)}</p>
          <h2>${escapeHtml(match.home.name)} vs ${escapeHtml(match.away.name)}</h2>
          <p>Partida oficial rodando no host.</p>
        </div>
      </section>
    </main>
  `;
}

function multiplayerMatchLiveView(match: TournamentMatch, liveState: MultiplayerMatchLiveState | null): string {
  const scoreHome = liveState?.scoreHome ?? 0;
  const scoreAway = liveState?.scoreAway ?? 0;
  const clock = liveState?.clock ?? '0\'';
  const phase = liveState?.phase ?? 'iniciando';
  const eventText = liveState?.eventText ?? 'Aguardando o primeiro pacote do host...';
  const updatedAgo = liveState ? Math.max(0, Math.round((Date.now() - liveState.updatedAt) / 1000)) : null;

  return `
    <main class="live-spectator-shell">
      <header class="draft-header" style="margin-bottom:12px">
        <div>
          <p class="draft-kicker">${escapeHtml(match.stage)} · Espectador</p>
          <h1 style="font-size:26px;line-height:1">${escapeHtml(match.home.name)} vs ${escapeHtml(match.away.name)}</h1>
        </div>
        <div class="live-scorebar" style="margin:0;width:auto;min-width:220px">
          <strong data-live-home>${escapeHtml(match.home.name)}</strong>
          <span data-live-score>${scoreHome} - ${scoreAway}</span>
          <strong data-live-away>${escapeHtml(match.away.name)}</strong>
        </div>
      </header>
      <p class="draft-kicker" data-live-event style="margin-bottom:6px">${escapeHtml(eventText)}</p>
      <div class="live-replay-stage" data-live-replay>
        <div class="live-host-hud">
          <span class="live-host-score" data-live-score>${scoreHome} - ${scoreAway}</span>
          <span class="live-host-clock" data-live-clock>${escapeHtml(clock)}</span>
        </div>
        <div class="live-host-possession">Ao vivo pelo host</div>
        <div class="live-goal live-goal-left"></div>
        <div class="live-goal live-goal-right"></div>
        <div class="live-field-border"></div>
        <div class="live-pitch-line live-half"></div>
        <div class="live-pitch-box live-penalty-left"></div>
        <div class="live-pitch-box live-penalty-right"></div>
        <div class="live-goal-box live-goal-box-left"></div>
        <div class="live-goal-box live-goal-box-right"></div>
        <div class="live-pitch-circle"></div>
        <div class="live-center-spot"></div>
        <div class="live-penalty-spot live-penalty-spot-left"></div>
        <div class="live-penalty-spot live-penalty-spot-right"></div>
        <div class="live-ball" data-live-ball></div>
      </div>
      <div class="live-meta-row" style="margin-top:8px">
        <span>Tempo <strong data-live-clock-meta>${escapeHtml(clock)}</strong></span>
        <span>Estado <strong data-live-phase>${escapeHtml(phase)}</strong></span>
        <span>Host <strong data-live-host>${updatedAgo === null ? 'conectando...' : `ha ${updatedAgo}s`}</strong></span>
      </div>
    </main>
  `;
}

function updateMultiplayerLiveReplay(root: HTMLDivElement, liveState: MultiplayerMatchLiveState): void {
  root.querySelectorAll<HTMLElement>('[data-live-score]').forEach((el) => {
    el.textContent = `${liveState.scoreHome} - ${liveState.scoreAway}`;
  });
  root.querySelector<HTMLElement>('[data-live-clock]')!.textContent = liveState.clock;
  root.querySelector<HTMLElement>('[data-live-clock-meta]')!.textContent = liveState.clock;
  root.querySelector<HTMLElement>('[data-live-phase]')!.textContent = liveState.phase;
  root.querySelector<HTMLElement>('[data-live-host]')!.textContent = 'agora';
  if (liveState.eventText) {
    root.querySelector<HTMLElement>('[data-live-event]')!.textContent = liveState.eventText;
  }

  const replay = liveState.replay;
  const pitch = root.querySelector<HTMLElement>('[data-live-replay]');
  if (!replay || !pitch) return;

  const ball = root.querySelector<HTMLElement>('[data-live-ball]');
  if (ball) {
    ball.style.left = `${(replay.ball.x / 1200) * 100}%`;
    ball.style.top = `${(replay.ball.y / 760) * 100}%`;
  }

  const seen = new Set<string>();
  for (const player of replay.players) {
    const markerKey = `${player.teamId}:${player.id}`;
    seen.add(markerKey);
    let marker = pitch.querySelector<HTMLElement>(`[data-live-player="${markerKey}"]`);
    if (!marker) {
      marker = document.createElement('div');
      marker.className = `live-player ${player.teamId === 'teamA' ? 'is-home' : 'is-away'}`;
      marker.dataset.livePlayer = markerKey;
      marker.innerHTML = `<span></span><small></small>`;
      pitch.appendChild(marker);
    }
    marker.classList.toggle('has-ball', player.hasBall);
    marker.style.left = `${(player.x / 1200) * 100}%`;
    marker.style.top = `${(player.y / 760) * 100}%`;
    marker.querySelector('span')!.textContent = String(player.jerseyNumber);
    marker.querySelector('small')!.textContent = shortPlayerName(player.name);
  }

  pitch.querySelectorAll<HTMLElement>('[data-live-player]').forEach((marker) => {
    if (!seen.has(marker.dataset.livePlayer ?? '')) marker.remove();
  });
}

function renderTournamentSetup(root: HTMLDivElement, pools: DraftPools, onStart: (plan: TournamentPlan) => void): void {
  let mode: TournamentMode = 'champions-16';
  let playerCount = 1;
  let names = ['Jogador 1'];
  let groupPlacement: GroupPlacement = 'separated';

  const renderSetup = (): void => {
    const plan = createTournamentPlan({ mode, playerNames: names.slice(0, playerCount), groupPlacement });
    root.innerHTML = tournamentSetupView(mode, playerCount, names, plan, groupPlacement);

    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        mode = button.dataset.mode as TournamentMode;
        renderSetup();
      });
    });

    root.querySelectorAll<HTMLButtonElement>('[data-placement]').forEach((button) => {
      button.addEventListener('click', () => {
        groupPlacement = button.dataset.placement as GroupPlacement;
        renderSetup();
      });
    });

    root.querySelector<HTMLInputElement>('[data-player-count]')?.addEventListener('input', (event) => {
      const next = Number((event.currentTarget as HTMLInputElement).value);
      playerCount = Math.max(0, Math.min(16, Number.isFinite(next) ? next : 1));
      names = Array.from({ length: playerCount }, (_, index) => names[index] ?? `Jogador ${index + 1}`);
      renderSetup();
    });

    root.querySelectorAll<HTMLInputElement>('[data-player-name]').forEach((input) => {
      input.addEventListener('input', () => {
        const index = Number(input.dataset.playerName);
        names[index] = input.value;
      });
    });

    root.querySelector<HTMLButtonElement>('[data-action="create-tournament"]')?.addEventListener('click', () => {
      const playerNames = names.slice(0, playerCount).map((name, index) => name.trim() || `Jogador ${index + 1}`);
      const botTeamNames = pickBotTeamNamesFromPool(16 - playerNames.length, pools.fullPool);
      onStart(createTournamentPlan({ mode, playerNames, botTeamNames, groupPlacement }));
    });
  };

  renderSetup();
}

function loadingView(): string {
  return `
    <main class="draft-shell">
      <section class="draft-loading">
        <h1>Carregando draft</h1>
        <p>Preparando boosters...</p>
      </section>
    </main>
  `;
}

function lobbyHomeView(
  playerName: string,
  joinCode: string,
  hasSave = false,
  hostSave: MultiplayerHostSave | null = null,
  invite: MultiplayerReturnInvite | null = null,
): string {
  return `
    <main class="tournament-shell">
      <section class="tournament-main">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">Multiplayer</p>
            <h1>Lobby</h1>
          </div>
        </header>

        <section class="player-count-panel">
          <label>
            Seu nome
            <input data-player-display value="${escapeHtml(playerName)}">
          </label>
          <p>Crie uma sala ou entre com o codigo. Cada dispositivo conectado vira um jogador humano no campeonato.</p>
        </section>

        ${hasSave ? `
        <div class="resume-banner">
          <span>Campeonato em andamento</span>
          <button class="start-button" data-action="resume-save">Continuar campeonato</button>
        </div>
        ` : ''}

        ${hostSave ? `
        <div class="resume-banner">
          <span>Sala multiplayer salva: ${escapeHtml(hostSave.roomCode)}</span>
          <button class="start-button" data-action="resume-multiplayer-host">Reabrir campeonato</button>
        </div>
        ` : ''}

        ${invite && !hostSave ? `
        <div class="resume-banner">
          <span>${escapeHtml(invite.hostName)} reabre esta sala como host</span>
          <button class="start-button" data-action="join-host-resume">Entrar na partida do host</button>
        </div>
        ` : ''}

        <div class="lobby-actions-grid">
          <button class="mode-card lobby-action-card" data-action="create-room">
            <strong>Criar sala</strong>
            <span>Voce escolhe o modo, a visibilidade dos picks e inicia o draft.</span>
          </button>
          <div class="join-card">
            <label>
              Codigo da sala
              <input data-join-code value="${escapeHtml(joinCode)}" maxlength="8" placeholder="ABC123">
            </label>
            <button class="start-button" data-action="join-room">Entrar</button>
          </div>
        </div>
      </section>

      <aside class="squad-panel">
        <div class="tournament-mini">
          <span>Multiplayer real</span>
          <strong>Compartilhe o codigo da sala e jogue de qualquer dispositivo ou navegador.</strong>
        </div>
      </aside>
    </main>
  `;
}

function renderLobbyWaiting(root: HTMLDivElement, roomCode: string): void {
  root.innerHTML = `
    <main class="tournament-shell">
      <section class="draft-loading">
        <p class="draft-kicker">Sala ${escapeHtml(roomCode)}</p>
        <h1>Conectando...</h1>
        <p>Aguardando resposta do host.</p>
      </section>
    </main>
  `;
}

function lobbyRoomView(
  roomCode: string,
  localPlayerId: string,
  isHost: boolean,
  players: LobbyPlayer[],
  settings: LobbySettings,
  plan: TournamentPlan,
): string {
  const localPlayer = players.find((player) => player.id === localPlayerId) ?? players[0];
  const onlineCount = players.filter((player) => player.isConnected !== false).length;

  return `
    <main class="tournament-shell">
      <section class="tournament-main">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">Sala ${escapeHtml(roomCode)}</p>
            <h1>Lobby multiplayer</h1>
            <p class="match-context">${onlineCount}/${players.length} humano${players.length === 1 ? '' : 's'} online / ${16 - players.length} bots</p>
          </div>
          <button class="start-button tournament-start" data-action="start-multiplayer-draft" ${isHost ? '' : 'disabled'}>
            Iniciar draft
          </button>
        </header>

        <section class="player-count-panel">
          <label>
            Seu nome
            <input data-local-name value="${escapeHtml(localPlayer?.name ?? 'Jogador')}">
          </label>
          <p>${isHost ? 'Voce e o host. Ajuste o modo e comece quando todos entrarem ou voltarem.' : 'Aguardando o host iniciar ou retomar o campeonato.'}</p>
        </section>

        <div class="mode-grid">
          ${Object.entries(TOURNAMENT_MODES).map(([key, option]) => `
            <button class="mode-card ${key === settings.mode ? 'is-active' : ''}" data-mode="${key}" ${isHost ? '' : 'disabled'}>
              <strong>${escapeHtml(option.title)}</strong>
              <span>${escapeHtml(option.subtitle)}</span>
            </button>
          `).join('')}
        </div>

        <div class="visibility-grid">
          <button class="mode-card ${settings.visibility === 'public' ? 'is-active' : ''}" data-visibility="public" ${isHost ? '' : 'disabled'}>
            <strong>Picks abertos</strong>
            <span>Todos veem os elencos sendo montados em tempo real.</span>
          </button>
          <button class="mode-card ${settings.visibility === 'hidden' ? 'is-active' : ''}" data-visibility="hidden" ${isHost ? '' : 'disabled'}>
            <strong>Hidden picks</strong>
            <span>Durante o draft, cada jogador ve apenas as proprias escolhas.</span>
          </button>
        </div>

        <div class="visibility-grid">
          <button class="mode-card ${(settings.groupPlacement ?? 'separated') === 'separated' ? 'is-active' : ''}" data-placement="separated" ${isHost ? '' : 'disabled'}>
            <strong>Grupos separados</strong>
            <span>Humanos distribuidos em grupos distintos — so se enfrentam nas quartas ou depois.</span>
          </button>
          <button class="mode-card ${settings.groupPlacement === 'random' ? 'is-active' : ''}" data-placement="random" ${isHost ? '' : 'disabled'}>
            <strong>Grupos aleatorios</strong>
            <span>Posicoes totalmente sortadas — humanos podem cair no mesmo grupo.</span>
          </button>
        </div>
      </section>

      <aside class="squad-panel">
        <div class="room-code-block">
          <span class="room-code-label">Codigo da sala</span>
          <strong class="room-code-value" id="room-code-display">${escapeHtml(roomCode)}</strong>
          <button class="copy-code-button" data-action="copy-code" data-code="${escapeHtml(roomCode)}">Copiar</button>
        </div>
        <div class="squad-header">
          <h2>Jogadores</h2>
          <span>${onlineCount}</span>
        </div>
        <ol class="picked-list tournament-list">
          ${players.map((player, index) => `
            <li>
              <span>${index + 1}</span>
              <div>
                <strong>${escapeHtml(player.name)}</strong>
                <small>${player.isHost ? 'Host' : 'Jogador'} / ${player.isConnected === false ? 'aguardando retorno' : 'online'} / ${plan.competitors[index]?.name ? 'Humano' : 'Bot'}</small>
              </div>
            </li>
          `).join('')}
        </ol>
      </aside>
    </main>
  `;
}

function multiplayerDraftView(
  state: MultiplayerDraftState,
  localTeam: MultiplayerDraftTeam,
  tournament: TournamentPlan,
  localIndex: number,
): string {
  const pickedCount = localTeam.picked.length;
  const totalPicks = 15;

  return `
    <main class="draft-shell">
      <section class="draft-board">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">${escapeHtml(tournament.title)} / Sala ${escapeHtml(state.roomCode)}</p>
            <h1>Draft de ${escapeHtml(localTeam.playerName)}</h1>
            <p class="match-context">Estreia contra ${escapeHtml(openingOpponentNameFor(tournament, localIndex))}</p>
          </div>
          <div class="draft-meter">
            <span>${pickedCount}/${totalPicks}</span>
            <div class="draft-progress" aria-hidden="true">
              <div style="width: ${(pickedCount / totalPicks) * 100}%"></div>
            </div>
          </div>
        </header>

        ${localTeam.isComplete
          ? completeView(localTeam.picked)
          : localTeam.hasPickedThisRound
            ? waitingForOthersView(state.teams)
            : multiplayerBoosterView(localTeam)}
      </section>

      <aside class="squad-panel" data-multiplayer-draft-sidebar>
        ${multiplayerDraftSidebarView(state, localTeam)}
      </aside>
    </main>
  `;
}

function multiplayerDraftSidebarView(state: MultiplayerDraftState, localTeam: MultiplayerDraftTeam): string {
  return `
    <div class="tournament-mini">
      <span>${state.settings.visibility === 'public' ? 'Picks abertos' : 'Hidden picks'}</span>
      <strong>${state.players.length} humanos / ${16 - state.players.length} bots</strong>
    </div>
    ${state.settings.visibility === 'public'
      ? publicDraftSummary(state.teams)
      : hiddenDraftSummary(state.teams, localTeam.playerId)}
  `;
}

function multiplayerLocalRenderKey(
  state: MultiplayerDraftState,
  localTeam: MultiplayerDraftTeam,
  tournament: TournamentPlan,
  localIndex: number,
): string {
  return JSON.stringify({
    roomCode: state.roomCode,
    mode: state.settings.mode,
    groupPlacement: state.settings.groupPlacement,
    title: tournament.title,
    opener: openingOpponentNameFor(tournament, localIndex),
    playerName: localTeam.playerName,
    picked: localTeam.picked.map((player) => player.id),
    currentPlayers: localTeam.currentPlayers.map((player) => player.id),
    currentKind: localTeam.currentKind,
    titleRound: localTeam.title,
    rerollsLeft: localTeam.rerollsLeft,
    isComplete: localTeam.isComplete,
    hasPickedThisRound: localTeam.hasPickedThisRound,
  });
}

function multiplayerBoosterView(team: MultiplayerDraftTeam): string {
  const specialClass = team.currentKind === 'famous-clubs' ? 'is-special' : '';
  const total = 15;
  const roundNumber = team.picked.length + 1;

  return `
    <div class="round-toolbar ${specialClass}">
      <div>
        <span>${team.currentKind === 'famous-clubs' ? 'Evento raro' : 'Booster'}</span>
        <strong>${team.currentKind === 'famous-clubs' ? 'Clubes famosos' : 'Pool completo'}</strong>
      </div>
      <div class="round-progress">
        <span class="round-label">Rodada ${roundNumber}/${total}</span>
        <div class="round-dots">
          ${Array.from({ length: total }, (_, i) => {
            const cls = i < roundNumber - 1 ? 'is-done' : i === roundNumber - 1 ? 'is-current' : '';
            return `<span class="round-dot ${cls}"></span>`;
          }).join('')}
        </div>
      </div>
      <button class="reroll-button" data-action="reroll" ${team.rerollsLeft <= 0 ? 'disabled' : ''}>
        Reroll (${team.rerollsLeft})
      </button>
    </div>

    <div class="booster-grid">
      ${team.currentPlayers.map((player, i) => playerCard(player, team.picked, i)).join('')}
    </div>
  `;
}

function waitingForOthersView(teams: MultiplayerDraftTeam[]): string {
  const pending = teams.filter((t) => !t.isComplete && !t.hasPickedThisRound);
  return `
    <div class="draft-waiting">
      <p class="draft-kicker">Rodada ${teams[0]?.picked.length ?? 0}</p>
      <h2>Escolha feita!</h2>
      <p>Aguardando ${pending.length === 1 ? pending[0].playerName : `${pending.length} jogadores`}...</p>
      <ul class="waiting-list">
        ${teams.map((t) => `
          <li class="${t.isComplete || t.hasPickedThisRound ? 'is-ready' : 'is-pending'}">
            <span class="waiting-dot"></span>
            ${escapeHtml(t.playerName)}
            ${t.isComplete ? '<small>completo</small>' : t.hasPickedThisRound ? '<small>escolheu</small>' : '<small>escolhendo...</small>'}
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

function publicDraftSummary(teams: MultiplayerDraftTeam[]): string {
  return `
    <div class="squad-header">
      <h2>Drafts</h2>
      <span>${teams.length}</span>
    </div>
    <div class="multi-team-list">
      ${teams.map((team) => `
        <section class="multi-team-card">
          <header>
            <strong>${escapeHtml(team.playerName)}</strong>
            <span>${team.isComplete ? '✓' : team.hasPickedThisRound ? 'Escolheu' : '...'} ${team.picked.length}/15</span>
          </header>
          ${positionNeedsView(team.picked, 'compact')}
          <ol class="picked-list">
            ${team.picked.map(pickedPlayerItem).join('')}
          </ol>
        </section>
      `).join('')}
    </div>
  `;
}

function hiddenDraftSummary(teams: MultiplayerDraftTeam[], localPlayerId: string): string {
  const localTeam = teams.find((team) => team.playerId === localPlayerId);
  const others = teams.filter((team) => team.playerId !== localPlayerId);

  return `
    ${others.length > 0 ? `
      <div class="hidden-progress-list">
        ${others.map((team) => `
          <div>
            <strong>${escapeHtml(team.playerName)}</strong>
            <span>${team.picked.length}/15</span>
          </div>
        `).join('')}
      </div>
    ` : ''}
    ${squadDraftPanel(localTeam?.picked ?? [], 'Seu elenco')}
  `;
}

function draftView(round: DraftRound, tournament: TournamentPlan): string {
  const pickedCount = round.picked.length;
  const totalPicks = 15;

  return `
    <main class="draft-shell">
      <section class="draft-board">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">${escapeHtml(tournament.title)} / ${round.isComplete ? 'Elenco completo' : round.title}</p>
            <h1>Draft do elenco</h1>
            <p class="match-context">Estreia contra ${escapeHtml(openingOpponentName(tournament))}</p>
          </div>
          <div class="draft-meter">
            <span>${pickedCount}/${totalPicks}</span>
            <div class="draft-progress" aria-hidden="true">
              <div style="width: ${(pickedCount / totalPicks) * 100}%"></div>
            </div>
          </div>
        </header>

        ${round.isComplete ? completeView(round.picked) : boosterView(round)}
      </section>

      <aside class="squad-panel">
        <div class="tournament-mini">
          <span>${escapeHtml(tournament.subtitle)}</span>
          <strong>${tournament.competitors.filter((team) => team.kind === 'player').length} humanos / ${tournament.competitors.filter((team) => team.kind === 'bot').length} bots</strong>
        </div>
        ${squadDraftPanel(round.picked, 'Escolhidos')}
      </aside>
    </main>
  `;
}

function tournamentSetupView(
  mode: TournamentMode,
  playerCount: number,
  names: string[],
  plan: TournamentPlan,
  groupPlacement: GroupPlacement = 'separated',
): string {
  return `
    <main class="tournament-shell">
      <section class="tournament-main">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">Novo campeonato</p>
            <h1>Criar campeonato</h1>
          </div>
          <button class="start-button tournament-start" data-action="create-tournament">Ir para o draft</button>
        </header>

        <div class="mode-grid">
          ${Object.entries(TOURNAMENT_MODES).map(([key, option]) => `
            <button class="mode-card ${key === mode ? 'is-active' : ''}" data-mode="${key}">
              <strong>${escapeHtml(option.title)}</strong>
              <span>${escapeHtml(option.subtitle)}</span>
            </button>
          `).join('')}
        </div>

        <div class="visibility-grid">
          <button class="mode-card ${groupPlacement === 'separated' ? 'is-active' : ''}" data-placement="separated">
            <strong>Grupos separados</strong>
            <span>Humanos distribuidos em grupos distintos — so se enfrentam nas quartas ou depois.</span>
          </button>
          <button class="mode-card ${groupPlacement === 'random' ? 'is-active' : ''}" data-placement="random">
            <strong>Grupos aleatorios</strong>
            <span>Posicoes totalmente sortadas — humanos podem cair no mesmo grupo.</span>
          </button>
        </div>

        <section class="player-count-panel">
          <label>
            Jogadores humanos
            <input data-player-count type="number" min="0" max="16" value="${playerCount}">
          </label>
          <p>O campeonato fecha sempre com 16 times. As vagas vazias viram bots automaticamente.</p>
        </section>

        <div class="name-grid">
          ${Array.from({ length: playerCount }, (_, index) => `
            <label>
              Time ${index + 1}
              <input data-player-name="${index}" value="${escapeHtml(names[index] ?? `Jogador ${index + 1}`)}">
            </label>
          `).join('')}
        </div>
      </section>

      <aside class="squad-panel">
        <div class="squad-header">
          <h2>Participantes</h2>
          <span>16</span>
        </div>
        <ol class="picked-list tournament-list">
          ${plan.competitors.map((team) => `
            <li>
              <span>${team.seed}</span>
              <div>
                <strong>${escapeHtml(team.name)}</strong>
                <small>${team.kind === 'player' ? 'Jogador' : 'Bot'}</small>
              </div>
            </li>
          `).join('')}
        </ol>
      </aside>
    </main>
  `;
}

function openingOpponentName(tournament: TournamentPlan): string {
  const ownTeam = tournament.competitors.find((team) => team.kind === 'player') ?? tournament.competitors[0];
  const opening = tournament.openingMatch;
  return opening.home.id === ownTeam.id ? opening.away.name : opening.home.name;
}

function openingOpponentNameFor(tournament: TournamentPlan, playerIndex: number): string {
  const ownTeam = tournament.competitors[playerIndex] ?? tournament.competitors[0];
  const ownMatch = tournament.matches.find((match) => (
    match.home.id === ownTeam.id || match.away.id === ownTeam.id
  )) ?? tournament.openingMatch;

  return ownMatch.home.id === ownTeam.id ? ownMatch.away.name : ownMatch.home.name;
}

function upsertPlayer(players: LobbyPlayer[], nextPlayer: LobbyPlayer): LobbyPlayer[] {
  const exists = players.some((player) => player.id === nextPlayer.id);
  if (!exists) return [...players, nextPlayer].slice(0, 16);

  return players.map((player) => (
    player.id === nextPlayer.id
      ? { ...player, name: nextPlayer.name, isHost: player.isHost, isConnected: nextPlayer.isConnected ?? player.isConnected }
      : player
  ));
}

function isHostHandledMessage(message: LobbyMessage): boolean {
  return (
    message.type === 'join'
    || message.type === 'leave'
    || message.type === 'update-name'
    || message.type === 'pick'
    || message.type === 'reroll'
    || message.type === 'prepare-match'
    || message.type === 'formation-ready'
    || message.type === 'host-start-match'
    || message.type === 'match-result'
  );
}

function boosterView(round: DraftRound): string {
  const specialClass = round.kind === 'famous-clubs' ? 'is-special' : '';
  const total = 15;

  return `
    <div class="round-toolbar ${specialClass}">
      <div>
        <span>${round.kind === 'famous-clubs' ? 'Evento raro' : 'Booster'}</span>
        <strong>${round.kind === 'famous-clubs' ? 'Clubes famosos' : 'Pool completo'}</strong>
      </div>
      <div class="round-progress">
        <span class="round-label">Rodada ${round.number}/${total}</span>
        <div class="round-dots">
          ${Array.from({ length: total }, (_, i) => {
            const cls = i < round.number - 1 ? 'is-done' : i === round.number - 1 ? 'is-current' : '';
            return `<span class="round-dot ${cls}"></span>`;
          }).join('')}
        </div>
      </div>
      <button class="reroll-button" data-action="reroll" ${round.rerollsLeft <= 0 ? 'disabled' : ''}>
        Reroll (${round.rerollsLeft})
      </button>
    </div>

    <div class="booster-grid">
      ${round.players.map((player, i) => playerCard(player, round.picked, i)).join('')}
    </div>
  `;
}

function completeView(picked: DraftPlayer[]): string {
  const avg = Math.round(picked.reduce((sum, player) => sum + player.overall, 0) / picked.length);
  const best = [...picked].sort((a, b) => b.overall - a.overall).slice(0, 3);

  return `
    <section class="draft-complete">
      <div>
        <span>OVR médio</span>
        <strong>${avg}</strong>
      </div>
      <div>
        <span>Destaques</span>
        <p>${best.map((player) => player.name).join(', ')}</p>
      </div>
      <div class="complete-actions">
        <button class="ghost-button" data-action="view-table">Ver Tabela</button>
        <button class="start-button" data-action="start-match">Começar partida</button>
      </div>
    </section>
  `;
}

const TRAIT_PT_LABELS: Record<string, string> = {
  'Rapid': 'Veloz',
  'Quick Step': 'Arrancada',
  'Relentless': 'Incansável',
  'Technical': 'Técnico',
  'First Touch': '1º Toque',
  'Incisive Pass': 'Passe Incisivo',
  'Whipped Pass': 'Passe Forte',
  'Intercept': 'Interceptador',
  'Jockey': 'Marcação',
  'Clinical': 'Finalizador',
  'Long Shot': 'Chute de Longe',
  'Crosser': 'Cruzador',
};

function traitBadges(player: DraftPlayer): string {
  const badges = [
    ...player.playstylesPlus.map(t => ({ name: t, plus: true })),
    ...player.playstyles.map(t => ({ name: t, plus: false })),
  ];
  if (badges.length === 0) return '';
  const spans = badges.map(({ name, plus }) => {
    const label = TRAIT_PT_LABELS[name] ?? name;
    return `<span class="trait${plus ? ' is-plus' : ''}">${escapeHtml(label)}${plus ? '+' : ''}</span>`;
  }).join('');
  return `<div class="trait-row">${spans}</div>`;
}

function cardTierClass(overall: number): string {
  if (overall >= 85) return 'tier-gold';
  if (overall >= 80) return 'tier-silver';
  if (overall >= 70) return 'tier-bronze';
  return 'tier-gray';
}

function statColor(v: number): string {
  if (v >= 85) return '#2dd4bf';
  if (v >= 75) return '#60a5fa';
  if (v >= 60) return '#fb923c';
  return '#f87171';
}

function statBar(label: string, value: number): string {
  return `
    <div class="stat-bar">
      <span>${label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${value}%;--v:${value}"></div></div>
      <b>${value}</b>
    </div>`;
}

function isPositionNeeded(player: DraftPlayer, picked: DraftPlayer[]): boolean {
  const target = SQUAD_TARGETS.find((t) => t.role === player.role);
  if (!target) return false;
  return picked.filter((p) => p.role === player.role).length < target.target;
}

function playerCard(player: DraftPlayer, picked: DraftPlayer[] = [], index = 0): string {
  const tier = cardTierClass(player.overall);
  const needed = isPositionNeeded(player, picked);
  const fitClass = needed ? 'is-needed' : 'is-full';
  const fitTitle = needed ? 'Posição necessária no elenco' : 'Posição já preenchida';
  const { speed, shooting, passing, dribbling, defending, physical } = player.stats;

  return `
    <div class="card-flip-wrapper ${tier}" style="--i:${index}">
    <button class="player-card ${tier}" data-pick-id="${escapeHtml(player.id)}">
      <div class="card-header-row">
        <div class="card-rating">
          <span class="overall">${player.overall}</span>
          <span class="position">${escapeHtml(positionLabel(player.position))}</span>
        </div>
        <span class="fit-dot ${fitClass}" title="${fitTitle}"></span>
      </div>
      <strong class="card-name">${escapeHtml(player.name)}</strong>
      <small class="card-club">${escapeHtml(player.team)}</small>
      <span class="meta">${playerMeta(player)}</span>
      <div class="stat-bars">
        ${statBar('PAC', speed)}
        ${statBar('FIN', shooting)}
        ${statBar('PAS', passing)}
        ${statBar('DRI', dribbling)}
        ${statBar('DEF', defending)}
        ${statBar('FIS', physical)}
      </div>
      ${traitBadges(player)}
    </button>
    </div>
  `;
}

function groupedPickedList(picked: DraftPlayer[]): string {
  if (picked.length === 0) {
    return '<li class="empty-pick"><div><strong>Nenhum jogador ainda</strong><small>Escolha no booster para preencher o elenco.</small></div></li>';
  }
  return SQUAD_TARGETS.flatMap(({ role, label }) => {
    const group = picked.filter((p) => p.role === role);
    if (group.length === 0) return [];
    const header = `<li class="position-group-label"><span class="pg-badge">${label}</span><span class="pg-count">${group.length}</span></li>`;
    return [header, ...group.map(pickedPlayerItem)];
  }).join('');
}

function squadDraftPanel(picked: DraftPlayer[], title: string): string {
  return `
    <div class="squad-header">
      <h2>${escapeHtml(title)}</h2>
      <span>${picked.length}</span>
    </div>
    ${positionNeedsView(picked)}
    ${formationPreview(picked, PREVIEW_FORMATION)}
    <ol class="picked-list picked-list-large">
      ${groupedPickedList(picked)}
    </ol>
  `;
}

const POSITION_ORDER = ['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'];

function positionNeedsView(picked: DraftPlayer[], density: 'normal' | 'compact' = 'normal'): string {
  if (picked.length === 0) return '';
  const className = density === 'compact' ? 'position-needs is-compact' : 'position-needs';

  const counts = new Map<string, number>();
  for (const p of picked) counts.set(p.position, (counts.get(p.position) ?? 0) + 1);

  const ordered = [
    ...POSITION_ORDER.filter((pos) => counts.has(pos)),
    ...[...counts.keys()].filter((pos) => !POSITION_ORDER.includes(pos)),
  ];

  return `
    <div class="${className}">
      ${ordered.map((pos) => `
        <span class="is-complete">
          <strong>${positionLabel(pos)}</strong>
          <em>${counts.get(pos)}</em>
        </span>
      `).join('')}
    </div>
  `;
}

function formationPreview(picked: DraftPlayer[], formation: FormationDefinition): string {
  const used = new Set<string>();
  const slots = formation.slots.map((slot) => {
    const player = pickPreviewPlayer(picked, used, slot.role);
    if (player) used.add(player.id);
    return { ...slot, player };
  });

  return `
    <section class="draft-formation-preview" aria-label="Previa da formacao">
      <header>
        <strong>${formation.name}</strong>
        <span>${slots.filter((slot) => slot.player).length}/11</span>
      </header>
      <div class="draft-mini-pitch">
        ${slots.map((slot) => `
          <div
            class="draft-mini-player ${slot.player ? 'is-filled' : 'is-empty'}"
            style="left: ${(slot.x / 1200) * 100}%; top: ${((slot.y - 76) / (744 - 76)) * 100}%"
          >
            ${slot.player
              ? `<span>${slot.player.overall}</span><strong>${escapeHtml(shortPlayerName(slot.player.name))}</strong>`
              : `<span>${roleLabel(slot.role)}</span><strong>Falta</strong>`}
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function pickPreviewPlayer(players: DraftPlayer[], used: Set<string>, role: PlayerRole): DraftPlayer | null {
  const available = players.filter((player) => !used.has(player.id));
  if (available.length === 0) return null;

  return [...available].sort((a, b) => previewFitScore(b, role) - previewFitScore(a, role))[0] ?? null;
}

function previewFitScore(player: DraftPlayer, role: PlayerRole): number {
  const exact = player.role === role ? 160 : 0;
  const close =
    role === PlayerRole.Winger && player.role === PlayerRole.Midfielder ? 45 :
    role === PlayerRole.Midfielder && player.role === PlayerRole.Winger ? 35 :
    role === PlayerRole.Striker && player.role === PlayerRole.Winger ? 25 :
    role === PlayerRole.Defender && player.role === PlayerRole.Midfielder ? 20 :
    0;

  if (role === PlayerRole.Goalkeeper) {
    return exact + player.stats.defending + player.stats.physical * 0.35 + player.overall;
  }

  return exact + close + player.overall + player.stats.intelligence * 0.2;
}

function roleLabel(role: PlayerRole): string {
  switch (role) {
    case PlayerRole.Goalkeeper: return 'GOL';
    case PlayerRole.Defender: return 'DEF';
    case PlayerRole.Midfielder: return 'MEI';
    case PlayerRole.Winger: return 'ALA';
    case PlayerRole.Striker: return 'ATA';
  }
}

function shortPlayerName(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  return (parts[parts.length - 1] ?? name).slice(0, 8);
}

function pickedPlayerItem(player: DraftPlayer): string {
  return `
    <li>
      <span>${player.overall}</span>
      <div>
        <strong>${escapeHtml(player.name)}</strong>
        <small><b>${escapeHtml(positionLabel(player.position))}</b> · ${escapeHtml(player.team)} · ${playerMeta(player)}</small>
        ${traitBadges(player)}
      </div>
    </li>
  `;
}

function playerMeta(player: DraftPlayer, includeTeam = false): string {
  const flagCode = nationalityFlagCode(player.nationality);
  const flag = flagCode
    ? `<img class="flag" src="https://flagcdn.com/20x15/${flagCode}.png" alt="" loading="lazy"> `
    : '';
  const nationality = `${flag}${escapeHtml(player.nationality)}`;
  const team = includeTeam ? `${escapeHtml(player.team)} · ` : '';
  return `${team}${nationality} · ${escapeHtml(player.leagueName)}`;
}

function playerBodyMeta(player: DraftPlayer): string {
  return `${formatHeight(player)} / ${formatWeight(player)}`;
}

function formatHeight(player: DraftPlayer): string {
  return player.heightCm > 0 ? `${Math.round(player.heightCm)}cm` : '--';
}

function formatWeight(player: DraftPlayer): string {
  return player.weightKg > 0 ? `${Math.round(player.weightKg)}kg` : '--';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

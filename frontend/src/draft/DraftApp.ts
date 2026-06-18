import { loadDraftPlayers } from './CsvPlayerLoader';
import { DraftManager, generateRoundSequence } from './DraftManager';
import { BotTeam, DraftPlayer, DraftRoundKind } from './DraftTypes';
import { buildBotPool, buildTeamDataFromBotTeam, filterBotPoolByDifficulty, pickBotTeams, renderFormationScreen, SavedFormationState } from './FormationApp';
import { showHalftimePanel } from './HalftimePanel';
import { compileScheme, DEFAULT_TACTICAL_PROFILE, TACTICAL_SCHEMES, TacticalProfile } from '../game/data/TacticalProfile';
import { createGame } from '../game/FootballGame';
import { KitColors, KitPattern, TeamData } from '../game/data/TeamFactory';
import { PlayerRole } from '../game/data/PlayerRole';
import {
  createPlayerId,
  createRoomCode,
  DEFAULT_LOBBY_SETTINGS,
  Difficulty,
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
import {
  accumulatePlayerStats,
  advanceAndSimulateKnockout,
  createTournamentPlan,
  createTournamentState,
  getNextUserMatch,
  GoalEvent,
  isTournamentComplete,
  simulateRoundBotMatches,
  simulateRoundBotMatchesBefore,
  TournamentMode,
  TournamentPlan,
  TournamentMatch,
  TournamentState,
} from './Tournament';
import { renderTournamentTable } from './TournamentTableApp';
import { loadingView, draftView, tournamentSetupView, penaltyScreenView, escapeHtml } from './DraftViews';
import {
  lobbyHomeView,
  lobbyWaitingView,
  lobbyRoomView,
  lobbyHexColor,
  kitPatternBg,
  multiplayerSyncWaitingView,
  multiplayerSpectatorWaitingView,
  multiplayerHostRunningView,
  multiplayerDraftView,
  multiplayerDraftSidebarView,
  multiplayerLocalRenderKey,
} from './MultiplayerViews';
import { simulatePenalties, buildPenaltyKickers, simulateMultiplayerPenaltyScore } from './PenaltySimulator';

// ── Module-level draft countdown (singleton — one draft screen at a time) ────
let _draftCountdown: ReturnType<typeof setInterval> | null = null;

// ── Storage keys ──────────────────────────────────────────────────────────────

const SAVE_KEY = 'football-sim-save';
const FORMATION_SAVE_KEY = 'football-sim-last-formation';
const MULTIPLAYER_HOST_SAVE_KEY = 'football-sim-multiplayer-host-save';
const MULTIPLAYER_INVITE_KEY = 'football-sim-multiplayer-invite';
const MULTIPLAYER_FORMATION_SAVE_PREFIX = 'football-sim-multiplayer-formation';

// ── Interfaces ────────────────────────────────────────────────────────────────

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
  roundKinds: DraftRoundKind[] | null;
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

export interface DraftPools {
  fullPool: DraftPlayer[];
  famousPool: DraftPlayer[];
  botPool: BotTeam[];
}

// ── Persistence helpers ───────────────────────────────────────────────────────

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

function saveLastFormation(formation: SavedFormationState): void {
  try {
    localStorage.setItem(FORMATION_SAVE_KEY, JSON.stringify(formation));
  } catch { /* ignore */ }
}

function loadLastFormation(): SavedFormationState | null {
  try {
    const raw = localStorage.getItem(FORMATION_SAVE_KEY);
    return raw ? (JSON.parse(raw) as SavedFormationState) : null;
  } catch {
    return null;
  }
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

function multiplayerFormationSaveKey(roomCode: string, playerId: string): string {
  return `${MULTIPLAYER_FORMATION_SAVE_PREFIX}:${roomCode}:${playerId}`;
}

function saveMultiplayerFormation(
  roomCode: string,
  playerId: string,
  formation: SavedFormationState,
): void {
  try {
    localStorage.setItem(multiplayerFormationSaveKey(roomCode, playerId), JSON.stringify(formation));
  } catch {
    // ignore storage failures
  }
}

function loadMultiplayerFormation(
  roomCode: string,
  playerId: string,
): SavedFormationState | null {
  try {
    const raw = localStorage.getItem(multiplayerFormationSaveKey(roomCode, playerId));
    return raw ? (JSON.parse(raw) as SavedFormationState) : null;
  } catch {
    return null;
  }
}

// ── Entry points ──────────────────────────────────────────────────────────────

const FULL_POOL_URL = '/data/ea_fc26_players.csv';
const FAMOUS_POOL_URL = '/data/ea_fc26_players_clubes_famosos.csv';

export async function startDraftApp(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#draft-root');
  if (!root) throw new Error('Missing #draft-root element.');

  root.innerHTML = loadingView();

  try {
    const [fullPool, famousPool] = await Promise.all([
      loadDraftPlayers(FULL_POOL_URL),
      loadDraftPlayers(FAMOUS_POOL_URL),
    ]);
    const botPool = buildBotPool(fullPool);

    renderLobbyHome(root, { fullPool, famousPool, botPool });
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

  const debugBotPool = buildBotPool(allPlayers);
  const reroll = (): void => {
    const squad = buildDebugSquad(allPlayers, 18);
    const botTeam = pickBotTeams(1, debugBotPool)[0];
    const opponent = botTeam ? buildTeamDataFromBotTeam(botTeam) : { id: 'teamB', name: 'Debug Bot', color: 0xef4444, attackDirection: -1 as const, formationName: '4-4-2', players: [] };
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

// ── Draft animations ──────────────────────────────────────────────────────────

function animatePickSelected(button: HTMLButtonElement, onDone: () => void): void {
  button.classList.add('is-picked');
  setTimeout(onDone, 220);
}

function animateBoosterExit(root: Element, onDone: () => void): void {
  root.querySelectorAll<HTMLElement>('.booster-grid .card-slide-wrapper').forEach((wrapper) => {
    wrapper.classList.add('is-exiting');
  });
  // 6 cards × 30ms delay + 130ms duration
  setTimeout(onDone, 310);
}

const FLIP_DURATION: Record<string, number> = {
  'tier-gold': 780,
  'tier-silver': 170,
  'tier-bronze': 170,
};
const DEFAULT_FLIP_DURATION = 180;
const SLIDE_DURATION_MS = 320;
const SLIDE_STAGGER_MS = 55;

function setupCardRowSlide(root: Element, slideWrappers: NodeListOf<HTMLElement>, baseSlideDelay: number): void {
  const grid = root.querySelector<HTMLElement>('.booster-grid');
  if (!grid || slideWrappers.length === 0) return;

  const gridRect = grid.getBoundingClientRect();
  const rows = new Map<number, HTMLElement[]>();

  slideWrappers.forEach((wrapper) => {
    const rect = wrapper.getBoundingClientRect();
    const rowKey = Math.round(rect.top - gridRect.top);
    rows.set(rowKey, [...(rows.get(rowKey) ?? []), wrapper]);
  });

  [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .forEach(([, row], rowIndex) => {
      row.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      row.forEach((wrapper, columnIndex) => {
        const rect = wrapper.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const startX = gridRect.left - rect.width * 0.65;
        const delay = baseSlideDelay + columnIndex * SLIDE_STAGGER_MS + rowIndex * 30;

        wrapper.style.setProperty('--stack-x', `${Math.round(startX - centerX)}px`);
        wrapper.style.setProperty('--stack-y', '0px');
        wrapper.style.setProperty('--stack-rotate', '-2deg');
        wrapper.style.setProperty('--slide-delay', `${delay}ms`);
      });
    });
}

function setupSequentialFlip(root: Element): void {
  const flipWrappers = root.querySelectorAll<HTMLElement>('.booster-grid .card-flip-wrapper');
  const slideWrappers = root.querySelectorAll<HTMLElement>('.booster-grid .card-slide-wrapper');
  const baseSlideDelay = 0;

  setupCardRowSlide(root, slideWrappers, baseSlideDelay);

  let cumulative = baseSlideDelay + SLIDE_DURATION_MS;
  flipWrappers.forEach((wrapper, index) => {
    cumulative = Math.max(cumulative, baseSlideDelay + index * SLIDE_STAGGER_MS + SLIDE_DURATION_MS);
    wrapper.style.setProperty('--flip-delay', `${cumulative}ms`);
    const dur = Object.entries(FLIP_DURATION).find(([cls]) => wrapper.classList.contains(cls))?.[1]
      ?? DEFAULT_FLIP_DURATION;
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

function setupCardToggles(root: Element): void {
  root.querySelectorAll<HTMLElement>('[data-toggle-details]').forEach((toggle) => {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = toggle.closest<HTMLElement>('.player-card');
      const panel = card?.querySelector<HTMLElement>('.extra-stats');
      if (!panel) return;
      const expanded = panel.hidden;
      panel.hidden = !expanded;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = expanded ? '▾ Ocultar' : '▸ Ver detalhes';
    });
  });
}

function setupGoldParticles(root: Element): void {
  root.querySelectorAll<HTMLElement>('.booster-grid .card-flip-wrapper.tier-gold').forEach((wrapper) => {
    wrapper.addEventListener('animationstart', (ev) => {
      if ((ev as AnimationEvent).animationName !== 'cardFlipRevealGold') return;
      setTimeout(() => spawnGoldParticles(wrapper), 360);
    }, { once: true });
  });
}

// ── Single-player draft render ────────────────────────────────────────────────

function render(root: HTMLDivElement, manager: DraftManager, tournament: TournamentPlan, pools: DraftPools): void {
  const round = manager.getRound();
  root.innerHTML = draftView(round, tournament);
  setupSequentialFlip(root);
  setupGoldParticles(root);
  setupCardToggles(root);

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
    const backToDraft = () => render(root, manager, tournament, pools);
    const launchTournament = () => startTournamentMatch(root, round.picked, state, pools, backToDraft);
    renderFormationScreen(root, round.picked, backToDraft, {
      competitionName: tournament.title,
      startButtonLabel: 'Iniciar torneio',
      savedFormation: loadLastFormation(),
      onFormationChange: saveLastFormation,
      onReady: (_team) => launchTournament(),
    });
  });
}

// ── Penalty shootout ──────────────────────────────────────────────────────────

const KNOCKOUT_STAGES = new Set(['Oitavas', 'Quartas', 'Semi', 'Final']);

function showPenaltyScreen(
  root: HTMLDivElement,
  picked: DraftPlayer[],
  opponentTeam: TeamData,
  drawScore: number,
  userIsHome: boolean,
  opponentName: string,
  userTeamName: string,
  onContinue: (penaltiesHome: number, penaltiesAway: number) => void,
): void {
  const userKickers = buildPenaltyKickers(picked);
  const botKickers  = buildPenaltyKickers(opponentTeam.players);
  const result      = simulatePenalties(userKickers, botKickers);

  const penHome = userIsHome ? result.userScore : result.botScore;
  const penAway = userIsHome ? result.botScore  : result.userScore;

  root.innerHTML = penaltyScreenView(userTeamName, opponentName, drawScore, result);

  root.querySelector<HTMLButtonElement>('[data-action="continue-penalty"]')?.addEventListener('click', () => {
    onContinue(penHome, penAway);
  });
}

// ── Tournament match flow ─────────────────────────────────────────────────────

function startTournamentMatch(
  root: HTMLDivElement,
  picked: DraftPlayer[],
  state: TournamentState,
  pools: DraftPools,
  onBack: () => void,
  onAfterResult?: () => void,
): void {
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

  saveProgress(state, picked);

  const userIsHome = match.home.kind === 'player';
  const opponentName = userIsHome ? match.away.name : match.home.name;
  const userTeamName = userIsHome ? match.home.name : match.away.name;
  const opponentBotTeam = pools.botPool.find((t) => t.name === opponentName);
  const opponentTeam = opponentBotTeam ? buildTeamDataFromBotTeam(opponentBotTeam) : buildTeamDataFromBotTeam(pickBotTeams(1, pools.botPool)[0] ?? { name: opponentName, overall: 75, players: [] });
  const isKnockout = KNOCKOUT_STAGES.has(match.stage);

  const goToTable = (): void => {
    renderTournamentTable(root, state, () => {
      startTournamentMatch(root, picked, state, pools, onBack, onAfterResult);
    });
  };

  const matchGoals: GoalEvent[] = [];

  const commitResult = (scoreHome: number, scoreAway: number, penHome?: number, penAway?: number): void => {
    state.results[match.id] = {
      scoreHome,
      scoreAway,
      ...(penHome !== undefined ? { penaltiesHome: penHome, penaltiesAway: penAway } : {}),
      goals: matchGoals.slice(),
    };
    accumulatePlayerStats(state, matchGoals);
    simulateRoundBotMatches(state, match.round);
    advanceAndSimulateKnockout(state);
    saveProgress(state, picked);
    onAfterResult?.();
    goToTable();
  };

  const staminaById = new Map(picked.map((p) => [p.id, p.stats.stamina]));

  renderFormationScreen(root, picked, goToTable, {
    competitionName: state.plan.title,
    teamName: userTeamName,
    opponentName,
    opponentTeam,
    matchId: match.id,
    userIsHome,
    savedFormation: loadLastFormation(),
    onFormationChange: saveLastFormation,
    initialStaminas: state.playerStaminas,
    onHalftime: (ctx) => showHalftimePanel(ctx),
    onGoalScored: (g) => matchGoals.push(g),
    onMatchEnd: (scoreA, scoreB, finalStaminas) => {
      if (finalStaminas) {
        const recovered: Record<string, number> = {};
        for (const [id, endStamina] of Object.entries(finalStaminas)) {
          const staminaStat = staminaById.get(id) ?? 75;
          // stat=50 → 50% recovery, stat=80 → 62%, stat=100 → 70%
          const recoveryRate = 0.30 + (staminaStat / 100) * 0.40;
          recovered[id] = Math.round(endStamina + (100 - endStamina) * recoveryRate);
        }
        state.playerStaminas = recovered;
      }

      const scoreHome = userIsHome ? scoreA : scoreB;
      const scoreAway = userIsHome ? scoreB : scoreA;

      if (isKnockout && scoreHome === scoreAway) {
        showPenaltyScreen(root, picked, opponentTeam, scoreHome, userIsHome, opponentName, userTeamName, (penHome, penAway) => {
          commitResult(scoreHome, scoreAway, penHome, penAway);
        });
      } else {
        commitResult(scoreHome, scoreAway);
      }
    },
  });
}

// ── Lobby home ────────────────────────────────────────────────────────────────

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

// ── Multiplayer lobby ─────────────────────────────────────────────────────────

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
  const botTeam = pools.botPool.find((t) => t.name === competitor.name) ?? pickBotTeams(1, pools.botPool)[0];
  return botTeam ? buildTeamDataFromBotTeam(botTeam) : { id: 'teamB', name: competitor.name, color: 0xef4444, attackDirection: -1 as const, formationName: '4-4-2', players: [] };
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
  let savedRoundKinds: DraftRoundKind[] | null = options.restore?.roundKinds ?? null;
  const restoredMatch = options.restore?.matchState ?? cloneEmptyMatchState();
  let matchState: MultiplayerMatchState = restoredMatch.phase === 'running'
    ? { ...restoredMatch, phase: 'formation', readyPlayerIds: Object.keys(restoredMatch.teams), startedAt: null }
    : restoredMatch;
  let liveState: MultiplayerMatchLiveState | null = null;
  // Mutable state that renderMultiplayerDraft can update — grouped into one object
  // so the function can mutate fields without needing individual { value } refs.
  const session = {
    tournamentState: (options.restore?.tournamentState ?? null) as TournamentState | null,
    runningMatchId: null as string | null,
    runningMatchStartedAt: null as number | null,
    runningGame: null as ReturnType<typeof createGame> | null,
    spectatorPush: null as ((s: MultiplayerMatchLiveState) => void) | null,
    applyGuestTactic: null as ((side: 'home' | 'away', profile: TacticalProfile) => void) | null,
    guestCurrentTactic: null as TacticalProfile | null,
    guestTeamData: null as TeamData | null,
    applyGuestSubstitution: null as ((side: 'home' | 'away', subs: Array<{ starterIndex: number; benchIndex: number }>) => void) | null,
    lastHalftimeAt: 0,
    pendingHalftimeResume: null as { resume: () => void; remaining: Set<string>; timeoutId: ReturnType<typeof setTimeout> } | null,
    receivedHalftimeTactics: new Set<string>(),
    baseFormationDone: (options.restore?.tournamentState != null) as boolean,
  };
  const managers = new Map<string, DraftManager>();
  const globalPickedIds = new Set<string>();
  const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const disconnectedPlayerIds = new Set<string>();
  let forceStartBanner: HTMLDivElement | null = null;

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
        tournamentState: session.tournamentState,
        matchState,
        roundKinds: savedRoundKinds,
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
      channel.postMessage({ type: 'player-identify', playerId: options.player.id });
      if (options.isHost) {
        if (draftState) {
          channel.postMessage({ type: 'draft-state', state: draftState });
          if (session.tournamentState) channel.postMessage({ type: 'tournament-state', state: session.tournamentState });
          channel.postMessage({ type: 'match-state', state: matchState });
        } else {
          channel.postMessage({ type: 'lobby-state', hostId: players[0].id, players, settings });
        }
      } else {
        post({ type: 'join', player: options.player });
      }
    }
  };

  const broadcastLobby = (): void => {
    post({ type: 'lobby-state', hostId: players[0].id, players, settings });
    if (options.isHost && !draftState) drawHostLobby();
  };

  const broadcastDraft = (): void => {
    draftState = createMultiplayerDraftState(options.roomCode, settings, players, managers);
    persistMultiplayerProgress();
    post({ type: 'draft-state', state: draftState });
    renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, options.isHost, draftState, post, managers, session, matchState, liveState, disconnectedPlayerIds);
  };

  const broadcastMatch = (): void => {
    autoStartMatchIfReady();
    persistMultiplayerProgress();
    post({ type: 'match-state', state: matchState });
    if (draftState) {
      renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, options.isHost, draftState, post, managers, session, matchState, liveState, disconnectedPlayerIds);
    }
  };

  const getOrCreateMultiplayerTs = (): TournamentState => {
    if (!session.tournamentState) {
      const playerNames = players.map((player) => player.name);
      const playerIds = players.map((player) => player.id);
      const botCount = 16 - playerNames.length;
      const botTeams = pickBotTeams(botCount, pools.botPool);
      const plan = createTournamentPlan({
        mode: settings.mode,
        playerNames,
        playerIds,
        botTeams,
        groupPlacement: settings.groupPlacement,
      });
      session.tournamentState = createTournamentState(plan);
    }
    return session.tournamentState;
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
    session.runningMatchId = null;
    session.runningMatchStartedAt = null;
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
      const active = document.activeElement;
      if (!(active instanceof HTMLInputElement && active.type === 'color')) {
        renderLobbyRoom(root, options.roomCode, options.player.id, false, players, settings, post, () => undefined);
      }
    }

    if (message.type === 'draft-state') {
      draftState = message.state;
      players = message.state.players;
      settings = message.state.settings;
      persistMultiplayerProgress();
      renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, false, draftState, post, managers, session, matchState, liveState, disconnectedPlayerIds);
    }

    if (message.type === 'tournament-state') {
      session.tournamentState = message.state;
      persistMultiplayerProgress();
      if (draftState) {
        renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, false, draftState, post, managers, session, matchState, liveState, disconnectedPlayerIds);
      }
    }

    if (message.type === 'match-state') {
      const previousMatchState = matchState;
      matchState = message.state;
      if (matchState.phase === 'idle') liveState = null;
      persistMultiplayerProgress();
      if (previousMatchState.phase === 'running' && matchState.phase === 'idle' && session.runningGame) {
        session.runningGame.destroy(true);
        session.runningGame = null;
        session.runningMatchId = null;
        session.runningMatchStartedAt = null;
        session.spectatorPush = null;
        session.guestCurrentTactic = null;
        session.guestTeamData = null;
        session.applyGuestSubstitution = null;
        session.lastHalftimeAt = 0;
        document.body.classList.remove('match-running');
        if (!root.isConnected) document.body.appendChild(root);
      }
      if (draftState) {
        renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, false, draftState, post, managers, session, matchState, liveState, disconnectedPlayerIds);
      }
    }

    if (message.type === 'match-live-state') {
      liveState = message.state;
      if (matchState.phase === 'running') {
        if (!options.isHost) {
          session.spectatorPush?.(liveState);
          if (liveState.event?.type === 'halftime' && session.lastHalftimeAt === 0) {
            const ts = session.tournamentState;
            if (ts && matchState.matchId) {
              const activeMatch = ts.plan.matches.find((m) => m.id === matchState.matchId);
              if (activeMatch) {
                const isParticipant = [activeMatch.home.playerId, activeMatch.away.playerId].includes(options.player.id);
                if (isParticipant) {
                  session.lastHalftimeAt = liveState.updatedAt;
                  const isHome = activeMatch.home.playerId === options.player.id;
                  const side: 'home' | 'away' = isHome ? 'home' : 'away';
                  const currentTactic = session.guestCurrentTactic ?? DEFAULT_TACTICAL_PROFILE;
                  const guestTeamId: 'teamA' | 'teamB' = isHome ? 'teamA' : 'teamB';
                  const livePlayerMap = new Map(
                    (liveState.replay?.players ?? [])
                      .filter(p => p.teamId === guestTeamId)
                      .map(p => [p.id, p]),
                  );
                  const teamData = session.guestTeamData;
                  const starters = teamData?.players.map(pd => ({
                    id: pd.id,
                    name: pd.name,
                    role: pd.role,
                    jerseyNumber: pd.jerseyNumber,
                    stamina: livePlayerMap.get(pd.id)?.stamina ?? 100,
                  }));
                  const bench = teamData?.bench?.map(pd => ({
                    id: pd.id,
                    name: pd.name,
                    role: pd.role,
                    jerseyNumber: pd.jerseyNumber,
                    stamina: 100,
                  }));
                  const pendingSubs: Array<{ starterIndex: number; benchIndex: number }> = [];
                  showHalftimePanel({
                    scoreA: isHome ? liveState.scoreHome : liveState.scoreAway,
                    scoreB: isHome ? liveState.scoreAway : liveState.scoreHome,
                    teamAName: isHome ? liveState.homeName : liveState.awayName,
                    teamBName: isHome ? liveState.awayName : liveState.homeName,
                    currentProfile: currentTactic,
                    applyTactic: (profile) => { session.guestCurrentTactic = profile; },
                    starters,
                    bench,
                    applySubstitution: bench && bench.length > 0 ? (si, bi) => { pendingSubs.push({ starterIndex: si, benchIndex: bi }); } : undefined,
                    resume: () => {
                      post({ type: 'halftime-tactic', playerId: options.player.id, side, tacticalProfile: session.guestCurrentTactic ?? DEFAULT_TACTICAL_PROFILE, substitutions: pendingSubs });
                    },
                  });
                }
              }
            }
          }
        } else if (draftState) {
          renderMultiplayerDraft(root, pools, options.roomCode, options.player.id, false, draftState, post, managers, session, matchState, liveState, disconnectedPlayerIds);
        }
      }
    }
  };

  window.addEventListener('beforeunload', () => {
    post({ type: 'leave', playerId: options.player.id });
    channel.close();
  });

  channel.postMessage({ type: 'player-identify', playerId: options.player.id });

  if (options.isHost) {
    if (options.restore) persistMultiplayerProgress();
    if (draftState) {
      if (session.tournamentState) post({ type: 'tournament-state', state: session.tournamentState });
      if (savedRoundKinds) {
        draftState.teams.forEach((team) => {
          team.picked.forEach((p) => globalPickedIds.add(p.id));
        });
        draftState.teams.forEach((team) => {
          managers.set(
            team.playerId,
            new DraftManager(pools.fullPool, pools.famousPool, {}, savedRoundKinds!, {
              picked: team.picked,
              rerollsLeft: team.rerollsLeft,
              pickedThisRound: team.hasPickedThisRound,
            }, globalPickedIds),
          );
        });
      }
      broadcastDraft();
      broadcastMatch();
    } else {
      drawHostLobby();
    }
  } else {
    post({ type: 'join', player: options.player });
    root.innerHTML = lobbyWaitingView(options.roomCode);
  }

  // ── Draft timer helpers ─────────────────────────────────────────────────────

  function clearDraftTimer(playerId: string): void {
    const t = draftTimers.get(playerId);
    if (t !== undefined) { clearTimeout(t); draftTimers.delete(playerId); }
  }

  function clearAllDraftTimers(): void {
    draftTimers.forEach((t) => clearTimeout(t));
    draftTimers.clear();
  }

  function startDraftAutoPickTimer(playerId: string): void {
    if (draftTimers.has(playerId)) return;
    const t = setTimeout(() => {
      draftTimers.delete(playerId);
      const mgr = managers.get(playerId);
      if (!mgr || mgr.isComplete() || mgr.hasPickedThisRound()) return;
      const round = mgr.getRound();
      const best = round.players.reduce(
        (a, b) => (b.overall > a.overall ? b : a),
        round.players[0],
      );
      if (!best) return;
      mgr.pick(best.id);
      const allPicked = [...managers.values()].every((m) => m.isComplete() || m.hasPickedThisRound());
      if (allPicked) {
        clearAllDraftTimers();
        managers.forEach((m) => m.advanceRound());
        managers.forEach((_, pid) => {
          const m = managers.get(pid)!;
          if (!m.isComplete()) startDraftAutoPickTimer(pid);
        });
      }
      broadcastDraft();
    }, 30_000);
    draftTimers.set(playerId, t);
  }

  function startDraftTimersForAll(): void {
    managers.forEach((mgr, playerId) => {
      if (!mgr.isComplete() && !mgr.hasPickedThisRound()) {
        startDraftAutoPickTimer(playerId);
      }
    });
  }

  // ── Force-start banner (floating, host-only) ─────────────────────────────────

  function removeForceStartBanner(): void {
    forceStartBanner?.remove();
    forceStartBanner = null;
  }

  function showForceStartBanner(matchId: string, pendingNames: string[]): void {
    removeForceStartBanner();
    const banner = document.createElement('div');
    banner.id = 'force-start-banner';
    banner.style.cssText = [
      'position:fixed', 'bottom:80px', 'left:50%', 'transform:translateX(-50%)',
      'background:#1e293b', 'border:1px solid #ef4444', 'border-radius:12px',
      'padding:16px 24px', 'z-index:9000', 'max-width:480px', 'width:90%',
      'box-shadow:0 8px 32px rgba(0,0,0,.6)',
    ].join(';');
    banner.innerHTML = `
      <p style="margin:0 0 12px;font-size:14px;color:#fca5a5">
        <strong>${pendingNames.map(escapeHtml).join(', ')}</strong>
        desconectou${pendingNames.length > 1 ? 'ram' : ''} e ainda não enviou${pendingNames.length > 1 ? 'ram' : ''} a formação.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="draft-btn draft-btn--secondary" data-action="force-wait">Aguardar retorno</button>
        <button class="draft-btn" style="background:#ef4444" data-action="force-start">
          Iniciar sem ele${pendingNames.length > 1 ? 's' : ''} (bot)
        </button>
      </div>
    `;
    banner.querySelector('[data-action="force-wait"]')?.addEventListener('click', removeForceStartBanner);
    banner.querySelector('[data-action="force-start"]')?.addEventListener('click', () => {
      post({ type: 'force-start-with-bots', matchId });
      removeForceStartBanner();
    });
    document.body.appendChild(banner);
    forceStartBanner = banner as HTMLDivElement;
  }

  function updateForceStartBanner(): void {
    if (!options.isHost || matchState.phase !== 'formation' || !matchState.matchId) {
      removeForceStartBanner();
      return;
    }
    const ts = session.tournamentState;
    const match = ts?.plan.matches.find((m) => m.id === matchState.matchId);
    if (!match) { removeForceStartBanner(); return; }

    const pendingNames = [match.home, match.away]
      .filter((c) => c.playerId && !matchState.readyPlayerIds.includes(c.playerId) && disconnectedPlayerIds.has(c.playerId))
      .map((c) => players.find((p) => p.id === c.playerId)?.name ?? c.name);

    if (pendingNames.length > 0) showForceStartBanner(matchState.matchId, pendingNames);
    else removeForceStartBanner();
  }

  function drawHostLobby(): void {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.type === 'color') return;
    renderLobbyRoom(root, options.roomCode, options.player.id, true, players, settings, post, (nextSettings) => {
      settings = nextSettings;
      broadcastLobby();
    }, () => startHostDraft());
  }

  function handleHostMessage(message: LobbyMessage): void {
    if (message.type === 'join') {
      clearDraftTimer(message.player.id);
      disconnectedPlayerIds.delete(message.player.id);
      players = upsertPlayer(players, { ...message.player, isHost: false, isConnected: true });
      updateForceStartBanner();
      if (draftState) {
        broadcastDraft();
      } else {
        broadcastLobby();
      }
      if (session.tournamentState) post({ type: 'tournament-state', state: session.tournamentState });
      post({ type: 'match-state', state: matchState });
    }

    if (message.type === 'player-disconnected') {
      disconnectedPlayerIds.add(message.playerId);
      players = players.map((p) => (
        p.id === message.playerId && !p.isHost ? { ...p, isConnected: false } : p
      ));

      // Draft phase: start auto-pick timer if player hasn't picked yet
      if (draftState) {
        const mgr = managers.get(message.playerId);
        if (mgr && !mgr.isComplete() && !mgr.hasPickedThisRound()) {
          startDraftAutoPickTimer(message.playerId);
        }
      }

      // Formation phase: if guest missed halftime response, release resume
      if (session.pendingHalftimeResume?.remaining.has(message.playerId)) {
        session.pendingHalftimeResume.remaining.delete(message.playerId);
        if (session.pendingHalftimeResume.remaining.size === 0) {
          clearTimeout(session.pendingHalftimeResume.timeoutId);
          session.pendingHalftimeResume.resume();
          session.pendingHalftimeResume = null;
        }
      }

      updateForceStartBanner();
      if (matchState.phase === 'formation') broadcastMatch();
      else if (!draftState) broadcastLobby();
    }

    if (message.type === 'force-start-with-bots') {
      if (matchState.phase !== 'formation' || matchState.matchId !== message.matchId) return;
      const ts = getOrCreateMultiplayerTs();
      const match = ts.plan.matches.find((m) => m.id === message.matchId);
      if (!match) return;

      const required = playerIdsForMatch(match);
      const missing = required.filter((pid) => !matchState.readyPlayerIds.includes(pid));
      const additionalTeams: Record<string, import('../game/data/TeamFactory').TeamData> = {};
      for (const pid of missing) {
        const competitor = match.home.playerId === pid ? match.home : match.away;
        additionalTeams[pid] = teamForCompetitor(competitor, {}, pools);
      }
      matchState = {
        ...matchState,
        readyPlayerIds: [...matchState.readyPlayerIds, ...missing],
        teams: { ...matchState.teams, ...additionalTeams },
      };
      if (autoStartMatchIfReady()) broadcastMatch();
    }

    if (message.type === 'leave') {
      disconnectedPlayerIds.add(message.playerId);
      players = players.map((player) => (
        player.id === message.playerId && !player.isHost ? { ...player, isConnected: false } : player
      ));
      updateForceStartBanner();
      broadcastLobby();
    }

    if (message.type === 'update-name') {
      players = players.map((player) => (
        player.id === message.playerId ? { ...player, name: message.name || player.name } : player
      ));
      broadcastLobby();
    }

    if (message.type === 'update-kit') {
      players = players.map((player) => (
        player.id === message.playerId ? { ...player, kitColors: message.kitColors } : player
      ));
      broadcastLobby();
    }

    if (message.type === 'pick') {
      managers.get(message.playerId)?.pick(message.pickId);
      clearDraftTimer(message.playerId);
      const allPicked = [...managers.values()].every((m) => m.isComplete() || m.hasPickedThisRound());
      if (allPicked) {
        clearAllDraftTimers();
        managers.forEach((m) => m.advanceRound());
        startDraftTimersForAll();
      }
      broadcastDraft();
    }

    if (message.type === 'reroll') {
      managers.get(message.playerId)?.reroll();
      broadcastDraft();
    }

    if (message.type === 'tournament-state') {
      session.tournamentState = message.state;
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

    if (message.type === 'formation-unready') {
      if (matchState.phase !== 'formation' || matchState.matchId !== message.matchId) return;
      const { [message.playerId]: _removed, ...remainingTeams } = matchState.teams;
      matchState = {
        ...matchState,
        readyPlayerIds: matchState.readyPlayerIds.filter((id) => id !== message.playerId),
        teams: remainingTeams,
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

    if (message.type === 'halftime-tactic') {
      session.applyGuestTactic?.(message.side, message.tacticalProfile);
      if (message.substitutions?.length) {
        session.applyGuestSubstitution?.(message.side, message.substitutions);
      }
      session.receivedHalftimeTactics.add(message.playerId);
      if (session.pendingHalftimeResume) {
        session.pendingHalftimeResume.remaining.delete(message.playerId);
        if (session.pendingHalftimeResume.remaining.size === 0) {
          clearTimeout(session.pendingHalftimeResume.timeoutId);
          session.pendingHalftimeResume.resume();
          session.pendingHalftimeResume = null;
        }
      }
    }
  }

  function startHostDraft(): void {
    clearAllDraftTimers();
    disconnectedPlayerIds.clear();
    removeForceStartBanner();
    managers.clear();
    session.tournamentState = null;
    matchState = cloneEmptyMatchState();
    savedRoundKinds = generateRoundSequence(pools.famousPool, pools.fullPool);
    globalPickedIds.clear();
    players.forEach((player) => {
      managers.set(player.id, new DraftManager(pools.fullPool, pools.famousPool, {}, savedRoundKinds!, undefined, globalPickedIds));
    });
    post({ type: 'start-draft' });
    broadcastDraft();
    startDraftTimersForAll();
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

// ── Lobby room ────────────────────────────────────────────────────────────────

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

  const localPlayer = players.find((p) => p.id === localPlayerId);
  let localKitColors: KitColors = localPlayer?.kitColors ?? { primary: 0x3b82f6, secondary: 0x000000, numberColor: 0xffffff, pattern: 'solid' };

  const postKit = (): void => {
    post({ type: 'update-kit', playerId: localPlayerId, kitColors: localKitColors });
  };

  const updatePreview = (): void => {
    const p = lobbyHexColor(localKitColors.primary);
    const s = lobbyHexColor(localKitColors.secondary);
    const preview = root.querySelector<HTMLElement>('.kit-preview-circle');
    if (preview) {
      preview.style.background = kitPatternBg(localKitColors.pattern, p, s);
      preview.style.borderColor = s;
      const numEl = preview.querySelector<HTMLElement>('span');
      if (numEl) numEl.style.color = lobbyHexColor(localKitColors.numberColor);
    }
    root.querySelectorAll<HTMLButtonElement>('[data-kit-pattern]').forEach((btn) => {
      btn.style.background = kitPatternBg(btn.dataset.kitPattern as KitPattern, p, s);
    });
  };

  root.querySelectorAll<HTMLInputElement>('[data-kit-color]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.kitColor as keyof Omit<KitColors, 'pattern'>;
      localKitColors = { ...localKitColors, [key]: parseInt(input.value.replace('#', ''), 16) };
      updatePreview();
    });
    input.addEventListener('change', () => {
      const key = input.dataset.kitColor as keyof Omit<KitColors, 'pattern'>;
      localKitColors = { ...localKitColors, [key]: parseInt(input.value.replace('#', ''), 16) };
      postKit();
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-kit-pattern]').forEach((btn) => {
    btn.addEventListener('click', () => {
      localKitColors = { ...localKitColors, pattern: btn.dataset.kitPattern as KitPattern };
      root.querySelectorAll<HTMLButtonElement>('[data-kit-pattern]').forEach((b) => {
        b.classList.toggle('is-active', b === btn);
      });
      updatePreview();
      postKit();
    });
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

// ── Multiplayer draft orchestration ──────────────────────────────────────────

function renderMultiplayerDraft(
  root: HTMLDivElement,
  pools: DraftPools,
  roomCode: string,
  localPlayerId: string,
  isHost: boolean,
  state: MultiplayerDraftState,
  post: (message: LobbyMessage) => void,
  managers: Map<string, DraftManager>,
  session: {
    tournamentState: TournamentState | null;
    runningMatchId: string | null;
    runningMatchStartedAt: number | null;
    runningGame: ReturnType<typeof createGame> | null;
    spectatorPush: ((s: MultiplayerMatchLiveState) => void) | null;
    applyGuestTactic: ((side: 'home' | 'away', profile: TacticalProfile) => void) | null;
    applyGuestSubstitution: ((side: 'home' | 'away', subs: Array<{ starterIndex: number; benchIndex: number }>) => void) | null;
    guestCurrentTactic: TacticalProfile | null;
    guestTeamData: TeamData | null;
    lastHalftimeAt: number;
    pendingHalftimeResume: { resume: () => void; remaining: Set<string>; timeoutId: ReturnType<typeof setTimeout> } | null;
    receivedHalftimeTactics: Set<string>;
    baseFormationDone: boolean;
  },
  matchState: MultiplayerMatchState,
  liveState: MultiplayerMatchLiveState | null,
  disconnectedPlayerIds: ReadonlySet<string> = new Set(),
): void {
  const localTeam = state.teams.find((team) => team.playerId === localPlayerId) ?? state.teams[0];
  const localIndex = Math.max(0, state.players.findIndex((player) => player.id === localPlayerId));

  const getOrCreateTs = (): TournamentState => {
    if (!session.tournamentState) {
      const playerNames = state.players.map((player) => player.name);
      const playerIds = state.players.map((player) => player.id);
      const botCount = 16 - playerNames.length;
      const botTeams = pickBotTeams(botCount, pools.botPool);
      const plan = createTournamentPlan({ mode: state.settings.mode, playerNames, playerIds, botTeams, groupPlacement: state.settings.groupPlacement });
      session.tournamentState = createTournamentState(plan);
    }
    return session.tournamentState;
  };

  const backToDraft = (): void => {
    renderMultiplayerDraft(root, pools, roomCode, localPlayerId, isHost, state, post, managers, session, matchState, liveState, disconnectedPlayerIds);
  };

  const tournament = session.tournamentState?.plan ?? createTournamentPlan({
    mode: state.settings.mode,
    playerNames: state.players.map((player) => player.name),
    playerIds: state.players.map((player) => player.id),
    groupPlacement: state.settings.groupPlacement,
  });

  const allTeamsComplete = state.teams.length > 0 && state.teams.every((team) => team.isComplete);
  if (allTeamsComplete && matchState.phase === 'idle') {
    if (!isHost && !session.tournamentState) {
      root.innerHTML = multiplayerSyncWaitingView(state.roomCode);
      return;
    }
    const ts = getOrCreateTs();
    if (isHost) {
      const nextMatch = getNextUserMatch(ts);
      if (nextMatch) simulateRoundBotMatchesBefore(ts, nextMatch.round, nextMatch.matchdayOrder);
      post({ type: 'tournament-state', state: ts });
    }

    if (!session.baseFormationDone && localTeam.picked.length > 0) {
      const localPlayerData = state.players.find((p) => p.id === localPlayerId);
      renderFormationScreen(root, localTeam.picked, backToDraft, {
        competitionName: ts.plan.title,
        teamName: localTeam.playerName,
        startButtonLabel: 'Confirmar formação',
        savedFormation: loadMultiplayerFormation(roomCode, localPlayerId),
        onFormationChange: (formation) => saveMultiplayerFormation(roomCode, localPlayerId, formation),
        initialKitColors: localPlayerData?.kitColors,
        onReady: (_team) => {
          session.baseFormationDone = true;
          renderMultiplayerDraft(root, pools, roomCode, localPlayerId, isHost, state, post, managers, session, matchState, liveState, disconnectedPlayerIds);
        },
      });
      return;
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
    if (!session.tournamentState) {
      root.innerHTML = multiplayerSyncWaitingView(state.roomCode);
      return;
    }

    const match = session.tournamentState.plan.matches.find((item) => item.id === matchState.matchId);
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
        const localPlayerData = state.players.find((p) => p.id === localPlayerId);
        renderFormationScreen(root, localTeam.picked, backToDraft, {
          competitionName: `${session.tournamentState.plan.title} / ${match.stage}`,
          teamName: localTeam.playerName,
          opponentName: opponent.name,
          opponentTeam: opponent.kind === 'bot' ? (() => { const bt = pools.botPool.find((t) => t.name === opponent.name) ?? pickBotTeams(1, pools.botPool)[0]; return bt ? buildTeamDataFromBotTeam(bt) : undefined; })() : undefined,
          savedFormation: loadMultiplayerFormation(roomCode, localPlayerId),
          onFormationChange: (formation) => {
            saveMultiplayerFormation(roomCode, localPlayerId, formation);
          },
          startButtonLabel: ready ? 'Cancelar prontidão' : 'Estou pronto',
          startButtonDisabled: false,
          initialKitColors: localPlayerData?.kitColors,
          onReady: ready ? undefined : (team) => {
            if (!isHost) session.guestTeamData = team;
            post({ type: 'formation-ready', playerId: localPlayerId, matchId: match.id, team });
          },
          onUnready: ready ? () => {
            post({ type: 'formation-unready', playerId: localPlayerId, matchId: match.id });
          } : undefined,
        });
      } else {
        root.innerHTML = multiplayerSpectatorWaitingView(match, state, matchState, {
          isHost,
          disconnectedPlayerIds: [...disconnectedPlayerIds],
        });
        root.querySelector<HTMLButtonElement>('[data-action="view-table"]')?.addEventListener('click', () => {
          renderTournamentTable(root, session.tournamentState!, () => {}, backToDraft, { canPlayNext: false });
        });
        root.querySelector<HTMLButtonElement>('[data-action="force-start-with-bots"]')?.addEventListener('click', (e) => {
          const matchId = (e.currentTarget as HTMLButtonElement).dataset.matchId ?? '';
          post({ type: 'force-start-with-bots', matchId });
        });
      }
      return;
    }

    if (matchState.phase === 'running') {
      if (!isHost) {
        if (session.runningMatchId !== match.id || session.runningMatchStartedAt !== matchState.startedAt) {
          if (session.runningGame) {
            session.runningGame.destroy(true);
            session.runningGame = null;
            session.spectatorPush = null;
            session.guestCurrentTactic = null;
            session.lastHalftimeAt = 0;
            if (!root.isConnected) document.body.appendChild(root);
            document.body.classList.remove('match-running');
          }
          session.runningMatchId = match.id;
          session.runningMatchStartedAt = matchState.startedAt;
          const homeTeamSpec = teamForCompetitor(match.home, matchState.teams, pools);
          const awayTeamSpec = teamForCompetitor(match.away, matchState.teams, pools);
          const home = orientTeam(homeTeamSpec, 'teamA', match.home.playerId ? homeTeamSpec.color : 0x38bdf8, 1);
          const away = orientTeam(awayTeamSpec, 'teamB', match.away.playerId ? awayTeamSpec.color : 0xef4444, -1);
          root.remove();
          document.body.classList.add('match-running');
          const game = createGame({
            teams: [home, away],
            spectatorMode: true,
            onSpectatorFrame: (push) => { session.spectatorPush = push; },
          });
          session.runningGame = game;
          if (liveState) session.spectatorPush?.(liveState);
        }
        return;
      }

      root.innerHTML = multiplayerHostRunningView(match);
      if (session.runningMatchId !== match.id) {
        session.runningMatchId = match.id;
        session.runningMatchStartedAt = matchState.startedAt;
        session.receivedHalftimeTactics.clear();
        const homeTeamHost = teamForCompetitor(match.home, matchState.teams, pools);
        const awayTeamHost = teamForCompetitor(match.away, matchState.teams, pools);
        const home = orientTeam(homeTeamHost, 'teamA', match.home.playerId ? homeTeamHost.color : 0x38bdf8, 1);
        const away = orientTeam(awayTeamHost, 'teamB', match.away.playerId ? awayTeamHost.color : 0xef4444, -1);
        root.remove();
        document.body.classList.add('match-running');
        const hostSide = match.home.playerId === localPlayerId ? 'home'
          : match.away.playerId === localPlayerId ? 'away' : null;
        const hostSavedFormation = hostSide !== null ? loadMultiplayerFormation(roomCode, localPlayerId) : null;
        const hostScheme = hostSavedFormation
          ? (() => {
              const base = TACTICAL_SCHEMES.find(s => s.name === hostSavedFormation.tacticalProfileName) ?? TACTICAL_SCHEMES[0];
              return hostSavedFormation.tacticalScheme ? { ...base, ...hostSavedFormation.tacticalScheme } : base;
            })()
          : undefined;
        const multiMatchGoals: GoalEvent[] = [];
        const game = createGame({
          teams: [home, away],
          autoFinishDelayMs: 3500,
          tacticalSchemeA: hostSide === 'home' ? hostScheme : undefined,
          tacticalSchemeB: hostSide === 'away' ? hostScheme : undefined,
          onGoalScored: (g) => multiMatchGoals.push(g),
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
          onHalftime: hostSide === null ? ({ resume }) => {
            const participants = [match.home, match.away]
              .filter(c => c.playerId)
              .map(c => c.playerId as string);
            if (participants.length === 0) {
              resume();
            } else {
              const timeoutId = setTimeout(() => {
                if (session.pendingHalftimeResume) {
                  session.pendingHalftimeResume.resume();
                  session.pendingHalftimeResume = null;
                }
              }, 5 * 60 * 1000);
              session.pendingHalftimeResume = { resume, remaining: new Set(participants), timeoutId };
            }
          } : ({ scoreA, scoreB, teamAName, teamBName, currentProfile, currentProfileB, currentScheme, currentSchemeB, applyTactic, applyTacticB, resume, starters, bench, applySubstitution, startersB, benchB, applySubstitutionB }) => {
            const isHome = hostSide === 'home';
            const otherSide = hostSide === 'home' ? match.away : match.home;
            const wrappedResume = (): void => {
              if (otherSide.playerId) {
                if (session.receivedHalftimeTactics.has(otherSide.playerId)) {
                  resume();
                } else {
                  const timeoutId = setTimeout(() => {
                    if (session.pendingHalftimeResume) {
                      session.pendingHalftimeResume.resume();
                      session.pendingHalftimeResume = null;
                    }
                  }, 5 * 60 * 1000);
                  session.pendingHalftimeResume = { resume, remaining: new Set([otherSide.playerId]), timeoutId };
                }
              } else {
                resume();
              }
            };
            showHalftimePanel({
              scoreA: isHome ? scoreA : scoreB,
              scoreB: isHome ? scoreB : scoreA,
              teamAName: isHome ? teamAName : teamBName,
              teamBName: isHome ? teamBName : teamAName,
              currentProfile: isHome ? currentProfile : (currentProfileB ?? currentProfile),
              currentScheme: isHome ? currentScheme : currentSchemeB,
              applyTactic: isHome ? applyTactic : applyTacticB,
              resume: wrappedResume,
              starters: isHome ? starters : startersB,
              bench: isHome ? bench : benchB,
              applySubstitution: isHome ? applySubstitution : applySubstitutionB,
            });
          },
          onHostApplyGuestTactic: (apply) => { session.applyGuestTactic = apply; },
          onHostApplyGuestSubstitution: (apply) => { session.applyGuestSubstitution = apply; },
          onMatchEnd: (scoreHome, scoreAway) => {
            game.destroy(true);
            session.runningGame = null;
            session.applyGuestTactic = null;
            session.applyGuestSubstitution = null;
            if (session.pendingHalftimeResume) {
              clearTimeout(session.pendingHalftimeResume.timeoutId);
              session.pendingHalftimeResume = null;
            }
            document.body.classList.remove('match-running');
            document.body.appendChild(root);
            session.runningMatchId = null;
            session.runningMatchStartedAt = null;
            if (multiMatchGoals.length > 0) {
              accumulatePlayerStats(getOrCreateTs(), multiMatchGoals);
            }
            post({ type: 'match-result', matchId: match.id, scoreHome, scoreAway });
          },
        });
        session.runningGame = game;
      }
      return;
    }
  }

  const localRenderKey = multiplayerLocalRenderKey(state, localTeam);
  const boosterKey = localTeam.currentPlayers.map((p) => p.id).join(',');
  if (root.dataset.multiplayerDraftScreen === 'draft' && root.dataset.multiplayerDraftLocalKey === localRenderKey) {
    const aside = root.querySelector<HTMLElement>('[data-multiplayer-draft-sidebar]');
    if (aside) {
      aside.innerHTML = multiplayerDraftSidebarView(state, localTeam);
      return;
    }
  }

  const isNewBooster = root.dataset.multiplayerBoosterKey !== boosterKey;
  root.innerHTML = multiplayerDraftView(state, localTeam, tournament, localIndex);
  root.dataset.multiplayerDraftScreen = 'draft';
  root.dataset.multiplayerDraftLocalKey = localRenderKey;
  root.dataset.multiplayerBoosterKey = boosterKey;
  if (isNewBooster) setupSequentialFlip(root);

  // Countdown timer: clear any previous interval, then start one if player still needs to pick
  if (_draftCountdown) { clearInterval(_draftCountdown); _draftCountdown = null; }
  if (!localTeam.hasPickedThisRound && !localTeam.isComplete) {
    if (isNewBooster) root.dataset.draftCountdownStart = String(Date.now());
    const startAt = Number(root.dataset.draftCountdownStart || Date.now());
    _draftCountdown = setInterval(() => {
      const el = root.querySelector<HTMLElement>('[data-draft-countdown]');
      if (!el) { clearInterval(_draftCountdown!); _draftCountdown = null; return; }
      const remaining = Math.max(0, 30 - (Date.now() - startAt) / 1000);
      el.textContent = remaining > 0 ? `${Math.ceil(remaining)}s` : '⌛';
      const urgent = remaining <= 10;
      el.style.background = urgent ? '#7f1d1d' : '#78350f';
      el.style.borderColor = urgent ? '#ef4444' : '#f59e0b';
      el.style.color = urgent ? '#fca5a5' : '#fde68a';
      if (remaining <= 0) { clearInterval(_draftCountdown!); _draftCountdown = null; }
    }, 200);
  }
  setupGoldParticles(root);
  setupCardToggles(root);

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
    if (session.tournamentState) post({ type: 'tournament-state', state: session.tournamentState });
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

// ── Multiplayer draft state builder ──────────────────────────────────────────

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

// ── Tournament setup ──────────────────────────────────────────────────────────

function renderTournamentSetup(root: HTMLDivElement, pools: DraftPools, onStart: (plan: TournamentPlan) => void): void {
  let mode: TournamentMode = 'champions-16';
  let playerCount = 1;
  let names = ['Jogador 1'];
  let groupPlacement: GroupPlacement = 'separated';
  let difficulty: Difficulty = 'normal';

  const renderSetup = (): void => {
    const filteredPool = filterBotPoolByDifficulty(pools.botPool, difficulty);
    const botTeams = pickBotTeams(16 - playerCount, filteredPool);
    const plan = createTournamentPlan({ mode, playerNames: names.slice(0, playerCount), botTeams, groupPlacement, difficulty });
    root.innerHTML = tournamentSetupView(mode, playerCount, names, plan, groupPlacement, difficulty);

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

    root.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((button) => {
      button.addEventListener('click', () => {
        difficulty = button.dataset.difficulty as Difficulty;
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
      const filteredPool = filterBotPoolByDifficulty(pools.botPool, difficulty);
      const botTeams = pickBotTeams(16 - playerNames.length, filteredPool);
      onStart(createTournamentPlan({ mode, playerNames, botTeams, groupPlacement, difficulty }));
    });
  };

  renderSetup();
}

// ── Shared helpers ────────────────────────────────────────────────────────────

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
    || message.type === 'player-disconnected'
    || message.type === 'update-name'
    || message.type === 'update-kit'
    || message.type === 'pick'
    || message.type === 'reroll'
    || message.type === 'prepare-match'
    || message.type === 'formation-ready'
    || message.type === 'formation-unready'
    || message.type === 'host-start-match'
    || message.type === 'force-start-with-bots'
    || message.type === 'match-result'
  );
}

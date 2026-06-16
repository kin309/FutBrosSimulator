import { createGame } from '../game/FootballGame';
import { createOpponentTeam, FORMATIONS, FormationDefinition, KitColors, TeamData } from '../game/data/TeamFactory';
import { TACTICAL_PROFILES, TacticalProfile } from '../game/data/TacticalProfile';
import { showHalftimePanel } from './HalftimePanel';
import { PlayerRole } from '../game/data/PlayerRole';
import { DraftPlayer } from './DraftTypes';
import { nationalityFlagCode } from './NationalityFlags';
import { positionLabel } from './PositionLabels';
import { applyOutOfPositionPenalty, isOutOfPosition } from '../game/data/OutOfPositionPenalty';

function buildEligibleTeamMap(allPlayers: DraftPlayer[]): Map<string, DraftPlayer[]> {
  const byTeam = new Map<string, DraftPlayer[]>();
  for (const p of allPlayers) {
    if (!p.team) continue;
    const list = byTeam.get(p.team) ?? [];
    list.push(p);
    byTeam.set(p.team, list);
  }
  return byTeam;
}

export function pickBotTeamNamesFromPool(count: number, allPlayers: DraftPlayer[]): string[] {
  const byTeam = buildEligibleTeamMap(allPlayers);
  const eligible = [...byTeam.entries()]
    .filter(([, players]) => players.length >= 11 && players.some((p) => p.role === PlayerRole.Goalkeeper))
    .map(([name]) => name)
    .sort(() => Math.random() - 0.5);

  return Array.from({ length: count }, (_, i) => eligible[i % eligible.length] ?? `Bot ${i + 1}`);
}

export function buildBotTeamFromPool(teamName: string, allPlayers: DraftPlayer[]): TeamData {
  const byTeam = buildEligibleTeamMap(allPlayers);

  const eligible = [...byTeam.values()].filter(
    (players) => players.length >= 11 && players.some((p) => p.role === PlayerRole.Goalkeeper),
  );

  if (eligible.length === 0) return createOpponentTeam(teamName);

  // Prefer the team whose name matches exactly; fall back to a random eligible team
  const namedTeam = byTeam.get(teamName);
  const teamPlayers = (namedTeam && namedTeam.length >= 11 && namedTeam.some((p) => p.role === PlayerRole.Goalkeeper))
    ? namedTeam
    : eligible[Math.floor(Math.random() * eligible.length)];

  const formation = FORMATIONS[Math.floor(Math.random() * FORMATIONS.length)];
  const used = new Set<string>();

  const players = formation.slots.map((slot, index) => {
    const player = pickBestPlayer(teamPlayers, used, slot.role);
    used.add(player.id);
    return {
      id: `b${index}`,
      name: player.commonName || player.lastName || player.name,
      jerseyNumber: index + 1,
      role: slot.role,
      stats: applyOutOfPositionPenalty(player.stats, player.role, slot.role, player.alternateRoles),
      heightCm: player.heightCm,
      weightKg: player.weightKg,
      baseX: 1200 - slot.x,
      baseY: slot.y,
      playstyles: player.playstyles,
      playstylesPlus: player.playstylesPlus,
    };
  });

  return {
    id: 'teamB',
    name: teamName,  // always uses the name as given (matched or fallback)
    color: 0xef4444,
    attackDirection: -1,
    formationName: formation.name,
    players,
  };
}

const FIELD_WIDTH = 1200;
const FIELD_TOP = 76;
const FIELD_BOTTOM = 744;
const FIELD_HEIGHT = FIELD_BOTTOM - FIELD_TOP;

interface FormationPlayer {
  player: DraftPlayer;
  slotIndex: number;
  role: PlayerRole;
  x: number;
  y: number;
}

interface FormationState {
  formation: FormationDefinition;
  starters: FormationPlayer[];
  bench: DraftPlayer[];
  selectedId: string | null;
  editMode: 'positions' | 'lineup';
  kitColors: KitColors;
  customJerseyNumbers: Record<string, number>;
  tacticalProfile: TacticalProfile;
}

export interface SavedFormationState {
  formationName: string;
  starters: Array<{
    playerId: string;
    slotIndex: number;
    role: PlayerRole;
    x: number;
    y: number;
  }>;
  benchPlayerIds: string[];
  kitColors?: KitColors;
  customJerseyNumbers?: Record<string, number>;
  tacticalProfileName?: string;
}

export interface MatchContext {
  competitionName?: string;
  opponentName?: string;
  opponentTeam?: TeamData;
  matchId?: string;
  userIsHome?: boolean;
  onMatchEnd?: (scoreA: number, scoreB: number) => void;
  onHalftime?: import('../game/FootballGame').MatchSetup['onHalftime'];
  startButtonLabel?: string;
  startButtonDisabled?: boolean;
  onReady?: (team: TeamData) => void;
  savedFormation?: SavedFormationState | null;
  onFormationChange?: (formation: SavedFormationState) => void;
  initialKitColors?: KitColors;
}

export function renderFormationScreen(
  root: HTMLDivElement,
  picked: DraftPlayer[],
  onBack: () => void,
  context: MatchContext = {},
): void {
  const defaultKitColors: KitColors = context.initialKitColors ?? { primary: 0x3b82f6, secondary: 0x000000, numberColor: 0xffffff, pattern: 'solid' };
  let state = createFormationState(picked, FORMATIONS[0], context.savedFormation ?? null, defaultKitColors);

  const render = (): void => {
    context.onFormationChange?.(serializeFormationState(state));
    root.innerHTML = formationView(state, context);
    wireFormationScreen(root, state, picked, onBack, render, context);
  };

  render();
}

function wireFormationScreen(
  root: HTMLDivElement,
  state: FormationState,
  picked: DraftPlayer[],
  onBack: () => void,
  render: () => void,
  context: MatchContext,
): void {
  root.querySelector<HTMLButtonElement>('[data-action="back-draft"]')?.addEventListener('click', onBack);

  root.querySelector<HTMLButtonElement>('[data-action="reset-positions"]')?.addEventListener('click', () => {
    const reset = createFormationState(picked, state.formation);
    state.starters = reset.starters;
    state.bench = reset.bench;
    state.selectedId = null;
    state.editMode = reset.editMode;
    render();
  });

  root.querySelector<HTMLButtonElement>('[data-action="start-match"]')?.addEventListener('click', () => {
    if (context.onReady) {
      context.onFormationChange?.(serializeFormationState(state));
      context.onReady(toTeamData(state));
      return;
    }

    root.remove();
    document.body.classList.add('match-running');
    const game = createGame({
      teams: [toTeamData(state), context.opponentTeam ?? createOpponentTeam(context.opponentName)],
      tacticalProfileA: state.tacticalProfile,
      onHalftime: context.onHalftime,
      onMatchEnd: context.onMatchEnd ? (scoreA, scoreB) => {
        game.destroy(true);
        document.body.classList.remove('match-running');
        document.body.appendChild(root);
        context.onMatchEnd!(scoreA, scoreB);
      } : undefined,
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-formation]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = FORMATIONS.find((formation) => formation.name === button.dataset.formation);
      if (!next) return;
      const nextState = changeFormationPreservingLineup(state, next);
      state.formation = nextState.formation;
      state.starters = nextState.starters;
      state.bench = nextState.bench;
      state.selectedId = null;
      render();
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-edit-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.editMode = button.dataset.editMode === 'lineup' ? 'lineup' : 'positions';
      state.selectedId = null;
      render();
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-tactical]').forEach((button) => {
    button.addEventListener('click', () => {
      const profile = TACTICAL_PROFILES.find(p => p.name === button.dataset.tactical);
      if (profile) { state.tacticalProfile = profile; render(); }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-select-player]').forEach((button) => {
    button.addEventListener('click', () => {
      const playerId = button.dataset.selectPlayer ?? null;
      if (!playerId) return;

      if (state.editMode === 'lineup') {
        selectOrSwapLineupPlayer(state, playerId);
      }

      render();
    });
  });

  const pitch = root.querySelector<HTMLDivElement>('.formation-pitch');
  if (!pitch) return;

  root.querySelectorAll<HTMLButtonElement>('[data-drag-player]').forEach((marker) => {
    marker.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const playerId = marker.dataset.dragPlayer;
      const starter = state.starters.find((item) => item.player.id === playerId);
      if (!starter) return;

      if (state.editMode === 'lineup') {
        selectOrSwapLineupPlayer(state, starter.player.id);
        render();
        return;
      }

      if (starter.role === PlayerRole.Goalkeeper) return;

      marker.setPointerCapture(event.pointerId);
      marker.classList.add('is-dragging');

      const move = (moveEvent: PointerEvent): void => {
        const next = positionFromPointer(pitch, moveEvent.clientX, moveEvent.clientY);
        starter.x = next.x;
        starter.y = next.y;
        marker.style.left = `${toPitchLeft(starter.x)}%`;
        marker.style.top = `${toPitchTop(starter.y)}%`;
      };

      const up = (upEvent: PointerEvent): void => {
        marker.releasePointerCapture(upEvent.pointerId);
        marker.classList.remove('is-dragging');
        marker.removeEventListener('pointermove', move);
        marker.removeEventListener('pointerup', up);
        render();
      };

      marker.addEventListener('pointermove', move);
      marker.addEventListener('pointerup', up);
    });
  });

  pitch.addEventListener('click', (event) => {
    if (state.editMode !== 'positions') return;
    if ((event.target as HTMLElement).closest('[data-drag-player]')) return;
    event.preventDefault();
  });

  root.querySelectorAll<HTMLInputElement>('[data-jersey-player]').forEach((input) => {
    input.addEventListener('change', () => {
      const playerId = input.dataset.jerseyPlayer!;
      const num = Math.max(1, Math.min(99, parseInt(input.value) || 1));
      state.customJerseyNumbers[playerId] = num;
      input.value = String(num);
    });
  });
}

function changeFormationPreservingLineup(
  state: FormationState,
  next: FormationDefinition,
): FormationState {
  // Group current starters by their slot role (not player.role) so manual swaps
  // (e.g. a bench GK promoted to the GK slot) are preserved when formation changes.
  const bySlotRole = new Map<PlayerRole, DraftPlayer[]>();
  for (const s of state.starters) {
    const list = bySlotRole.get(s.role) ?? [];
    list.push(s.player);
    bySlotRole.set(s.role, list);
  }

  const used = new Set<string>();
  const allPlayers = [...state.starters.map((s) => s.player), ...state.bench];

  const starters = next.slots.map((slot, slotIndex) => {
    const currentInRole = (bySlotRole.get(slot.role) ?? []).filter((p) => !used.has(p.id));
    let player: DraftPlayer;

    if (currentInRole.length > 0) {
      // Keep the current starter who was playing this role
      player = currentInRole[0];
    } else {
      // Role count changed — fill from remaining players by best fit
      const remaining = allPlayers.filter((p) => !used.has(p.id));
      player = [...remaining].sort((a, b) => fitScore(b, slot.role) - fitScore(a, slot.role))[0];
    }

    used.add(player.id);
    return { player, slotIndex, role: slot.role, x: slot.x, y: slot.y };
  });

  return {
    formation: next,
    starters,
    bench: allPlayers.filter((p) => !used.has(p.id)),
    selectedId: null,
    editMode: state.editMode,
    kitColors: state.kitColors,
    customJerseyNumbers: state.customJerseyNumbers,
    tacticalProfile: state.tacticalProfile,
  };
}

function createFormationState(
  picked: DraftPlayer[],
  formation: FormationDefinition,
  savedFormation: SavedFormationState | null = null,
  defaultKitColors: KitColors = { primary: 0x3b82f6, secondary: 0x000000, numberColor: 0xffffff, pattern: 'solid' },
): FormationState {
  if (savedFormation) {
    return createFormationStateFromSaved(picked, formation, savedFormation, defaultKitColors);
  }

  const used = new Set<string>();
  const starters = formation.slots.map((slot, slotIndex) => {
    const player = pickBestPlayer(picked, used, slot.role);
    used.add(player.id);
    return {
      player,
      slotIndex,
      role: slot.role,
      x: slot.x,
      y: slot.y,
    };
  });

  return {
    formation,
    starters,
    bench: picked.filter((player) => !used.has(player.id)),
    selectedId: null,
    editMode: 'positions',
    kitColors: defaultKitColors,
    customJerseyNumbers: {},
    tacticalProfile: TACTICAL_PROFILES[0],
  };
}

function createFormationStateFromSaved(
  picked: DraftPlayer[],
  fallbackFormation: FormationDefinition,
  saved: SavedFormationState,
  defaultKitColors: KitColors = { primary: 0x3b82f6, secondary: 0x000000, numberColor: 0xffffff, pattern: 'solid' },
): FormationState {
  const formation = FORMATIONS.find((item) => item.name === saved.formationName) ?? fallbackFormation;
  const byId = new Map(picked.map((player) => [player.id, player]));
  const used = new Set<string>();

  const starters = formation.slots.map((slot, slotIndex) => {
    const savedStarter = saved.starters.find((item) => item.slotIndex === slotIndex);
    const savedPlayer = savedStarter ? byId.get(savedStarter.playerId) : undefined;
    const player = savedPlayer && !used.has(savedPlayer.id)
      ? savedPlayer
      : pickBestPlayer(picked, used, slot.role);

    used.add(player.id);
    return {
      player,
      slotIndex,
      role: savedStarter?.role ?? slot.role,
      x: savedStarter?.x ?? slot.x,
      y: savedStarter?.y ?? slot.y,
    };
  });

  const benchFromSave = saved.benchPlayerIds
    .map((playerId) => byId.get(playerId))
    .filter((player): player is DraftPlayer => player !== undefined && !used.has(player.id));
  benchFromSave.forEach((player) => used.add(player.id));

  return {
    formation,
    starters,
    bench: [
      ...benchFromSave,
      ...picked.filter((player) => !used.has(player.id)),
    ],
    selectedId: null,
    editMode: 'positions',
    kitColors: {
      ...defaultKitColors,
      ...(saved.kitColors ?? {}),
    } as KitColors,
    customJerseyNumbers: saved.customJerseyNumbers ?? {},
    tacticalProfile: TACTICAL_PROFILES.find(p => p.name === saved.tacticalProfileName) ?? TACTICAL_PROFILES[0],
  };
}

function serializeFormationState(state: FormationState): SavedFormationState {
  return {
    formationName: state.formation.name,
    starters: state.starters.map((starter) => ({
      playerId: starter.player.id,
      slotIndex: starter.slotIndex,
      role: starter.role,
      x: starter.x,
      y: starter.y,
    })),
    benchPlayerIds: state.bench.map((player) => player.id),
    kitColors: state.kitColors,
    customJerseyNumbers: state.customJerseyNumbers,
    tacticalProfileName: state.tacticalProfile.name,
  };
}

function selectOrSwapLineupPlayer(state: FormationState, playerId: string): void {
  if (!state.selectedId || state.selectedId === playerId) {
    state.selectedId = state.selectedId === playerId ? null : playerId;
    return;
  }

  if (canSwapLineupPlayers(state, state.selectedId, playerId)) {
    swapLineupPlayers(state, state.selectedId, playerId);
    state.selectedId = null;
  } else {
    state.selectedId = playerId;
  }
}

function swapLineupPlayers(state: FormationState, firstId: string, secondId: string): void {
  const first = findLineupLocation(state, firstId);
  const second = findLineupLocation(state, secondId);
  if (!first || !second) return;

  const firstPlayer = first.kind === 'starter'
    ? state.starters[first.index].player
    : state.bench[first.index];
  const secondPlayer = second.kind === 'starter'
    ? state.starters[second.index].player
    : state.bench[second.index];

  if (first.kind === 'starter') {
    state.starters[first.index].player = secondPlayer;
  } else {
    state.bench[first.index] = secondPlayer;
  }

  if (second.kind === 'starter') {
    state.starters[second.index].player = firstPlayer;
  } else {
    state.bench[second.index] = firstPlayer;
  }
}

function findLineupLocation(
  state: FormationState,
  playerId: string,
): { kind: 'starter' | 'bench'; index: number } | null {
  const starterIndex = state.starters.findIndex((starter) => starter.player.id === playerId);
  if (starterIndex >= 0) return { kind: 'starter', index: starterIndex };

  const benchIndex = state.bench.findIndex((player) => player.id === playerId);
  if (benchIndex >= 0) return { kind: 'bench', index: benchIndex };

  return null;
}

function canSwapLineupPlayers(state: FormationState, firstId: string, secondId: string): boolean {
  const first = findLineupLocation(state, firstId);
  const second = findLineupLocation(state, secondId);
  if (!first || !second) return false;

  return first.kind !== second.kind || first.index !== second.index;
}

function pickBestPlayer(players: DraftPlayer[], used: Set<string>, role: PlayerRole): DraftPlayer {
  const available = players.filter((player) => !used.has(player.id));
  const pool = available.length > 0 ? available : players;

  return [...pool].sort((a, b) => fitScore(b, role) - fitScore(a, role))[0];
}

function fitScore(player: DraftPlayer, role: PlayerRole): number {
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

function toTeamData(state: FormationState): TeamData {
  return {
    id: 'teamA',
    name: 'Seu Time',
    color: state.kitColors.primary,
    secondaryColor: state.kitColors.secondary,
    numberColor: state.kitColors.numberColor,
    kitPattern: state.kitColors.pattern,
    attackDirection: 1,
    formationName: state.formation.name,
    players: state.starters.map((starter, index) => ({
      id: `a${index}`,
      name: starter.player.commonName || starter.player.lastName || starter.player.name,
      jerseyNumber: state.customJerseyNumbers[starter.player.id] ?? (index + 1),
      role: starter.role,
      stats: applyOutOfPositionPenalty(starter.player.stats, starter.player.role, starter.role, starter.player.alternateRoles),
      heightCm: starter.player.heightCm,
      weightKg: starter.player.weightKg,
      baseX: starter.x,
      baseY: starter.y,
      playstyles: starter.player.playstyles,
      playstylesPlus: starter.player.playstylesPlus,
    })),
    bench: state.bench.map((player, index) => ({
      id: `ab${index}`,
      name: player.commonName || player.lastName || player.name,
      jerseyNumber: state.customJerseyNumbers[player.id] ?? (state.starters.length + index + 1),
      role: player.role,
      stats: player.stats,
      heightCm: player.heightCm,
      weightKg: player.weightKg,
      baseX: 0,
      baseY: 0,
      playstyles: player.playstyles,
      playstylesPlus: player.playstylesPlus,
    })),
  };
}

function teamOverall(starters: FormationPlayer[]): number {
  if (starters.length === 0) return 0;
  return Math.round(starters.reduce((sum, s) => sum + s.player.overall, 0) / starters.length);
}

function formationView(state: FormationState, context: MatchContext): string {
  const ovr = teamOverall(state.starters);
  return `
    <main class="formation-shell">
      <section class="formation-main">
        <header class="formation-header">
          <div>
            <p class="draft-kicker">${escapeHtml(context.competitionName ?? 'Preparacao da partida')}</p>
            <h1>Formacao</h1>
            ${context.opponentName ? `<p class="match-context">Proximo adversario: ${escapeHtml(context.opponentName)}</p>` : ''}
          </div>
          <div class="formation-actions">
            <button class="ghost-button" data-action="back-draft">Voltar</button>
            <button class="ghost-button" data-action="reset-positions">Resetar</button>
            <button class="start-button" data-action="start-match" ${context.startButtonDisabled ? 'disabled' : ''}>
              ${escapeHtml(context.startButtonLabel ?? 'Comecar partida')}
            </button>
          </div>
        </header>

        <div class="formation-controls-bar">
          <div class="formation-controls-group">
            <span class="formation-controls-label">Formação</span>
            <div class="formation-tabs">
              ${FORMATIONS.map((formation) => `
                <button class="${formation.name === state.formation.name ? 'is-active' : ''}" data-formation="${formation.name}">
                  ${formation.name}
                </button>
              `).join('')}
            </div>
          </div>
          <div class="formation-controls-divider"></div>
          <div class="formation-controls-group">
            <span class="formation-controls-label">Tática</span>
            <div class="formation-tabs">
              ${TACTICAL_PROFILES.map(profile => `
                <button
                  class="${profile.name === state.tacticalProfile.name ? 'is-active' : ''}"
                  data-tactical="${escapeHtml(profile.name)}"
                  title="${escapeHtml(profile.description)}"
                >
                  ${escapeHtml(profile.label)}
                </button>
              `).join('')}
            </div>
          </div>
        </div>

        <div class="formation-edit-tabs">
          <button class="${state.editMode === 'positions' ? 'is-active' : ''}" data-edit-mode="positions">
            Posicoes
          </button>
          <button class="${state.editMode === 'lineup' ? 'is-active' : ''}" data-edit-mode="lineup">
            Escalacao
          </button>
        </div>

        <div class="formation-pitch ${state.editMode === 'lineup' ? 'is-lineup-mode' : 'is-position-mode'}">
          <div class="pitch-line pitch-half"></div>
          <div class="pitch-box pitch-box-left"></div>
          <div class="pitch-box pitch-box-right"></div>
          <div class="pitch-circle"></div>
          ${state.starters.map((starter) => playerMarker(starter, state.editMode === 'lineup' && state.selectedId === starter.player.id, state.editMode)).join('')}
        </div>
      </section>

      <aside class="formation-panel">
        <div class="squad-header">
          <h2>${state.editMode === 'lineup' ? 'Trocar jogadores' : 'Titulares'}</h2>
          <div class="squad-header-meta">
            <span class="ovr-badge">OVR ${ovr}</span>
            <span>${state.formation.name}</span>
          </div>
        </div>
        <ol class="formation-list">
          ${state.starters.map((starter, index) => starterItem(starter, state.editMode === 'lineup' && state.selectedId === starter.player.id, state.editMode, state.customJerseyNumbers[starter.player.id] ?? (index + 1))).join('')}
        </ol>

        <div class="bench-header">
          <h2>Banco</h2>
          <span>${state.bench.length}</span>
        </div>
        <ol class="formation-list bench-list">
          ${state.bench.map((player) => benchItem(player, state.selectedId === player.id, state.editMode)).join('')}
        </ol>

      </aside>
    </main>
  `;
}

function playerMarker(starter: FormationPlayer, selected: boolean, editMode: FormationState['editMode']): string {
  const locked = editMode === 'positions' && starter.role === PlayerRole.Goalkeeper;
  const outOfPos = isOutOfPosition(starter.player.role, starter.role, starter.player.alternateRoles);
  return `
    <button
      class="formation-marker ${roleClass(starter.role)} ${selected ? 'is-selected' : ''} ${editMode === 'lineup' ? 'is-swap-marker' : ''} ${locked ? 'is-locked' : ''} ${outOfPos ? 'is-out-of-pos' : ''}"
      data-drag-player="${escapeHtml(starter.player.id)}"
      style="left: ${toPitchLeft(starter.x)}%; top: ${toPitchTop(starter.y)}%"
      title="${escapeHtml(starter.player.name)}${outOfPos ? ' (fora de posição)' : ''}"
    >
      <span>${starter.player.overall}${outOfPos ? '⚠' : ''}</span>
      <strong>${escapeHtml(shortName(starter.player.name))}</strong>
      <small>${escapeHtml(positionLabel(starter.player.position))}</small>
    </button>
  `;
}

function starterItem(starter: FormationPlayer, selected: boolean, editMode: FormationState['editMode'], jerseyNum: number): string {
  const outOfPos = isOutOfPosition(starter.player.role, starter.role, starter.player.alternateRoles);
  return `
    <li class="starter-list-item">
      <button
        class="${roleClass(starter.role)} ${selected ? 'is-selected' : ''} ${outOfPos ? 'is-out-of-pos' : ''}"
        data-select-player="${escapeHtml(starter.player.id)}"
        ${editMode === 'positions' ? 'disabled' : ''}
      >
        <span>${starter.player.overall}</span>
        <div>
          <strong>${escapeHtml(starter.player.name)}</strong>
          <small>
            <b>${escapeHtml(positionLabel(starter.player.position))}</b>
            ${starter.player.alternatePositions.map((p) => `<span class="alt-pos-badge">${escapeHtml(positionLabel(p))}</span>`).join('')}
            ${outOfPos ? `<span class="oop-badge" title="Fora de posição — atributos penalizados">↗ ${roleLabel(starter.role)}</span>` : ''}
            / ${playerMeta(starter.player)}
          </small>
        </div>
      </button>
      <input
        class="jersey-num-input"
        type="number"
        min="1"
        max="99"
        value="${jerseyNum}"
        data-jersey-player="${escapeHtml(starter.player.id)}"
        title="Número da camisa"
      >
    </li>
  `;
}

function benchItem(player: DraftPlayer, selected: boolean, editMode: FormationState['editMode']): string {
  return `
    <li>
      <button class="${selected ? 'is-selected' : ''}" data-select-player="${escapeHtml(player.id)}" ${editMode === 'positions' ? 'disabled' : ''}>
        <span>${player.overall}</span>
        <div>
          <strong>${escapeHtml(player.name)}</strong>
          <small>
            ${escapeHtml(positionLabel(player.position))}
            ${player.alternatePositions.map((p) => `<span class="alt-pos-badge">${escapeHtml(positionLabel(p))}</span>`).join('')}
            / ${playerMeta(player, true)}
          </small>
        </div>
      </button>
    </li>
  `;
}

function playerMeta(player: DraftPlayer, includeTeam = false): string {
  const flagCode = nationalityFlagCode(player.nationality);
  const flag = flagCode
    ? `<img class="flag" src="https://flagcdn.com/20x15/${flagCode}.png" alt="" loading="lazy"> `
    : '';
  const nationality = `${flag}${escapeHtml(player.nationality)}`;
  const team = includeTeam ? `${escapeHtml(player.team)} / ` : '';
  return `${team}${nationality}`;
}

function positionFromPointer(pitch: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = pitch.getBoundingClientRect();
  const px = (clientX - rect.left) / rect.width;
  const py = (clientY - rect.top) / rect.height;

  return {
    x: clamp(px * FIELD_WIDTH, 75, 1045),
    y: clamp(FIELD_TOP + py * FIELD_HEIGHT, FIELD_TOP + 24, FIELD_BOTTOM - 24),
  };
}

function toPitchLeft(x: number): number {
  return (x / FIELD_WIDTH) * 100;
}

function toPitchTop(y: number): number {
  return ((y - FIELD_TOP) / FIELD_HEIGHT) * 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function shortName(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  return (parts[parts.length - 1] ?? name).slice(0, 10);
}

function roleLabel(role: PlayerRole): string {
  switch (role) {
    case PlayerRole.Goalkeeper: return 'GK';
    case PlayerRole.Defender: return 'DEF';
    case PlayerRole.Midfielder: return 'MID';
    case PlayerRole.Winger: return 'ALA';
    case PlayerRole.Striker: return 'ATA';
  }
}

function roleClass(role: PlayerRole): string {
  switch (role) {
    case PlayerRole.Goalkeeper: return 'role-gk';
    case PlayerRole.Defender: return 'role-def';
    case PlayerRole.Midfielder: return 'role-mid';
    case PlayerRole.Winger:
    case PlayerRole.Striker: return 'role-attack';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

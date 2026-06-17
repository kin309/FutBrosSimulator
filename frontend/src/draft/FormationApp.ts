import { createGame } from '../game/FootballGame';
import { createOpponentTeam, FORMATIONS, FormationDefinition, KitColors, TeamData } from '../game/data/TeamFactory';
import { TACTICAL_PROFILES, TacticalProfile, TACTICAL_SCHEMES, compileScheme } from '../game/data/TacticalProfile';
import type { TacticalScheme } from '../game/data/TacticalScheme';
import {
  ATTACK_FOCUS_LABELS, BUILD_UP_STYLE_LABELS, TEMPO_LABELS, WIDTH_LABELS,
  RISK_LEVEL_LABELS, DEFENSIVE_LINE_LABELS, PRESSURE_INTENSITY_LABELS,
  MARKING_STYLE_LABELS, OFFENSIVE_TRANSITION_LABELS, DEFENSIVE_TRANSITION_LABELS,
  FULLBACK_BEHAVIOR_LABELS, WINGER_BEHAVIOR_LABELS, STRIKER_BEHAVIOR_LABELS,
} from '../game/data/TacticalScheme';
import type { PlayerInstructions } from '../game/data/PlayerInstructions';
import {
  POSITIONING_LABELS, ATTACK_SUPPORT_LABELS, MOVEMENT_LABELS,
  WITH_BALL_LABELS, PRESS_LABELS, DEFENSIVE_PARTICIPATION_LABELS,
} from '../game/data/PlayerInstructions';
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
    name: teamName,
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
  editMode: 'positions' | 'lineup' | 'instructions';
  kitColors: KitColors;
  customJerseyNumbers: Record<string, number>;
  tacticalProfile: TacticalProfile;
  tacticalScheme: TacticalScheme;
  tacticViewMode: 'preset' | 'advanced';
  playerInstructions: Map<string, PlayerInstructions>;
  selectedInstructionId: string | null;
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
  tacticalScheme?: Partial<TacticalScheme>;
  playerInstructions?: Record<string, Partial<PlayerInstructions>>;
}

export interface MatchContext {
  competitionName?: string;
  opponentName?: string;
  opponentTeam?: TeamData;
  matchId?: string;
  userIsHome?: boolean;
  onMatchEnd?: (scoreA: number, scoreB: number, finalStaminas?: Record<string, number>) => void;
  onGoalScored?: import('../game/FootballGame').MatchSetup['onGoalScored'];
  initialStaminas?: Record<string, number>;
  onHalftime?: import('../game/FootballGame').MatchSetup['onHalftime'];
  startButtonLabel?: string;
  startButtonDisabled?: boolean;
  onReady?: (team: TeamData) => void;
  onUnready?: () => void;
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
    if (context.onUnready) {
      context.onUnready();
      return;
    }
    if (context.onReady) {
      context.onFormationChange?.(serializeFormationState(state));
      context.onReady(toTeamData(state));
      return;
    }

    const mappedInstructions = new Map<string, PlayerInstructions>();
    // Build bidirectional index: DraftPlayer.id ↔ a${index} (positional game ID)
    const draftIdToSlot = new Map<string, string>();
    const slotToDraftId = new Map<string, string>();
    state.starters.forEach((starter, index) => {
      const slot = `a${index}`;
      draftIdToSlot.set(starter.player.id, slot);
      slotToDraftId.set(slot, starter.player.id);
      const inst = state.playerInstructions.get(starter.player.id);
      if (inst) mappedInstructions.set(slot, inst);
    });

    // Convert context.initialStaminas (keyed by DraftPlayer.id) to slot-keyed map
    const slotInitialStaminas: Record<string, number> | undefined = context.initialStaminas
      ? Object.fromEntries(
          Object.entries(context.initialStaminas)
            .map(([draftId, val]) => [draftIdToSlot.get(draftId) ?? '', val])
            .filter(([slot]) => slot !== ''),
        )
      : undefined;

    root.remove();
    document.body.classList.add('match-running');
    const game = createGame({
      teams: [toTeamData(state), context.opponentTeam ?? createOpponentTeam(context.opponentName)],
      tacticalProfileA: state.tacticalProfile,
      tacticalSchemeA: state.tacticalScheme,
      playerInstructionsA: mappedInstructions.size > 0 ? mappedInstructions : undefined,
      onHalftime: context.onHalftime,
      onGoalScored: context.onGoalScored,
      initialStaminas: slotInitialStaminas,
      onMatchEnd: context.onMatchEnd ? (scoreA, scoreB, finalStaminas) => {
        game.destroy(true);
        document.body.classList.remove('match-running');
        document.body.appendChild(root);
        // Convert slot-keyed finalStaminas back to DraftPlayer.id keys
        const draftFinalStaminas: Record<string, number> | undefined = finalStaminas
          ? Object.fromEntries(
              Object.entries(finalStaminas)
                .map(([slot, val]) => [slotToDraftId.get(slot) ?? '', val])
                .filter(([draftId]) => draftId !== ''),
            )
          : undefined;
        context.onMatchEnd!(scoreA, scoreB, draftFinalStaminas);
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
      state.editMode = button.dataset.editMode as FormationState['editMode'];
      state.selectedId = null;
      if (state.editMode === 'instructions' || state.editMode === 'lineup') state.tacticViewMode = 'preset';
      render();
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-tactical]').forEach((button) => {
    button.addEventListener('click', () => {
      const scheme = TACTICAL_SCHEMES.find(s => s.name === button.dataset.tactical);
      if (scheme) {
        state.tacticalScheme = scheme;
        state.tacticalProfile = compileScheme(scheme);
        render();
      }
    });
  });

  root.querySelector<HTMLButtonElement>('[data-tactic-view]')?.addEventListener('click', () => {
    state.tacticViewMode = state.tacticViewMode === 'advanced' ? 'preset' : 'advanced';
    render();
  });

  root.querySelectorAll<HTMLButtonElement>('[data-scheme-dim]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dim = btn.dataset.schemeDim as keyof TacticalScheme;
      const val = btn.dataset.schemeVal!;
      (state.tacticalScheme as unknown as Record<string, unknown>)[dim] = val;
      state.tacticalProfile = compileScheme(state.tacticalScheme);
      context.onFormationChange?.(serializeFormationState(state));
      render();
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-cc-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.ccKey as keyof typeof state.tacticalScheme.chanceCreation;
      const val = parseInt(btn.dataset.ccVal ?? '0', 10);
      state.tacticalScheme = {
        ...state.tacticalScheme,
        chanceCreation: { ...state.tacticalScheme.chanceCreation, [key]: val },
      };
      state.tacticalProfile = compileScheme(state.tacticalScheme);
      context.onFormationChange?.(serializeFormationState(state));
      render();
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-instr-dim]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dim = btn.dataset.instrDim as keyof PlayerInstructions;
      const val = btn.dataset.instrVal!;
      const playerId = state.selectedInstructionId;
      if (!playerId) return;
      const current = state.playerInstructions.get(playerId) ?? {};
      if ((current as Record<string, unknown>)[dim] === val) {
        const next: Record<string, unknown> = { ...current };
        delete next[dim];
        if (Object.keys(next).length === 0) {
          state.playerInstructions.delete(playerId);
        } else {
          state.playerInstructions.set(playerId, next as PlayerInstructions);
        }
      } else {
        state.playerInstructions.set(playerId, { ...current, [dim]: val } as PlayerInstructions);
      }
      context.onFormationChange?.(serializeFormationState(state));
      render();
    });
  });

  root.querySelector<HTMLButtonElement>('[data-clear-instr]')?.addEventListener('click', () => {
    if (!state.selectedInstructionId) return;
    state.playerInstructions.delete(state.selectedInstructionId);
    context.onFormationChange?.(serializeFormationState(state));
    render();
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

      if (state.editMode === 'instructions') {
        state.selectedInstructionId = state.selectedInstructionId === starter.player.id ? null : starter.player.id;
        render();
        return;
      }

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
      context.onFormationChange?.(serializeFormationState(state));
    });
  });
}

function changeFormationPreservingLineup(
  state: FormationState,
  next: FormationDefinition,
): FormationState {
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
      player = currentInRole[0];
    } else {
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
    tacticalScheme: state.tacticalScheme,
    tacticViewMode: state.tacticViewMode,
    playerInstructions: state.playerInstructions,
    selectedInstructionId: state.selectedInstructionId,
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
    return { player, slotIndex, role: slot.role, x: slot.x, y: slot.y };
  });

  return {
    formation,
    starters,
    bench: picked.filter((player) => !used.has(player.id)),
    selectedId: null,
    editMode: 'lineup',
    kitColors: defaultKitColors,
    customJerseyNumbers: {},
    tacticalProfile: TACTICAL_PROFILES[0],
    tacticalScheme: TACTICAL_SCHEMES[0],
    tacticViewMode: 'preset',
    playerInstructions: new Map(),
    selectedInstructionId: null,
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

  // Restore tactical scheme (merge saved overrides into the base preset scheme)
  let tacticalScheme: TacticalScheme = TACTICAL_SCHEMES.find(s => s.name === saved.tacticalProfileName) ?? TACTICAL_SCHEMES[0];
  if (saved.tacticalScheme) {
    tacticalScheme = { ...tacticalScheme, ...saved.tacticalScheme } as TacticalScheme;
  }

  // Restore player instructions
  const playerInstructions = new Map<string, PlayerInstructions>();
  if (saved.playerInstructions) {
    for (const [playerId, inst] of Object.entries(saved.playerInstructions)) {
      if (Object.keys(inst).length > 0) {
        playerInstructions.set(playerId, inst as PlayerInstructions);
      }
    }
  }

  return {
    formation,
    starters,
    bench: [
      ...benchFromSave,
      ...picked.filter((player) => !used.has(player.id)),
    ],
    selectedId: null,
    editMode: 'lineup',
    kitColors: { ...defaultKitColors, ...(saved.kitColors ?? {}) } as KitColors,
    customJerseyNumbers: saved.customJerseyNumbers ?? {},
    tacticalProfile: compileScheme(tacticalScheme),
    tacticalScheme,
    tacticViewMode: 'preset',
    playerInstructions,
    selectedInstructionId: null,
  };
}

function serializeFormationState(state: FormationState): SavedFormationState {
  const instrRecord: Record<string, Partial<PlayerInstructions>> = {};
  state.playerInstructions.forEach((inst, playerId) => {
    instrRecord[playerId] = inst;
  });

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
    tacticalProfileName: state.tacticalScheme.name,
    tacticalScheme: {
      attackFocus: state.tacticalScheme.attackFocus,
      buildUpStyle: state.tacticalScheme.buildUpStyle,
      tempo: state.tacticalScheme.tempo,
      width: state.tacticalScheme.width,
      riskLevel: state.tacticalScheme.riskLevel,
      chanceCreation: state.tacticalScheme.chanceCreation,
      defensiveLine: state.tacticalScheme.defensiveLine,
      pressure: state.tacticalScheme.pressure,
      marking: state.tacticalScheme.marking,
      offensiveTransition: state.tacticalScheme.offensiveTransition,
      defensiveTransition: state.tacticalScheme.defensiveTransition,
      fullbackBehavior: state.tacticalScheme.fullbackBehavior,
      wingerBehavior: state.tacticalScheme.wingerBehavior,
      strikerBehavior: state.tacticalScheme.strikerBehavior,
    },
    playerInstructions: Object.keys(instrRecord).length > 0 ? instrRecord : undefined,
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

// ── View helpers ────────────────────────────────────────────────────────────────

const CC_LEVEL_LABELS = ['—', 'Baixo', 'Normal', 'Alto', 'Muito'];

function schemeOptBtns(dim: string, options: string[], labels: Record<string, string>, current: string): string {
  return options.map(opt =>
    `<button class="${current === opt ? 'is-active' : ''}" data-scheme-dim="${escapeHtml(dim)}" data-scheme-val="${escapeHtml(opt)}">${escapeHtml(labels[opt] ?? opt)}</button>`
  ).join('');
}

function ccLevelBtns(key: string, currentVal: number): string {
  const level = Math.round(Math.min(4, Math.max(0, currentVal)));
  return CC_LEVEL_LABELS.map((label, idx) =>
    `<button class="${level === idx ? 'is-active' : ''}" data-cc-key="${escapeHtml(key)}" data-cc-val="${idx}">${escapeHtml(label)}</button>`
  ).join('');
}

function tacticGroupHtml(header: string, rows: string[]): string {
  return `<div class="tactic-group"><div class="tactic-group-header">${escapeHtml(header)}</div>${rows.join('')}</div>`;
}

function tacticRowHtml(label: string, optionsHtml: string, extraClass = ''): string {
  return `<div class="tactic-row"><span class="tactic-row-label">${escapeHtml(label)}</span><div class="tactic-options${extraClass ? ' ' + extraClass : ''}">${optionsHtml}</div></div>`;
}

function instrOptBtns(dim: string, options: string[], labels: Record<string, string>, current?: string): string {
  return options.map(opt =>
    `<button class="${current === opt ? 'is-active' : ''}" data-instr-dim="${escapeHtml(dim)}" data-instr-val="${escapeHtml(opt)}">${escapeHtml(labels[opt] ?? opt)}</button>`
  ).join('');
}

function instrRowHtml(label: string, optionsHtml: string): string {
  return `<div class="instr-row"><div class="instr-row-label">${escapeHtml(label)}</div><div class="instr-options">${optionsHtml}</div></div>`;
}

function advancedTacticPanelView(state: FormationState, ovr: number): string {
  const s = state.tacticalScheme;
  return `
    <div class="squad-header">
      <div class="panel-section-header">
        <h2>Tática Avançada</h2>
        <span class="ovr-badge">OVR ${ovr}</span>
      </div>
    </div>
    <div class="tactic-advanced-panel">
      ${tacticGroupHtml('Ataque', [
        tacticRowHtml('Foco', schemeOptBtns('attackFocus',
          ['very-wings','wings','balanced','center','very-center'], ATTACK_FOCUS_LABELS, s.attackFocus)),
        tacticRowHtml('Amplitude', schemeOptBtns('width',
          ['very-narrow','narrow','normal','wide','very-wide'], WIDTH_LABELS, s.width)),
        tacticRowHtml('Ritmo', schemeOptBtns('tempo',
          ['very-slow','slow','normal','fast','very-fast'], TEMPO_LABELS, s.tempo)),
        tacticRowHtml('Risco', schemeOptBtns('riskLevel',
          ['very-safe','safe','balanced','risky','very-risky'], RISK_LEVEL_LABELS, s.riskLevel)),
      ])}
      ${tacticGroupHtml('Construção', [
        tacticRowHtml('Estilo', schemeOptBtns('buildUpStyle',
          ['patient','vertical','balanced','direct','long-ball'], BUILD_UP_STYLE_LABELS, s.buildUpStyle)),
        tacticRowHtml('Cruzamentos', ccLevelBtns('crosses', s.chanceCreation.crosses), 'tactic-level-opts'),
        tacticRowHtml('Passes prof.', ccLevelBtns('throughBalls', s.chanceCreation.throughBalls), 'tactic-level-opts'),
        tacticRowHtml('Infiltrações', ccLevelBtns('runs', s.chanceCreation.runs), 'tactic-level-opts'),
        tacticRowHtml('Chutes longe', ccLevelBtns('longShots', s.chanceCreation.longShots), 'tactic-level-opts'),
      ])}
      ${tacticGroupHtml('Defesa', [
        tacticRowHtml('Linha def.', schemeOptBtns('defensiveLine',
          ['very-high','high','medium','low','very-low'], DEFENSIVE_LINE_LABELS, s.defensiveLine)),
        tacticRowHtml('Pressão', schemeOptBtns('pressure',
          ['very-high','high','medium','low','very-low'], PRESSURE_INTENSITY_LABELS, s.pressure)),
        tacticRowHtml('Marcação', schemeOptBtns('marking',
          ['zone','mixed','man'], MARKING_STYLE_LABELS, s.marking)),
      ])}
      ${tacticGroupHtml('Transições', [
        tacticRowHtml('Ofensiva', schemeOptBtns('offensiveTransition',
          ['counter','vertical','possession','reorganize'], OFFENSIVE_TRANSITION_LABELS, s.offensiveTransition)),
        tacticRowHtml('Defensiva', schemeOptBtns('defensiveTransition',
          ['immediate','moderate','retreat'], DEFENSIVE_TRANSITION_LABELS, s.defensiveTransition)),
      ])}
      ${tacticGroupHtml('Papel dos Jogadores', [
        tacticRowHtml('Laterais', schemeOptBtns('fullbackBehavior',
          ['very-defensive','defensive','balanced','offensive','very-offensive'], FULLBACK_BEHAVIOR_LABELS, s.fullbackBehavior)),
        tacticRowHtml('Pontas', schemeOptBtns('wingerBehavior',
          ['open-space','cut-inside','attack-depth','receive-feet','free'], WINGER_BEHAVIOR_LABELS, s.wingerBehavior)),
        tacticRowHtml('Centroavante', schemeOptBtns('strikerBehavior',
          ['target-man','finisher','false-9','presser','mobile'], STRIKER_BEHAVIOR_LABELS, s.strikerBehavior)),
      ])}
    </div>
  `;
}

function instructionPanelView(state: FormationState, ovr: number): string {
  const selectedStarter = state.selectedInstructionId
    ? state.starters.find(s => s.player.id === state.selectedInstructionId) ?? null
    : null;
  const inst = selectedStarter
    ? (state.playerInstructions.get(selectedStarter.player.id) ?? {})
    : {};
  const isGK = selectedStarter?.role === PlayerRole.Goalkeeper;
  const hasAny = Object.keys(inst).length > 0;

  return `
    <div class="squad-header">
      <div class="panel-section-header">
        <h2>Instruções</h2>
        <span class="ovr-badge">OVR ${ovr}</span>
      </div>
    </div>
    ${selectedStarter ? `
      <div class="instr-player-header">
        <span class="instr-ovr-badge ${roleClass(selectedStarter.role)}">${selectedStarter.player.overall}</span>
        <div>
          <strong>${escapeHtml(selectedStarter.player.name)}</strong>
          <small>${escapeHtml(positionLabel(selectedStarter.player.position))} — instruções individuais</small>
        </div>
      </div>
      ${instrRowHtml('Posicionamento', instrOptBtns('positioning',
        ['stay','freedom','roam'], POSITIONING_LABELS, (inst as PlayerInstructions).positioning))}
      ${!isGK ? instrRowHtml('Apoio ao ataque', instrOptBtns('attackSupport',
        ['very-defensive','defensive','balanced','offensive','very-offensive'], ATTACK_SUPPORT_LABELS, (inst as PlayerInstructions).attackSupport)) : ''}
      ${!isGK ? instrRowHtml('Movimentação', instrOptBtns('movement',
        ['open-space','cut-inside','attack-depth','come-short','free'], MOVEMENT_LABELS, (inst as PlayerInstructions).movement)) : ''}
      ${!isGK ? instrRowHtml('Com a bola', instrOptBtns('withBall',
        ['dribble','pass','cross','shoot','retain'], WITH_BALL_LABELS, (inst as PlayerInstructions).withBall)) : ''}
      ${instrRowHtml('Pressão', instrOptBtns('press',
        ['high','normal','save'], PRESS_LABELS, (inst as PlayerInstructions).press))}
      ${!isGK ? instrRowHtml('Def. participação', instrOptBtns('defensiveParticipation',
        ['track-back','partial','stay'], DEFENSIVE_PARTICIPATION_LABELS, (inst as PlayerInstructions).defensiveParticipation)) : ''}
      ${hasAny ? `<button class="instr-clear-all-btn" data-clear-instr>Limpar instruções</button>` : ''}
    ` : `
      <div class="instr-panel-empty">Selecione um jogador<br>no campo para editar<br>suas instruções</div>
    `}
  `;
}

function squadPanelView(state: FormationState, ovr: number, staminas: Record<string, number> = {}): string {
  return `
    <div class="squad-header">
      <h2>${state.editMode === 'lineup' ? 'Trocar jogadores' : 'Titulares'}</h2>
      <div class="squad-header-meta">
        <span class="ovr-badge">OVR ${ovr}</span>
        <span>${state.formation.name}</span>
      </div>
    </div>
    <ol class="formation-list">
      ${state.starters.map((starter, index) => starterItem(
        starter,
        state.editMode === 'lineup' && state.selectedId === starter.player.id,
        state.editMode,
        state.customJerseyNumbers[starter.player.id] ?? (index + 1),
        staminas[starter.player.id] ?? 100,
      )).join('')}
    </ol>
    <div class="bench-header">
      <h2>Banco</h2>
      <span>${state.bench.length}</span>
    </div>
    <ol class="formation-list bench-list">
      ${state.bench.map((player) => benchItem(player, state.selectedId === player.id, state.editMode, staminas[player.id] ?? 100)).join('')}
    </ol>
  `;
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
            <div class="tactic-label-row">
              <span class="formation-controls-label">Tática</span>
              <button class="tactic-advanced-toggle ${state.tacticViewMode === 'advanced' ? 'is-active' : ''}" data-tactic-view>
                ${state.tacticViewMode === 'advanced' ? 'Simples ▴' : 'Avançado ▾'}
              </button>
            </div>
            <div class="formation-tabs">
              ${TACTICAL_PROFILES.map(profile => `
                <button
                  class="${profile.name === state.tacticalScheme.name ? 'is-active' : ''}"
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
          <button class="${state.editMode === 'instructions' ? 'is-active' : ''}" data-edit-mode="instructions">
            Instruções
          </button>
        </div>

        <div class="formation-pitch ${state.editMode === 'lineup' ? 'is-lineup-mode' : state.editMode === 'instructions' ? 'is-instructions-mode' : 'is-position-mode'}">
          <div class="pitch-line pitch-half"></div>
          <div class="pitch-box pitch-box-left"></div>
          <div class="pitch-box pitch-box-right"></div>
          <div class="pitch-circle"></div>
          ${state.starters.map((starter, index) => playerMarker(starter, state, state.customJerseyNumbers[starter.player.id] ?? (index + 1))).join('')}
        </div>
      </section>

      <aside class="formation-panel">
        ${state.tacticViewMode === 'advanced'
          ? advancedTacticPanelView(state, ovr)
          : state.editMode === 'instructions'
            ? instructionPanelView(state, ovr)
            : squadPanelView(state, ovr, context.initialStaminas ?? {})}
      </aside>
    </main>
  `;
}

function playerMarker(starter: FormationPlayer, state: FormationState, jerseyNum: number): string {
  const isSelected = state.editMode === 'lineup'
    ? state.selectedId === starter.player.id
    : state.editMode === 'instructions'
      ? state.selectedInstructionId === starter.player.id
      : false;
  const hasInst = state.playerInstructions.has(starter.player.id);
  const locked = state.editMode === 'positions' && starter.role === PlayerRole.Goalkeeper;
  const outOfPos = isOutOfPosition(starter.player.role, starter.role, starter.player.alternateRoles);
  return `
    <button
      class="formation-marker ${roleClass(starter.role)} ${isSelected ? 'is-selected' : ''} ${state.editMode === 'lineup' ? 'is-swap-marker' : ''} ${locked ? 'is-locked' : ''} ${outOfPos ? 'is-out-of-pos' : ''} ${hasInst ? 'has-instructions' : ''}"
      data-drag-player="${escapeHtml(starter.player.id)}"
      style="left: ${toPitchLeft(starter.x)}%; top: ${toPitchTop(starter.y)}%"
      title="${escapeHtml(starter.player.name)}${outOfPos ? ' (fora de posição)' : ''}${hasInst ? ' (tem instruções)' : ''}"
    >
      <span>${starter.player.overall}</span>
      <strong><em>#${jerseyNum}</em>${escapeHtml(shortName(starter.player.name))}</strong>
      <small>${escapeHtml(positionLabel(starter.player.position))}</small>
    </button>
  `;
}

function starterItem(starter: FormationPlayer, selected: boolean, editMode: FormationState['editMode'], jerseyNum: number, stamina: number): string {
  const outOfPos = isOutOfPosition(starter.player.role, starter.role, starter.player.alternateRoles);
  return `
    <li class="starter-list-item">
      <button
        class="${roleClass(starter.role)} ${selected ? 'is-selected' : ''} ${outOfPos ? 'is-out-of-pos' : ''}"
        data-select-player="${escapeHtml(starter.player.id)}"
        ${editMode === 'positions' || editMode === 'instructions' ? 'disabled' : ''}
      >
        <span>${starter.player.overall}</span>
        <div>
          <div class="player-name-row"><strong>${escapeHtml(starter.player.name)}</strong>${flagImg(starter.player)}</div>
          <small>
            <b>${escapeHtml(positionLabel(starter.player.position))}</b>
            ${starter.player.alternatePositions.map((p) => `<span class="alt-pos-badge">${escapeHtml(positionLabel(p))}</span>`).join('')}
            ${outOfPos ? `<span class="oop-badge" title="Fora de posição">↗ ${roleLabel(starter.role)}</span>` : ''}
          </small>
        </div>
      </button>
      <div class="starter-footer">
        <label class="jersey-label">
          <span>Camisa</span>
          <input class="jersey-num-input" type="number" min="1" max="99" value="${jerseyNum}" data-jersey-player="${escapeHtml(starter.player.id)}" title="Número da camisa">
        </label>
        ${staminaBar(stamina)}
      </div>
    </li>
  `;
}

function benchItem(player: DraftPlayer, selected: boolean, editMode: FormationState['editMode'], stamina: number): string {
  return `
    <li>
      <button class="${selected ? 'is-selected' : ''}" data-select-player="${escapeHtml(player.id)}" ${editMode === 'positions' || editMode === 'instructions' ? 'disabled' : ''}>
        <span>${player.overall}</span>
        <div>
          <div class="player-name-row"><strong>${escapeHtml(player.name)}</strong>${flagImg(player)}</div>
          <small>
            ${escapeHtml(positionLabel(player.position))}
            ${player.alternatePositions.map((p) => `<span class="alt-pos-badge">${escapeHtml(positionLabel(p))}</span>`).join('')}
            / ${escapeHtml(player.team)}
          </small>
          ${staminaBar(stamina)}
        </div>
      </button>
    </li>
  `;
}

function flagImg(player: DraftPlayer): string {
  const flagCode = nationalityFlagCode(player.nationality);
  return flagCode
    ? `<img class="flag" src="https://flagcdn.com/20x15/${flagCode}.png" alt="${escapeHtml(player.nationality)}" loading="lazy"> `
    : '';
}

function staminaBar(stamina: number): string {
  const cls = stamina > 65 ? 'is-green' : stamina > 35 ? 'is-yellow' : 'is-red';
  return `<div class="stamina-bar-wrap"><div class="stamina-bar ${cls}" style="width:${stamina}%"></div></div>`;
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

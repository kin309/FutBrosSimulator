import { DraftPlayer, DraftRoundKind } from './DraftTypes';
import { TeamData } from '../game/data/TeamFactory';
import { TournamentMode, TournamentState } from './Tournament';

export type DraftVisibility = 'hidden' | 'public';

export interface LobbyPlayer {
  id: string;
  name: string;
  isHost: boolean;
  isConnected?: boolean;
}

export type GroupPlacement = 'separated' | 'random';

export interface LobbySettings {
  mode: TournamentMode;
  visibility: DraftVisibility;
  groupPlacement: GroupPlacement;
}

export interface MultiplayerDraftTeam {
  playerId: string;
  playerName: string;
  picked: DraftPlayer[];
  currentPlayers: DraftPlayer[];
  currentKind: DraftRoundKind;
  title: string;
  rerollsLeft: number;
  isComplete: boolean;
  hasPickedThisRound: boolean;
}

export interface MultiplayerDraftState {
  roomCode: string;
  settings: LobbySettings;
  players: LobbyPlayer[];
  teams: MultiplayerDraftTeam[];
}

export type MultiplayerMatchPhase = 'idle' | 'formation' | 'running';

export interface MultiplayerMatchState {
  phase: MultiplayerMatchPhase;
  matchId: string | null;
  readyPlayerIds: string[];
  teams: Record<string, TeamData>;
  startedAt: number | null;
}

export interface MultiplayerMatchLiveState {
  matchId: string;
  homeName: string;
  awayName: string;
  scoreHome: number;
  scoreAway: number;
  clock: string;
  phase: string;
  eventText?: string;
  replay?: {
    ball: { x: number; y: number };
    players: Array<{
      id: string;
      name: string;
      jerseyNumber: number;
      teamId: 'teamA' | 'teamB';
      x: number;
      y: number;
      hasBall: boolean;
    }>;
  };
  updatedAt: number;
}

export type LobbyMessage =
  | { type: 'join'; player: LobbyPlayer }
  | { type: 'leave'; playerId: string }
  | { type: 'lobby-state'; hostId: string; players: LobbyPlayer[]; settings: LobbySettings }
  | { type: 'update-name'; playerId: string; name: string }
  | { type: 'update-settings'; settings: LobbySettings }
  | { type: 'start-draft' }
  | { type: 'draft-state'; state: MultiplayerDraftState }
  | { type: 'pick'; playerId: string; pickId: string }
  | { type: 'reroll'; playerId: string }
  | { type: 'tournament-state'; state: TournamentState }
  | { type: 'match-state'; state: MultiplayerMatchState }
  | { type: 'prepare-match'; matchId: string }
  | { type: 'formation-ready'; playerId: string; matchId: string; team: TeamData }
  | { type: 'host-start-match'; matchId: string }
  | { type: 'match-live-state'; state: MultiplayerMatchLiveState }
  | { type: 'match-result'; matchId: string; scoreHome: number; scoreAway: number };

export const DEFAULT_LOBBY_SETTINGS: LobbySettings = {
  mode: 'champions-16',
  visibility: 'public',
  groupPlacement: 'separated',
};

export function createPlayerId(): string {
  const stored = sessionStorage.getItem('football-sim-player-id');
  if (stored) return stored;

  const next = `p-${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem('football-sim-player-id', next);
  return next;
}

export function createRoomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function normalizeRoomCode(value: string): string {
  return value.trim().replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
}

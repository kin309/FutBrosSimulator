import Phaser from 'phaser';
import MatchScene from './scenes/MatchScene';
import { TeamData } from './data/TeamFactory';
import type { MultiplayerMatchLiveState } from '../draft/MultiplayerLobby';

export interface LiveUpdatePayload {
  scoreA: number;
  scoreB: number;
  clock: string;
  phase: string;
  eventText?: string;
  event?: import('../draft/MultiplayerLobby').SpectatorEvent;
  replay?: {
    ball: { x: number; y: number; vx: number; vy: number };
    players: import('../draft/MultiplayerLobby').SpectatorPlayerState[];
  };
}

export interface MatchSetup {
  teams: [TeamData, TeamData];
  onMatchEnd?: (scoreA: number, scoreB: number) => void;
  onLiveUpdate?: (state: LiveUpdatePayload) => void;
  /** Modo espectador: desativa IA/física e aplica estado vindo da rede. */
  spectatorMode?: boolean;
  /** Callback registrado pelo DraftApp para empurrar estado recebido na cena. */
  onSpectatorFrame?: (push: (state: MultiplayerMatchLiveState) => void) => void;
  autoFinishDelayMs?: number;
}

export function createGame(setup?: MatchSetup): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    width: 1200,
    height: 760,
    backgroundColor: '#1a5c1a',
    parent: 'game-root',
    scene: [new MatchScene(setup)],
    render: {
      roundPixels: true,
      antialias: true,
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  });
}

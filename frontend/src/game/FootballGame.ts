import Phaser from 'phaser';
import MatchScene from './scenes/MatchScene';
import { TeamData } from './data/TeamFactory';
import type { MultiplayerMatchLiveState } from '../draft/MultiplayerLobby';
import type { TacticalProfile } from './data/TacticalProfile';
import type { PlayerInstructions } from './data/PlayerInstructions';
import type { PlayerRole } from './data/PlayerRole';

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
  /** Perfil tático do time A (controlado pelo jogador). */
  tacticalProfileA?: TacticalProfile;
  /**
   * Instruções individuais por jogador para o time A.
   * Chave: player.id. Sobrescreve comportamentos do TacticalProfile por jogador.
   */
  playerInstructionsA?: Map<string, PlayerInstructions>;
  /** Chamado no intervalo após a animação de saída. O callback deve chamar resume() para iniciar o 2º tempo. */
  onHalftime?: (ctx: {
    scoreA: number;
    scoreB: number;
    teamAName: string;
    teamBName: string;
    currentProfile: TacticalProfile;
    applyTactic: (profile: TacticalProfile) => void;
    resume: () => void;
    starters?: Array<{ id: string; name: string; role: PlayerRole; jerseyNumber: number; stamina: number }>;
    bench?: Array<{ id: string; name: string; role: PlayerRole; jerseyNumber: number; stamina: number }>;
    applySubstitution?: (starterIndex: number, benchIndex: number) => void;
  }) => void;
}

export function createGame(setup?: MatchSetup): Phaser.Game {
  const game = new Phaser.Game({
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

  // Phaser calls game.loop.sleep() when the page is hidden or the window loses
  // focus (via 'hidden' / 'blur' events), stopping requestAnimationFrame entirely.
  // Override blur() so the loop keeps running when the host minimizes the browser.
  const timeStep = game.loop as unknown as { inFocus: boolean; blur(): void };
  timeStep.blur = () => { timeStep.inFocus = false; };

  return game;
}

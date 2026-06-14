import Phaser from 'phaser';
import MatchScene from './scenes/MatchScene';
import { TeamData } from './data/TeamFactory';

export interface MatchSetup {
  teams: [TeamData, TeamData];
  onMatchEnd?: (scoreA: number, scoreB: number) => void;
  onLiveUpdate?: (state: {
    scoreA: number;
    scoreB: number;
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
  }) => void;
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

import Phaser from 'phaser';
import { MatchManager } from './MatchManager';
import { Team } from '../entities/Team';

import { GAME_WIDTH, GAME_HEIGHT } from '../constants';

const MAX_LOG = 5;
const CENTER_X = GAME_WIDTH / 2;
const FONT = 'Nunito';

export class Scoreboard {
  private scene: Phaser.Scene;
  private manager: MatchManager;
  private teamA: Team;
  private teamB: Team;

  private hudBg!: Phaser.GameObjects.Rectangle;
  private scoreText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private possText!: Phaser.GameObjects.Text;
  private logTexts: Phaser.GameObjects.Text[] = [];
  private eventLog: string[] = [];

  private goalBanner!: Phaser.GameObjects.Container;
  private goalText!: Phaser.GameObjects.Text;
  private goalScorerText!: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, manager: MatchManager, teamA: Team, teamB: Team) {
    this.scene = scene;
    this.manager = manager;
    this.teamA = teamA;
    this.teamB = teamB;
    this.build();
  }

  private build(): void {
    // HUD background strip
    this.hudBg = this.scene.add.rectangle(CENTER_X, 29, GAME_WIDTH, 58, 0x111827, 0.94).setDepth(20);

    // Score text
    this.scoreText = this.scene.add.text(CENTER_X, 14, '', {
      fontSize: '22px',
      fontStyle: 'bold',
      fontFamily: FONT,
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
      resolution: 2,
    }).setOrigin(0.5, 0).setDepth(21);

    // Timer
    this.timerText = this.scene.add.text(CENTER_X, 38, '', {
      fontSize: '15px',
      fontStyle: 'bold',
      fontFamily: FONT,
      color: '#fbbf24',
      stroke: '#000000',
      strokeThickness: 2,
      resolution: 2,
    }).setOrigin(0.5, 0).setDepth(21);

    // Possession
    this.possText = this.scene.add.text(GAME_WIDTH - 24, 14, '', {
      fontSize: '13px',
      fontStyle: 'bold',
      fontFamily: FONT,
      color: '#d1d5db',
      stroke: '#000000',
      strokeThickness: 2,
      resolution: 2,
    }).setOrigin(1, 0).setDepth(21);

    // Controls hint
    this.scene.add.text(10, 14, 'SPACE pausar  R reiniciar  1 2x  2 1x', {
      fontSize: '11px',
      fontFamily: FONT,
      color: '#9ca3af',
      resolution: 2,
    }).setDepth(21);

    // Event log
    for (let i = 0; i < MAX_LOG; i++) {
      this.logTexts.push(
        this.scene.add.text(10, GAME_HEIGHT - 44 + i * 16 - (MAX_LOG - 1) * 16, '', {
          fontSize: '13px',
          fontStyle: 'bold',
          fontFamily: FONT,
          color: '#f3f4f6',
          stroke: '#000000',
          strokeThickness: 3,
          resolution: 2,
        }).setDepth(21),
      );
    }

    // Goal banner (hidden by default)
    const bannerBg = this.scene.add.rectangle(0, 0, 400, 100, 0x000000, 0.88);
    this.goalText = this.scene.add.text(0, -22, '', {
      fontSize: '32px',
      fontStyle: 'bold',
      fontFamily: FONT,
      color: '#fbbf24',
      stroke: '#000000',
      strokeThickness: 4,
      resolution: 2,
    }).setOrigin(0.5);
    this.goalScorerText = this.scene.add.text(0, 22, '', {
      fontSize: '16px',
      fontFamily: FONT,
      color: '#e2e8f0',
      stroke: '#000000',
      strokeThickness: 3,
      resolution: 2,
    }).setOrigin(0.5);
    this.goalBanner = this.scene.add.container(CENTER_X, GAME_HEIGHT / 2, [bannerBg, this.goalText, this.goalScorerText]);
    this.goalBanner.setDepth(30).setVisible(false);
  }

  update(): void {
    const { scoreA, scoreB } = this.manager;
    this.scoreText.setText(
      `${this.teamA.name} [${this.teamA.formationName}]  ${scoreA} - ${scoreB}  [${this.teamB.formationName}] ${this.teamB.name}`,
    );
    this.timerText.setText(this.manager.getTimeString());

    const possTeam = this.teamA.hasPossession()
      ? this.teamA.name
      : this.teamB.hasPossession()
        ? this.teamB.name
        : '—';
    this.possText.setText(`Posse: ${possTeam}`);
  }

  logEvent(msg: string): void {
    this.eventLog.unshift(msg);
    if (this.eventLog.length > MAX_LOG) this.eventLog.length = MAX_LOG;
    for (let i = 0; i < MAX_LOG; i++) {
      this.logTexts[i].setText(this.eventLog[i] ?? '');
      this.logTexts[i].setAlpha(1 - i * 0.15);
    }
  }

  showGoalBanner(teamName: string, scorerName?: string): void {
    this.goalText.setText(`⚽  GOL!  —  ${teamName}`);
    this.goalScorerText.setText(scorerName ? scorerName : '');
    this.goalBanner.setVisible(true);
    this.scene.time.delayedCall(2200, () => this.goalBanner.setVisible(false));
  }

  showFinished(isTournament: boolean | null = false): void {
    const { scoreA, scoreB } = this.manager;
    const winner = scoreA > scoreB ? this.teamA.name : scoreB > scoreA ? this.teamB.name : 'Empate!';
    const text = scoreA === scoreB
      ? `Fim de jogo — Empate ${scoreA} - ${scoreB}`
      : `Fim de jogo — ${winner} vence ${scoreA} - ${scoreB}`;

    const bgHeight = isTournament !== null ? 90 : 60;
    this.scene.add.rectangle(CENTER_X, GAME_HEIGHT / 2, 560, bgHeight, 0x000000, 0.92).setDepth(30);
    this.scene.add.text(CENTER_X, GAME_HEIGHT / 2 - (isTournament !== null ? 10 : 0), text, {
      fontSize: '24px',
      fontStyle: 'bold',
      fontFamily: FONT,
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 4,
      resolution: 2,
    }).setOrigin(0.5).setDepth(31);

    if (isTournament !== null) {
      const hint = isTournament ? 'Pressione T para voltar ao campeonato' : 'Pressione R para jogar novamente';
      this.scene.add.text(CENTER_X, GAME_HEIGHT / 2 + 26, hint, {
        fontSize: '15px',
        fontStyle: 'bold',
        fontFamily: FONT,
        color: '#fbbf24',
        stroke: '#000000',
        strokeThickness: 2,
        resolution: 2,
      }).setOrigin(0.5).setDepth(31);
    }
  }
}

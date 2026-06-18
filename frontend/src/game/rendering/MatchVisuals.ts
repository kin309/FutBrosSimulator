import Phaser from 'phaser';
import { Team } from '../entities/Team';
import { MatchManager } from '../systems/MatchManager';
import { StatsTracker } from '../systems/StatsTracker';
import { FieldHeatMap } from '../ai/FieldHeatMap';
import type { MatchSetup } from '../FootballGame';
import { GAME_WIDTH, FIELD, GOAL_LEFT, GOAL_RIGHT } from '../constants';

export interface MatchVisualsDeps {
  matchManager: MatchManager;
  stats: StatsTracker;
  teamA: Team;
  teamB: Team;
  setup: MatchSetup | undefined;
  getHeatMap: () => FieldHeatMap;
  heatMapGfx: Phaser.GameObjects.Graphics;
  heatMapLabel: Phaser.GameObjects.Text;
  getHeatMapMode: () => 0 | 1 | 2 | 3;
}

export class MatchVisuals {
  statsOverlay: Phaser.GameObjects.Container | null = null;

  constructor(private scene: Phaser.Scene, private deps: MatchVisualsDeps) {}

  showHalftimeBanner(): void {
    const W = 1200;
    const H = 760;
    const { matchManager } = this.deps;
    const bg  = this.scene.add.rectangle(W / 2, H / 2, 400, 90, 0x000000, 0.92).setDepth(30);
    const txt = this.scene.add.text(W / 2, H / 2, 'Intervalo', {
      fontSize: '34px',
      fontStyle: 'bold',
      fontFamily: 'Nunito',
      color: '#fbbf24',
      stroke: '#000000',
      strokeThickness: 4,
      resolution: 2,
    }).setOrigin(0.5).setDepth(31);
    const sub = this.scene.add.text(W / 2, H / 2 + 28, `${matchManager.scoreA} – ${matchManager.scoreB}`, {
      fontSize: '18px',
      fontStyle: 'bold',
      fontFamily: 'Nunito',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 2,
      resolution: 2,
    }).setOrigin(0.5).setDepth(31);
    // Auto-destroy when second half starts
    matchManager.onHalftimeEnd = (() => {
      const prev = matchManager.onHalftimeEnd;
      return () => { bg.destroy(); txt.destroy(); sub.destroy(); prev?.call(matchManager); };
    })();
  }

  showStatsOverlay(): void {
    const { stats, matchManager, teamA, teamB, setup } = this.deps;
    const sA = stats.getStats('teamA');
    const sB = stats.getStats('teamB');
    const totalPoss = stats.totalPossessionMs();
    const possA = totalPoss > 0 ? Math.round((sA.possessionMs / totalPoss) * 100) : 50;
    const possB = 100 - possA;
    const accA = sA.passes > 0 ? Math.round((sA.passesCompleted / sA.passes) * 100) : 0;
    const accB = sB.passes > 0 ? Math.round((sB.passesCompleted / sB.passes) * 100) : 0;
    const scA = matchManager.scoreA;
    const scB = matchManager.scoreB;

    const goals = stats.getGoals();
    const goalsA = goals.filter(g => g.scorerTeamId === 'teamA');
    const goalsB = goals.filter(g => g.scorerTeamId === 'teamB');
    const goalRows = Math.max(1, goalsA.length, goalsB.length);
    const goalRowH = 22;
    const goalSectionH = 30 + goalRows * goalRowH; // separator + header + rows

    const W = 630, H = 390 + goalSectionH;
    const cx = GAME_WIDTH / 2;
    const cy = (FIELD.top + FIELD.bottom) / 2;

    const c = this.scene.add.container(cx, cy).setDepth(30);
    this.statsOverlay = c;

    const bg = this.scene.add.rectangle(0, 0, W, H, 0x0f172a, 0.95);
    bg.setStrokeStyle(2, 0x1e3a5f);
    c.add(bg);

    c.add(this.scene.add.rectangle(-W / 2 + 68, -H / 2 + 5, 136, 4, teamA.color));
    c.add(this.scene.add.rectangle(W / 2 - 68, -H / 2 + 5, 136, 4, teamB.color));

    c.add(this.scene.add.text(0, -H / 2 + 24, 'FIM DE JOGO', {
      fontSize: '20px', color: '#f8fafc', fontStyle: 'bold', fontFamily: 'Nunito', resolution: 2,
    }).setOrigin(0.5));

    c.add(this.scene.add.text(-90, -H / 2 + 54, teamA.name, {
      fontSize: '13px', color: '#93c5fd', fontFamily: 'Nunito', fontStyle: 'bold', resolution: 2,
    }).setOrigin(1, 0.5));
    c.add(this.scene.add.text(0, -H / 2 + 54, `${scA}  —  ${scB}`, {
      fontSize: '18px', fontStyle: 'bold', fontFamily: 'Nunito', resolution: 2,
      color: scA !== scB ? '#f8fafc' : '#e2e8f0',
    }).setOrigin(0.5));
    c.add(this.scene.add.text(90, -H / 2 + 54, teamB.name, {
      fontSize: '13px', color: '#fca5a5', fontFamily: 'Nunito', fontStyle: 'bold', resolution: 2,
    }).setOrigin(0, 0.5));

    c.add(this.scene.add.rectangle(0, -H / 2 + 74, W - 60, 1, 0x334155));

    const rows: [string, string | number, string | number][] = [
      ['Posse de Bola',   `${possA}%`,          `${possB}%`],
      ['Finalizações',     sA.shots,              sB.shots],
      ['No Alvo',          sA.shotsOnTarget,      sB.shotsOnTarget],
      ['Passes',           sA.passes,             sB.passes],
      ['Precisão Passes',  `${accA}%`,            `${accB}%`],
      ['Desarmes',         sA.tacklesWon,         sB.tacklesWon],
      ['Interceptações',   sA.interceptions,      sB.interceptions],
      ['Defesas (GK)',     sA.saves,              sB.saves],
    ];

    const rowStartY = -H / 2 + 90;
    const rowH = 30;

    rows.forEach(([label, vA, vB], i) => {
      const y = rowStartY + i * rowH;
      if (i % 2 === 0) c.add(this.scene.add.rectangle(0, y, W - 60, rowH - 2, 0x1e293b, 0.55));

      c.add(this.scene.add.text(0, y, label, {
        fontSize: '11px', color: '#64748b', fontFamily: 'Nunito', resolution: 2,
      }).setOrigin(0.5));
      c.add(this.scene.add.text(-205, y, String(vA), {
        fontSize: '13px', color: '#93c5fd', fontStyle: 'bold', fontFamily: 'Nunito', resolution: 2,
      }).setOrigin(0.5));
      c.add(this.scene.add.text(205, y, String(vB), {
        fontSize: '13px', color: '#fca5a5', fontStyle: 'bold', fontFamily: 'Nunito', resolution: 2,
      }).setOrigin(0.5));
    });

    // Goals & assists section
    const gSepY = rowStartY + rows.length * rowH + 10;
    c.add(this.scene.add.rectangle(0, gSepY, W - 60, 1, 0x334155));
    c.add(this.scene.add.text(-205, gSepY + 12, 'GOLS / ASSIST.', {
      fontSize: '10px', color: '#64748b', fontFamily: 'Nunito', resolution: 2,
    }).setOrigin(0.5));
    c.add(this.scene.add.text(205, gSepY + 12, 'GOLS / ASSIST.', {
      fontSize: '10px', color: '#64748b', fontFamily: 'Nunito', resolution: 2,
    }).setOrigin(0.5));

    for (let i = 0; i < goalRows; i++) {
      const y = gSepY + 24 + i * goalRowH;
      if (i % 2 === 0) c.add(this.scene.add.rectangle(0, y, W - 60, goalRowH - 2, 0x1e293b, 0.40));

      const gA = goalsA[i];
      const gB = goalsB[i];

      if (gA) {
        const label = gA.assistName ? `⚽ ${gA.scorerName}  (A: ${gA.assistName})` : `⚽ ${gA.scorerName}`;
        c.add(this.scene.add.text(-50, y, label, {
          fontSize: '11px', color: '#93c5fd', fontFamily: 'Nunito', resolution: 2,
        }).setOrigin(1, 0.5));
      }
      if (gB) {
        const label = gB.assistName ? `⚽ ${gB.scorerName}  (A: ${gB.assistName})` : `⚽ ${gB.scorerName}`;
        c.add(this.scene.add.text(50, y, label, {
          fontSize: '11px', color: '#fca5a5', fontFamily: 'Nunito', resolution: 2,
        }).setOrigin(0, 0.5));
      }
    }

    c.add(this.scene.add.rectangle(0, H / 2 - 40, W - 60, 1, 0x334155));
    const footerText = setup?.onMatchEnd
      ? '[T]  Voltar ao Campeonato'
      : '[R]  Novo Jogo';
    c.add(this.scene.add.text(0, H / 2 - 20, footerText, {
      fontSize: '12px', color: '#475569', fontFamily: 'Nunito', resolution: 2,
    }).setOrigin(0.5));
  }

  spawnGoalConfetti(scoringTeamId: string): void {
    const goal    = scoringTeamId === 'teamA' ? GOAL_RIGHT : GOAL_LEFT;
    const centerX = goal.centerX;
    const centerY = (goal.top + goal.bottom) / 2;
    const COLORS  = [0xff4444, 0xffdd00, 0x44ff88, 0x4499ff, 0xff44cc, 0xffffff, 0xff8833];

    for (let burst = 0; burst < 4; burst++) {
      this.scene.time.delayedCall(burst * 180, () => {
        const bx = centerX + (Math.random() - 0.5) * 130;
        const by = centerY + (Math.random() - 0.5) * 90;

        for (let i = 0; i < 22; i++) {
          const angle  = Math.random() * Math.PI * 2;
          const speed  = 40 + Math.random() * 90;
          const color  = COLORS[Math.floor(Math.random() * COLORS.length)];
          const w      = 4 + Math.random() * 5;
          const h      = 3 + Math.random() * 3;

          const piece = this.scene.add.rectangle(bx, by, w, h, color, 1).setDepth(12);
          piece.setRotation(Math.random() * Math.PI * 2);

          this.scene.tweens.add({
            targets: piece,
            x: bx + Math.cos(angle) * speed,
            y: by + Math.sin(angle) * speed + 55,
            rotation: piece.rotation + (Math.random() - 0.5) * Math.PI * 6,
            alpha: 0,
            duration: 650 + Math.random() * 450,
            ease: 'Sine.easeOut',
            onComplete: () => piece.destroy(),
          });
        }
      });
    }
  }

  drawHeatMapDebug(): void {
    const { heatMapGfx, heatMapLabel, getHeatMapMode, getHeatMap, teamA, teamB } = this.deps;
    heatMapGfx.clear();
    const mode = getHeatMapMode();
    if (mode === 0) return;

    type HIdx = 0 | 1 | 2;
    const isGlobal = mode === 3;
    const teamIdx: HIdx = isGlobal ? 2 : (mode - 1) as HIdx;
    const baseColor = isGlobal ? 0xf59e0b
      : teamIdx === 0 ? 0x3b82f6
      : 0xef4444;
    const label = isGlobal
      ? 'GLOBAL'
      : teamIdx === 0 ? teamA.name : teamB.name;

    const heatMap = getHeatMap();
    const { cols, rows, cellW, cellH } = heatMap;

    let maxHeat = 0.1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = FIELD.left + (c + 0.5) * cellW;
        const wy = FIELD.top  + (r + 0.5) * cellH;
        const h = heatMap.getHeat(wx, wy, teamIdx);
        if (h > maxHeat) maxHeat = h;
      }
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = FIELD.left + c * cellW;
        const wy = FIELD.top  + r * cellH;
        const heat = heatMap.getHeat(wx + cellW * 0.5, wy + cellH * 0.5, teamIdx);
        if (heat < 0.05) continue;
        const norm  = heat / maxHeat;
        const alpha = norm * 0.60;
        heatMapGfx.fillStyle(baseColor, alpha);
        heatMapGfx.fillRect(wx + 1, wy + 1, cellW - 2, cellH - 2);
      }
    }

    heatMapLabel.setText(`HEAT: ${label}  [H] para trocar`);
  }
}

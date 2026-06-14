import Phaser from 'phaser';
import { Ball } from '../entities/Ball';
import { Player } from '../entities/Player';
import { Team } from '../entities/Team';
import { MatchManager } from '../systems/MatchManager';
import { Scoreboard } from '../systems/Scoreboard';
import { EventResolver } from '../systems/EventResolver';
import { TeamAI } from '../ai/TeamAI';
import { AIContext, findAttackingOpenSpace, gkShotStoppingQuality, gkDistributionQuality } from '../ai/DecisionUtils';
import { FieldHeatMap } from '../ai/FieldHeatMap';
import { TacticalPhase, GameContext } from '../ai/TacticalAI';
import type { MatchSetup } from '../FootballGame';
import { createTeams } from '../data/TeamFactory';
import { StatsTracker } from '../systems/StatsTracker';
import { PlayerRole } from '../data/PlayerRole';
import { PlayerState } from '../data/PlayerState';
import { FieldBounds, GoalBounds } from '../types';
import { dist, clamp, distancePointToSegment } from '../utils/MathUtils';
import { traitBonus, TRAITS } from '../data/PlayerTraits';
import { BALL_PHYSICS } from '../physics/BallPhysics';

// ─── Constants ───────────────────────────────────────────────────────────────

const GAME_WIDTH = 1200;
const GAME_HEIGHT = 760;
const HUD_HEIGHT = 58;
const FIELD: FieldBounds = {
  left: 20, right: 1180, top: 76, bottom: 744,
  centerX: 600, centerY: 410,
};
const GOAL_HEIGHT = 192;
// Field markings derived from real football ratios applied to our field (1160×668 ≈ 105×68m)
const PENALTY_AREA_H = 396;  // 40.32/68 × 668 — real proportion of field height
const PENALTY_AREA_W = 182;  // 16.5/105 × 1160 — real proportion of field width
const GOAL_AREA_H    = 240;  // slightly wider than goal (extends ~24px past each post)
const GOAL_AREA_W    = 62;   // 5.5/105 × 1160 — real proportion of field width
const GOAL_LEFT: GoalBounds = { centerX: 10, top: FIELD.centerY - GOAL_HEIGHT / 2, bottom: FIELD.centerY + GOAL_HEIGHT / 2 };
const GOAL_RIGHT: GoalBounds = { centerX: 1190, top: FIELD.centerY - GOAL_HEIGHT / 2, bottom: FIELD.centerY + GOAL_HEIGHT / 2 };
const GOAL_LINE_LEFT = FIELD.left;
const GOAL_LINE_RIGHT = FIELD.right;
const CENTER_CIRCLE_RADIUS = 100; // 9.15m radius ≈ 9.7% of field width
// Physical contact distance: player radius (14) + ball radius (7) + 1px tolerance
const CONTACT_RADIUS: number = BALL_PHYSICS.contactRadius;
const BALL_FRICTION: number = BALL_PHYSICS.groundFrictionPerFrame;
const BALL_PICKUP_RADIUS: number = BALL_PHYSICS.pickupRadius;
const TACKLE_RANGE = 36;
const TACKLE_COOLDOWN_MS = 1400;
const SHOT_BASE_POWER = 7.0;
const SHOT_STAT_POWER = 3.1;
const SHOT_DISTANCE_POWER = 2.6;
const SHOT_MIN_POWER = 7.4;
const SHOT_MAX_POWER = 12.5;
const SHOT_ELITE_MAX_POWER_BONUS = 3.2;
const SHOT_DISTANCE_POWER_START = 180;
const SHOT_DISTANCE_POWER_FULL = 620;
const CLEARANCE_BASE_POWER = 7.0;
const CLEARANCE_STAT_POWER = 2.6;
const SIMULATION_SPEED = 1.0;
const GK_DIVE_MIN_DISTANCE = 66;
const GK_DIVE_BASE_REACH = 100;
const GK_DIVE_MAX_REACH = 196;
const GK_DIVE_MIN_DISPLACEMENT = 50;
const GK_DIVE_OVERSHOOT = 18;
const GK_DIVE_MIN_REACTION_FRAMES = 2;
const GK_DIVE_MAX_REACTION_FRAMES = 90;
const GK_DIVE_MIN_TARGETED_THREAT_SPEED = 6.0;
const GK_DIVE_MIN_CROSS_THREAT_SPEED = 4.8;
const GK_DIVE_CATCH_RADIUS = 26;
const GK_DIVE_GOAL_LINE_MARGIN = 2;
const GK_DIVE_PARALLEL_BIAS = 0.62;

interface BallLaneAnalysis {
  risk: number;
  blockers: number;
  nearestDist: number;
  blocker: Player | null;
  blockerT: number;
  openSide: -1 | 1;
}

// ─── Scene ───────────────────────────────────────────────────────────────────

export default class MatchScene extends Phaser.Scene {
  private ball!: Ball;
  private teamA!: Team;
  private teamB!: Team;
  private matchManager!: MatchManager;
  private scoreboard!: Scoreboard;
  private resolver!: EventResolver;
  private aiA!: TeamAI;
  private aiB!: TeamAI;
  private tackleCooldowns = new Map<string, number>();
  private tacticalHud!: Phaser.GameObjects.Text;
  private stats!: StatsTracker;
  private heatMap!: FieldHeatMap;
  private heatMapGfx!: Phaser.GameObjects.Graphics;
  private gkDiveDebugGfx!: Phaser.GameObjects.Graphics;
  private heatMapLabel!: Phaser.GameObjects.Text;
  private heatMapMode: 0 | 1 | 2 | 3 = 0; // 0=off  1=teamA  2=teamB  3=global
  private statsOverlay: Phaser.GameObjects.Container | null = null;
  private lastPassWasCross = false;
  private gkDiveHoldoffMs = 0;
  private gkDiveDebugTtlMs = 0;
  private liveUpdateElapsedMs = 0;
  private matchEndDelivered = false;

  // Spectator mode
  private spectatorLatestState: import('../../draft/MultiplayerLobby').MultiplayerMatchLiveState | null = null;
  private spectatorLastEventAt = 0;
  private playerById = new Map<string, Player>();

  // Advantage-of-attack state (when time runs out with ball in play)
  private advTeamId: string = '';
  private advText: Phaser.GameObjects.Text | null = null;
  private advPrevBallX: number = 0;

  private keys!: {
    space: Phaser.Input.Keyboard.Key;
    r: Phaser.Input.Keyboard.Key;
    t: Phaser.Input.Keyboard.Key;
    one: Phaser.Input.Keyboard.Key;
    two: Phaser.Input.Keyboard.Key;
  };

  constructor(private readonly setup?: MatchSetup) { super({ key: 'MatchScene' }); }

  // ──────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────

  create(): void {
    this.drawField();
    this.resolver = new EventResolver();
    this.stats = new StatsTracker();
    this.buildTeams();
    this.ball = new Ball(this, FIELD.centerX, FIELD.centerY);
    this.heatMapGfx = this.add.graphics().setDepth(3);
    this.gkDiveDebugGfx = this.add.graphics().setDepth(24);
    this.heatMapLabel = this.add.text(FIELD.left + 4, FIELD.top + 4, '', {
      fontSize: '12px', color: '#ffffff', stroke: '#000000', strokeThickness: 3,
      fontFamily: 'Nunito', resolution: 2,
    }).setDepth(25).setVisible(false);
    this.matchManager = new MatchManager();
    this.scoreboard = new Scoreboard(this, this.matchManager, this.teamA, this.teamB);
    this.tacticalHud = this.add.text(GAME_WIDTH / 2, HUD_HEIGHT - 6, '', {
      fontSize: '11px',
      fontStyle: 'bold',
      color: '#cbd5e1',
      stroke: '#000000',
      strokeThickness: 2,
      resolution: 2,
    }).setOrigin(0.5, 1).setDepth(20);

    if (this.setup?.spectatorMode) {
      // Build index for fast player lookup by id
      for (const p of this.allPlayers()) this.playerById.set(p.id, p);
      // Register the push callback so DraftApp can feed frames into this scene
      this.setup.onSpectatorFrame?.((state) => { this.spectatorLatestState = state; });
      return;
    }

    this.aiA = new TeamAI(this.teamA);
    this.aiB = new TeamAI(this.teamB);
    this.heatMap = new FieldHeatMap(FIELD.left, FIELD.top, FIELD.right, FIELD.bottom);
    this.wireEvents();
    this.setupKeys();
    this.resetPlayersToKickoffShape();
    this.giveKickoff('teamA');
  }

  update(_time: number, delta: number): void {
    if (this.setup?.spectatorMode) {
      this.updateSpectator();
      return;
    }

    const simDelta = delta * SIMULATION_SPEED;

    this.matchManager.update(simDelta);
    this.liveUpdateElapsedMs += simDelta;
    if (this.liveUpdateElapsedMs >= 120) {
      this.liveUpdateElapsedMs = 0;
      this.emitLiveUpdate();
    }
    if (this.matchManager.isPaused) return;
    if (this.matchManager.state === 'goalScored' || this.matchManager.state === 'halftime' || this.matchManager.state === 'finished') return;

    // Tick cooldowns
    for (const [id, cd] of this.tackleCooldowns) {
      if (cd > 0) this.tackleCooldowns.set(id, Math.max(0, cd - simDelta));
    }
    this.gkDiveHoldoffMs = Math.max(0, this.gkDiveHoldoffMs - simDelta);
    this.gkDiveDebugTtlMs = Math.max(0, this.gkDiveDebugTtlMs - simDelta);
    if (this.gkDiveDebugTtlMs <= 0) this.gkDiveDebugGfx.clear();

    this.ball.updateBall(simDelta);
    this.handleBallBounds();
    if (this.checkGoal()) return;

    // Possession tracking — checked once per frame against live ball ownership
    const possessorTeamId: string | null =
      this.teamA.getBallCarrier()?.teamId ??
      this.teamB.getBallCarrier()?.teamId ??
      null;
    this.stats.tickPossession(possessorTeamId, simDelta);

    // AI — pass delta and live game context so the collective brain can factor in score/time
    const gameCtxA: GameContext = {
      scoreOwn: this.matchManager.scoreA,
      scoreOpp: this.matchManager.scoreB,
      elapsedMs: this.matchManager.matchTime,
      halfLengthMs: this.matchManager.halfDuration,
    };
    const gameCtxB: GameContext = {
      scoreOwn: this.matchManager.scoreB,
      scoreOpp: this.matchManager.scoreA,
      elapsedMs: this.matchManager.matchTime,
      halfLengthMs: this.matchManager.halfDuration,
    };
    // Refresh shared occupancy grid before any AI reads it this frame
    this.heatMap.update(this.teamA.players, this.teamB.players);
    this.drawHeatMapDebug();
    // Own/opp goals derive from attackDirection so they stay correct after halftime side swap
    const ownGoalA = this.teamA.attackDirection > 0 ? GOAL_LEFT  : GOAL_RIGHT;
    const oppGoalA = this.teamA.attackDirection > 0 ? GOAL_RIGHT : GOAL_LEFT;
    const ownGoalB = this.teamB.attackDirection > 0 ? GOAL_LEFT  : GOAL_RIGHT;
    const oppGoalB = this.teamB.attackDirection > 0 ? GOAL_RIGHT : GOAL_LEFT;
    this.aiA.update(simDelta, this.ball, this.teamB, ownGoalA, oppGoalA, FIELD, gameCtxA, this.heatMap);
    this.aiB.update(simDelta, this.ball, this.teamA, ownGoalB, oppGoalB, FIELD, gameCtxB, this.heatMap);

    // Update tactical HUD
    this.tacticalHud.setText(
      `${this.teamA.name}: ${this.phaseLabel(this.aiA.getPhase(), !!this.aiA.getManualPhase())}` +
      `   |   ` +
      `${this.teamB.name}: ${this.phaseLabel(this.aiB.getPhase(), false)}`,
    );

    // Always chase free ball (overrides AI position targets)
    this.chaseFreeeBall();

    // Spread teammate targets so they don't converge on the same spot
    this.separateTeamTargets(this.teamA);
    this.separateTeamTargets(this.teamB);

    // Execute pending actions
    this.processPlayerActions();

    this.updateGoalkeeperDives();

    // Route around nearby bodies before steering so players circle blockers instead of piling up
    this.applyPlayerTrafficAvoidance();

    // Move players
    for (const p of this.allPlayers()) {
      p.updatePlayer(simDelta, FIELD);
      p.updateLabelAlpha(this.ball.x, this.ball.y);
    }

    this.checkFreeBall();           // free-ball pickup before body separation can push players off it

    // Separate overlapping players
    this.resolvePlayerCollisions();

    this.checkTackles();
    this.checkPassArrival();        // resolve intended receiver / abandon stale passes
    this.checkBallPlayerContacts(); // physical collision: interception + teammate deflection
    this.checkFreeBall();           // second pass for deflections created this frame
    this.scoreboard.update();

    if (this.matchManager.state === 'advantage') {
      this.updateAdvantage(simDelta);
    }
  }

  // ──────────────────────────────────────────────
  // Build
  // ──────────────────────────────────────────────

  private buildTeams(): void {
    const [dataA, dataB] = this.setup?.teams ?? createTeams();

    this.teamA = new Team(dataA.id, dataA.name, dataA.color, dataA.attackDirection, dataA.formationName);
    this.teamB = new Team(dataB.id, dataB.name, dataB.color, dataB.attackDirection, dataB.formationName);

    for (const pd of dataA.players) {
      const p = new Player(this, pd.baseX, pd.baseY, pd.id, pd.name, pd.jerseyNumber, 'teamA', pd.role, pd.stats, dataA.color, pd.heightCm, pd.weightKg, pd.playstyles ?? [], pd.playstylesPlus ?? []);
      this.teamA.players.push(p);
      this.tackleCooldowns.set(pd.id, 0);
    }
    for (const pd of dataB.players) {
      const p = new Player(this, pd.baseX, pd.baseY, pd.id, pd.name, pd.jerseyNumber, 'teamB', pd.role, pd.stats, dataB.color, pd.heightCm, pd.weightKg, pd.playstyles ?? [], pd.playstylesPlus ?? []);
      this.teamB.players.push(p);
      this.tackleCooldowns.set(pd.id, 0);
    }
  }

  private wireEvents(): void {
    this.matchManager.onGoal = (teamId) => {
      const scorer   = teamId === 'teamA' ? this.teamA : this.teamB;
      const conceder = teamId === 'teamA' ? this.teamB : this.teamA;
      this.scoreboard.showGoalBanner(scorer.name);
      this.scoreboard.logEvent(`⚽ GOL! ${scorer.name} marca!`);
      this.emitLiveUpdate(`GOL! ${scorer.name} marca!`, { type: 'goal', text: scorer.name, teamId });
      this.spawnGoalConfetti(teamId);

      const HAPPY  = ['🎉', '😄', '🔥', '😎', '🤩', '💪', '😜', '🙌', '👏'];
      const UPSET  = ['😡', '😤', '😢', '😭', '🤦', '💔', '😩', '🤬', '😠'];

      const shuffled = <T>(arr: T[]) => [...arr].sort(() => Math.random() - 0.5);

      // 3–4 random players per team show emotes at staggered intervals
      const scorerShow   = shuffled(scorer.players).slice(0, 3 + Math.floor(Math.random() * 2));
      const concederShow = shuffled(conceder.players).slice(0, 3 + Math.floor(Math.random() * 2));

      for (const p of scorer.players) p.showCelebration();
      for (const p of conceder.players) p.showDisappointment();

      for (let i = 0; i < scorerShow.length; i++) {
        const emote = HAPPY[Math.floor(Math.random() * HAPPY.length)];
        scorerShow[i].showEmote(emote, i * 160);
      }
      for (let i = 0; i < concederShow.length; i++) {
        const emote = UPSET[Math.floor(Math.random() * UPSET.length)];
        concederShow[i].showEmote(emote, i * 200 + 120);
      }
    };
    this.matchManager.onReset = () => {
      if (this.advTeamId) {
        // Goal scored during advantage → end match after goal animation
        this.endAdvantage();
      } else {
        this.resetPositions();
      }
    };
    this.matchManager.onFinished = () => {
      this.scoreboard.showFinished(!!this.setup?.onMatchEnd);
      this.emitLiveUpdate('Fim de jogo', { type: 'finished' });
      this.showStatsOverlay();
      if (this.setup?.autoFinishDelayMs !== undefined) {
        this.time.delayedCall(this.setup.autoFinishDelayMs, () => this.deliverMatchEnd());
      }
    };
    this.matchManager.onHalftime = () => {
      this.scoreboard.logEvent(`45' — Intervalo`);
      this.emitLiveUpdate('Intervalo', { type: 'halftime' });
      this.showHalftimeBanner();
    };
    this.matchManager.onHalftimeEnd = () => {
      this.emitLiveUpdate(undefined, { type: 'halftime-end' });
      this.swapSides();
      this.resetPlayersToKickoffShape();
      this.ball.release();
      this.ball.setPosition(FIELD.centerX, FIELD.centerY);
      this.ball.velocity = { x: 0, y: 0 };
      this.ball.resetFlight();
      this.giveKickoff('teamB');
    };
    this.matchManager.onTimeUp = () => {
      const ballHolder = this.allPlayers().find(p => p.hasBall);
      // Ball in the air: fall back to last player who touched it
      const lastToucher = !ballHolder && this.ball.kickedById
        ? this.allPlayers().find(p => p.id === this.ball.kickedById) ?? null
        : null;
      const referencePlayer = ballHolder ?? lastToucher;
      if (!referencePlayer || !this.isInAttackingHalf(referencePlayer)) {
        this.matchManager.forceFinish();
        return;
      }
      // Ball (or last toucher's team) is in the attacking half — keep playing until ball crosses center
      this.advTeamId = referencePlayer.teamId;
      this.advPrevBallX = this.ball.x;
      const baseMin = this.matchManager.half === 1 ? 45 : 90;
      this.advText = this.add.text(GAME_WIDTH / 2, HUD_HEIGHT + 4, `⏱ ${baseMin}' — Vantagem de ataque`, {
        fontSize: '13px',
        fontStyle: 'bold',
        fontFamily: 'Nunito',
        color: '#fbbf24',
        stroke: '#000000',
        strokeThickness: 2,
        resolution: 2,
      }).setOrigin(0.5, 0).setDepth(25);
    };
  }

  // ──────────────────────────────────────────────
  // Field drawing
  // ──────────────────────────────────────────────

  private updateSpectator(): void {
    const s = this.spectatorLatestState;
    if (!s) return;

    // Sync scoreboard data
    this.matchManager.scoreA = s.scoreHome;
    this.matchManager.scoreB = s.scoreAway;
    this.matchManager.spectatorClockOverride = s.clock;
    this.matchManager.state = s.phase as import('../systems/MatchManager').MatchState;
    this.scoreboard.update();

    // Apply player positions and visuals
    if (s.replay) {
      this.ball.setPosition(s.replay.ball.x, s.replay.ball.y);
      this.ball.velocity = { x: s.replay.ball.vx, y: s.replay.ball.vy };

      for (const pd of s.replay.players) {
        const p = this.playerById.get(pd.id);
        if (!p) continue;
        p.applySpectatorFrame(pd);
        p.updateLabelAlpha(s.replay.ball.x, s.replay.ball.y);
      }
    }

    // Process one-shot events (goal, halftime, finished)
    if (s.event && s.updatedAt !== this.spectatorLastEventAt) {
      this.spectatorLastEventAt = s.updatedAt;
      const ev = s.event;
      if (ev.type === 'goal' && ev.teamId) {
        this.scoreboard.showGoalBanner(ev.text ?? '');
        this.spawnGoalConfetti(ev.teamId);
        const teamPlayers = ev.teamId === 'teamA' ? this.teamA.players : this.teamB.players;
        const otherPlayers = ev.teamId === 'teamA' ? this.teamB.players : this.teamA.players;
        for (const p of teamPlayers) p.showCelebration();
        for (const p of otherPlayers) p.showDisappointment();
      } else if (ev.type === 'halftime') {
        this.showHalftimeBanner();
      } else if (ev.type === 'finished') {
        this.scoreboard.showFinished(false);
      }
    }
  }

  private emitLiveUpdate(eventText?: string, event?: import('../../draft/MultiplayerLobby').SpectatorEvent): void {
    if (!this.setup?.onLiveUpdate || !this.matchManager) return;
    this.setup.onLiveUpdate({
      scoreA: this.matchManager.scoreA,
      scoreB: this.matchManager.scoreB,
      clock: this.matchManager.getTimeString(),
      phase: this.matchManager.state,
      eventText,
      event,
      replay: {
        ball: { x: this.ball.x, y: this.ball.y, vx: this.ball.velocity.x, vy: this.ball.velocity.y },
        players: this.allPlayers().map((p) => {
          const dir = p.getCarryDir();
          return {
            id: p.id,
            name: p.playerName,
            jerseyNumber: p.jerseyNumber,
            teamId: p.teamId as 'teamA' | 'teamB',
            x: p.x,
            y: p.y,
            hasBall: p.hasBall,
            stamina: p.currentStamina,
            sprintMs: p.sprintMs,
            dirX: dir.x,
            dirY: dir.y,
            state: p.state,
          };
        }),
      },
    });
  }

  private deliverMatchEnd(): void {
    if (this.matchEndDelivered) return;
    this.matchEndDelivered = true;
    this.setup?.onMatchEnd?.(this.matchManager.scoreA, this.matchManager.scoreB);
  }

  private drawField(): void {
    const g = this.add.graphics().setDepth(0);
    const pitchW = FIELD.right - FIELD.left;
    const pitchH = FIELD.bottom - FIELD.top;
    const penaltyW = PENALTY_AREA_W;
    const penaltyH = PENALTY_AREA_H;
    const goalAreaW = GOAL_AREA_W;
    const goalAreaH = GOAL_AREA_H;
    const penaltySpotOffset = 125; // 11m/105m × 1160 — real penalty spot distance

    // Outer area (slightly darker to frame the pitch)
    g.fillStyle(0x154d15);
    g.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // Main pitch base — lighter green
    g.fillStyle(0x2e8b2e);
    g.fillRect(FIELD.left, FIELD.top, pitchW, pitchH);

    // Vertical mowed stripes — 14 bands, two alternating shades
    const stripeCount = 14;
    for (let i = 0; i < stripeCount; i++) {
      const sx = FIELD.left + (pitchW / stripeCount) * i;
      const sw = pitchW / stripeCount;
      if (i % 2 === 0) {
        g.fillStyle(0x1f6e1f, 0.62);  // darker
      } else {
        g.fillStyle(0x3B7D40, 0.54);  // lighter
      }
      g.fillRect(sx, FIELD.top, sw, pitchH);
    }

    // Inner-edge shadow — subtle vignette to give the pitch depth
    g.fillStyle(0x000000, 0.08);
    g.fillRect(FIELD.left, FIELD.top, pitchW, 18);         // top
    g.fillRect(FIELD.left, FIELD.bottom - 18, pitchW, 18); // bottom
    g.fillRect(FIELD.left, FIELD.top, 18, pitchH);         // left
    g.fillRect(FIELD.right - 18, FIELD.top, 18, pitchH);   // right
    g.fillStyle(0x000000, 0.04);
    g.fillRect(FIELD.left, FIELD.top, pitchW, 8);
    g.fillRect(FIELD.left, FIELD.bottom - 8, pitchW, 8);
    g.fillRect(FIELD.left, FIELD.top, 8, pitchH);
    g.fillRect(FIELD.right - 8, FIELD.top, 8, pitchH);

    // White lines
    g.lineStyle(2, 0xffffff, 0.9);
    g.strokeRect(FIELD.left, FIELD.top, pitchW, pitchH);

    // Center line
    g.beginPath(); g.moveTo(FIELD.centerX, FIELD.top); g.lineTo(FIELD.centerX, FIELD.bottom); g.strokePath();

    // Center circle & dot
    g.strokeCircle(FIELD.centerX, FIELD.centerY, CENTER_CIRCLE_RADIUS);
    g.fillStyle(0xffffff);
    g.fillCircle(FIELD.centerX, FIELD.centerY, 4);

    // Penalty areas
    g.lineStyle(2, 0xffffff, 0.9);
    g.strokeRect(FIELD.left, FIELD.centerY - penaltyH / 2, penaltyW, penaltyH);
    g.strokeRect(FIELD.right - penaltyW, FIELD.centerY - penaltyH / 2, penaltyW, penaltyH);

    // Goal areas
    g.strokeRect(FIELD.left, FIELD.centerY - goalAreaH / 2, goalAreaW, goalAreaH);
    g.strokeRect(FIELD.right - goalAreaW, FIELD.centerY - goalAreaH / 2, goalAreaW, goalAreaH);

    // Penalty spots
    g.fillStyle(0xffffff);
    g.fillCircle(FIELD.left + penaltySpotOffset, FIELD.centerY, 3);
    g.fillCircle(FIELD.right - penaltySpotOffset, FIELD.centerY, 3);

    // Penalty arc ("D") — radius 9.15m = 9.15/105 × 1160 ≈ 101px, centered on penalty spot.
    // Only the portion that lies OUTSIDE the penalty area is drawn.
    // The arc crosses the penalty-area edge at ±arccos(distToEdge / arcRadius).
    const penaltyArcR = 101;
    // Distance from penalty spot to the far edge of the penalty area
    const spotToBoxEdge = penaltyW - penaltySpotOffset; // 182 - 125 = 57px
    const dAngle = Math.acos(spotToBoxEdge / penaltyArcR); // ≈ 0.968 rad (≈ 55°)
    g.lineStyle(2, 0xffffff, 0.9);
    // Left D: arc bulges rightward (toward center); angles ±dAngle around 0 (= right direction)
    g.beginPath();
    g.arc(FIELD.left + penaltySpotOffset, FIELD.centerY, penaltyArcR, -dAngle, dAngle, false);
    g.strokePath();
    // Right D: arc bulges leftward (toward center); angles around π (= left direction)
    g.beginPath();
    g.arc(FIELD.right - penaltySpotOffset, FIELD.centerY, penaltyArcR, Math.PI - dAngle, Math.PI + dAngle, false);
    g.strokePath();

    // Corner arcs (quarter circles of radius 9.15m ≈ 9.15/68 × 668 → ~90px, but visually ~22px is standard)
    const cornerR = 22;
    // Top-left
    g.beginPath(); g.arc(FIELD.left, FIELD.top, cornerR, 0, Math.PI * 0.5, false); g.strokePath();
    // Top-right
    g.beginPath(); g.arc(FIELD.right, FIELD.top, cornerR, Math.PI * 0.5, Math.PI, false); g.strokePath();
    // Bottom-right
    g.beginPath(); g.arc(FIELD.right, FIELD.bottom, cornerR, Math.PI, Math.PI * 1.5, false); g.strokePath();
    // Bottom-left
    g.beginPath(); g.arc(FIELD.left, FIELD.bottom, cornerR, Math.PI * 1.5, Math.PI * 2, false); g.strokePath();

    // Goals
    g.fillStyle(0xffffff, 0.2);
    g.fillRect(0, GOAL_LEFT.top, FIELD.left, GOAL_HEIGHT);
    g.lineStyle(3, 0xffffff, 1);
    g.strokeRect(0, GOAL_LEFT.top, FIELD.left, GOAL_HEIGHT);

    g.fillStyle(0xffffff, 0.2);
    g.fillRect(FIELD.right, GOAL_RIGHT.top, GAME_WIDTH - FIELD.right, GOAL_HEIGHT);
    g.strokeRect(FIELD.right, GOAL_RIGHT.top, GAME_WIDTH - FIELD.right, GOAL_HEIGHT);

    // Goal posts (solid white rectangles for visibility)
    g.fillStyle(0xffffff);
    g.fillRect(FIELD.left - 3, GOAL_LEFT.top - 3, 6, 6);
    g.fillRect(FIELD.left - 3, GOAL_LEFT.bottom - 3, 6, 6);
    g.fillRect(FIELD.right - 3, GOAL_RIGHT.top - 3, 6, 6);
    g.fillRect(FIELD.right - 3, GOAL_RIGHT.bottom - 3, 6, 6);

    // HUD strip
    this.add.rectangle(GAME_WIDTH / 2, HUD_HEIGHT / 2 - 2, GAME_WIDTH, HUD_HEIGHT, 0x0f172a, 0.95).setDepth(18);
  }

  // ──────────────────────────────────────────────
  // Ball bounds & goal detection
  // ──────────────────────────────────────────────

  private handleBallBounds(): void {
    const b = this.ball;
    const gt = GOAL_LEFT.top, gb = GOAL_LEFT.bottom;

    if (b.y < FIELD.top && b.velocity.y < 0) {
      b.y = FIELD.top;
      this.reboundBallFromWall('horizontal');
    }
    if (b.y > FIELD.bottom && b.velocity.y > 0) {
      b.y = FIELD.bottom;
      this.reboundBallFromWall('horizontal');
    }
    if (b.x < FIELD.left && !(b.y > gt && b.y < gb) && b.velocity.x < 0) {
      b.x = FIELD.left;
      this.reboundBallFromWall('vertical');
    }
    if (b.x > FIELD.right && !(b.y > gt && b.y < gb) && b.velocity.x > 0) {
      b.x = FIELD.right;
      this.reboundBallFromWall('vertical');
    }
  }

  private reboundBallFromWall(axis: 'horizontal' | 'vertical'): void {
    const oldTarget = this.ball.targetPlayer as Player | null;
    if (oldTarget) oldTarget.state = PlayerState.FindSpace;
    this.ball.targetPlayer = null;

    const speed = this.ball.getSpeed();
    if (speed < 0.05) return;

    const reflectedX = axis === 'vertical' ? -this.ball.velocity.x : this.ball.velocity.x;
    const reflectedY = axis === 'horizontal' ? -this.ball.velocity.y : this.ball.velocity.y;
    const spin = (Math.random() - 0.5) * 0.22;
    const angle = Math.atan2(reflectedY, reflectedX) + spin;
    const reboundSpeed = clamp(speed * BALL_PHYSICS.wallRestitution, 0, BALL_PHYSICS.maxWallReboundSpeed);

    this.ball.velocity.x = Math.cos(angle) * reboundSpeed;
    this.ball.velocity.y = Math.sin(angle) * reboundSpeed;
    this.ball.spin = spin * 0.85 + Math.sign(reboundSpeed || 1) * 0.045;
    this.recalculateRoutesAfterBallTrajectoryChange(oldTarget);
  }

  private checkGoal(): boolean {
    if (this.ball.owner) return false;
    const { x, y } = this.ball;
    if (x < GOAL_LINE_LEFT && y > GOAL_LEFT.top && y < GOAL_LEFT.bottom) {
      // Who attacks GOAL_LEFT (attackDirection < 0)?
      const scorer = this.teamA.attackDirection < 0 ? 'teamA' : 'teamB';
      this.matchManager.goalScored(scorer);
      return true;
    }
    if (x > GOAL_LINE_RIGHT && y > GOAL_RIGHT.top && y < GOAL_RIGHT.bottom) {
      // Who attacks GOAL_RIGHT (attackDirection > 0)?
      const scorer = this.teamA.attackDirection > 0 ? 'teamA' : 'teamB';
      this.matchManager.goalScored(scorer);
      return true;
    }
    return false;
  }

  // ──────────────────────────────────────────────
  // Player action execution
  // ──────────────────────────────────────────────

  private processPlayerActions(): void {
    for (const p of this.allPlayers()) {
      if (!p.hasBall) continue;

      if (p.state === PlayerState.Pass && p.passTarget) {
        // Wait until player reaches their pre-pass movement target
        const dx = p.x - p.targetX;
        const dy = p.y - p.targetY;
        const distToTarget = Math.sqrt(dx * dx + dy * dy);
        if (distToTarget < 12) {
          this.doPass(p, p.passTarget);
          p.passTarget = null;
        }
        // else: keep walking toward pre-pass position

      } else if (p.state === PlayerState.Shoot) {
        this.doShot(p);

      } else if (p.state === PlayerState.Clearance) {
        const dx = p.x - p.targetX;
        const dy = p.y - p.targetY;
        if (Math.sqrt(dx * dx + dy * dy) < 14) {
          this.doClearance(p);
        }

      } else if (p.state === PlayerState.Dribble && p.dribbleTarget) {
        const blocker = p.dribbleTarget as Player;
        const blockerDist = dist(p.x, p.y, blocker.x, blocker.y);
        const targetDist = dist(p.x, p.y, p.targetX, p.targetY);
        if (blockerDist < p.dribbleContactRadius && p.dribbleCommitMs <= 0) {
          this.doDribble(p, blocker);
        } else if (targetDist < 12 && p.dribbleCommitMs <= 0) {
          p.dribbleTarget = null;
          p.dribbleContactRadius = 38;
          p.state = PlayerState.CarryBall;
          p.aiCooldown = 0;
        }
      }
    }
  }

  private doPass(passer: Player, receiver: Player): void {
    this.stats.recordPass(passer.teamId);
    passer.hasBall = false;
    this.ball.release();
    passer.state = PlayerState.FindSpace;
    passer.aiCooldown = 600;

    const intendedX = passer.passTargetX ?? receiver.x;
    const intendedY = passer.passTargetY ?? receiver.y;
    const passKind = passer.passKind;
    const isThroughPass = passKind === 'through';
    const isCross = passKind === 'cross';
    const isCutback = passKind === 'cutback';
    const passDist = dist(passer.x, passer.y, intendedX, intendedY);
    const passLane = this.analyzeBallLane(
      passer.x,
      passer.y,
      intendedX,
      intendedY,
      this.allPlayers().filter(p => p !== passer && p !== receiver),
      passer.teamId,
    );
    const targetFrames = clamp(passDist / 10.2, 18, 48);
    // statMult range 0.52–0.76: poor passers underpowered on long balls; elite passers thread anything
    const statMult = 0.52 + (passer.stats.passing / 100) * 0.24;
    // Whipped Pass: harder, faster crosses and cutbacks (+0.14 power regular, +0.10 extra for Plus)
    const whippedBoost = (isCross || isCutback) ? traitBonus(passer, TRAITS.WHIPPED_PASS, 0.14, 0.10) : 0;
    const servicePower = (isCross ? 1.24 : isCutback ? 0.96 : isThroughPass ? 1.14 : 1.0) + whippedBoost;
    // Friction-corrected v0: exact initial velocity to cover passDist in targetFrames
    // under the same per-frame friction used by Ball.updateBall. Formula: v0 = D*(1-f)/(1-f^n)
    const PASS_FRICTION = BALL_FRICTION;
    const baseVelocity = passDist * (1 - PASS_FRICTION) / (1 - Math.pow(PASS_FRICTION, targetFrames));
    const lanePowerBoost = 1 + passLane.risk * (isCross ? 0.05 : isCutback ? 0.04 : 0.09);
    const power = clamp(baseVelocity * statMult * servicePower * lanePowerBoost, 2.1, 14.0);

    // Angular accuracy: same angular error = larger positional miss at distance.
    // passing reduces base error; pressure and stamina add noise; pass kind adds extra spread.
    const opponents = passer.teamId === 'teamA' ? this.teamB.players : this.teamA.players;
    let minOppDist = Infinity;
    for (const opp of opponents) {
      const d = dist(opp.x, opp.y, passer.x, passer.y);
      if (d < minOppDist) minOppDist = d;
    }
    const pressure = clamp((60 - minOppDist) / 60, 0, 1);
    const kindExtra = isThroughPass ? 2.0 : isCross ? 2.5 : isCutback ? 0.5 : 0;
    const laneExtra = passLane.risk * (isCutback ? 1.2 : 2.4) * (1 - passer.stats.passing / 140);
    const maxDevDeg = (1 - passer.stats.passing / 100) * 4.5
      + pressure * 3.5
      + (1 - passer.getStaminaFactor()) * 1.5
      + kindExtra
      + laneExtra;
    const maxDevRad = Phaser.Math.DegToRad(maxDevDeg);
    const deviation = (Math.random() - 0.5) * 2 * maxDevRad;
    const baseAngle = Math.atan2(intendedY - passer.y, intendedX - passer.x);
    const laneAvoidDeg = passLane.blocker
      ? clamp((CONTACT_RADIUS + 18 - passLane.nearestDist) / 18, 0, 1)
          * clamp(4.2 - passer.stats.passing * 0.018, 1.2, 4.2)
          * (0.6 + passLane.risk * 0.4)
      : 0;
    const actualAngle = baseAngle + deviation + Phaser.Math.DegToRad(laneAvoidDeg) * passLane.openSide;
    const destX = clamp(passer.x + Math.cos(actualAngle) * passDist, FIELD.left + 15, FIELD.right - 15);
    const destY = clamp(passer.y + Math.sin(actualAngle) * passDist, FIELD.top  + 15, FIELD.bottom - 15);
    const kickAngle = Math.atan2(destY - passer.y, destX - passer.x);

    const lift = isCross ? 4.1 : isThroughPass ? 1.4 : isCutback ? 0.35 : 0.65;
    const spin = (passLane.openSide || 1) * (0.035 + power * (isCross ? 0.014 : 0.010));
    this.ball.kickTo(destX, destY, power, passer.id, { lift, spin });
    passer.showShotPulse(this.ball.x, this.ball.y, power);
    this.ball.targetPlayer = receiver;
    receiver.state = PlayerState.ReceivePass;
    receiver.recentPassFromId = passer.id;
    receiver.recentPassCooldownMs = 1900;
    const receiverOppTeam = receiver.teamId === 'teamA' ? this.teamB : this.teamA;
    const receiverReception = this.planReceptionTarget(receiver, receiverOppTeam.getNearestPlayerTo(receiver.x, receiver.y));
    receiver.setTarget(receiverReception.x, receiverReception.y);
    this.applyKickFollowThrough(passer, kickAngle, 0.75);
    const attackDir = passer.attackDirection;
    const peelSide = passer.y < FIELD.centerY ? -1 : 1;
    const space = this.findOpenSpaceAfterPass(passer);
    if (space) {
      passer.setTarget(space.tx, space.ty);
      // Wall-pass positioning: outfield passers sprint into space so they're ready
      // to receive the return (1-2 combination). Skip for GK and defenders recycling.
      const isAttackingRole = passer.role === PlayerRole.Striker
        || passer.role === PlayerRole.Winger
        || passer.role === PlayerRole.Midfielder;
      const runningForward = (space.tx - passer.x) * attackDir > 40;
      if (isAttackingRole && runningForward) {
        passer.requestSprint(520, 50);
      }
    } else {
      passer.setTarget(
        clamp(passer.x - attackDir * 34, FIELD.left + 15, FIELD.right - 15),
        clamp(passer.y + peelSide * 78, FIELD.top + 20, FIELD.bottom - 20),
      );
    }
    if (isThroughPass || isCross || isCutback) receiver.requestSprint(isCross ? 650 : 900, 60);
    this.lastPassWasCross = isCross;
    passer.passTargetX = null;
    passer.passTargetY = null;
    passer.passKind = 'normal';

    this.scoreboard.logEvent(
      isThroughPass
        ? `${passer.playerName} enfia para ${receiver.playerName}`
        : isCross
          ? `${passer.playerName} cruza para ${receiver.playerName}`
          : isCutback
            ? `${passer.playerName} toca atrás para ${receiver.playerName}`
        : `${passer.playerName} → ${receiver.playerName}`,
    );
  }

  private doShot(shooter: Player): void {
    const isTeamA = shooter.teamId === 'teamA';
    const ownTeamShooter = isTeamA ? this.teamA : this.teamB;
    const targetGoal = ownTeamShooter.attackDirection > 0 ? GOAL_RIGHT : GOAL_LEFT;
    const oppTeam   = isTeamA ? this.teamB  : this.teamA;
    const goalkeeper = oppTeam.players.find(p => p.role === PlayerRole.Goalkeeper);
    if (!goalkeeper) return;

    shooter.hasBall = false;
    this.ball.release();
    shooter.state = PlayerState.FindSpace;
    shooter.aiCooldown = 700;

    const shotDist = dist(shooter.x, shooter.y, targetGoal.centerX, FIELD.centerY);
    const shootingSkill = shooter.stats.shooting / 100;
    const physicalPower = shooter.stats.physical / 100;
    const elitePowerBonus = Math.pow(shootingSkill, 1.7) * 1.85
      + Math.pow(physicalPower, 1.45) * 1.35;
    const maxShotPower = SHOT_MAX_POWER + clamp(elitePowerBonus, 0, SHOT_ELITE_MAX_POWER_BONUS);
    const distanceFactor = clamp(
      (shotDist - SHOT_DISTANCE_POWER_START) / (SHOT_DISTANCE_POWER_FULL - SHOT_DISTANCE_POWER_START),
      0,
      1,
    );
    let power = clamp(
      SHOT_BASE_POWER
        + shootingSkill * SHOT_STAT_POWER
        + physicalPower * 1.15
        + distanceFactor * SHOT_DISTANCE_POWER,
      SHOT_MIN_POWER,
      maxShotPower,
    );

    // Pressure from nearest opponent
    const nearestOpp = oppTeam.getNearestPlayerTo(shooter.x, shooter.y);
    const normalPressure = nearestOpp
      ? clamp((60 - nearestOpp.distanceTo(shooter)) / 60, 0, 1)
      : 0;
    const gkClosePressure = clamp((155 - goalkeeper.distanceTo(shooter)) / 155, 0, 1)
      * clamp((230 - shotDist) / 230, 0, 1);
    const pressure = clamp(normalPressure + gkClosePressure * 0.85, 0, 1.35);

    // How wide the shooter's angle is: lateral/forward ratio (0=straight, >1=very wide)
    const shooterLateral = Math.abs(shooter.y - FIELD.centerY);
    const shooterDepth   = Math.abs(shooter.x - targetGoal.centerX) + 1;
    const wideness = clamp(shooterLateral / shooterDepth, 0, 2.5);
    // From a tight angle only the near-post half of the goal is realistically reachable.
    // narrowFactor: 0 = straight on (full goal), 0.72 = extreme byline (near-post quarter).
    const narrowFactor = clamp((wideness - 0.4) / 1.6, 0, 0.72);
    const nearPostY = shooter.y < FIELD.centerY ? targetGoal.top : targetGoal.bottom;
    const farPostY  = shooter.y < FIELD.centerY ? targetGoal.bottom : targetGoal.top;
    const goalMid   = (targetGoal.top + targetGoal.bottom) / 2;
    // Compress the aim window toward the near post for wide shots
    const aimLow  = Math.min(nearPostY, farPostY) + 5 + (nearPostY > farPostY ? narrowFactor * (goalMid - targetGoal.top) : 0);
    const aimHigh = Math.max(nearPostY, farPostY) - 5 - (nearPostY < farPostY ? narrowFactor * (targetGoal.bottom - goalMid) : 0);
    // GK-aware aiming: read the open side of the goal and aim there.
    // Intelligence controls how accurately the player reads the GK's position.
    // Shooting skill already drives execution precision via maxDevDeg below.
    const intelligenceFactor = shooter.stats.intelligence / 100;
    const gkInWindow = clamp(goalkeeper.y, aimLow, aimHigh);
    const topGap = gkInWindow - aimLow;   // open space above GK
    const botGap = aimHigh - gkInWindow;  // open space below GK
    const betterTopGap = topGap >= botGap;
    const bestGap = Math.max(topGap, botGap);
    const cornerIntent = clamp(
      0.16
        + shootingSkill * 0.52
        + intelligenceFactor * 0.26
        + shooter.stats.physical / 100 * 0.08
        - pressure * 0.18
        - (1 - shooter.getStaminaFactor()) * 0.22,
      0.10,
      0.92,
    );
    const minimumCornerGap = 22;
    const cornerPadding = clamp(7 + (1 - shootingSkill) * 12 + pressure * 7, 6, 24);
    const cornerOffset = clamp(
      bestGap * (1 - cornerIntent),
      cornerPadding,
      Math.max(cornerPadding, bestGap - minimumCornerGap),
    );
    const openSideAimY = betterTopGap
      ? aimLow + cornerOffset
      : aimHigh - cornerOffset;
    const centerGapAimY = betterTopGap
      ? aimLow + bestGap * 0.48
      : aimHigh - bestGap * 0.48;
    const deliberateCornerChance = clamp(
      0.18 + shootingSkill * 0.50 + intelligenceFactor * 0.22 - pressure * 0.20,
      0.08,
      0.88,
    );
    const smartAimY = Math.random() < deliberateCornerChance ? openSideAimY : centerGapAimY;
    // Low intelligence → drifts toward a naive random aim; high → stays on the open side
    // blendWeight: 0.18 (int=0) → 0.83 (int=100)
    const naiveAimY = aimLow + Math.random() * (aimHigh - aimLow);
    const blendWeight = clamp(0.14 + shootingSkill * 0.46 + intelligenceFactor * 0.34 - pressure * 0.12, 0.12, 0.90);
    let aimY = smartAimY * blendWeight + naiveAimY * (1 - blendWeight);
    const shotBlockers = this.allPlayers().filter(p => p !== shooter && p !== goalkeeper);
    let selectedShotLane = this.analyzeBallLane(
      shooter.x,
      shooter.y,
      targetGoal.centerX,
      aimY,
      shotBlockers,
      shooter.teamId,
    );
    let bestAimScore = -selectedShotLane.risk * 42 - selectedShotLane.blockers * 4;
    const candidateAimYs = [
      openSideAimY,
      centerGapAimY,
      aimLow + (aimHigh - aimLow) * 0.22,
      aimLow + (aimHigh - aimLow) * 0.50,
      aimLow + (aimHigh - aimLow) * 0.78,
    ];
    for (const candidateY of candidateAimYs) {
      const candidateLane = this.analyzeBallLane(
        shooter.x,
        shooter.y,
        targetGoal.centerX,
        candidateY,
        shotBlockers,
        shooter.teamId,
      );
      const aimCost = Math.abs(candidateY - aimY) * (0.030 + (1 - shootingSkill) * 0.020);
      const cornerValue = Math.abs(candidateY - goalMid) / (GOAL_HEIGHT / 2) * (4 + shootingSkill * 4);
      const score = -candidateLane.risk * 42 - candidateLane.blockers * 4 - aimCost + cornerValue;
      if (score > bestAimScore) {
        bestAimScore = score;
        aimY = candidateY;
        selectedShotLane = candidateLane;
      }
    }

    // Angular accuracy: same angular error produces larger positional miss at distance
    // intelligence + physical reduce how much pressure disturbs the shot
    const pressureResist = clamp(
      shooter.stats.intelligence * 0.002 + shooter.stats.physical * 0.002,
      0, 0.40,
    );
    // Clinical: tighter finish in the box (−1.8° regular, −1.2° extra for Plus)
    const clinicalBonus = shotDist < 220 ? traitBonus(shooter, TRAITS.CLINICAL, 1.8, 1.2) : 0;
    // Long Shot: better accuracy on attempts beyond normal range (−1.4° regular, −1.0° extra for Plus)
    const longShotBonus = shotDist > 250 ? traitBonus(shooter, TRAITS.LONG_SHOT, 1.4, 1.0) : 0;
    const maxDevDeg = Math.max(0.4,
      (1 - shootingSkill) * 7.5
      + pressure * 5.5 * (1 - pressureResist)
      + selectedShotLane.risk * 3.2 * (1 - shootingSkill * 0.55)
      + (1 - shooter.getStaminaFactor()) * 2.5
      - clinicalBonus
      - longShotBonus,
    );
    const maxDevRad = Phaser.Math.DegToRad(maxDevDeg);
    const baseAngle = Math.atan2(aimY - shooter.y, targetGoal.centerX - shooter.x);
    const deviation = (Math.random() - 0.5) * 2 * maxDevRad;
    const actualY   = shooter.y + (targetGoal.centerX - shooter.x) * Math.tan(baseAngle + deviation);

    // Physical save check: can the GK cross |actualY – gk.y| before ball arrives?
    // Use actual shot distance (to actualY, not FIELD.centerY) for accuracy on corner shots.
    const actualShotDist = dist(shooter.x, shooter.y, targetGoal.centerX, actualY);
    // GK rushes at sprint speed — include stamina so tired GKs cover less ground.
    const gkSpeed = (goalkeeper.stats.speed / 100) * 1.85 * 1.28
                  * (0.9 + goalkeeper.stats.defending / 100 * 0.2)
                  * goalkeeper.getStaminaFactor();
    const gkDistNeeded   = Math.abs(actualY - goalkeeper.y);
    const inGoal = actualY > targetGoal.top && actualY < targetGoal.bottom;
    const safeY  = clamp(actualY, FIELD.top + 20, FIELD.bottom - 20);
    const finalShotLane = this.analyzeBallLane(
      shooter.x,
      shooter.y,
      targetGoal.centerX,
      safeY,
      shotBlockers,
      shooter.teamId,
    );
    power = clamp(power * (1 + finalShotLane.risk * 0.06), SHOT_MIN_POWER, maxShotPower + 0.7);
    const travelFrames = actualShotDist / (power * 0.82);
    const gkCanCover = gkSpeed * travelFrames * (1 + gkClosePressure * 0.55);

    const shotLift = clamp(1.0 + distanceFactor * 1.45 + finalShotLane.risk * 0.55, 0.8, 3.1);
    const shotSpin = finalShotLane.openSide * (0.045 + power * 0.012 + shootingSkill * 0.035);
    this.ball.kickTo(targetGoal.centerX, safeY, inGoal ? power : power * 0.9, shooter.id, {
      lift: shotLift,
      spin: shotSpin,
    });
    this.gkDiveHoldoffMs = 18;
    this.applyKickFollowThrough(shooter, Math.atan2(safeY - shooter.y, targetGoal.centerX - shooter.x), 1.05);
    shooter.showShotPulse(this.ball.x, this.ball.y, power);

    const easySaveRange = 24 + (gkShotStoppingQuality(goalkeeper) / 100) * 18;
    const normalSave = inGoal && gkDistNeeded < Math.min(gkCanCover, easySaveRange);
    this.stats.recordShot(shooter.teamId, inGoal, false);

    if (normalSave) {
      // saveX anchored to the GK's CURRENT position (not baseX) so the dive is purely lateral.
      const saveX  = clamp(goalkeeper.x, FIELD.left + 15, FIELD.right - 15);
      const saveY = clamp(actualY, targetGoal.top + 10, targetGoal.bottom - 10);
      this.ball.targetPlayer = goalkeeper;
      goalkeeper.stretchSave = false;
      goalkeeper.state = PlayerState.ReceivePass;
      goalkeeper.setTarget(saveX, saveY);
      goalkeeper.requestSprint(travelFrames * 16.67 + 500);

      this.scoreboard.logEvent(`${shooter.playerName} chuta — Defesa!`);
    } else if (inGoal) {
      this.scoreboard.logEvent(`${shooter.playerName} chuta!`);
    } else {
      this.scoreboard.logEvent(`${shooter.playerName} chuta — Fora!`);
    }
  }

  private updateGoalkeeperDives(): void {
    if (this.gkDiveHoldoffMs > 0) return;
    if (this.ball.owner) return;

    const speed = this.ball.getSpeed();
    const target = this.ball.targetPlayer as Player | null;
    if (target?.role === PlayerRole.Goalkeeper) return;
    if (speed < 4.4) return;

    const targetedThreat = !!target
      && (speed >= GK_DIVE_MIN_TARGETED_THREAT_SPEED
        || (this.lastPassWasCross && speed >= GK_DIVE_MIN_CROSS_THREAT_SPEED));
    if (target && !targetedThreat) return;

    this.gkDiveDebugGfx.clear();

    this.tryGoalkeeperDive(this.teamA, this.teamA.attackDirection > 0 ? GOAL_LEFT : GOAL_RIGHT, target);
    this.tryGoalkeeperDive(this.teamB, this.teamB.attackDirection > 0 ? GOAL_LEFT : GOAL_RIGHT, target);
  }

  private tryGoalkeeperDive(team: Team, ownGoal: GoalBounds, previousTarget: Player | null = null): void {
    const gk = team.players.find(p => p.role === PlayerRole.Goalkeeper);
    if (!gk || gk.hasBall || gk.state === PlayerState.GkDive || gk.currentStamina < 10) return;

    const lineX = ownGoal.centerX < FIELD.centerX ? GOAL_LINE_LEFT : GOAL_LINE_RIGHT;
    const vx = this.ball.velocity.x;
    if ((lineX < FIELD.centerX && vx >= -0.7) || (lineX > FIELD.centerX && vx <= 0.7)) return;

    const framesToGoal = this.findBallFramesToX(lineX, 140);
    if (framesToGoal === null || framesToGoal <= 0 || framesToGoal > 118) return;

    const projectedAtGoal = this.projectBallAtFrames(framesToGoal);
    const projectedGoalY = projectedAtGoal.y;
    // this.drawGkBallTrajectoryDebug(lineX, projectedGoalY, framesToGoal);
    if (projectedGoalY < ownGoal.top + 4 || projectedGoalY > ownGoal.bottom - 4) return;

    const speedSq = this.ball.velocity.x * this.ball.velocity.x + this.ball.velocity.y * this.ball.velocity.y;
    if (speedSq < 60) return;
    const ballSpeed = Math.sqrt(speedSq);
    const kickDistance = dist(this.ball.lastKickX, this.ball.lastKickY, lineX, projectedGoalY);
    const closeKickPressure = clamp((260 - kickDistance) / 210, 0, 1);
    const farKickRead = clamp((kickDistance - 360) / 420, 0, 1);
    const speedPressure = clamp((ballSpeed - 7.4) / 6.2, 0, 1);
    const ballInOwnTerritory = ownGoal.centerX < FIELD.centerX
      ? this.ball.x < FIELD.centerX
      : this.ball.x > FIELD.centerX;
    const closestFrames = this.findClosestBallFrameToPlayer(gk, framesToGoal);
    const rawQuality = gkShotStoppingQuality(gk) / 100;
    const quality = ballInOwnTerritory ? rawQuality : 0.18;
    const farReachReactionBonus = ballInOwnTerritory ? traitBonus(gk, TRAITS.FAR_REACH, 1.2, 0.8) : 0;
    const reactionFrames = clamp(
      12 - quality * 8 - farReachReactionBonus,
      GK_DIVE_MIN_REACTION_FRAMES,
      12,
    );
    if (closestFrames > GK_DIVE_MAX_REACTION_FRAMES) return;

    const intercept = this.projectBallAtFrames(closestFrames);
    const interceptX = intercept.x;
    const interceptY = intercept.y;
    const diveDistance = dist(gk.x, gk.y, interceptX, interceptY);
    // this.drawGkDiveDebugPoint(gk, interceptX, interceptY);
    const reach = clamp(
      GK_DIVE_BASE_REACH + gk.stats.speed * 0.42 + gk.stats.defending * 0.28 + traitBonus(gk, TRAITS.FAR_REACH, 24, 14),
      GK_DIVE_BASE_REACH,
      GK_DIVE_MAX_REACH,
    ) * gk.getStaminaFactor();

    if (diveDistance < GK_DIVE_MIN_DISTANCE || diveDistance > reach) return;

    const cutDirX = (interceptX - gk.x) / diveDistance;
    const cutDirY = (interceptY - gk.y) / diveDistance;
    const parallelDirY = cutDirY === 0 ? 0 : Math.sign(cutDirY);
    let dirX = cutDirX * (1 - GK_DIVE_PARALLEL_BIAS);
    let dirY = cutDirY * (1 - GK_DIVE_PARALLEL_BIAS) + parallelDirY * GK_DIVE_PARALLEL_BIAS;
    const biasedLen = Math.sqrt(dirX * dirX + dirY * dirY);
    if (biasedLen > 0.001) {
      dirX /= biasedLen;
      dirY /= biasedLen;
    } else {
      dirX = cutDirX;
      dirY = cutDirY;
    }
    const displacement = Math.max(diveDistance + GK_DIVE_OVERSHOOT, GK_DIVE_MIN_DISPLACEMENT);
    const minDiveX = lineX < FIELD.centerX ? FIELD.left - GK_DIVE_GOAL_LINE_MARGIN : FIELD.left + 15;
    const maxDiveX = lineX > FIELD.centerX ? FIELD.right + GK_DIVE_GOAL_LINE_MARGIN : FIELD.right - 15;
    const saveX = clamp(gk.x + dirX * displacement, minDiveX, maxDiveX);
    const saveY = clamp(gk.y + dirY * displacement, FIELD.top + 8, FIELD.bottom - 8);
    const actualDisplacement = dist(gk.x, gk.y, saveX, saveY);
    const diveDurationMs = this.estimateGkDiveDurationMs(gk, actualDisplacement);
    const diveFrames = diveDurationMs / 16.67;
    const interceptTravelRatio = clamp(diveDistance / Math.max(actualDisplacement, 1), 0.42, 0.88);
    const framesToReachIntercept = diveFrames * interceptTravelRatio;
    const timingLeadFrames = clamp(
      0.3
        + quality * 1.8
        + farKickRead * 0.7
        + (ballInOwnTerritory ? traitBonus(gk, TRAITS.FAR_REACH, 0.35, 0.2) : 0)
        - reactionFrames * 0.12
        - closeKickPressure * 0.7
        - speedPressure * 0.45,
      0.1,
      2.4,
    );
    if (closestFrames > framesToReachIntercept + timingLeadFrames) return;

    const lateGraceFrames = clamp(3 + quality * 7 - closeKickPressure * 1.4 - speedPressure * 1.1, 1.4, 9.5);
    const emergencyCloseShot = framesToGoal < 18 && diveDistance < reach * (0.72 + quality * 0.20);
    if (closestFrames + lateGraceFrames < framesToReachIntercept && !emergencyCloseShot) return;

    // this.drawGkDiveDebugPoint(gk, interceptX, interceptY, saveX, saveY);
    if (previousTarget && previousTarget !== gk && !previousTarget.hasBall) {
      previousTarget.state = PlayerState.FindSpace;
      previousTarget.aiCooldown = 0;
    }
    this.ball.targetPlayer = gk;
    gk.stretchSave = false;
    gk.diveToward(saveX, saveY, this.ball.x, this.ball.y, this.ball.velocity.x, this.ball.velocity.y, diveDurationMs);
    gk.aiCooldown = Math.max(gk.aiCooldown, 520);
    this.scoreboard.logEvent(`${gk.playerName} mergulha na bola!`);
  }

  private estimateGkDiveDurationMs(gk: Player, displacement: number): number {
    return clamp(205 + displacement * 1.75 - gk.stats.speed * 0.10, 225, 460);
  }

  private drawGkDiveDebugPoint(
    gk: Player,
    interceptX: number,
    interceptY: number,
    targetX?: number,
    targetY?: number,
  ): void {
    this.gkDiveDebugTtlMs = 420;
    const g = this.gkDiveDebugGfx;
    g.lineStyle(2, 0xff00ff, 0.85);
    g.beginPath();
    g.moveTo(gk.x, gk.y);
    g.lineTo(interceptX, interceptY);
    g.strokePath();

    g.fillStyle(0xff00ff, 0.85);
    g.fillCircle(interceptX, interceptY, 6);
    g.lineStyle(2, 0xffffff, 0.9);
    g.strokeCircle(interceptX, interceptY, 10);

    if (targetX === undefined || targetY === undefined) return;
    g.lineStyle(2, 0x00e5ff, 0.85);
    g.beginPath();
    g.moveTo(interceptX, interceptY);
    g.lineTo(targetX, targetY);
    g.strokePath();
    g.fillStyle(0x00e5ff, 0.75);
    g.fillCircle(targetX, targetY, 4);
  }

  private drawGkBallTrajectoryDebug(goalLineX: number, projectedGoalY: number, framesToGoal: number): void {
    this.gkDiveDebugTtlMs = 420;
    const g = this.gkDiveDebugGfx;
    g.lineStyle(2, 0xfbbf24, 0.9);
    g.beginPath();
    g.moveTo(this.ball.x, this.ball.y);
    const samples = Math.max(2, Math.ceil(framesToGoal / 8));
    for (let i = 1; i <= samples; i++) {
      const p = this.projectBallAtFrames((framesToGoal * i) / samples);
      g.lineTo(p.x, p.y);
    }
    g.strokePath();

    g.fillStyle(0xfbbf24, 0.95);
    g.fillCircle(this.ball.x, this.ball.y, 4);
    g.fillStyle(0xff7a00, 0.95);
    g.fillCircle(goalLineX, projectedGoalY, 5);
    g.lineStyle(2, 0xff7a00, 0.85);
    g.strokeCircle(goalLineX, projectedGoalY, 10);
  }

  private projectBallAtFrames(frames: number): { x: number; y: number } {
    const wholeFrames = Math.max(0, Math.floor(frames));
    const partialFrame = clamp(frames - wholeFrames, 0, 1);
    const fullFrameFactor = wholeFrames > 0
      ? (1 - Math.pow(BALL_FRICTION, wholeFrames)) / (1 - BALL_FRICTION)
      : 0;
    const partialVelocityFactor = Math.pow(BALL_FRICTION, wholeFrames) * partialFrame;
    const displacementFactor = fullFrameFactor + partialVelocityFactor;

    return {
      x: this.ball.x + this.ball.velocity.x * displacementFactor,
      y: this.ball.y + this.ball.velocity.y * displacementFactor,
    };
  }

  private findBallFramesToX(lineX: number, maxFrames: number): number | null {
    const dir = Math.sign(lineX - this.ball.x);
    if (dir === 0) return 0;
    if ((dir < 0 && this.ball.velocity.x >= 0) || (dir > 0 && this.ball.velocity.x <= 0)) return null;

    let x = this.ball.x;
    let vx = this.ball.velocity.x;
    for (let frame = 1; frame <= maxFrames; frame++) {
      const prevX = x;
      x += vx;
      vx *= BALL_FRICTION;
      const crossed = dir < 0 ? x <= lineX : x >= lineX;
      if (crossed) {
        const span = x - prevX;
        const frac = Math.abs(span) > 0.001 ? clamp((lineX - prevX) / span, 0, 1) : 0;
        return frame - 1 + frac;
      }
    }

    return null;
  }

  private findClosestBallFrameToPlayer(player: Player, maxFrames: number): number {
    const sampleCount = Math.max(1, Math.ceil(maxFrames));
    let bestFrame = 0;
    let bestDistSq = Infinity;

    for (let frame = 0; frame <= sampleCount; frame++) {
      const p = this.projectBallAtFrames(Math.min(frame, maxFrames));
      const dx = p.x - player.x;
      const dy = p.y - player.y;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestFrame = Math.min(frame, maxFrames);
      }
    }

    return bestFrame;
  }

  private doClearance(gk: Player): void {
    gk.hasBall = false;
    this.ball.release();
    gk.state = PlayerState.ReturnToShape;
    gk.aiCooldown = 900;

    const isTeamA = gk.teamId === 'teamA';
    const ownTeam = isTeamA ? this.teamA : this.teamB;
    const oppTeam = isTeamA ? this.teamB : this.teamA;
    const dir     = ownTeam.attackDirection; // forward direction (changes after halftime swap)

    const controlledOutlet = this.findGkControlledOutlet(gk, ownTeam, oppTeam, dir);
    if (controlledOutlet) {
      const { target, blocker } = controlledOutlet;
      const passErr = 1 - gk.stats.passing / 100;
      const maxOff = passErr * 34 + 16;
      const destX = clamp(target.x + (Math.random() - 0.5) * maxOff, FIELD.left + 15, FIELD.right - 15);
      const destY = clamp(target.y + (Math.random() - 0.5) * maxOff * 1.25, FIELD.top + 15, FIELD.bottom - 15);
      const kickDist = dist(gk.x, gk.y, destX, destY);
      const power = clamp(3.1 + kickDist / 92 + (gk.stats.passing / 100) * 1.4, 3.8, 8.4);

      this.ball.targetPlayer = target;
      this.ball.kickTo(destX, destY, power, gk.id, {
        lift: blocker ? 2.8 : 1.2,
        spin: dir * (0.035 + power * 0.010),
      });
      target.state = PlayerState.ReceivePass;
      const reception = this.planReceptionTarget(target, oppTeam.getNearestPlayerTo(target.x, target.y));
      target.setTarget(reception.x, reception.y);
      gk.showShotPulse(this.ball.x, this.ball.y, power);
      if (blocker) this.ball.preventPickup(blocker.id, 400);
      this.applyKickFollowThrough(gk, Math.atan2(destY - gk.y, destX - gk.x), 0.85);
      this.scoreboard.logEvent(`${gk.playerName} sai jogando!`);
      return;
    }

    // Returns the closest opponent blocking the kick lane within 120 px of the GK,
    // or null if the lane is clear. Beyond 120 px a lofted kick clears any blocker.
    const findLaneBlocker = (tx: number, ty: number): Player | null => {
      const ldx = tx - gk.x, ldy = ty - gk.y;
      const lenSq = ldx * ldx + ldy * ldy;
      if (lenSq < 1) return null;
      let nearest: Player | null = null;
      let nearestDist = Infinity;
      for (const opp of oppTeam.players) {
        const od = dist(gk.x, gk.y, opp.x, opp.y);
        if (od > 120) continue;
        const t = clamp(((opp.x - gk.x) * ldx + (opp.y - gk.y) * ldy) / lenSq, 0, 1);
        const cx = gk.x + ldx * t, cy = gk.y + ldy * t;
        if (dist(opp.x, opp.y, cx, cy) < 30 && od < nearestDist) {
          nearest = opp; nearestDist = od;
        }
      }
      return nearest;
    };

    // Chance the GK lofts the ball over a blocker.
    // Scales with blocker distance (closer = harder) and GK passing stat.
    const loftChance = (blocker: Player): number => {
      const d = dist(gk.x, gk.y, blocker.x, blocker.y);
      const distFactor = clamp((d - 15) / 105, 0, 1); // 0 at ≤15 px, 1 at ≥120 px
      return distFactor * 0.50 + (gk.stats.passing / 100) * 0.45;
    };

    // Find the most advanced free midfielder/striker — loft over nearby blockers when able
    let clearTarget: Player | null = null;
    let clearTargetBlocker: Player | null = null;
    let bestAdvance = -Infinity;
    for (const p of ownTeam.players) {
      if (p.role === PlayerRole.Goalkeeper || p.role === PlayerRole.Defender) continue;
      const advance = p.x * dir;
      const nearOpp = oppTeam.getNearestPlayerTo(p.x, p.y);
      if (nearOpp && nearOpp.distanceTo(p) < 55) continue; // too marked
      const blocker = findLaneBlocker(p.x, p.y);
      if (blocker && Math.random() >= loftChance(blocker)) continue; // failed to loft
      if (advance > bestAdvance) {
        bestAdvance = advance;
        clearTarget = p;
        clearTargetBlocker = blocker ?? null;
      }
    }

    const passErr  = 1 - gk.stats.passing / 100;
    const maxOff   = passErr * 70 + 55; // clearances always carry some spread

    let destX: number;
    let destY: number;

    if (clearTarget) {
      const ox = (Math.random() - 0.5) * maxOff;
      const oy = (Math.random() - 0.5) * maxOff * 1.4;
      destX = clamp(clearTarget.x + ox, FIELD.left + 15, FIELD.right - 15);
      destY = clamp(clearTarget.y + oy, FIELD.top  + 15, FIELD.bottom - 15);
      clearTarget.state = PlayerState.ReceivePass;
      this.ball.targetPlayer = clearTarget;
    } else {
      // No free target — boot to flank, angled away from nearest pressing opponent
      const pressOpp = oppTeam.getNearestPlayerTo(gk.x, gk.y);
      const sideShift = pressOpp && Math.abs(pressOpp.y - gk.y) < 80
        ? (pressOpp.y > gk.y ? -130 : 130)   // kick to opposite flank from presser
        : (Math.random() > 0.5 ? 100 : -100); // random flank when presser is off-center
      const oy = sideShift + (Math.random() - 0.5) * maxOff;
      destX = clamp(FIELD.centerX + dir * 80, FIELD.left + 15, FIELD.right - 15);
      destY = clamp(FIELD.centerY + oy, FIELD.top + 15, FIELD.bottom - 15);
    }

    const power = CLEARANCE_BASE_POWER + (gk.stats.passing / 100) * CLEARANCE_STAT_POWER;
    this.ball.kickTo(destX, destY, power, gk.id, {
      lift: clearTargetBlocker ? 4.2 : 3.4,
      spin: dir * (0.050 + power * 0.013),
    });
    if (clearTarget) {
      const reception = this.planReceptionTarget(clearTarget, oppTeam.getNearestPlayerTo(clearTarget.x, clearTarget.y));
      clearTarget.setTarget(reception.x, reception.y);
    }
    gk.showShotPulse(this.ball.x, this.ball.y, power);
    // If the GK lofted over a blocker, block that player from immediately
    // intercepting without replacing the GK as the recent kicker.
    if (clearTargetBlocker) this.ball.preventPickup(clearTargetBlocker.id, 400);
    this.applyKickFollowThrough(gk, Math.atan2(destY - gk.y, destX - gk.x), 0.85);
    this.scoreboard.logEvent(`${gk.playerName} distribui!`);
  }

  private findGkControlledOutlet(
    gk: Player,
    ownTeam: Team,
    oppTeam: Team,
    dir: 1 | -1,
  ): { target: Player; blocker: Player | null } | null {
    let best: { target: Player; blocker: Player | null; score: number } | null = null;
    const distribution = gkDistributionQuality(gk);

    for (const p of ownTeam.players) {
      if (p.role === PlayerRole.Goalkeeper) continue;

      const d = dist(gk.x, gk.y, p.x, p.y);
      if (d < 28 || d > 360) continue;

      const isDefender = p.role === PlayerRole.Defender;
      const isMid = p.role === PlayerRole.Midfielder || p.role === PlayerRole.Winger;
      if (!isDefender && !isMid) continue;
      if (distribution < 52 && !isDefender && d > 220) continue;

      const nearOpp = oppTeam.getNearestPlayerTo(p.x, p.y);
      const nearOppDist = nearOpp ? nearOpp.distanceTo(p) : 999;
      const minSpace = (isDefender ? 36 : 48) + clamp(60 - distribution, 0, 35) * 0.28;
      if (nearOppDist < minSpace) continue;

      const blocker = this.findShortLaneBlocker(gk, p, oppTeam);
      if (blocker && d < 175 + distribution * 1.1) continue;

      const advance = (p.x - gk.x) * dir;
      const roleScore = isDefender ? 34 : 20;
      const spaceScore = clamp((nearOppDist - minSpace) / 120, 0, 1) * 34;
      const distanceScore = isDefender
        ? clamp((260 - d) / 230, 0, 1) * 24
        : clamp((360 - d) / 300, 0, 1) * 14;
      const progressScore = clamp(advance / 240, -0.35, 1) * 16;
      const lanePenalty = blocker ? 18 : 0;
      const score = roleScore + spaceScore + distanceScore + progressScore + distribution * 0.08 - lanePenalty;

      if (!best || score > best.score) best = { target: p, blocker, score };
    }

    return best && best.score > 60 - distribution * 0.20 ? best : null;
  }

  private findShortLaneBlocker(gk: Player, target: Player, oppTeam: Team): Player | null {
    const ldx = target.x - gk.x;
    const ldy = target.y - gk.y;
    const lenSq = ldx * ldx + ldy * ldy;
    if (lenSq < 1) return null;

    let nearest: Player | null = null;
    let nearestDist = Infinity;
    for (const opp of oppTeam.players) {
      const od = dist(gk.x, gk.y, opp.x, opp.y);
      if (od > 145) continue;
      const t = clamp(((opp.x - gk.x) * ldx + (opp.y - gk.y) * ldy) / lenSq, 0, 1);
      const cx = gk.x + ldx * t;
      const cy = gk.y + ldy * t;
      if (dist(opp.x, opp.y, cx, cy) < 32 && od < nearestDist) {
        nearest = opp;
        nearestDist = od;
      }
    }
    return nearest;
  }

  private doDribble(carrier: Player, blocker: Player): void {
    carrier.dribbleTarget = null;
    carrier.dribbleCommitMs = 0;
    carrier.dribbleContactRadius = 38;

    const success = this.resolver.resolveDribble(carrier, blocker);

    if (success) {
      // Burst past — push velocity toward the pre-chosen target direction so the
      // player cuts along the side chosen by the AI, not always straight forward.
      const dir = carrier.attackDirection;
      carrier.requestSprint(850);
      const tdx = carrier.targetX - carrier.x;
      const tdy = carrier.targetY - carrier.y;
      const tlen = Math.sqrt(tdx * tdx + tdy * tdy);
      if (tlen > 0.1) {
        carrier.vx += (tdx / tlen) * 2.2;
        carrier.vy += (tdy / tlen) * 2.2;
      } else {
        carrier.vx += dir * 2.2;
      }
      // Blocker stumbles — more so when the dribbler has superior dribbling skill
      const stumbleY = carrier.y < blocker.y ? 1 : -1;
      const stumbleMag = clamp(35 + (carrier.stats.dribbling - blocker.stats.defending) * 0.18, 28, 60);
      blocker.setTarget(
        clamp(blocker.x - dir * 22, FIELD.left + 15, FIELD.right - 15),
        clamp(blocker.y + stumbleY * stumbleMag, FIELD.top + 15, FIELD.bottom - 15),
      );
      this.tackleCooldowns.set(blocker.id, 900);
      carrier.state = PlayerState.CarryBall;
      carrier.aiCooldown = 350;
      blocker.showStumble();
      this.scoreboard.logEvent(`${carrier.playerName} dribla ${blocker.playerName}!`);
    } else {
      // Defender wins the ball
      const contactX = (carrier.x + blocker.x) / 2;
      const contactY = (carrier.y + blocker.y) / 2;
      carrier.hasBall = false;
      this.ball.release();
      carrier.state = PlayerState.FindSpace;
      carrier.dribbleTarget = null;
      carrier.dribbleCommitMs = 0;
      carrier.dribbleContactRadius = 38;
      blocker.hasBall = true;
      blocker.state = PlayerState.CarryBall;
      this.ball.attachToPlayer(blocker);
      this.tackleCooldowns.set(carrier.id, 650);
      blocker.showTackleBurst(contactX, contactY);
      this.scoreboard.logEvent(`${blocker.playerName} bloqueou o drible de ${carrier.playerName}!`);
    }
  }

  private doParry(gk: Player): void {
    // Better GKs push rebounds wide; weak GKs spill more centrally and unpredictably.
    const dir = gk.attackDirection;
    const quality = gkShotStoppingQuality(gk) / 100;
    const awaySide = Math.abs(gk.y - FIELD.centerY) < 18
      ? (Math.random() < 0.5 ? -1 : 1)
      : (gk.y < FIELD.centerY ? -1 : 1);
    const controlledWide = awaySide * (0.28 + quality * 0.72);
    const randomSpread = (Math.random() - 0.5) * (1.9 - quality * 1.35);
    const outAngle = Math.atan2(controlledWide + randomSpread, dir);
    const power = 2.2 + quality * 2.4 + Math.random() * (2.4 - quality * 1.1);
    const distance = 58 + quality * 62;
    const destX = clamp(gk.x + Math.cos(outAngle) * distance, FIELD.left + 15, FIELD.right - 15);
    const destY = clamp(gk.y + Math.sin(outAngle) * distance, FIELD.top  + 15, FIELD.bottom - 15);
    this.ball.kickTo(destX, destY, power, gk.id, {
      lift: 1.7 + (1 - quality) * 0.7,
      spin: awaySide * (0.060 + power * 0.016),
    });
    this.recalculateRoutesAfterBallTrajectoryChange();
  }

  // ──────────────────────────────────────────────
  // Pass arrival
  // ──────────────────────────────────────────────

  // Handles physical ball contact for the INTENDED receiver (targeted pass arrival).
  // Opponent interception and teammate deflection are handled by checkBallPlayerContacts().
  private recalculateRoutesAfterBallTrajectoryChange(previousTarget?: Player | null): void {
    if (this.ball.owner) return;

    if (previousTarget && this.ball.targetPlayer !== previousTarget && !previousTarget.hasBall) {
      previousTarget.state = PlayerState.FindSpace;
      previousTarget.aiCooldown = 0;
    }

    const target = this.ball.targetPlayer as Player | null;
    if (target && target.state === PlayerState.ReceivePass) {
      const oppTeam = target.teamId === 'teamA' ? this.teamB : this.teamA;
      const reception = this.planReceptionTarget(target, oppTeam.getNearestPlayerTo(target.x, target.y));
      target.setTarget(reception.x, reception.y);
      if (reception.urgency > 0.5) target.requestSprint(320, 45);
      return;
    }

    for (const player of this.allPlayers()) {
      if (player.state === PlayerState.ReceivePass && !player.hasBall) {
        player.state = PlayerState.FindSpace;
        player.aiCooldown = 0;
      }
    }

    this.chaseFreeeBall();
  }

  private checkPassArrival(): void {
    if (!this.ball.targetPlayer || this.ball.owner) return;

    const target = this.ball.targetPlayer as Player;
    const ballDist = dist(this.ball.x, this.ball.y, target.x, target.y);

    // Abandon pass if ball stopped far from target (deflected / friction killed it)
    if (this.ball.getSpeed() < 1.5 && ballDist > 80) {
      this.ball.targetPlayer = null;
      target.state = PlayerState.FindSpace;
      this.recalculateRoutesAfterBallTrajectoryChange(target);
      return;
    }

    // Abandon if ball is clearly heading away from target or a teammate is much better placed
    if (ballDist > 110 && this.ball.getSpeed() > 1.0) {
      const toTargetX = target.x - this.ball.x;
      const toTargetY = target.y - this.ball.y;
      const len = Math.sqrt(toTargetX * toTargetX + toTargetY * toTargetY);
      const dot = (this.ball.velocity.x * toTargetX + this.ball.velocity.y * toTargetY)
        / (this.ball.getSpeed() * len);
      if (dot < -0.15) {
        this.ball.targetPlayer = null;
        target.state = PlayerState.FindSpace;
        this.recalculateRoutesAfterBallTrajectoryChange(target);
        return;
      }

      const projFrames = 35;
      const dispFactor = (1 - Math.pow(BALL_FRICTION, projFrames)) / (1 - BALL_FRICTION);
      const projX = clamp(this.ball.x + this.ball.velocity.x * dispFactor, FIELD.left + 15, FIELD.right - 15);
      const projY = clamp(this.ball.y + this.ball.velocity.y * dispFactor, FIELD.top + 15, FIELD.bottom - 15);
      const targetDistToProj = dist(target.x, target.y, projX, projY);
      const ownTeam = target.teamId === 'teamA' ? this.teamA : this.teamB;
      for (const p of ownTeam.players) {
        if (p === target || p.role === PlayerRole.Goalkeeper || p.hasBall) continue;
        if (dist(p.x, p.y, projX, projY) < targetDistToProj * 0.5) {
          this.ball.targetPlayer = null;
          target.state = PlayerState.FindSpace;
          this.recalculateRoutesAfterBallTrajectoryChange(target);
          return;
        }
      }
    }

    // Keep receiver preparing for the first touch, not only chasing the ball center.
    if (target.state === PlayerState.ReceivePass) {
      const oppTeam = target.teamId === 'teamA' ? this.teamB : this.teamA;
      const nearestOpp = oppTeam.getNearestPlayerTo(target.x, target.y);
      const reception = this.planReceptionTarget(target, nearestOpp);
      target.setTarget(reception.x, reception.y);

      if (reception.urgency > 0.58 || this.isBallInDangerArea()) {
        target.requestSprint(300, 52);
      } else if (ballDist < 58) {
        target.sprintMs = Math.min(target.sprintMs, 80);
      }
    }

    // Arrival: ball physically reaches receiver. Diving GKs need swept contact because
    // fast shots can cross their body between two rendered frames.
    const arrivalRadius = this.getBallArrivalRadius(target);
    const arrivalDist = target.role === PlayerRole.Goalkeeper
      ? Math.min(
        ballDist,
        distancePointToSegment(target.x, target.y, this.ball.previousX, this.ball.previousY, this.ball.x, this.ball.y),
      )
      : ballDist;
    if (arrivalDist >= arrivalRadius) return;

    this.ball.targetPlayer = null;

    // Aerial duel: when a cross arrives, nearest opponent contests in the air
    if (this.lastPassWasCross && target.role !== PlayerRole.Goalkeeper) {
      this.lastPassWasCross = false;
      const oppTeamForDuel = target.teamId === 'teamA' ? this.teamB : this.teamA;
      let closestDef: Player | null = null;
      let closestDist = Infinity;
      for (const p of oppTeamForDuel.players) {
        if (p.role === PlayerRole.Goalkeeper) continue;
        const d = dist(p.x, p.y, target.x, target.y);
        if (d < 65 && d < closestDist) { closestDist = d; closestDef = p; }
      }
      if (closestDef) {
        const winner = this.resolver.resolveAerialDuel(target, closestDef);
        const loser  = winner === target ? closestDef : target;
        loser.state = PlayerState.FindSpace;
        loser.aiCooldown = 500;
        if (winner === closestDef) {
          // Defender wins — ball loose near them
          closestDef.hasBall = true;
          closestDef.state = PlayerState.CarryBall;
          this.ball.attachToPlayer(closestDef);
          this.applyFirstTouchMovement(closestDef, target);
          this.scoreboard.logEvent(`${closestDef.playerName} ganhou o duelo aéreo!`);
          return;
        }
        this.scoreboard.logEvent(`${target.playerName} ganhou o duelo aéreo!`);
      }
    } else {
      this.lastPassWasCross = false;
    }

    const isGKCatch = target.role === PlayerRole.Goalkeeper;

    if (isGKCatch) {
      // stretchSave: GK dived visually but has comfortable reach — resolve as routine save
      const isDive  = target.state === PlayerState.GkDive && !target.stretchSave;
      target.stretchSave = false;
      const result  = this.resolver.resolveGkSave(target, isDive, this.ball.getSpeed());

      if (result === 'catch') {
        target.hasBall = true;
        target.state = PlayerState.Clearance;
        this.ball.attachToPlayer(target);
        this.stats.recordSave(target.teamId);
        this.scoreboard.logEvent(`${target.playerName} segurou!`);
      } else if (result === 'parry') {
        target.state = PlayerState.ReturnToShape;
        target.aiCooldown = 650;
        this.doParry(target);
        this.stats.recordSave(target.teamId);
        this.scoreboard.logEvent(`${target.playerName} espalmou!`);
      } else {
        // Miss/fumble: ball carries on toward goal, checkGoal() handles it
        target.state = PlayerState.ReturnToShape;
        target.aiCooldown = 900;
        this.scoreboard.logEvent(
          isDive ? `${target.playerName} não alcançou!` : `${target.playerName} soltou!`,
        );
      }
      return;
    }

    const oppTeam = target.teamId === 'teamA' ? this.teamB : this.teamA;
    const nearestOpp = oppTeam.getNearestPlayerTo(target.x, target.y);
    const passer = this.ball.kickedById
      ? this.allPlayers().find(p => p.id === this.ball.kickedById) ?? target
      : target;
    const success = this.resolver.resolveFirstTouch(target, passer, nearestOpp, this.ball.getSpeed());

    if (success) {
      this.stats.recordPassCompleted(target.teamId);
      target.hasBall = true;
      target.state = PlayerState.CarryBall;
      target.aiCooldown = this.settleTime(target, nearestOpp);
      this.ball.attachToPlayer(target);
      this.applyFirstTouchMovement(target, nearestOpp);
    } else {
      target.state = PlayerState.FindSpace;
      this.applyFailedFirstTouchDeflection(target);
      this.recalculateRoutesAfterBallTrajectoryChange(target);
      this.scoreboard.logEvent(`${target.playerName} não dominou!`);
    }
  }

  private applyFailedFirstTouchDeflection(player: Player): void {
    const speed = this.ball.getSpeed();
    const incomingX = speed > 0.05 ? this.ball.velocity.x / speed : player.attackDirection;
    const incomingY = speed > 0.05 ? this.ball.velocity.y / speed : 0;
    const lateralX = -incomingY;
    const lateralY = incomingX;

    const cushion = 0.16 + Math.random() * 0.30;
    const carryOn = clamp(speed * cushion, 0.55, 3.4);
    const heavyTouch = Math.random() < clamp((speed - 4.0) / 8.0, 0.08, 0.36);
    const extraPush = heavyTouch ? 0.6 + Math.random() * 1.2 : Math.random() * 0.35;
    const touchNoise = (Math.random() - 0.5) * (1.1 + speed * 0.10);

    this.ball.velocity.x = incomingX * (carryOn + extraPush) + lateralX * touchNoise;
    this.ball.velocity.y = incomingY * (carryOn + extraPush) + lateralY * touchNoise;
    this.ball.markTouchedBy(player.id, 260);
  }

  // Physical ball collision for non-target players while ball is in flight.
  // Opponents within contact range attempt an interception; teammates deflect the ball.
  private checkBallPlayerContacts(): void {
    if (this.ball.owner) return;

    const targetId = this.ball.targetPlayer ? (this.ball.targetPlayer as Player).id : null;
    const ballMoving = this.ball.getSpeed() > 1.5;

    for (const player of this.allPlayers()) {
      // Skip: the player who just kicked, or the intended receiver (handled by checkPassArrival)
      if (this.ball.isPickupBlocked(player.id)) continue;
      const gkClaimRadius = this.getGkPhysicalClaimRadius(player);
      if (player.id === targetId) continue;

      const contactRadius = Math.max(CONTACT_RADIUS, gkClaimRadius);
      if (this.getBallPlayerContactDistance(player) >= contactRadius) continue;

      if (player.role === PlayerRole.Goalkeeper && gkClaimRadius > CONTACT_RADIUS) {
        this.ball.targetPlayer = null;
        this.ball.attachToPlayer(player);
        player.hasBall = true;
        player.state = PlayerState.Clearance;
        player.aiCooldown = 650;
        this.scoreboard.logEvent(`${player.playerName} saiu e segurou!`);
        return;
      }

      // --- Physical contact ---

      if (!this.ball.targetPlayer) {
        // Free ball touched by this player — let checkFreeBall handle possession,
        // but keep kickedById updated so the logic is consistent.
        break;
      }

      // Ball is a targeted pass and this player is NOT the target
      const target = this.ball.targetPlayer as Player;
      const isOpponent = player.teamId !== target.teamId;

      if (isOpponent && ballMoving) {
        const isShot = this.ball.getSpeed() > 6.5;

        // 1. Clean intercept — defender controls the ball.
        // Defending + intelligence (reading the ball) + Intercept trait.
        const interceptTrait = player.playstyles.includes('Intercept') || player.playstylesPlus.includes('Intercept')
          ? (player.playstylesPlus.includes('Intercept') ? 0.10 : 0.06)
          : 0;
        const interceptChance = 0.22
          + (player.stats.defending / 100) * 0.38
          + (player.stats.intelligence / 100) * 0.14
          + interceptTrait;
        if (Math.random() < interceptChance) {
          this.stats.recordInterception(player.teamId);
          this.ball.targetPlayer = null;
          target.state = PlayerState.FindSpace;
          this.ball.attachToPlayer(player);
          player.hasBall = true;
          player.state = PlayerState.CarryBall;
          this.applyFirstTouchMovement(player, target);
          this.scoreboard.logEvent(`${player.playerName} interceptou!`);
          return;
        }

        // 2. Deflection — ball hits defender. Can be a full normal reflection or a
        //    glancing contact where the ball continues mostly on its original path.
        //    More likely for players with higher defending and faster balls.
        const ballSpeedFactor = clamp((this.ball.getSpeed() - 4.5) / 7.5, 0, 1);
        const deflectChance = 0.18 + (player.stats.defending / 100) * 0.14 + ballSpeedFactor * 0.20;
        if (Math.random() < deflectChance) {
          const spd = this.ball.getSpeed() * (isShot ? 0.70 : 0.76);
          // ~42% of deflections are glancing — ball veers off by 10–30° but keeps going.
          // Full normal reflection only happens ~58% of the time.
          if (Math.random() < 0.42) {
            const currentAngle = Math.atan2(this.ball.velocity.y, this.ball.velocity.x);
            const deviation = (Math.random() - 0.5) * 0.90; // ±~26° max
            this.rotateBallVelocity(currentAngle + deviation, spd * 1.05);
          } else {
            this.deflectBallOffPlayer(player, spd, 0.56);
          }
          this.ball.targetPlayer = null;
          target.state = PlayerState.FindSpace;
          this.ball.markTouchedBy(player.id, 280);
          this.recalculateRoutesAfterBallTrajectoryChange(target);
          this.scoreboard.logEvent(`${player.playerName} desviou!`);
          return;
        }

        // 3. Glance — barely touches, pass continues with a slight deviation
        const spd = this.ball.getSpeed() * 0.91;
        this.glanceBallOffPlayer(player, spd, 0.22);
        this.ball.markTouchedBy(player.id, 220);
        this.recalculateRoutesAfterBallTrajectoryChange(target);

      } else if (!isOpponent && ballMoving) {
        // Teammate in the way: ball deflects off them.
        // ~30% of the time it's a slight clip and continues roughly on course.
        const spd = this.ball.getSpeed() * 0.82;
        if (Math.random() < 0.30) {
          const currentAngle = Math.atan2(this.ball.velocity.y, this.ball.velocity.x);
          const deviation = (Math.random() - 0.5) * 0.70; // ±~20° max
          this.rotateBallVelocity(currentAngle + deviation, spd * 1.04);
        } else {
          this.deflectBallOffPlayer(player, spd, 0.42);
        }
        target.state = PlayerState.FindSpace;
        this.ball.targetPlayer = null;
        this.ball.markTouchedBy(player.id, 220);
        this.recalculateRoutesAfterBallTrajectoryChange(target);
        this.scoreboard.logEvent(`Desvio em ${player.playerName}!`);
      }

      break; // handle one contact per frame
    }
  }

  // ──────────────────────────────────────────────
  // Ball contact helpers
  // ──────────────────────────────────────────────

  private analyzeBallLane(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    players: Player[],
    owningTeamId: string,
  ): BallLaneAnalysis {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 0.001) {
      return {
        risk: 0,
        blockers: 0,
        nearestDist: Infinity,
        blocker: null,
        blockerT: 0,
        openSide: 1,
      };
    }

    const len = Math.sqrt(lenSq);
    const perpX = -dy / len;
    const perpY = dx / len;
    let risk = 0;
    let blockers = 0;
    let nearestDist = Infinity;
    let blocker: Player | null = null;
    let blockerT = 0;
    let openSide: -1 | 1 = 1;

    for (const player of players) {
      const relX = player.x - fromX;
      const relY = player.y - fromY;
      const t = (relX * dx + relY * dy) / lenSq;
      if (t < 0.07 || t > 0.98) continue;

      const laneDist = distancePointToSegment(player.x, player.y, fromX, fromY, toX, toY);
      const lateralSpeed = Math.abs(player.vx * perpX + player.vy * perpY);
      const dangerRadius = CONTACT_RADIUS + 5 + clamp(lateralSpeed * 3.0, 0, 10);
      const warningRadius = dangerRadius + 18;
      if (laneDist > warningRadius) continue;

      blockers++;
      const closeness = clamp((warningRadius - laneDist) / Math.max(warningRadius - dangerRadius + 1, 1), 0, 1);
      const opponentWeight = player.teamId === owningTeamId ? 0.55 : 1.0;
      const roleWeight = player.role === PlayerRole.Goalkeeper ? 1.12 : 1.0;
      const pathWeight = 1 - t * 0.28;
      risk = Math.max(risk, closeness * opponentWeight * roleWeight * pathWeight);

      if (laneDist < nearestDist) {
        nearestDist = laneDist;
        blocker = player;
        blockerT = t;
        const lateral = relX * perpX + relY * perpY;
        openSide = lateral >= 0 ? -1 : 1;
      }
    }

    return {
      risk: clamp(risk, 0, 1),
      blockers,
      nearestDist,
      blocker,
      blockerT,
      openSide,
    };
  }

  private getBallPlayerContactDistance(player: Player): number {
    if (this.ball.getSpeed() <= 0.05) return dist(this.ball.x, this.ball.y, player.x, player.y);
    return Math.min(
      dist(this.ball.x, this.ball.y, player.x, player.y),
      distancePointToSegment(player.x, player.y, this.ball.previousX, this.ball.previousY, this.ball.x, this.ball.y),
    );
  }

  private getBallContactNormalFrom(player: Player): { x: number; y: number } {
    const segX = this.ball.x - this.ball.previousX;
    const segY = this.ball.y - this.ball.previousY;
    const segLenSq = segX * segX + segY * segY;
    const t = segLenSq > 0
      ? clamp(((player.x - this.ball.previousX) * segX + (player.y - this.ball.previousY) * segY) / segLenSq, 0, 1)
      : 1;
    const contactX = this.ball.previousX + segX * t;
    const contactY = this.ball.previousY + segY * t;
    let nx = contactX - player.x;
    let ny = contactY - player.y;
    let len = Math.sqrt(nx * nx + ny * ny);

    if (len < 0.001) {
      const speed = this.ball.getSpeed();
      if (speed > 0.001) {
        nx = -this.ball.velocity.x / speed;
        ny = -this.ball.velocity.y / speed;
        len = 1;
      } else {
        nx = 1;
        ny = 0;
        len = 1;
      }
    }

    return { x: nx / len, y: ny / len };
  }

  private rotateBallVelocity(angle: number, speed: number): void {
    this.ball.velocity.x = Math.cos(angle) * speed;
    this.ball.velocity.y = Math.sin(angle) * speed;
    this.ball.spin = Math.sin(angle * 1.3 + this.ball.x * 0.015) * (0.045 + speed * 0.012);
  }

  private deflectBallOffPlayer(player: Player, speed: number, maxNoiseRad: number): void {
    const normal = this.getBallContactNormalFrom(player);
    const vx = this.ball.velocity.x;
    const vy = this.ball.velocity.y;
    const dot = vx * normal.x + vy * normal.y;
    let outX = dot < 0 ? vx - 2 * dot * normal.x : vx + normal.x * Math.max(speed * 0.35, 0.5);
    let outY = dot < 0 ? vy - 2 * dot * normal.y : vy + normal.y * Math.max(speed * 0.35, 0.5);
    const outLen = Math.sqrt(outX * outX + outY * outY) || 1;
    outX /= outLen;
    outY /= outLen;
    const angle = Math.atan2(outY, outX) + (Math.random() - 0.5) * maxNoiseRad;
    this.rotateBallVelocity(angle, speed);
  }

  private glanceBallOffPlayer(player: Player, speed: number, maxNoiseRad: number): void {
    const normal = this.getBallContactNormalFrom(player);
    const vx = this.ball.velocity.x;
    const vy = this.ball.velocity.y;
    const dot = vx * normal.x + vy * normal.y;
    const outX = vx - Math.min(dot, 0) * normal.x * 0.45;
    const outY = vy - Math.min(dot, 0) * normal.y * 0.45;
    const angle = Math.atan2(outY, outX) + (Math.random() - 0.5) * maxNoiseRad;
    this.rotateBallVelocity(angle, speed);
  }

  private getGkPhysicalClaimRadius(player: Player): number {
    if (player.role !== PlayerRole.Goalkeeper) return CONTACT_RADIUS;

    const team = player.teamId === 'teamA' ? this.teamA : this.teamB;
    const ownGoal = team.attackDirection > 0 ? GOAL_LEFT : GOAL_RIGHT;
    const goalCenterY = (ownGoal.top + ownGoal.bottom) / 2;
    const ballGoalDist = Math.abs(this.ball.x - ownGoal.centerX);
    const ballCentralDist = Math.abs(this.ball.y - goalCenterY);

    // Only active within the penalty area
    if (ballGoalDist > PENALTY_AREA_W + 10 || ballCentralDist > PENALTY_AREA_H / 2) return CONTACT_RADIUS;

    // Deeper in the box = more GK authority; also scales with defending stat
    const depthFactor = clamp(1 - ballGoalDist / 250, 0, 1);
    const skillBonus = gkShotStoppingQuality(player) * 0.035;
    const depthBonus = depthFactor * 3;
    return CONTACT_RADIUS + skillBonus + depthBonus;
  }

  private getBallArrivalRadius(target: Player): number {
    if (target.role !== PlayerRole.Goalkeeper) return CONTACT_RADIUS;

    const physicalClaimRadius = this.getGkPhysicalClaimRadius(target);
    if (target.state !== PlayerState.GkDive) return Math.max(CONTACT_RADIUS, physicalClaimRadius);

    const diveSkillBonus = gkShotStoppingQuality(target) * 0.025;
    return Math.max(physicalClaimRadius, GK_DIVE_CATCH_RADIUS + diveSkillBonus);
  }

  // Free ball pickup
  private chaseFreeeBall(): void {
    if (this.ball.owner || this.ball.targetPlayer) return;

    for (const team of [this.teamA, this.teamB]) {
      const ownGoal = team.attackDirection > 0 ? GOAL_LEFT : GOAL_RIGHT;

      // Score each candidate: physical distance + penalty for abandoning a committed mark.
      // A defender holding a striker near own goal gets a heavy penalty so the AI
      // only pulls them off if truly no one else can reach the ball.
      let best: Player | null = null;
      let bestScore = Infinity;
      for (const p of team.players) {
        if (p.role === PlayerRole.Goalkeeper) continue;
        if (p.hasBall || p.state === PlayerState.ReceivePass) continue;
        const d = p.distanceToBall(this.ball);
        let penalty = 0;
        if (p.state === PlayerState.MarkOpponent && p.markingTarget) {
          const threatGoalDist = Math.abs(p.markingTarget.x - ownGoal.centerX);
          // Heavier penalty the closer the marked threat is to the goal
          penalty = threatGoalDist < 260
            ? 130 + (260 - threatGoalDist) * 0.9
            : 55;
        }
        const score = d + penalty;
        if (score < bestScore) { bestScore = score; best = p; }
      }
      if (best) {
        const ballDist = best.distanceToBall(this.ball);
        const intercept = this.projectBallIntercept(best);
        best.setTarget(intercept.x, intercept.y);
        best.state = PlayerState.PressBall;
        const oppTeam = team === this.teamA ? this.teamB : this.teamA;
        const opponentRunner = oppTeam.players
          .filter(p => p.role !== PlayerRole.Goalkeeper && !p.hasBall)
          .reduce<Player | null>((closest, p) => {
            if (!closest) return p;
            return p.distanceToBall(this.ball) < closest.distanceToBall(this.ball) ? p : closest;
          }, null);
        const contested = opponentRunner
          ? Math.abs(ballDist - opponentRunner.distanceToBall(this.ball)) < 80
          : false;
        const difficult = ballDist > 85 || this.ball.getSpeed() > 2.2 || this.isBallInDangerArea();
        if (opponentRunner && this.shouldSprintForRace(best, opponentRunner, this.ball.x, this.ball.y)) {
          best.forceSprint(380);
        } else if (contested || difficult) {
          best.requestSprint(350, 85);
        }
      }
    }
  }

  // Spread targets of players on the same team so they don't converge to the same spot.
  // Runs after AI sets targets but before movement, breaking the separation↔attraction cycle.
  private separateTeamTargets(team: Team): void {
    const MIN_T = 45; // minimum distance between two teammates' targets
    const eligible = team.players.filter(
      p => !p.hasBall
        && p.state !== PlayerState.ReceivePass
        && p.state !== PlayerState.Pass,
    );

    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i];
        const b = eligible[j];
        const dx = b.targetX - a.targetX;
        const dy = b.targetY - a.targetY;
        const dSq = dx * dx + dy * dy;
        if (dSq >= MIN_T * MIN_T || dSq === 0) continue;

        const d = Math.sqrt(dSq);
        const push = (MIN_T - d) / 2;
        const nx = dx / d;
        const ny = dy / d;

        a.targetX = clamp(a.targetX - nx * push, FIELD.left + 15, FIELD.right - 15);
        a.targetY = clamp(a.targetY - ny * push, FIELD.top + 15, FIELD.bottom - 15);
        b.targetX = clamp(b.targetX + nx * push, FIELD.left + 15, FIELD.right - 15);
        b.targetY = clamp(b.targetY + ny * push, FIELD.top + 15, FIELD.bottom - 15);
      }
    }
  }

  private checkFreeBall(): void {
    if (this.ball.owner || this.ball.targetPlayer) return;

    let nearest: Player | null = null;
    let nearestDist = BALL_PICKUP_RADIUS;

    for (const p of this.allPlayers()) {
        if (this.ball.isPickupBlocked(p.id)) continue; // recent touch cannot immediately recover
      const d = p.distanceToBall(this.ball);
      if (d < nearestDist) { nearestDist = d; nearest = p; }
    }
    if (!nearest) return;

    const oppTeam = nearest.teamId === 'teamA' ? this.teamB : this.teamA;
    const contestor = oppTeam.players.find(
      p => !this.ball.isPickupBlocked(p.id) && p.distanceToBall(this.ball) < BALL_PICKUP_RADIUS,
    ) ?? null;
    if (contestor) {
      if (this.shouldSprintForRace(nearest, contestor, this.ball.x, this.ball.y)) {
        nearest.forceSprint(280);
      } else {
        nearest.requestSprint(250, 80);
      }
      if (this.shouldSprintForRace(contestor, nearest, this.ball.x, this.ball.y)) {
        contestor.forceSprint(280);
      } else {
        contestor.requestSprint(250, 80);
      }
    }
    const winner = contestor
      ? this.resolver.resolveDuel(nearest, contestor)
      : nearest;

    winner.hasBall = true;
    winner.state = PlayerState.CarryBall;
    this.ball.attachToPlayer(winner);
    this.applyFirstTouchMovement(winner, oppTeam.getNearestPlayerTo(winner.x, winner.y));
  }

  // ──────────────────────────────────────────────
  // Tackle
  // ──────────────────────────────────────────────

  private checkTackles(): void {
    for (const team of [this.teamA, this.teamB]) {
      const oppTeam = team === this.teamA ? this.teamB : this.teamA;
      const carrier = oppTeam.getBallCarrier();
      if (!carrier) continue;

      for (const defender of team.players) {
        if (defender.role === PlayerRole.Goalkeeper) continue;
        if ((this.tackleCooldowns.get(defender.id) ?? 0) > 0) continue;
        if (defender.distanceTo(carrier) > TACKLE_RANGE) continue;
        if (defender.state !== PlayerState.MarkOpponent && defender.state !== PlayerState.PressBall) continue;

        this.tackleCooldowns.set(defender.id, TACKLE_COOLDOWN_MS);
        this.tackleCooldowns.set(carrier.id, TACKLE_COOLDOWN_MS * 0.7);

        if (this.resolver.resolveTackle(defender, carrier, this.tacklePositioningBonus(defender, carrier, team))) {
          this.stats.recordTackleWon(defender.teamId);
          carrier.hasBall = false;
          this.ball.release();
          carrier.state = PlayerState.FindSpace;
          this.ball.velocity.x = (Math.random() - 0.5) * 4;
          this.ball.velocity.y = (Math.random() - 0.5) * 4;
          this.scoreboard.logEvent(`${defender.playerName} roubou de ${carrier.playerName}!`);
        } else {
          // Push defender back
          const dx = carrier.x - defender.x;
          const dy = carrier.y - defender.y;
          defender.setTarget(defender.x - dx * 0.4, defender.y - dy * 0.4);
        }
        break;
      }
    }

    // GK tackle: inside own penalty area the goalkeeper can dispossess a carrier.
    // Unlike outfield tackles, a successful GK tackle gives them ball possession.
    for (const team of [this.teamA, this.teamB]) {
      const gk = team.players.find(p => p.role === PlayerRole.Goalkeeper);
      if (!gk || (this.tackleCooldowns.get(gk.id) ?? 0) > 0) continue;
      if (gk.state !== PlayerState.PressBall) continue;

      const oppTeam = team === this.teamA ? this.teamB : this.teamA;
      const carrier = oppTeam.getBallCarrier();
      if (!carrier) continue;

      // Only inside own penalty area
      const ownGoal = team.attackDirection > 0 ? GOAL_LEFT : GOAL_RIGHT;
      const goalCenterY = (ownGoal.top + ownGoal.bottom) / 2;
      if (Math.abs(carrier.x - ownGoal.centerX) > PENALTY_AREA_W + 50) continue;
      if (Math.abs(carrier.y - goalCenterY) > PENALTY_AREA_H / 2) continue;

      if (gk.distanceTo(carrier) > TACKLE_RANGE) continue;

      this.tackleCooldowns.set(gk.id, TACKLE_COOLDOWN_MS);
      this.tackleCooldowns.set(carrier.id, TACKLE_COOLDOWN_MS * 0.7);

      if (this.resolver.resolveTackle(gk, carrier, this.tacklePositioningBonus(gk, carrier, team))) {
        this.stats.recordTackleWon(gk.teamId);
        carrier.hasBall = false;
        carrier.state = PlayerState.FindSpace;
        this.ball.release();
        this.ball.attachToPlayer(gk);
        gk.hasBall = true;
        gk.state = PlayerState.Clearance;
        gk.aiCooldown = 650;
        this.scoreboard.logEvent(`${gk.playerName} roubou de ${carrier.playerName}!`);
      } else {
        const dx = carrier.x - gk.x;
        const dy = carrier.y - gk.y;
        gk.setTarget(gk.x - dx * 0.4, gk.y - dy * 0.4);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Kickoff & reset
  // ──────────────────────────────────────────────

  private tacklePositioningBonus(defender: Player, carrier: Player, defendingTeam: Team): number {
    const run = this.playerMovementVector(carrier);
    const futureX = clamp(carrier.x + run.x * 58, FIELD.left + 15, FIELD.right - 15);
    const futureY = clamp(carrier.y + run.y * 58, FIELD.top + 15, FIELD.bottom - 15);
    const pathDist = distancePointToSegment(defender.x, defender.y, carrier.x, carrier.y, futureX, futureY);
    const fromCarrierX = defender.x - carrier.x;
    const fromCarrierY = defender.y - carrier.y;
    const aheadDot = fromCarrierX * run.x + fromCarrierY * run.y;
    const laneBlock = clamp((42 - pathDist) / 42, 0, 1);
    const ahead = clamp((aheadDot + 18) / 76, 0, 1);

    const ownGoal = defendingTeam.attackDirection > 0 ? GOAL_LEFT : GOAL_RIGHT;
    const carrierGoalDist = Math.abs(carrier.x - ownGoal.centerX);
    const defenderGoalDist = Math.abs(defender.x - ownGoal.centerX);
    const betweenCarrierAndGoal = defenderGoalDist < carrierGoalDist + 8;
    const goalSideBonus = betweenCarrierAndGoal ? 4 : -5;
    const jockeyBonus = traitBonus(defender, TRAITS.JOCKEY, 5, 4);
    const readBonus = (defender.stats.defending * 0.045 + defender.stats.intelligence * 0.035) * laneBlock * ahead;
    const recoveryPenalty = aheadDot < -18 ? clamp((-aheadDot - 18) / 70, 0, 1) * 12 : 0;

    return clamp(laneBlock * 14 + ahead * 7 + readBonus + goalSideBonus + jockeyBonus - recoveryPenalty, -14, 24);
  }

  private playerMovementVector(player: Player): { x: number; y: number } {
    const speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
    if (speed > 0.18) return { x: player.vx / speed, y: player.vy / speed };

    const tx = player.targetX - player.x;
    const ty = player.targetY - player.y;
    const targetDist = Math.sqrt(tx * tx + ty * ty);
    if (targetDist > 8) return { x: tx / targetDist, y: ty / targetDist };

    return { x: player.attackDirection, y: 0 };
  }

  private swapSides(): void {
    const fieldMidX = FIELD.left + FIELD.right; // = left + right, mirror formula: newX = left+right - oldX
    for (const p of this.allPlayers()) {
      p.baseX = fieldMidX - p.baseX;
      p.attackDirection = (p.attackDirection * -1) as 1 | -1;
    }
    this.teamA.attackDirection = (this.teamA.attackDirection * -1) as 1 | -1;
    this.teamB.attackDirection = (this.teamB.attackDirection * -1) as 1 | -1;
  }

  private showHalftimeBanner(): void {
    const W = 1200;
    const H = 760;
    const bg = this.add.rectangle(W / 2, H / 2, 400, 90, 0x000000, 0.92).setDepth(30);
    const txt = this.add.text(W / 2, H / 2, 'Intervalo', {
      fontSize: '34px',
      fontStyle: 'bold',
      fontFamily: 'Nunito',
      color: '#fbbf24',
      stroke: '#000000',
      strokeThickness: 4,
      resolution: 2,
    }).setOrigin(0.5).setDepth(31);
    const sub = this.add.text(W / 2, H / 2 + 28, `${this.matchManager.scoreA} – ${this.matchManager.scoreB}`, {
      fontSize: '18px',
      fontStyle: 'bold',
      fontFamily: 'Nunito',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 2,
      resolution: 2,
    }).setOrigin(0.5).setDepth(31);
    // Auto-destroy when second half starts
    this.matchManager.onHalftimeEnd = (() => {
      const prev = this.matchManager.onHalftimeEnd;
      return () => { bg.destroy(); txt.destroy(); sub.destroy(); prev?.call(this.matchManager); };
    })();
  }

  private isInAttackingHalf(player: Player): boolean {
    const team = player.teamId === 'teamA' ? this.teamA : this.teamB;
    return team.attackDirection > 0
      ? this.ball.x >= FIELD.centerX
      : this.ball.x <= FIELD.centerX;
  }

  private endAdvantage(): void {
    if (!this.advTeamId) return;
    this.advText?.destroy();
    this.advText = null;
    this.advTeamId = '';
    this.advPrevBallX = 0;
    this.matchManager.forceFinish();
  }

  private updateAdvantage(_delta: number): void {
    // End as soon as ball leaves the attacking half (crosses center line)
    const prevSide = this.advPrevBallX < FIELD.centerX ? -1 : 1;
    const currSide = this.ball.x       < FIELD.centerX ? -1 : 1;
    if (prevSide !== currSide) {
      this.endAdvantage();
      return;
    }
    this.advPrevBallX = this.ball.x;
  }

  private giveKickoff(teamId: string): void {
    const team = teamId === 'teamA' ? this.teamA : this.teamB;
    const kicker = team.players.find(p =>
      p.role === PlayerRole.Midfielder || p.role === PlayerRole.Striker,
    ) ?? team.players[1];

    // Place kicker just inside center circle on their own half (behind center line)
    const offsetX = team.attackDirection > 0 ? -35 : 35;
    kicker.x = FIELD.centerX + offsetX;
    kicker.y = FIELD.centerY;
    kicker.targetX = kicker.x;
    kicker.targetY = kicker.y;
    kicker.hasBall = true;
    kicker.state = PlayerState.CarryBall;
    kicker.aiCooldown = 800;
    this.clearCenterCircleForKickoff(kicker);

    this.ball.setPosition(kicker.x, kicker.y);
    this.ball.attachToPlayer(kicker);
  }

  private resetPositions(): void {
    this.resetPlayersToKickoffShape();
    this.ball.release();
    this.ball.setPosition(FIELD.centerX, FIELD.centerY);
    this.ball.velocity = { x: 0, y: 0 };
    this.ball.resetFlight();
    const scorer = this.matchManager.getLastScorer();
    this.giveKickoff(scorer === 'teamA' ? 'teamB' : 'teamA');
  }

  // ──────────────────────────────────────────────
  // Keys
  // ──────────────────────────────────────────────

  private resetPlayersToKickoffShape(): void {
    for (const p of this.allPlayers()) {
      const kx = this.kickoffFormationX(p.baseX, p.attackDirection);

      p.x = kx;
      p.y = p.baseY;
      p.targetX = kx;
      p.targetY = p.baseY;
      p.vx = 0;
      p.vy = 0;
      p.avoidanceX = 0;
      p.avoidanceY = 0;
      p.hasBall = false;
      p.passTarget = null;
      p.passTargetX = null;
      p.passTargetY = null;
      p.passKind = 'normal';
      p.dribbleTarget = null;
      p.dribbleCommitMs = 0;
      p.dribbleContactRadius = 38;
      p.markingTarget = null;
      p.sprintMs = 0;
      p.recentPassFromId = null;
      p.recentPassCooldownMs = 0;
      p.state = PlayerState.ReturnToShape;
      p.aiCooldown = 0;
    }
  }

  // Maps a player's baseX (formation position) to a kickoff x that keeps them
  // entirely within their own half, preserving the formation's relative shape.
  // Uses attackDirection so this works correctly after halftime side-swap too.
  private kickoffFormationX(baseX: number, attackDirection: 1 | -1): number {
    // Formation x range (Team A perspective, before any halftime swap):
    //   GK ≈ 105, furthest attacker ≈ 900  →  range ≈ 795
    // After halftime swap the values are mirrored around FIELD.left+FIELD.right (=1200),
    // but the ratio calculation below handles both halves symmetrically.
    const FORM_GK_X  = 105;
    const FORM_ATT_X = 900;
    const FORM_RANGE = FORM_ATT_X - FORM_GK_X; // 795

    const buffer = CENTER_CIRCLE_RADIUS + 22; // keep all players behind centre circle

    if (attackDirection === 1) {
      // Own half is the LEFT side: x ∈ [FIELD.left, FIELD.centerX - buffer]
      const ownHalfEnd = FIELD.centerX - buffer;
      const ratio = clamp((baseX - FORM_GK_X) / FORM_RANGE, 0, 1);
      return FORM_GK_X + ratio * (ownHalfEnd - FORM_GK_X);
    } else {
      // Own half is the RIGHT side: x ∈ [FIELD.centerX + buffer, FIELD.right]
      // baseX is mirrored: GK ≈ 1200-105=1095, attacker ≈ 1200-900=300
      const mirroredGKX  = FIELD.left + FIELD.right - FORM_GK_X; // 1095
      const ownHalfStart = FIELD.centerX + buffer;
      const ratio = clamp((mirroredGKX - baseX) / FORM_RANGE, 0, 1);
      return mirroredGKX - ratio * (mirroredGKX - ownHalfStart);
    }
  }

  private clearCenterCircleForKickoff(kicker: Player): void {
    const minRadius = CENTER_CIRCLE_RADIUS + 24;

    for (const p of this.allPlayers()) {
      if (p === kicker) continue;

      const dx = p.x - FIELD.centerX;
      const dy = p.y - FIELD.centerY;
      const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);
      if (distanceFromCenter >= minRadius) continue;

      const side = -p.attackDirection; // push away from attacking direction
      const nx = distanceFromCenter > 1 ? dx / distanceFromCenter : side;
      const ny = distanceFromCenter > 1
        ? dy / distanceFromCenter
        : (p.baseY < FIELD.centerY ? -0.45 : 0.45);
      const rawX = FIELD.centerX + nx * minRadius;
      const rawY = FIELD.centerY + ny * minRadius;
      const ownHalfX = p.attackDirection === 1
        ? Math.min(rawX, FIELD.centerX - minRadius * 0.35)
        : Math.max(rawX, FIELD.centerX + minRadius * 0.35);

      p.x = clamp(ownHalfX, FIELD.left + 20, FIELD.right - 20);
      p.y = clamp(rawY, FIELD.top + 24, FIELD.bottom - 24);
      p.targetX = p.x;
      p.targetY = p.y;
      p.vx = 0;
      p.vy = 0;
    }
  }

  private setupKeys(): void {
    const kb = this.input.keyboard!;
    this.keys = {
      space: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      r: kb.addKey(Phaser.Input.Keyboard.KeyCodes.R),
      t: kb.addKey(Phaser.Input.Keyboard.KeyCodes.T),
      one: kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE),
      two: kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO),
    };
    this.keys.space.on('down', () => this.matchManager.togglePause());
    this.keys.r.on('down', () => {
      if (this.setup?.onMatchEnd) return; // tournament match — R disabled
      this.matchManager.reset();
      this.resetPositions();
      for (const p of this.allPlayers()) p.currentStamina = 100;
      this.stats.reset();
      this.statsOverlay?.destroy();
      this.statsOverlay = null;
    });
    this.keys.t.on('down', () => {
      if (this.matchManager.state !== 'finished') return;
      this.deliverMatchEnd();
    });
    this.keys.one.on('down', () => { this.time.timeScale = 2; });
    this.keys.two.on('down', () => { this.time.timeScale = 1; });

    // Tactical phase control for Team A (repeat key = cancel override → auto)
    // Q = Pressão Alta  W = Forma  E = Construção
    // H = cycle heat map debug overlay (off → Team A → Team B → off)
    // D = toggle state rings debug (GK dive / dribble / carry indicators)
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.H).on('down', () => {
      this.heatMapMode = ((this.heatMapMode + 1) % 4) as 0 | 1 | 2 | 3;
      this.heatMapLabel.setVisible(this.heatMapMode !== 0);
    });
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.D).on('down', () => {
      Player.debugRings = !Player.debugRings;
    });

    kb.addKey(Phaser.Input.Keyboard.KeyCodes.Q).on('down', () => {
      this.aiA.setManualPhase(this.aiA.getManualPhase() === 'high-press' ? null : 'high-press');
    });
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.W).on('down', () => {
      this.aiA.setManualPhase(this.aiA.getManualPhase() === 'hold-shape' ? null : 'hold-shape');
    });
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.E).on('down', () => {
      this.aiA.setManualPhase(this.aiA.getManualPhase() === 'build-up' ? null : 'build-up');
    });
  }

  // ──────────────────────────────────────────────
  // Player collision separation
  // ──────────────────────────────────────────────

  // Gentle drift-apart: apply only 20 % of the overlap per frame so players
  // smoothly glide away from each other instead of snapping/jittering.
  // Hard collision is handled mechanically only via tackles.
  private applyPlayerTrafficAvoidance(): void {
    const players = this.allPlayers();
    const LOOKAHEAD = 86;
    const LANE_WIDTH = 42;
    const AVOID_STRENGTH = 48;

    for (const p of players) {
      p.avoidanceX = 0;
      p.avoidanceY = 0;
    }

    for (const p of players) {
      if (p.state === PlayerState.GkDive) continue;

      const tx = p.targetX - p.x;
      const ty = p.targetY - p.y;
      const targetDist = Math.sqrt(tx * tx + ty * ty);
      if (targetDist < 12) continue;

      const dirX = tx / targetDist;
      const dirY = ty / targetDist;
      const perpX = -dirY;
      const perpY = dirX;

      // Navigating players (off-ball, seeking space) scan farther ahead and
      // react more strongly to opponents so they find gaps instead of barging
      // straight through defensive clusters.
      const isNavigating = !p.hasBall
        && p.role !== PlayerRole.Goalkeeper
        && (p.state === PlayerState.FindSpace || p.state === PlayerState.ReturnToShape);

      for (const blocker of players) {
        if (blocker === p) continue;

        const isOpp = blocker.teamId !== p.teamId;
        const lookahead  = isNavigating && isOpp ? LOOKAHEAD  * 1.65 : LOOKAHEAD;
        const laneWidth  = isNavigating && isOpp ? LANE_WIDTH * 1.35 : LANE_WIDTH;

        const relX = blocker.x - p.x;
        const relY = blocker.y - p.y;
        const forward = relX * dirX + relY * dirY;
        if (forward < -6 || forward > lookahead) continue;

        const lateral = relX * perpX + relY * perpY;
        const lateralAbs = Math.abs(lateral);
        if (lateralAbs > laneWidth) continue;

        const side = lateralAbs < 2
          ? (p.id < blocker.id ? -1 : 1)
          : (lateral > 0 ? -1 : 1);
        const forwardWeight = 1 - Math.max(0, forward) / lookahead;
        const lateralWeight = 1 - lateralAbs / laneWidth;
        const navOppMult = isNavigating && isOpp ? 2.1 : 1.0;
        const strength = AVOID_STRENGTH * forwardWeight * lateralWeight * navOppMult;

        p.avoidanceX += perpX * side * strength;
        p.avoidanceY += perpY * side * strength;
      }

      // Wider cap for navigating players so the larger forces don't get clipped.
      const cap = isNavigating ? 82 : 55;
      p.avoidanceX = clamp(p.avoidanceX, -cap, cap);
      p.avoidanceY = clamp(p.avoidanceY, -cap, cap);
    }
  }

  private resolvePlayerCollisions(): void {
    const players = this.allPlayers();
    const MIN_DIST = 22;
    const PUSH = 0.20; // fraction of overlap corrected per frame
    const ITERATIONS = 3;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          const a = players[i];
          const b = players[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dSq = dx * dx + dy * dy;
          if (dSq >= MIN_DIST * MIN_DIST || dSq === 0) continue;

          const d = Math.sqrt(dSq);
          const nudge = (MIN_DIST - d) * PUSH;
          const nx = dx / d;
          const ny = dy / d;
          const aDiving = a.state === PlayerState.GkDive;
          const bDiving = b.state === PlayerState.GkDive;
          const massA = a.getBodyMassFactor();
          const massB = b.getBodyMassFactor();
          const massTotal = massA + massB;
          const aShare = aDiving ? 0 : bDiving ? 1 : massB / massTotal;
          const bShare = bDiving ? 0 : aDiving ? 1 : massA / massTotal;

          // Light velocity deflection — just enough to make players curve around
          // each other; heavy deflection caused visible stumbling/direction changes
          const velocityNudge = nudge * 0.4;
          if (!a.hasBall && !aDiving) {
            a.vx -= nx * velocityNudge * aShare;
            a.vy -= ny * velocityNudge * aShare;
          }
          if (!b.hasBall && !bDiving) {
            b.vx += nx * velocityNudge * bShare;
            b.vy += ny * velocityNudge * bShare;
          }

          // Stronger positional correction to actually separate overlapping bodies
          const posNudge = nudge * 1.2;
          if (!a.hasBall && !aDiving) {
            a.x = clamp(a.x - nx * posNudge * aShare, FIELD.left + 15, FIELD.right - 15);
            a.y = clamp(a.y - ny * posNudge * aShare, FIELD.top + 15, FIELD.bottom - 15);
          }
          if (!b.hasBall && !bDiving) {
            b.x = clamp(b.x + nx * posNudge * bShare, FIELD.left + 15, FIELD.right - 15);
            b.y = clamp(b.y + ny * posNudge * bShare, FIELD.top + 15, FIELD.bottom - 15);
          }
        }
      }
    }
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  private allPlayers(): Player[] {
    return [...this.teamA.players, ...this.teamB.players];
  }

  private showStatsOverlay(): void {
    const sA = this.stats.getStats('teamA');
    const sB = this.stats.getStats('teamB');
    const totalPoss = this.stats.totalPossessionMs();
    const possA = totalPoss > 0 ? Math.round((sA.possessionMs / totalPoss) * 100) : 50;
    const possB = 100 - possA;
    const accA = sA.passes > 0 ? Math.round((sA.passesCompleted / sA.passes) * 100) : 0;
    const accB = sB.passes > 0 ? Math.round((sB.passesCompleted / sB.passes) * 100) : 0;
    const scA = this.matchManager.scoreA;
    const scB = this.matchManager.scoreB;

    const W = 630, H = 390;
    const cx = GAME_WIDTH / 2;
    const cy = (FIELD.top + FIELD.bottom) / 2;

    const c = this.add.container(cx, cy).setDepth(30);
    this.statsOverlay = c;

    // Background panel
    const bg = this.add.rectangle(0, 0, W, H, 0x0f172a, 0.95);
    bg.setStrokeStyle(2, 0x1e3a5f);
    c.add(bg);

    // Team color strips
    c.add(this.add.rectangle(-W / 2 + 68, -H / 2 + 5, 136, 4, this.teamA.color));
    c.add(this.add.rectangle(W / 2 - 68, -H / 2 + 5, 136, 4, this.teamB.color));

    // Title
    c.add(this.add.text(0, -H / 2 + 24, 'FIM DE JOGO', {
      fontSize: '20px', color: '#f8fafc', fontStyle: 'bold', fontFamily: 'Nunito', resolution: 2,
    }).setOrigin(0.5));

    // Score line
    c.add(this.add.text(-90, -H / 2 + 54, this.teamA.name, {
      fontSize: '13px', color: '#93c5fd', fontFamily: 'Nunito', fontStyle: 'bold', resolution: 2,
    }).setOrigin(1, 0.5));
    c.add(this.add.text(0, -H / 2 + 54, `${scA}  —  ${scB}`, {
      fontSize: '18px', fontStyle: 'bold', fontFamily: 'Nunito', resolution: 2,
      color: scA !== scB ? '#f8fafc' : '#e2e8f0',
    }).setOrigin(0.5));
    c.add(this.add.text(90, -H / 2 + 54, this.teamB.name, {
      fontSize: '13px', color: '#fca5a5', fontFamily: 'Nunito', fontStyle: 'bold', resolution: 2,
    }).setOrigin(0, 0.5));

    // Divider
    c.add(this.add.rectangle(0, -H / 2 + 74, W - 60, 1, 0x334155));

    // Stats rows: [label, valueA, valueB]
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
      if (i % 2 === 0) c.add(this.add.rectangle(0, y, W - 60, rowH - 2, 0x1e293b, 0.55));

      c.add(this.add.text(0, y, label, {
        fontSize: '11px', color: '#64748b', fontFamily: 'Nunito', resolution: 2,
      }).setOrigin(0.5));
      c.add(this.add.text(-205, y, String(vA), {
        fontSize: '13px', color: '#93c5fd', fontStyle: 'bold', fontFamily: 'Nunito', resolution: 2,
      }).setOrigin(0.5));
      c.add(this.add.text(205, y, String(vB), {
        fontSize: '13px', color: '#fca5a5', fontStyle: 'bold', fontFamily: 'Nunito', resolution: 2,
      }).setOrigin(0.5));
    });

    // Footer
    c.add(this.add.rectangle(0, H / 2 - 40, W - 60, 1, 0x334155));
    const footerText = this.setup?.onMatchEnd
      ? '[T]  Voltar ao Campeonato'
      : '[R]  Novo Jogo';
    c.add(this.add.text(0, H / 2 - 20, footerText, {
      fontSize: '12px', color: '#475569', fontFamily: 'Nunito', resolution: 2,
    }).setOrigin(0.5));
  }

  private phaseLabel(phase: TacticalPhase, manual: boolean): string {
    const labels: Record<TacticalPhase, string> = {
      'build-up':      'CONSTRUÇÃO',
      'hold-shape':    'FORMA',
      'high-press':    'PRESSÃO ALTA',
      'counterattack': 'CONTRA-ATAQUE',
    };
    return labels[phase] + (manual ? ' [M]' : '');
  }

  private isBallInDangerArea(): boolean {
    return Math.abs(this.ball.x - GOAL_LEFT.centerX) < 245
      || Math.abs(this.ball.x - GOAL_RIGHT.centerX) < 245;
  }

  private shouldSprintForRace(player: Player, opponent: Player, targetX: number, targetY: number): boolean {
    const playerDist = dist(player.x, player.y, targetX, targetY);
    const opponentDist = dist(opponent.x, opponent.y, targetX, targetY);
    if (playerDist > 210 || opponentDist > 230) return false;

    const playerTime = this.estimatedArrivalFrames(player, playerDist, false);
    const opponentTime = this.estimatedArrivalFrames(opponent, opponentDist, opponent.isSprinting());
    const closeRace = playerTime < opponentTime + 18;
    const opponentThreat = opponent.isSprinting() || opponentTime < playerTime + 12;

    return closeRace && opponentThreat && player.currentStamina > 18;
  }

  private estimatedArrivalFrames(player: Player, distance: number, sprinting: boolean): number {
    const baseSpeed = Math.max(0.35, (player.stats.speed / 100) * 1.85 * player.getStaminaFactor());
    const sprintMult = sprinting ? 1.28 : 1.0;
    return distance / (baseSpeed * sprintMult);
  }

  // Projects where the ball will be when `player` arrives, factoring in friction decay.
  // Players with higher intelligence anticipate more of the trajectory; low-intel players
  // react closer to the current position. Returns current ball position if ball is near-stopped.
  // How long (ms) a player needs before making their first with-ball decision.
  // High dribbling = settles the ball faster; high intelligence = reads situation faster.
  // Pressure (opponent nearby) shortens the window — urgency forces the decision.
  private settleTime(player: Player, nearestOpp: Player | null): number {
    const skill = (player.stats.dribbling * 0.6 + player.stats.intelligence * 0.4) / 100; // 0–1
    const oppDist = nearestOpp ? nearestOpp.distanceTo(player) : 999;
    const pressure = clamp((85 - oppDist) / 85, 0, 1); // 0 = free, 1 = opponent right on you
    const base = 220 - skill * 165;           // 55 ms (elite) to 220 ms (poor)
    const urgency = pressure * 85;            // up to 85 ms faster under pressure
    const noise = (Math.random() - 0.5) * 44; // +/-22 ms variation, less visible stutter
    return clamp(Math.round(base - urgency + noise), 20, 260);
  }

  private projectBallIntercept(player: Player): { x: number; y: number } {
    const speed = this.ball.getSpeed();
    if (speed < 0.8) return { x: this.ball.x, y: this.ball.y };

    const d = dist(player.x, player.y, this.ball.x, this.ball.y);
    const playerSpeed = Math.max(0.4, (player.stats.speed / 100) * 1.85 * player.getStaminaFactor());
    const frames = clamp(d / playerSpeed, 0, 90);

    // Geometric series: sum of friction^i for i=0..frames-1 gives total displacement
    const displacementFactor = (1 - Math.pow(BALL_FRICTION, frames)) / (1 - BALL_FRICTION);

    // Intelligence scales how much the player anticipates vs. chasing current position.
    // Range: 0.35 (intel=0) → 1.0 (intel=100)
    const anticipation = 0.62 + (player.stats.intelligence / 100) * 0.38;

    return {
      x: clamp(this.ball.x + this.ball.velocity.x * displacementFactor * anticipation, FIELD.left + 15, FIELD.right - 15),
      y: clamp(this.ball.y + this.ball.velocity.y * displacementFactor * anticipation, FIELD.top + 15, FIELD.bottom - 15),
    };
  }

  private planReceptionTarget(player: Player, nearestOpp: Player | null): { x: number; y: number; urgency: number } {
    const ballSpeed = this.ball.getSpeed();
    const ballDist = dist(this.ball.x, this.ball.y, player.x, player.y);
    const intercept = this.projectBallIntercept(player);

    if (ballSpeed < 0.8) {
      return { x: this.ball.x, y: this.ball.y, urgency: clamp(ballDist / 90, 0, 1) };
    }

    const invSpeed = 1 / ballSpeed;
    const ballDirX = this.ball.velocity.x * invSpeed;
    const ballDirY = this.ball.velocity.y * invSpeed;
    const perpX = -ballDirY;
    const perpY = ballDirX;
    const oppDist = nearestOpp ? nearestOpp.distanceTo(player) : 999;
    const pressure = clamp((82 - oppDist) / 82, 0, 1);
    const closeControl = clamp((70 - ballDist) / 70, 0, 1);
    const slowBall = clamp((3.4 - ballSpeed) / 3.4, 0, 1);

    const meetBall = slowBall * 0.68 + pressure * 0.18;
    const cushion = 5 + closeControl * 8 + pressure * 4 - slowBall * 4;
    let receiveX = intercept.x * (1 - meetBall) + this.ball.x * meetBall - ballDirX * cushion;
    let receiveY = intercept.y * (1 - meetBall) + this.ball.y * meetBall - ballDirY * cushion;

    let lateralSign = player.y < FIELD.centerY ? 1 : -1;
    if (nearestOpp && oppDist < 95) {
      const awayX = player.x - nearestOpp.x;
      const awayY = player.y - nearestOpp.y;
      lateralSign = (awayX * perpX + awayY * perpY) >= 0 ? 1 : -1;
    }

    const openBody = (1 - pressure) * 5 + closeControl * 3;
    receiveX += perpX * lateralSign * openBody;
    receiveY += perpY * lateralSign * openBody;

    if (nearestOpp && pressure > 0) {
      const awayX = player.x - nearestOpp.x;
      const awayY = player.y - nearestOpp.y;
      const awayLen = Math.sqrt(awayX * awayX + awayY * awayY) || 1;
      const shield = pressure * 8;
      receiveX += (awayX / awayLen) * shield;
      receiveY += (awayY / awayLen) * shield;
    }

    const urgency = clamp(ballDist / 95 + ballSpeed / 9 + pressure * 0.28 - closeControl * 0.34, 0, 1);
    return {
      x: clamp(receiveX, FIELD.left + 15, FIELD.right - 15),
      y: clamp(receiveY, FIELD.top + 15, FIELD.bottom - 15),
      urgency,
    };
  }

  // Sets a short movement target immediately after a player receives the ball so they
  // don't stand frozen during the settle-time cooldown. Under pressure they shield away
  // from the nearest opponent; in space they take a small step in the attack direction.
  private applyFirstTouchMovement(player: Player, nearestOpp: Player | null): void {
    const attackDir = player.attackDirection;
    if (nearestOpp && nearestOpp.distanceTo(player) < 75) {
      const dx = player.x - nearestOpp.x;
      const dy = player.y - nearestOpp.y;
      const dlen = Math.sqrt(dx * dx + dy * dy) || 1;
      player.setTarget(
        clamp(player.x + (dx / dlen) * 28 + attackDir * 10, FIELD.left + 15, FIELD.right - 15),
        clamp(player.y + (dy / dlen) * 20, FIELD.top + 15, FIELD.bottom - 15),
      );
      player.vx += ((dx / dlen) * 0.85 + attackDir * 0.25) * player.getStaminaFactor();
      player.vy += (dy / dlen) * 0.65 * player.getStaminaFactor();
    } else {
      player.setTarget(
        clamp(player.x + attackDir * 26, FIELD.left + 15, FIELD.right - 15),
        player.y,
      );
      player.vx += attackDir * 0.9 * player.getStaminaFactor();
    }
    if (player.currentStamina > 18) player.forceSprint(180);
  }

  private applyKickFollowThrough(player: Player, angle: number, impulse: number): void {
    const targetDistance = 38 + player.stats.speed * 0.22;
    player.vx += Math.cos(angle) * impulse;
    player.vy += Math.sin(angle) * impulse;
    player.setTarget(
      clamp(player.x + Math.cos(angle) * targetDistance, FIELD.left + 15, FIELD.right - 15),
      clamp(player.y + Math.sin(angle) * targetDistance, FIELD.top + 20, FIELD.bottom - 20),
    );
  }

  private findOpenSpaceAfterPass(player: Player): { tx: number; ty: number } | null {
    const ownTeam = player.teamId === 'teamA' ? this.teamA : this.teamB;
    const oppTeam = player.teamId === 'teamA' ? this.teamB : this.teamA;
    const ownGoal = player.teamId === 'teamA' ? GOAL_LEFT : GOAL_RIGHT;
    const oppGoal = player.teamId === 'teamA' ? GOAL_RIGHT : GOAL_LEFT;
    const ctx: AIContext = {
      ball: this.ball,
      ownTeam,
      oppTeam,
      ownGoal,
      oppGoal,
      field: FIELD,
    };
    return findAttackingOpenSpace(player, ctx);
  }

  private spawnGoalConfetti(scoringTeamId: string): void {
    const goal    = scoringTeamId === 'teamA' ? GOAL_RIGHT : GOAL_LEFT;
    const centerX = goal.centerX;
    const centerY = (goal.top + goal.bottom) / 2;
    const COLORS  = [0xff4444, 0xffdd00, 0x44ff88, 0x4499ff, 0xff44cc, 0xffffff, 0xff8833];

    for (let burst = 0; burst < 4; burst++) {
      this.time.delayedCall(burst * 180, () => {
        const bx = centerX + (Math.random() - 0.5) * 130;
        const by = centerY + (Math.random() - 0.5) * 90;

        for (let i = 0; i < 22; i++) {
          const angle  = Math.random() * Math.PI * 2;
          const speed  = 40 + Math.random() * 90;
          const color  = COLORS[Math.floor(Math.random() * COLORS.length)];
          const w      = 4 + Math.random() * 5;
          const h      = 3 + Math.random() * 3;

          const piece = this.add.rectangle(bx, by, w, h, color, 1).setDepth(12);
          piece.setRotation(Math.random() * Math.PI * 2);

          this.tweens.add({
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

  private drawHeatMapDebug(): void {
    this.heatMapGfx.clear();
    if (this.heatMapMode === 0) return;

    // teamIdx: 0=A  1=B  2=global
    type HIdx = 0 | 1 | 2;
    const isGlobal = this.heatMapMode === 3;
    const teamIdx: HIdx = isGlobal ? 2 : (this.heatMapMode - 1) as HIdx;
    const baseColor = isGlobal ? 0xf59e0b  // amber = global
      : teamIdx === 0 ? 0x3b82f6            // blue  = teamA
      : 0xef4444;                           // red   = teamB
    const label = isGlobal
      ? 'GLOBAL'
      : teamIdx === 0 ? this.teamA.name : this.teamB.name;

    const { cols, rows, cellW, cellH } = this.heatMap;

    // Find max heat for adaptive normalisation so the palette always fills
    // the full range regardless of how spread-out or clustered players are.
    let maxHeat = 0.1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = FIELD.left + (c + 0.5) * cellW;
        const wy = FIELD.top + (r + 0.5) * cellH;
        const h = this.heatMap.getHeat(wx, wy, teamIdx);
        if (h > maxHeat) maxHeat = h;
      }
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = FIELD.left + c * cellW;
        const wy = FIELD.top + r * cellH;
        const heat = this.heatMap.getHeat(wx + cellW * 0.5, wy + cellH * 0.5, teamIdx);
        if (heat < 0.05) continue;
        const norm = heat / maxHeat;           // 0..1 relative to current frame peak
        const alpha = norm * 0.60;             // max 60 % opacity at the hottest cell
        this.heatMapGfx.fillStyle(baseColor, alpha);
        this.heatMapGfx.fillRect(wx + 1, wy + 1, cellW - 2, cellH - 2);
      }
    }

    this.heatMapLabel.setText(`HEAT: ${label}  [H] para trocar`);
  }
}

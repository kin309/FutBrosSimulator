import Phaser from 'phaser';
import { Ball } from '../entities/Ball';
import { Player } from '../entities/Player';
import { Team } from '../entities/Team';
import { MatchManager } from '../systems/MatchManager';
import { Scoreboard } from '../systems/Scoreboard';
import { EventResolver } from '../systems/EventResolver';
import { TeamAI } from '../ai/TeamAI';
import { FieldHeatMap } from '../ai/FieldHeatMap';
import { TacticalPhase, GameContext } from '../ai/TacticalAI';
import type { MatchSetup } from '../FootballGame';
import { createTeams } from '../data/TeamFactory';
import { DEFAULT_TACTICAL_PROFILE, TacticalProfile } from '../data/TacticalProfile';
import { showHalftimePanel } from '../../draft/HalftimePanel';
import { StatsTracker } from '../systems/StatsTracker';
import { PlayerRole } from '../data/PlayerRole';
import { PlayerState } from '../data/PlayerState';
import { dist, clamp } from '../utils/MathUtils';
import { planReceptionTarget } from '../physics/BallProjection';
import { GAME_WIDTH, HUD_HEIGHT, FIELD, GOAL_LEFT, GOAL_RIGHT, GOAL_LINE_LEFT, GOAL_LINE_RIGHT } from '../constants';
import { BALL_PHYSICS } from '../physics/BallPhysics';
import { projectBallAtFrames, findBallFramesToX, findClosestBallFrameToPlayer } from '../physics/BallProjection';
import { drawField } from '../rendering/FieldRenderer';
import { MatchVisuals } from '../rendering/MatchVisuals';
import { GoalkeeperSystem } from '../systems/GoalkeeperSystem';
import { PlayerKickSystem } from '../systems/PlayerKickSystem';
import { BallContactSystem } from '../systems/BallContactSystem';
import { PlayerMovementSystem } from '../systems/PlayerMovementSystem';
import { MatchFlowSystem } from '../systems/MatchFlowSystem';
import { SpectatorSystem } from '../systems/SpectatorSystem';
import type { MatchContext } from '../systems/MatchContext';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function complementaryColor(hex: number): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 0xaaff00; // achromatic fallback
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0)
        : max === g ? (b - r) / d + 2
        :             (r - g) / d + 4;
  h = ((h / 6) + 0.5) % 1.0; // rotate 180°
  const hue2rgb = (p: number, q: number, t: number) => {
    const tt = ((t % 1) + 1) % 1;
    if (tt < 1/6) return p + (q - p) * 6 * tt;
    if (tt < 1/2) return q;
    if (tt < 2/3) return p + (q - p) * (2/3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const rr = Math.round(hue2rgb(p, q, h + 1/3) * 255);
  const gg = Math.round(hue2rgb(p, q, h) * 255);
  const bb = Math.round(hue2rgb(p, q, h - 1/3) * 255);
  return (rr << 16) | (gg << 8) | bb;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Physical contact distance: player radius (14) + ball radius (7) + 1px tolerance
const CONTACT_RADIUS: number = BALL_PHYSICS.contactRadius;
const BALL_PICKUP_RADIUS: number = BALL_PHYSICS.pickupRadius;

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
  private visuals!: MatchVisuals;
  private gkSystem!: GoalkeeperSystem;
  private kickSystem!: PlayerKickSystem;
  private contactSystem!: BallContactSystem;
  private movementSystem!: PlayerMovementSystem;
  private flowSystem!: MatchFlowSystem;
  private spectatorSystem!: SpectatorSystem;
  private gkDiveDebugTtlMs = 0;
  private matchEndDelivered = false;
  private halftimeExitActive = false;
  private previousPossessorTeamId: string | null = null;
  private halftimeExitSpeeds = new Map<string, number>();
  private currentTacticalProfileA: TacticalProfile = DEFAULT_TACTICAL_PROFILE;
  private simulationSpeed = 1.0;
  private speedIndicator!: Phaser.GameObjects.Text;

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
    drawField(this);
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

    const ctx: MatchContext = {
      ball: this.ball,
      teamA: this.teamA,
      teamB: this.teamB,
      matchManager: this.matchManager,
      scoreboard: this.scoreboard,
      stats: this.stats,
      resolver: this.resolver,
      tackleCooldowns: this.tackleCooldowns,
      field: FIELD,
      goalLeft: GOAL_LEFT,
      goalRight: GOAL_RIGHT,
      setup: this.setup,
      gkSystem: null,
      kickSystem: null,
      allPlayers: () => this.allPlayers(),
      recalculateRoutesAfterBallTrajectoryChange: (prev) => this.recalculateRoutesAfterBallTrajectoryChange(prev),
      shouldSprintForRace: (player, opponent, tx, ty) => this.movementSystem.shouldSprintForRace(player, opponent, tx, ty),
      isBallInDangerArea: () => this.isBallInDangerArea(),
      spawnGoalConfetti: (id) => this.visuals.spawnGoalConfetti(id),
      showHalftimeBanner: () => this.visuals.showHalftimeBanner(),
    };

    this.gkSystem = new GoalkeeperSystem(ctx);
    ctx.gkSystem = this.gkSystem;

    this.kickSystem = new PlayerKickSystem(ctx);
    ctx.kickSystem = this.kickSystem;

    this.contactSystem = new BallContactSystem(ctx);
    this.movementSystem = new PlayerMovementSystem(ctx);
    this.flowSystem = new MatchFlowSystem(ctx);

    this.speedIndicator = this.add.text(GAME_WIDTH - 8, 8, '⚡ 2x', {
      fontSize: '13px',
      fontStyle: 'bold',
      fontFamily: 'Nunito',
      color: '#fbbf24',
      stroke: '#000000',
      strokeThickness: 2,
      resolution: 2,
    }).setOrigin(1, 0).setDepth(22).setVisible(false);

    this.visuals = new MatchVisuals(this, {
      matchManager: this.matchManager,
      stats: this.stats,
      teamA: this.teamA,
      teamB: this.teamB,
      setup: this.setup,
      getHeatMap: () => this.heatMap,
      heatMapGfx: this.heatMapGfx,
      heatMapLabel: this.heatMapLabel,
      getHeatMapMode: () => this.heatMapMode,
    });

    this.spectatorSystem = new SpectatorSystem(ctx);

    if (this.setup?.spectatorMode) {
      this.spectatorSystem.init();
      return;
    }

    this.aiA = new TeamAI(this.teamA);
    this.aiB = new TeamAI(this.teamB);
    if (this.setup?.tacticalProfileA) {
      this.currentTacticalProfileA = this.setup.tacticalProfileA;
      this.aiA.setTacticalProfile(this.setup.tacticalProfileA);
    }
    this.heatMap = new FieldHeatMap(FIELD.left, FIELD.top, FIELD.right, FIELD.bottom);
    this.wireEvents();
    this.setupKeys();
    this.flowSystem.resetPlayersToKickoffShape();
    this.flowSystem.giveKickoff('teamA');
  }

  update(_time: number, delta: number): void {
    if (this.setup?.spectatorMode) {
      this.spectatorSystem.update(delta);
      return;
    }

    const simDelta = delta * this.simulationSpeed;

    this.matchManager.update(simDelta);
    this.spectatorSystem.tickLiveUpdate(simDelta);
    if (this.matchManager.isPaused) return;
    if (this.matchManager.state === 'halftime') {
      if (this.halftimeExitActive) {
        for (const p of this.allPlayers()) {
          p.y += (this.halftimeExitSpeeds.get(p.id) ?? 0.1) * delta;
        }
      }
      return;
    }
    if (this.matchManager.state === 'goalScored' || this.matchManager.state === 'finished') return;

    // Tick cooldowns
    for (const [id, cd] of this.tackleCooldowns) {
      if (cd > 0) this.tackleCooldowns.set(id, Math.max(0, cd - simDelta));
    }
    this.gkSystem.gkDiveHoldoffMs = Math.max(0, this.gkSystem.gkDiveHoldoffMs - simDelta);
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

    // Transition detection: when possession changes hands, bypass cooldowns so players react immediately
    if (possessorTeamId !== null) {
      if (this.previousPossessorTeamId !== null && this.previousPossessorTeamId !== possessorTeamId) {
        this.triggerTransitionReaction(possessorTeamId, this.previousPossessorTeamId);
      }
      this.previousPossessorTeamId = possessorTeamId;
    }

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
    this.visuals.drawHeatMapDebug();
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
    this.contactSystem.chaseFreeeBall();

    // Spread teammate targets so they don't converge on the same spot
    this.movementSystem.separateTeamTargets(this.teamA);
    this.movementSystem.separateTeamTargets(this.teamB);

    // Execute pending actions
    this.processPlayerActions();

    this.gkSystem.updateGoalkeeperDives();

    // Route around nearby bodies before steering so players circle blockers instead of piling up
    this.movementSystem.applyPlayerTrafficAvoidance();

    // Move players
    for (const p of this.allPlayers()) {
      p.updatePlayer(simDelta, FIELD);
      p.updateLabelAlpha(this.ball.x, this.ball.y);
    }

    this.contactSystem.checkFreeBall();  // free-ball pickup before body separation can push players off it

    // Separate overlapping players
    this.movementSystem.resolvePlayerCollisions();

    this.movementSystem.checkTackles();
    this.contactSystem.checkPassArrival();        // resolve intended receiver / abandon stale passes
    this.contactSystem.checkBallPlayerContacts(); // physical collision: interception + teammate deflection
    this.contactSystem.checkFreeBall();           // second pass for deflections created this frame
    this.scoreboard.update();

    if (this.matchManager.state === 'advantage') {
      this.flowSystem.updateAdvantage(simDelta);
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
      const isGK = pd.role === PlayerRole.Goalkeeper;
      const pColor = isGK ? complementaryColor(dataA.color) : dataA.color;
      const pSecondary = isGK ? dataA.color : (dataA.secondaryColor ?? 0x000000);
      const p = new Player(this, pd.baseX, pd.baseY, pd.id, pd.name, pd.jerseyNumber, 'teamA', pd.role, pd.stats, pColor, pd.heightCm, pd.weightKg, pd.playstyles ?? [], pd.playstylesPlus ?? [], dataA.numberColor ?? 0xffffff, pSecondary, dataA.kitPattern ?? 'solid', true);
      this.teamA.players.push(p);
      this.tackleCooldowns.set(pd.id, 0);
    }
    for (const pd of dataB.players) {
      const isGK = pd.role === PlayerRole.Goalkeeper;
      const pColor = isGK ? complementaryColor(dataB.color) : dataB.color;
      const pSecondary = isGK ? dataB.color : (dataB.secondaryColor ?? 0x000000);
      const p = new Player(this, pd.baseX, pd.baseY, pd.id, pd.name, pd.jerseyNumber, 'teamB', pd.role, pd.stats, pColor, pd.heightCm, pd.weightKg, pd.playstyles ?? [], pd.playstylesPlus ?? [], dataB.numberColor ?? 0xffffff, pSecondary, dataB.kitPattern ?? 'solid', false);
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
      this.spectatorSystem.emitLiveUpdate(`GOL! ${scorer.name} marca!`, { type: 'goal', text: scorer.name, teamId });
      this.visuals.spawnGoalConfetti(teamId);

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
      if (this.flowSystem.isAdvantageActive) {
        // Goal scored during advantage → end match after goal animation
        this.flowSystem.endAdvantage();
      } else {
        this.flowSystem.resetPositions();
      }
    };
    this.matchManager.onFinished = () => {
      this.scoreboard.showFinished(!!this.setup?.onMatchEnd);
      this.spectatorSystem.emitLiveUpdate('Fim de jogo', { type: 'finished' });
      this.visuals.showStatsOverlay();
      if (this.setup?.autoFinishDelayMs !== undefined) {
        this.time.delayedCall(this.setup.autoFinishDelayMs, () => this.deliverMatchEnd());
      }
    };
    this.matchManager.onHalftime = () => {
      this.scoreboard.logEvent(`45' — Intervalo`);
      this.spectatorSystem.emitLiveUpdate('Intervalo', { type: 'halftime' });
      this.ball.release();
      this.ball.velocity = { x: 0, y: 0 };
      this.halftimeExitActive = true;
      this.halftimeExitSpeeds.clear();
      for (const p of this.allPlayers()) {
        this.halftimeExitSpeeds.set(p.id, 0.02 + Math.random() * 0.05);
      }
      if (!this.setup?.onHalftime) this.visuals.showHalftimeBanner();
    };
    this.matchManager.onHalftimeEnd = () => {
      this.halftimeExitActive = false;
      this.spectatorSystem.emitLiveUpdate(undefined, { type: 'halftime-end' });

      const startSecondHalf = () => {
        this.flowSystem.swapSides();
        this.flowSystem.resetPlayersToKickoffShape();
        this.ball.release();
        this.ball.setPosition(FIELD.centerX, FIELD.centerY);
        this.ball.velocity = { x: 0, y: 0 };
        this.ball.resetFlight();
        this.flowSystem.giveKickoff('teamB');
      };

      if (!this.setup?.spectatorMode) {
        this.matchManager.isPaused = true;
        const halftimeCb = this.setup?.onHalftime ?? showHalftimePanel;
        halftimeCb({
          scoreA: this.matchManager.scoreA,
          scoreB: this.matchManager.scoreB,
          teamAName: this.setup?.teams[0].name ?? '',
          teamBName: this.setup?.teams[1].name ?? '',
          currentProfile: this.currentTacticalProfileA,
          applyTactic: (profile) => {
            this.currentTacticalProfileA = profile;
            this.aiA.setTacticalProfile(profile);
          },
          resume: () => {
            this.matchManager.isPaused = false;
            startSecondHalf();
          },
        });
      } else {
        startSecondHalf();
      }
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
      const baseMin = this.matchManager.half === 1 ? 45 : 90;
      const advText = this.add.text(GAME_WIDTH / 2, HUD_HEIGHT + 4, `⏱ ${baseMin}' — Vantagem de ataque`, {
        fontSize: '13px',
        fontStyle: 'bold',
        fontFamily: 'Nunito',
        color: '#fbbf24',
        stroke: '#000000',
        strokeThickness: 2,
        resolution: 2,
      }).setOrigin(0.5, 0).setDepth(25);
      this.flowSystem.beginAdvantage(referencePlayer.teamId, this.ball.x, advText);
    };
  }

  private deliverMatchEnd(): void {
    if (this.matchEndDelivered) return;
    this.matchEndDelivered = true;
    this.setup?.onMatchEnd?.(this.matchManager.scoreA, this.matchManager.scoreB);
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
          this.kickSystem.doPass(p, p.passTarget);
          p.passTarget = null;
        }
        // else: keep walking toward pre-pass position

      } else if (p.state === PlayerState.Shoot) {
        this.kickSystem.doShot(p);

      } else if (p.state === PlayerState.Clearance) {
        const dx = p.x - p.targetX;
        const dy = p.y - p.targetY;
        if (Math.sqrt(dx * dx + dy * dy) < 14) {
          this.kickSystem.doClearance(p);
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
      const p = projectBallAtFrames(this.ball, (framesToGoal * i) / samples);
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


  private doDribble(carrier: Player, blocker: Player): void {
    carrier.dribbleTarget = null;
    carrier.dribbleCommitMs = 0;
    carrier.dribbleContactRadius = 38;

    const success = this.resolver.resolveDribble(carrier, blocker);

    if (success) {
      // Burst past — push velocity toward the pre-chosen target direction so the
      // player cuts along the side chosen by the AI, not always straight forward.
      const dir = carrier.attackDirection;
      // Skilled dribblers burst harder: stat=60→780ms, stat=91→873ms, stat=100→900ms
      carrier.requestSprint(600 + carrier.stats.dribbling * 3);
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

  // ──────────────────────────────────────────────
  // Pass arrival
  // ──────────────────────────────────────────────

  private recalculateRoutesAfterBallTrajectoryChange(previousTarget?: Player | null): void {
    if (this.ball.owner) return;

    if (previousTarget && this.ball.targetPlayer !== previousTarget && !previousTarget.hasBall) {
      previousTarget.state = PlayerState.FindSpace;
      previousTarget.aiCooldown = 0;
    }

    const target = this.ball.targetPlayer as Player | null;
    if (target && target.state === PlayerState.ReceivePass) {
      const oppTeam = target.teamId === 'teamA' ? this.teamB : this.teamA;
      const reception = planReceptionTarget(this.ball, target, oppTeam.getNearestPlayerTo(target.x, target.y), FIELD);
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

    this.contactSystem.chaseFreeeBall();
  }


  // ──────────────────────────────────────────────
  // Kickoff & reset
  // ──────────────────────────────────────────────


  private isInAttackingHalf(player: Player): boolean {
    const team = player.teamId === 'teamA' ? this.teamA : this.teamB;
    return team.attackDirection > 0
      ? this.ball.x >= FIELD.centerX
      : this.ball.x <= FIELD.centerX;
  }

  // ──────────────────────────────────────────────
  // Keys
  // ──────────────────────────────────────────────

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
      this.flowSystem.resetPositions();
      for (const p of this.allPlayers()) p.currentStamina = 100;
      this.stats.reset();
      this.visuals.statsOverlay?.destroy();
      this.visuals.statsOverlay = null;
    });
    this.keys.t.on('down', () => {
      if (this.matchManager.state !== 'finished') return;
      this.deliverMatchEnd();
    });
    this.keys.one.on('down', () => {
      this.simulationSpeed = 2.0;
      this.speedIndicator.setVisible(true);
    });
    this.keys.two.on('down', () => {
      this.simulationSpeed = 1.0;
      this.speedIndicator.setVisible(false);
    });

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

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  private allPlayers(): Player[] {
    return [...this.teamA.players, ...this.teamB.players];
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

  private triggerTransitionReaction(gainedTeamId: string, lostTeamId: string): void {
    const gainedTeam = gainedTeamId === 'teamA' ? this.teamA : this.teamB;
    const lostTeam   = lostTeamId   === 'teamA' ? this.teamA : this.teamB;

    for (const p of gainedTeam.players) {
      if (p.hasBall || p.role === PlayerRole.Goalkeeper) continue;
      if (p.role === PlayerRole.Striker || p.role === PlayerRole.Winger || p.role === PlayerRole.Midfielder) {
        p.aiCooldown = 0;
      }
    }

    for (const p of lostTeam.players) {
      if (p.hasBall || p.role === PlayerRole.Goalkeeper) continue;
      if (p.role === PlayerRole.Defender || p.role === PlayerRole.Midfielder) {
        p.aiCooldown = 0;
      }
    }
  }

  private isBallInDangerArea(): boolean {
    return Math.abs(this.ball.x - GOAL_LEFT.centerX) < 245
      || Math.abs(this.ball.x - GOAL_RIGHT.centerX) < 245;
  }

}

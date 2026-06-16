import Phaser from 'phaser';
import { PlayerRole } from '../data/PlayerRole';
import { PlayerState } from '../data/PlayerState';
import { PlayerStats } from '../data/PlayerStats';
import { Ball } from './Ball';
import { dist, clamp } from '../utils/MathUtils';
import { FieldBounds } from '../types';
import { traitBonus, TRAITS } from '../data/PlayerTraits';
import type { SpectatorPlayerState } from '../../draft/MultiplayerLobby';

const PLAYER_SPEED_SCALE = 1.62;
const PLAYER_ACCELERATION_FAR = 0.07;
const PLAYER_ACCELERATION_NEAR = 0.050;
const PLAYER_DIVE_ACCELERATION = 0.20;
const GK_DIVE_IMPULSE_BASE = 13.6;
const SPRINT_SPEED_MULTIPLIER = 1.28;
const SPRINT_STAMINA_DRAIN_MULTIPLIER = 2.4;
// Stamina floor for sprinting is now per-player (see sprintStaminaFloor getter).
const PLAYER_NAME_MAX_CHARS = 14;

export class Player extends Phaser.GameObjects.Container {
  readonly id: string;
  readonly playerName: string;
  readonly jerseyNumber: number;
  readonly teamId: string;
  readonly role: PlayerRole;
  readonly stats: PlayerStats;
  readonly heightCm: number;
  readonly weightKg: number;
  readonly playstyles: readonly string[];
  readonly playstylesPlus: readonly string[];

  state: PlayerState = PlayerState.ReturnToShape;
  hasBall: boolean = false;
  currentStamina: number = 100;
  attackDirection: 1 | -1 = 1;

  baseX: number;
  baseY: number;
  targetX: number;
  targetY: number;

  passTarget: Player | null = null;
  passTargetX: number | null = null;
  passTargetY: number | null = null;
  passKind: 'normal' | 'through' | 'cross' | 'cutback' = 'normal';
  dribbleTarget: Player | null = null;
  dribbleCommitMs = 0;
  dribbleContactRadius = 38;
  carryRiskMs = 0;
  carryDurationMs = 0; // total ms holding the ball (resets on loss of possession)
  carryRiskAnchorX: number;
  carryRiskAnchorY: number;
  markingTarget: Player | null = null;
  aiCooldown: number = 0;
  sprintMs = 0;
  recentPassFromId: string | null = null;
  recentPassCooldownMs = 0;
  // True when the GK dives for visual effect on a save they can reliably make (resolves as normal save)
  stretchSave = false;

  // Pending dive: GK runs first, then dives when this countdown hits 0
  scheduledDiveMs = 0;
  scheduledDiveSaveX = 0;
  scheduledDiveSaveY = 0;

  // Velocity for smooth steering (px per 60-fps frame)
  vx = 0;
  vy = 0;
  avoidanceX = 0;
  avoidanceY = 0;

  // Continuous per-player wander — unique phase derived from id so no two players sync
  private readonly wanderPhase: number;
  private wanderTime = 0;

  private circle!: Phaser.GameObjects.Arc;
  private ring!: Phaser.GameObjects.Arc;
  private staminaArc!: Phaser.GameObjects.Graphics;
  private sprintGlow!: Phaser.GameObjects.Graphics;
  private patternGraphics!: Phaser.GameObjects.Graphics;
  private outlineCircle!: Phaser.GameObjects.Arc;
  private sprintGlowIntensity = 0;
  private infoAlpha = 0.2;
  private label!: Phaser.GameObjects.Text;
  private jerseyText!: Phaser.GameObjects.Text;

  private sprintDustCooldown = 0;
  private ballCarryDirX: number;
  private ballCarryDirY = 0;
  private diveDirX = 0;
  private diveDirY = 0;
  private diveRemaining = 0;
  private diveMsRemaining = 0;

  constructor(
    scene: Phaser.Scene,
    x: number, y: number,
    id: string,
    name: string,
    jerseyNumber: number,
    teamId: string,
    role: PlayerRole,
    stats: PlayerStats,
    color: number,
    heightCm = 180,
    weightKg = 78,
    playstyles: string[] = [],
    playstylesPlus: string[] = [],
    numberColor = 0xffffff,
    secondaryColor = 0x000000,
    kitPattern = 'solid',
    isHome = true,
  ) {
    super(scene, x, y);
    this.id = id;
    this.playerName = name;
    this.jerseyNumber = jerseyNumber;
    this.teamId = teamId;
    this.role = role;
    this.stats = stats;
    this.heightCm = heightCm > 0 ? heightCm : 180;
    this.weightKg = weightKg > 0 ? weightKg : 78;
    this.playstyles = playstyles;
    this.playstylesPlus = playstylesPlus;
    this.baseX = x;
    this.baseY = y;
    this.targetX = x;
    this.targetY = y;
    this.carryRiskAnchorX = x;
    this.carryRiskAnchorY = y;
    this.attackDirection = teamId === 'teamA' ? 1 : -1;
    this.ballCarryDirX = this.attackDirection;
    // Unique wander phase so no two players oscillate in sync
    this.wanderPhase = id.split('').reduce((s, c) => s + c.charCodeAt(0), 0) * 2.39;

    this.circle = scene.add.arc(0, 0, 14, 0, 360, false, color, 1);
    this.outlineCircle = scene.add.arc(0, 0, 14, 0, 360, false, 0x000000, 0);
    this.outlineCircle.setStrokeStyle(isHome ? 1.5 : 3, 0xffffff, isHome ? 0.3 : 1);

    this.ring = scene.add.arc(0, 0, 19, 0, 360, false, 0x000000, 0);
    this.ring.setVisible(false);

    // Both graphics live outside the container and draw at world coords each frame
    this.sprintGlow  = scene.add.graphics().setDepth(4); // behind player circle
    this.staminaArc  = scene.add.graphics().setDepth(6); // in front

    this.jerseyText = scene.add.text(0, 1, String(jerseyNumber), {
      fontSize: '10px',
      fontStyle: 'bold',
      fontFamily: 'Nunito',
      color: `#${numberColor.toString(16).padStart(6, '0')}`,
      stroke: '#000000',
      strokeThickness: 2,
      resolution: 2,
    }).setOrigin(0.5, 0.5);

    this.label = scene.add.text(0, -26, this.formatDisplayName(name), {
      fontSize: '10px',
      fontStyle: 'bold',
      fontFamily: 'Nunito',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 2,
      resolution: 2,
    }).setOrigin(0.5, 1);

    // Created without scene.add so it stays out of the scene displayList —
    // the container owns it and transforms it correctly in local space.
    this.patternGraphics = new Phaser.GameObjects.Graphics(scene);
    this.drawPattern(kitPattern, color, secondaryColor);

    this.add([this.ring, this.circle, this.patternGraphics, this.outlineCircle, this.jerseyText, this.label]);
    scene.add.existing(this);
    this.setDepth(5);
  }

  private drawPattern(pattern: string, primary: number, secondary: number): void {
    const g = this.patternGraphics;
    const R = 14;
    if (pattern === 'solid') return;

    g.fillStyle(secondary, 1);

    // Horizontal scanline helpers — one pixel tall rect clipped to circle
    const scanH = (y0: number, y1: number): void => {
      for (let y = Math.ceil(y0); y < y1; y++) {
        const hw = Math.sqrt(Math.max(0, R * R - (y + 0.5) * (y + 0.5)));
        if (hw > 0) g.fillRect(-hw, y, hw * 2, 1);
      }
    };

    const scanV = (x0: number, x1: number): void => {
      for (let x = Math.ceil(x0); x < x1; x++) {
        const hh = Math.sqrt(Math.max(0, R * R - (x + 0.5) * (x + 0.5)));
        if (hh > 0) g.fillRect(x, -hh, 1, hh * 2);
      }
    };

    if (pattern === 'stripes-h') {
      // 2 secondary bands centered symmetrically; primary fills center and edges
      const sh = (2 * R) / 4;
      const half = sh / 2;
      scanH( half,        half + sh);
      scanH(-half - sh,  -half);
    } else if (pattern === 'stripes-v') {
      const sw = (2 * R) / 4;
      const half = sw / 2;
      scanV( half,        half + sw);
      scanV(-half - sw,  -half);
    } else if (pattern === 'checkered') {
      // 4×4 grid centered at (0,0): cell (0,0) is primary, alternating outward
      const cell = (2 * R) / 4;
      const half = cell / 2;
      for (let y = Math.ceil(-R); y < R; y++) {
        const hw = Math.sqrt(Math.max(0, R * R - (y + 0.5) * (y + 0.5)));
        const row = Math.floor((y + half) / cell);
        const colStart = Math.floor((-hw + half) / cell);
        const colEnd   = Math.ceil((hw + half) / cell);
        for (let col = colStart; col < colEnd; col++) {
          if ((row + col) % 2 !== 0) {
            const cx1 = Math.max(-half + col * cell, -hw);
            const cx2 = Math.min(-half + (col + 1) * cell, hw);
            if (cx2 > cx1) g.fillRect(cx1, y, cx2 - cx1, 1);
          }
        }
      }
    } else if (pattern === 'sash') {
      // Diagonal band where |x - y| < bw (top-left to bottom-right)
      const bw = 7;
      for (let y = -R; y < R; y++) {
        const hw = Math.sqrt(Math.max(0, R * R - (y + 0.5) * (y + 0.5)));
        const bx1 = Math.max(-hw, y - bw);
        const bx2 = Math.min(hw, y + bw);
        if (bx2 > bx1) g.fillRect(bx1, y, bx2 - bx1, 1);
      }
    }
  }

  updatePlayer(delta: number, field: FieldBounds): void {
    const cappedDelta = Math.min(delta, 50);
    this.aiCooldown -= cappedDelta;
    this.sprintMs = Math.max(0, this.sprintMs - cappedDelta);
    this.recentPassCooldownMs = Math.max(0, this.recentPassCooldownMs - cappedDelta);
    this.dribbleCommitMs = Math.max(0, this.dribbleCommitMs - cappedDelta);
    if (this.recentPassCooldownMs <= 0) this.recentPassFromId = null;
    this.wanderTime += cappedDelta;

    if (this.scheduledDiveMs > 0) {
      this.scheduledDiveMs -= cappedDelta;
      if (this.scheduledDiveMs <= 0) {
        this.launchDive(this.scheduledDiveSaveX, this.scheduledDiveSaveY);
      }
    }

    this.tickStamina(delta);
    this.steer(delta, field);
    this.updateBallCarryDirection(cappedDelta);
    this.emitSprintDust(cappedDelta);
    this.updateVisuals();
  }

  // Returns the speed multiplier based on current stamina (1.0 when fresh, 0.82 when exhausted).
  // Curve is piecewise: stays full until ~70, drops gently to 0.92 by 40, then softer to 0.82.
  getStaminaFactor(): number {
    const s = this.currentStamina;
    if (s >= 70) return 1.0;
    if (s >= 40) return 0.92 + ((s - 40) / 30) * 0.08;
    return 0.82 + (s / 40) * 0.10;
  }

  getBodyMassFactor(): number {
    return clamp(this.weightKg / 78, 0.78, 1.28);
  }

  getAerialBodyScore(): number {
    const heightScore = (this.heightCm - 180) * 0.55;
    const weightScore = (this.weightKg - 78) * 0.16;
    return clamp(heightScore + weightScore, -12, 18);
  }

  getCarryDir(): { x: number; y: number } {
    return { x: this.ballCarryDirX, y: this.ballCarryDirY };
  }

  getSprintGlowIntensity(): number {
    return this.sprintGlowIntensity;
  }

  applySpectatorFrame(data: SpectatorPlayerState): void {
    this.setPosition(data.x, data.y);
    this.applySpectatorFrameState(data);
  }

  applySpectatorFrameState(data: SpectatorPlayerState): void {
    this.state = data.state as PlayerState;
    this.hasBall = data.hasBall;
    this.currentStamina = data.stamina;
    this.sprintMs = data.sprintMs;
    this.ballCarryDirX = data.dirX;
    this.ballCarryDirY = data.dirY;
    // Approximate velocity so GkDive ellipse rotates correctly
    this.vx = data.dirX * 2;
    this.vy = data.dirY * 2;
    this.wanderTime += 16;
    this.updateVisuals();
  }

  requestSprint(durationMs = 650, minIntentDistance = 70): void {
    if (durationMs <= 0) return;
    if (this.currentStamina < this.sprintStaminaFloor) return;
    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    // Quick Step: triggers sprint sooner and extends burst duration
    const distThreshold = minIntentDistance - traitBonus(this, TRAITS.QUICK_STEP, 25, 10);
    const extraMs = traitBonus(this, TRAITS.QUICK_STEP, 120, 80);
    if (Math.sqrt(dx * dx + dy * dy) < distThreshold) return;
    this.sprintMs = Math.max(this.sprintMs, durationMs + extraMs);
  }

  forceSprint(durationMs = 450): void {
    if (durationMs <= 0) return;
    if (this.currentStamina < this.sprintStaminaFloor) return;
    this.sprintMs = Math.max(this.sprintMs, durationMs);
  }

  /** High-stamina players can sprint even when more depleted (stat=30→15, stat=60→12, stat=90→9). */
  private get sprintStaminaFloor(): number {
    return Math.round(Math.max(6, 18 - (this.stats.stamina / 100) * 10));
  }

  isSprinting(): boolean {
    return this.sprintMs > 0 && this.currentStamina >= this.sprintStaminaFloor;
  }

  private tickStamina(delta: number): void {
    const dt = Math.min(delta, 50) / 1000; // seconds, capped to avoid lag spikes
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);

    const physicalFactor = this.stats.physical / 100;
    // Physical reduces base depletion by up to 15%. Stamina stat reduces by up to 30%
    // (coefficient 0.003 — halved from old 0.006 so the drain gap between low/high stamina
    // players stays small; the stat now matters more for recovery than for drain).
    const physicalMult = 1 - physicalFactor * 0.15;
    const relentlessMult = 1 - traitBonus(this, TRAITS.RELENTLESS, 0.15, 0.07);
    // Wider stamina gap: base 0.50, coefficient 0.005 → stat=60 drains 28% more than stat=91
    // (was 0.42 * 0.003 → only 12% gap). Average at stat=55 is equivalent to before.
    const deplRate = 0.50 * (1 - this.stats.stamina * 0.005) * physicalMult * relentlessMult;

    let staminaDelta: number;
    if (speed > 1.2) {
      // Physical cushions sprint cost by up to 18% (was 28%) — less compounding with base reduction.
      const physSprintShield = 1 - physicalFactor * 0.18;
      const sprintDrain = this.isSprinting() ? SPRINT_STAMINA_DRAIN_MULTIPLIER * physSprintShield : 1.0;
      // Fatigue amplifier: sprinting when depleted still costs more, but gentler slope.
      // At 25 stamina → +15% cost; at 10 stamina → +24% cost.
      const fatigueAmp = this.isSprinting() && this.currentStamina < 50
        ? 1 + (1 - this.currentStamina / 50) * 0.30
        : 1.0;
      staminaDelta = -deplRate * (this.hasBall ? 1.6 : 1.0) * sprintDrain * fatigueAmp * dt;
    } else {
      // Recovery: stamina contributes 65% of the rate, base 35% always.
      // Gap stat=60 vs stat=91: ~27% (was 15%). Physical boosts by up to 18%.
      const recoveryBoost = (1 + physicalFactor * 0.18)
        * (1 + traitBonus(this, TRAITS.RELENTLESS, 0.30, 0.15));
      staminaDelta = 0.17 * (0.35 + (this.stats.stamina / 100) * 0.65) * recoveryBoost * dt;
    }

    this.currentStamina = clamp(this.currentStamina + staminaDelta, 0, 100);
  }

  private steer(delta: number, field: FieldBounds): void {
    // Effective target: stable AI target + continuous per-player wander offset.
    // Wander evolves every frame (not at AI ticks) so there are no sudden jumps
    // when a decision fires. Only applied in free-roaming states — pressing and
    // marking players move directly toward their goal.
    let effTX = this.targetX;
    let effTY = this.targetY;
    const freeRoaming = !this.hasBall
      && this.role !== PlayerRole.Goalkeeper
      && (this.state === PlayerState.FindSpace || this.state === PlayerState.ReturnToShape);
    if (freeRoaming) {
      const t = this.wanderTime / 1000; // seconds
      effTX += Math.sin(t * 0.95 + this.wanderPhase) * 16;
      effTY += Math.cos(t * 0.71 + this.wanderPhase) * 20;
    }
    effTX += this.avoidanceX;
    effTY += this.avoidanceY;
    effTX = clamp(effTX, field.left + 15, field.right - 15);
    effTY = clamp(effTY, field.top + 15, field.bottom - 15);

    const dx = effTX - this.x;
    const dy = effTY - this.y;
    const d = Math.sqrt(dx * dx + dy * dy);

    const isDiving = this.state === PlayerState.GkDive;
    // sprintSpeed controls 45% of the range; 55% floor is always present.
    const baseSpeed = (0.55 + (this.stats.sprintSpeed / 100) * 0.45) * PLAYER_SPEED_SCALE;
    // Rapid: +6 % top sprint speed (Plus: +10 %)
    const rapidBoost = this.isSprinting() ? 1 + traitBonus(this, TRAITS.RAPID, 0.06, 0.04) : 1;
    const sprintMult = this.isSprinting() && !isDiving ? SPRINT_SPEED_MULTIPLIER : 1.0;
    // Extra burst when actively dribbling past a defender — agility sharpens the cut, dribbling adds carry speed
    const dribbleBoost = (this.hasBall && this.state === PlayerState.Dribble && this.isSprinting())
      ? 1.06 + (this.stats.dribbling / 100) * 0.08 + (this.stats.agility / 100) * 0.08
      : 1.0;
    const maxSpeed = (this.hasBall
      ? baseSpeed * (0.88 + (this.stats.dribbling / 100) * 0.20)
      : baseSpeed) * this.getStaminaFactor() * sprintMult * rapidBoost * dribbleBoost;

    // Dive snaps much faster to target; normal: snappier when far, softer near
    // Quick Step: faster acceleration ramp when starting a sprint (+35 % far, +20 % near; Plus adds 20 %/10 % more)
    const quickStepFar  = 1 + traitBonus(this, TRAITS.QUICK_STEP, 0.35, 0.20);
    const quickStepNear = 1 + traitBonus(this, TRAITS.QUICK_STEP, 0.20, 0.10);
    // steerBlend: how quickly velocity aligns to the desired direction each frame.
    // acceleration stat controls startup burst (far); agility stat controls tight turns (near).
    const steerBlend = isDiving
      ? PLAYER_DIVE_ACCELERATION
      : d > 80
        ? (0.050 + (this.stats.acceleration / 100) * 0.030) * quickStepFar   // acc=75→0.0725, acc=91→0.0773
        : (0.036 + (this.stats.agility    / 100) * 0.018) * quickStepNear;   // agi=72→0.049, agi=91→0.052

    const scale = Math.min(delta, 50) / 16.67;
    const oldX = this.x;
    const oldY = this.y;

    if (isDiving) {
      // Impulse-brake: the burst set by diveToward() decelerates naturally — no active steering
      const framesRemaining = Math.max(this.diveMsRemaining / 16.67, 1);
      const speed = clamp(this.diveRemaining / framesRemaining, 2.2, 4.0);
      this.vx = this.diveDirX * speed;
      this.vy = this.diveDirY * speed;
      this.diveMsRemaining = Math.max(0, this.diveMsRemaining - Math.min(delta, 50));
      if (this.diveRemaining <= 0) {
        this.vx = 0;
        this.vy = 0;
        this.diveRemaining = 0;
        this.diveMsRemaining = 0;
        this.state = PlayerState.ReturnToShape;
      }
    } else if (d < 3) {
      // Hard stop — eliminates the micro-oscillation from velocity bleed
      this.vx = 0;
      this.vy = 0;
    } else {
      const slowRadius = this.state === PlayerState.PressBall ? 8 : 18;
      const minSlowFactor = this.state === PlayerState.PressBall ? 0.75 : 0.55;
      const slowFactor = d < slowRadius ? Math.max(minSlowFactor, d / slowRadius) : 1;
      const desiredVx = (dx / d) * maxSpeed * slowFactor;
      const desiredVy = (dy / d) * maxSpeed * slowFactor;

      this.vx += (desiredVx - this.vx) * steerBlend;
      this.vy += (desiredVy - this.vy) * steerBlend;

      const spd = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      if (spd > maxSpeed) {
        this.vx = (this.vx / spd) * maxSpeed;
        this.vy = (this.vy / spd) * maxSpeed;
      }
    }

    const minX = isDiving ? field.left - 2 : field.left + 15;
    const maxX = isDiving ? field.right + 2 : field.right - 15;
    const minY = isDiving ? field.top + 8 : field.top + 15;
    const maxY = isDiving ? field.bottom - 8 : field.bottom - 15;
    this.x = clamp(this.x + this.vx * scale, minX, maxX);
    this.y = clamp(this.y + this.vy * scale, minY, maxY);
    if (isDiving && this.diveRemaining > 0) {
      this.diveRemaining = Math.max(0, this.diveRemaining - dist(oldX, oldY, this.x, this.y));
    }
  }

  updateLabelAlpha(ballX: number, ballY: number): void {
    const dx = this.x - ballX;
    const dy = this.y - ballY;
    const near = dx * dx + dy * dy < 200 * 200;
    const alpha = near ? 1 : 0.2;
    this.infoAlpha = alpha;
    this.label.setAlpha(alpha);
    this.jerseyText.setAlpha(alpha);
  }

  static debugRings = false;

  private getRoleRingColor(): number {
    switch (this.role) {
      case PlayerRole.Goalkeeper: return 0xf8fafc;
      case PlayerRole.Defender:   return 0x4ade80;
      case PlayerRole.Midfielder:
      case PlayerRole.Winger:     return 0x60a5fa;
      case PlayerRole.Striker:    return 0xf87171;
      default:                    return 0xfbbf24;
    }
  }

  private updateVisuals(): void {

    // Dive: flatten the circle into an ellipse aligned with the velocity direction.
    const isDiving = this.state === PlayerState.GkDive;
    if (isDiving) {
      const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      if (speed > 0.1) {
        const angleDeg = Math.atan2(this.vy, this.vx) * (180 / Math.PI);
        this.circle.setAngle(angleDeg);
        this.circle.setScale(1.15, 0.85);
        this.outlineCircle.setAngle(angleDeg);
        this.outlineCircle.setScale(1.15, 0.85);
      }
      this.circle.setAlpha(0.95);
      this.outlineCircle.setAlpha(0.95);
    } else {
      this.circle.setAngle(0);
      this.circle.setScale(1, 1);
      this.circle.setAlpha(1);
      this.outlineCircle.setAngle(0);
      this.outlineCircle.setScale(1, 1);
      this.outlineCircle.setAlpha(1);
    }

    // Dribble glow: radial gradient arcs that oscillate while the player is dribbling
    const isDribbling = this.hasBall && this.state === PlayerState.Dribble;
    const targetGlow = isDribbling ? 1 : 0;
    this.sprintGlowIntensity += (targetGlow - this.sprintGlowIntensity) * 0.12;
    this.sprintGlow.clear();
    if (this.sprintGlowIntensity > 0.02) {
      const t = this.wanderTime / 1000;
      const intensity = this.sprintGlowIntensity;
      const layers = [
        { r: 13, a: 1.00 },
        { r: 16, a: 0.78 },
        { r: 19, a: 0.54 },
        { r: 22, a: 0.30 },
        { r: 25, a: 0.13 },
      ];
      for (let i = 0; i < layers.length; i++) {
        const { r, a } = layers[i];
        const phase = i * 0.55;
        const pulse = 0.65 + 0.35 * Math.sin(t * 7.5 + phase);
        const sweep = (0.45 + 0.45 * Math.sin(t * 3.2 + phase * 0.9)) * Math.PI * 2;
        const start = -Math.PI / 2 + t * 2.0 + phase;
        this.sprintGlow.lineStyle(2.5, 0x38bdf8, a * pulse * intensity);
        this.sprintGlow.beginPath();
        this.sprintGlow.arc(this.x, this.y, r, start, start + sweep, false);
        this.sprintGlow.strokePath();
      }
    }

    this.staminaArc.clear();
  }

  private formatDisplayName(name: string): string {
    return name.length > PLAYER_NAME_MAX_CHARS
      ? name.substring(0, PLAYER_NAME_MAX_CHARS)
      : name;
  }

  private emitSprintDust(delta: number): void {
    this.sprintDustCooldown = Math.max(0, this.sprintDustCooldown - delta);
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    const isDiving = this.state === PlayerState.GkDive;

    if (isDiving) {
      if (speed < 0.5 || this.sprintDustCooldown > 0) return;
      this.sprintDustCooldown = 50 + Math.random() * 25;
      const nx = this.vx / speed;
      const ny = this.vy / speed;
      const back = 4 + Math.random() * 6;
      const lateral = (Math.random() - 0.5) * 12;
      const x = this.x - nx * back + -ny * lateral;
      const y = this.y - ny * back + nx * lateral;
      const trail = this.scene.add.circle(x, y, 5 + Math.random() * 4, 0x00e5ff, 0.55);
      trail.setDepth(4);
      this.scene.tweens.add({
        targets: trail,
        alpha: 0,
        scaleX: 2.2 + Math.random() * 0.6,
        scaleY: 2.2 + Math.random() * 0.6,
        x: x - nx * (6 + Math.random() * 6),
        y: y - ny * (4 + Math.random() * 4) + (Math.random() - 0.5) * 5,
        duration: 300 + Math.random() * 120,
        ease: 'Sine.easeOut',
        onComplete: () => trail.destroy(),
      });
      return;
    }

    if (!this.isSprinting() || speed < 0.85 || this.sprintDustCooldown > 0) return;

    this.sprintDustCooldown = 70 + Math.random() * 30;
    const nx = this.vx / speed;
    const ny = this.vy / speed;
    const back = 2 + Math.random() * 4;
    const lateral = (Math.random() - 0.5) * 10;
    const x = this.x - nx * back + -ny * lateral;
    const y = this.y - ny * back + nx * lateral;
    const size = 5 + Math.random() * 4;

    const dust = this.scene.add.circle(x, y, size / 2, 0xffffff, 0.55);
    dust.setDepth(4);

    this.scene.tweens.add({
      targets: dust,
      alpha: 0,
      scaleX: 1.8 + Math.random() * 0.5,
      scaleY: 1.8 + Math.random() * 0.5,
      x: x - nx * (5 + Math.random() * 5),
      y: y - ny * (3 + Math.random() * 4) + (Math.random() - 0.5) * 4,
      duration: 420 + Math.random() * 160,
      ease: 'Sine.easeOut',
      onComplete: () => dust.destroy(),
    });
  }

  distanceTo(other: { x: number; y: number }): number {
    return dist(this.x, this.y, other.x, other.y);
  }

  showEmote(emote: string, delayMs = 0): void {
    this.scene.time.delayedCall(delayMs, () => {
      const text = this.scene.add.text(this.x, this.y - 36, emote, {
        fontSize: '17px',
        resolution: 2,
      }).setOrigin(0.5, 1).setDepth(15);

      this.scene.tweens.add({
        targets: text,
        y: text.y - 28,
        alpha: 0,
        duration: 1900,
        ease: 'Sine.easeOut',
        onComplete: () => text.destroy(),
      });
    });
  }

  showCelebration(): void {
    this.scene.tweens.add({
      targets: this,
      rotation: 0.28,
      duration: 75,
      yoyo: true,
      repeat: 5,
      ease: 'Sine.easeInOut',
      onComplete: () => { this.rotation = 0; },
    });
  }

  showDisappointment(): void {
    this.scene.tweens.add({
      targets: this,
      scaleY: 0.82,
      duration: 110,
      yoyo: true,
      repeat: 2,
      ease: 'Sine.easeInOut',
      onComplete: () => { this.scaleY = 1; },
    });
  }

  /** Red X mark that expands and fades — plays on the defender that got beaten. */
  showStumble(): void {
    const g = this.scene.add.graphics();
    g.lineStyle(2.5, 0xff4444, 1);
    g.beginPath(); g.moveTo(-5, -5); g.lineTo(5, 5); g.strokePath();
    g.beginPath(); g.moveTo(5, -5);  g.lineTo(-5, 5); g.strokePath();
    g.setPosition(this.x, this.y).setDepth(8);
    this.scene.tweens.add({
      targets: g,
      scaleX: 2.8, scaleY: 2.8,
      alpha: 0,
      duration: 280,
      ease: 'Cubic.Out',
      onComplete: () => g.destroy(),
    });
  }

  /** Short radiating lines at the contact point — plays on the defender that wins a tackle. */
  showTackleBurst(contactX: number, contactY: number): void {
    const g = this.scene.add.graphics();
    g.lineStyle(1.5, 0xffffff, 0.9);
    const COUNT = 6;
    for (let i = 0; i < COUNT; i++) {
      const angle = (i / COUNT) * Math.PI * 2;
      g.beginPath();
      g.moveTo(Math.cos(angle) * 5,  Math.sin(angle) * 5);
      g.lineTo(Math.cos(angle) * 11, Math.sin(angle) * 11);
      g.strokePath();
    }
    g.setPosition(contactX, contactY).setDepth(8);
    this.scene.tweens.add({
      targets: g,
      scaleX: 2.2, scaleY: 2.2,
      alpha: 0,
      duration: 220,
      ease: 'Cubic.Out',
      onComplete: () => g.destroy(),
    });
  }

  /** Ripple at the ball's position when any kick is taken — scales with shot power. */
  showShotPulse(bx: number, by: number, power: number): void {
    const t = clamp((power - 3.5) / 12, 0, 1);
    const ring = this.scene.add.arc(bx, by, 8, 0, 360, false, 0xffffff, 0);
    ring.setStrokeStyle(1.5 + t * 1.5, 0xffffff, 0.28 + t * 0.42);
    ring.setDepth(7);
    this.scene.tweens.add({
      targets: ring,
      scaleX: 1.8 + t * 2.2,
      scaleY: 1.8 + t * 2.2,
      alpha: 0,
      duration: 180 + t * 130,
      ease: 'Cubic.Out',
      onComplete: () => ring.destroy(),
    });
  }

  destroy(fromScene?: boolean): void {
    this.sprintGlow.destroy();
    this.staminaArc.destroy();
    super.destroy(fromScene);
  }

  setTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
  }

  getBallCarryOffset(): { x: number; y: number } {
    if (this.role === PlayerRole.Goalkeeper) {
      return {
        x: this.attackDirection * 11,
        y: 3,
      };
    }

    const skill = this.getBallControlSkill();
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    const looseTouch = clamp(speed / 2.6, 0, 1) * (1 - skill);
    const controlDistance = this.state === PlayerState.Dribble
      ? 15 + looseTouch * 5
      : 12 + looseTouch * 4;
    const lateralSet = this.state === PlayerState.Dribble ? 1.5 * (skill - 0.5) : 0;

    return {
      x: this.ballCarryDirX * controlDistance - this.ballCarryDirY * lateralSet,
      y: this.ballCarryDirY * controlDistance + this.ballCarryDirX * lateralSet + 2,
    };
  }

  primeBallCarryDirection(incomingX: number, incomingY: number): void {
    if (this.role === PlayerRole.Goalkeeper) {
      this.ballCarryDirX = this.attackDirection;
      this.ballCarryDirY = 0;
      return;
    }

    let dx = incomingX;
    let dy = incomingY;
    let len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.1) {
      dx = this.attackDirection;
      dy = 0;
      len = 1;
    }

    const skill = this.getBallControlSkill();
    const forwardSettle = 0.08 + skill * 0.10;
    let targetX = (dx / len) * (1 - forwardSettle) + this.attackDirection * forwardSettle;
    let targetY = (dy / len) * (1 - forwardSettle);
    const targetLen = Math.sqrt(targetX * targetX + targetY * targetY) || 1;
    this.ballCarryDirX = targetX / targetLen;
    this.ballCarryDirY = targetY / targetLen;
  }

  getBallSteeringFactor(): number {
    if (this.role === PlayerRole.Goalkeeper) return 1;

    const skill = this.getBallControlSkill();
    const sprintPenalty = this.isSprinting() ? 0.08 * (1 - skill) : 0;
    const dribbleBonus = this.state === PlayerState.Dribble ? 0.06 * skill : 0;
    return clamp(0.42 + skill * 0.34 + dribbleBonus - sprintPenalty, 0.36, 0.84);
  }

  private updateBallCarryDirection(delta: number): void {
    if (!this.hasBall) return;

    if (this.role === PlayerRole.Goalkeeper) {
      this.ballCarryDirX = this.attackDirection;
      this.ballCarryDirY = 0;
      return;
    }

    let dx = this.vx;
    let dy = this.vy;
    let speed = Math.sqrt(dx * dx + dy * dy);

    if (speed < 0.18) {
      dx = this.targetX - this.x;
      dy = this.targetY - this.y;
      speed = Math.sqrt(dx * dx + dy * dy);
    }

    if (speed < 0.18) {
      dx = this.attackDirection;
      dy = 0;
      speed = 1;
    }

    let targetX = dx / speed;
    let targetY = dy / speed;
    const skill = this.getBallControlSkill();
    const forwardBias = this.state === PlayerState.Dribble
      ? 0.10 + (1 - skill) * 0.14
      : 0.18 + (1 - skill) * 0.18;
    targetX = targetX * (1 - forwardBias) + this.attackDirection * forwardBias;
    const targetLen = Math.sqrt(targetX * targetX + targetY * targetY) || 1;
    targetX /= targetLen;
    targetY /= targetLen;

    const baseTurnRate = this.state === PlayerState.Dribble ? 0.16 : 0.10;
    const skillTurnBonus = this.state === PlayerState.Dribble ? 0.15 : 0.10;
    const turnRate = baseTurnRate + skill * skillTurnBonus;
    const alpha = 1 - Math.pow(1 - turnRate, Math.min(delta, 50) / 16.67);

    this.ballCarryDirX += (targetX - this.ballCarryDirX) * alpha;
    this.ballCarryDirY += (targetY - this.ballCarryDirY) * alpha;

    const len = Math.sqrt(this.ballCarryDirX * this.ballCarryDirX + this.ballCarryDirY * this.ballCarryDirY) || 1;
    this.ballCarryDirX /= len;
    this.ballCarryDirY /= len;
  }

  private getBallControlSkill(): number {
    return clamp((this.stats.dribbling * 0.72 + this.stats.reactions * 0.28) / 100, 0, 1);
  }

  showDiveBurst(): void {
    // Expanding cyan ring at the GK's position when the dive launches.
    const ring = this.scene.add.arc(this.x, this.y, 10, 0, 360, false, 0x00e5ff, 0);
    ring.setStrokeStyle(2, 0x00e5ff, 0.8).setDepth(8);
    this.scene.tweens.add({
      targets: ring, scaleX: 3, scaleY: 3, alpha: 0,
      duration: 340, ease: 'Cubic.Out',
      onComplete: () => ring.destroy(),
    });
    const ring2 = this.scene.add.arc(this.x, this.y, 6, 0, 360, false, 0xffffff, 0);
    ring2.setStrokeStyle(2, 0xffffff, 0.55).setDepth(8);
    this.scene.tweens.add({
      targets: ring2, scaleX: 2.8, scaleY: 2.8, alpha: 0,
      duration: 240, ease: 'Cubic.Out', delay: 40,
      onComplete: () => ring2.destroy(),
    });
  }

  diveToward(
    targetX: number,
    targetY: number,
    _ballX: number,
    _ballY: number,
    _ballVx: number,
    _ballVy: number,
    durationMs?: number,
  ): void {
    this.state = PlayerState.GkDive;
    this.sprintMs = 0;
    this.scheduledDiveMs = 0;
    this.setTarget(targetX, targetY);
    this.showDiveBurst();

    let impulseX = targetX - this.x;
    let impulseY = targetY - this.y;

    let len = Math.sqrt(impulseX * impulseX + impulseY * impulseY);
    if (len <= 0.01) {
      // Target is already the trajectory cut point; if it is on the GK, no burst is needed.
      if (len <= 0.01) return;
    }

    const impulse = GK_DIVE_IMPULSE_BASE + (this.stats.defending / 100) * 2.2;
    this.diveDirX = impulseX / len;
    this.diveDirY = impulseY / len;
    this.diveRemaining = len;
    this.diveMsRemaining = durationMs ?? clamp(115 + len * 1.15 - this.stats.sprintSpeed * 0.28, 125, 285);
    this.vx = this.diveDirX * impulse;
    this.vy = this.diveDirY * impulse;
  }

  scheduleDive(saveX: number, saveY: number, delayMs: number): void {
    this.scheduledDiveMs = Math.max(0, delayMs);
    this.scheduledDiveSaveX = saveX;
    this.scheduledDiveSaveY = saveY;
  }

  private launchDive(saveX: number, saveY: number): void {
    // Cancel if GK already has ball, or is no longer tracking the shot (state changed)
    if (this.hasBall || this.state !== PlayerState.ReceivePass) return;
    this.state = PlayerState.GkDive;
    this.scheduledDiveMs = 0;
    this.sprintMs = 0;
    this.showDiveBurst();
    let impulseX = saveX - this.x;
    let impulseY = saveY - this.y;
    let len = Math.sqrt(impulseX * impulseX + impulseY * impulseY);
    if (len <= 0.01) return;
    const impulse = GK_DIVE_IMPULSE_BASE + (this.stats.defending / 100) * 2.2;
    this.diveDirX = impulseX / len;
    this.diveDirY = impulseY / len;
    this.diveRemaining = len;
    this.diveMsRemaining = clamp(115 + len * 1.15 - this.stats.sprintSpeed * 0.28, 125, 285);
    this.vx = this.diveDirX * impulse;
    this.vy = this.diveDirY * impulse;
  }

  resetToBase(): void {
    this.x = this.baseX;
    this.y = this.baseY;
    this.targetX = this.baseX;
    this.targetY = this.baseY;
    this.vx = 0;
    this.vy = 0;
    this.diveDirX = 0;
    this.diveDirY = 0;
    this.diveRemaining = 0;
    this.diveMsRemaining = 0;
    this.avoidanceX = 0;
    this.avoidanceY = 0;
    this.hasBall = false;
    this.passTarget = null;
    this.passTargetX = null;
    this.passTargetY = null;
    this.passKind = 'normal';
    this.dribbleTarget = null;
    this.dribbleCommitMs = 0;
    this.dribbleContactRadius = 38;
    this.carryRiskMs = 0;
    this.carryDurationMs = 0;
    this.carryRiskAnchorX = this.x;
    this.carryRiskAnchorY = this.y;
    this.markingTarget = null;
    this.sprintMs = 0;
    this.recentPassFromId = null;
    this.recentPassCooldownMs = 0;
    this.ballCarryDirX = this.attackDirection;
    this.ballCarryDirY = 0;
    this.state = PlayerState.ReturnToShape;
    this.aiCooldown = 0;
  }

  distanceToBall(ball: Ball): number {
    return dist(this.x, this.y, ball.x, ball.y);
  }
}

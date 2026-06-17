import Phaser from 'phaser';
import { BALL_PHYSICS } from '../physics/BallPhysics';

export interface IBallCarrier {
  x: number;
  y: number;
  id: string;
  getBallCarryOffset?: () => { x: number; y: number };
  getBallSteeringFactor?: () => number;
  primeBallCarryDirection?: (incomingX: number, incomingY: number) => void;
}

export type ShotResult = 'Goal' | 'Saved' | 'Missed';

export interface BallKickOptions {
  lift?: number;
  spin?: number;
}

export class Ball extends Phaser.GameObjects.Arc {
  private static readonly textureKeys = ['ball-art-classic', 'ball-art-strike', 'ball-art-orbit'];

  velocity: { x: number; y: number } = { x: 0, y: 0 };
  flightHeight = 0;
  verticalVelocity = 0;
  spin = 0;
  spinAngle = 0;
  owner: IBallCarrier | null = null;
  targetPlayer: IBallCarrier | null = null;
  previousX: number;
  previousY: number;
  lastKickX: number;
  lastKickY: number;

  // Id of the player who last kicked the ball; they cannot pick it up again
  // for kickCooldown ms, preventing instant self-interception.
  kickedById: string | null = null;
  private kickCooldown = 0;

  // Persistent touch history for goal attribution (not affected by cooldown reset).
  lastToucherId: string | null = null;
  previousToucherId: string | null = null;
  private pickupBlockers = new Map<string, number>();

  private shadow!: Phaser.GameObjects.Arc;
  private skin!: Phaser.GameObjects.Image;
  private skinBaseScale = 1;
  private trailGfx!: Phaser.GameObjects.Graphics;
  private readonly trailPos: Array<{ x: number; y: number }> = [];
  private trailFrame = 0;
  private static readonly TRAIL_MAX = 28;
  private static readonly TRAIL_SAMPLE_EVERY = 2;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, BALL_PHYSICS.radius, 0, 360, false, 0xffffff, 0);
    this.previousX = x;
    this.previousY = y;
    this.lastKickX = x;
    this.lastKickY = y;
    const textureKey = Ball.pickRandomTexture(scene);
    scene.add.existing(this);
    this.setDepth(10);

    // Drop shadow
    this.shadow = scene.add.arc(x, y, BALL_PHYSICS.radius, 0, 360, false, 0x000000, 0.3);
    this.shadow.setDepth(9);

    this.skin = scene.add.image(x, y, textureKey);
    this.skinBaseScale = (BALL_PHYSICS.radius * 2) / BALL_PHYSICS.artTextureSize;
    this.skin.setScale(this.skinBaseScale);
    this.skin.setDepth(11);

    this.trailGfx = scene.add.graphics().setDepth(9);
  }

  private static pickRandomTexture(scene: Phaser.Scene): string {
    Ball.ensureTextures(scene);
    return Phaser.Math.RND.pick(Ball.textureKeys);
  }

  private static ensureTextures(scene: Phaser.Scene): void {
    if (scene.textures.exists(Ball.textureKeys[0])) return;
    Ball.drawTexture(scene, Ball.textureKeys[0], (ctx, size) => {
      Ball.drawBaseBall(ctx, size, '#f8fafc', '#dbeafe');
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(size * 0.50, size * 0.50, size * 0.31, -0.75, 0.82);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(size * 0.50, size * 0.50, size * 0.31, Math.PI - 0.82, Math.PI + 0.75);
      ctx.stroke();
      ctx.fillStyle = '#111827';
      Ball.fillPentagon(ctx, size * 0.50, size * 0.50, size * 0.16, -Math.PI / 2);
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + i * Math.PI * 0.4;
        ctx.beginPath();
        ctx.moveTo(size * 0.50 + Math.cos(a) * size * 0.15, size * 0.50 + Math.sin(a) * size * 0.15);
        ctx.lineTo(size * 0.50 + Math.cos(a) * size * 0.36, size * 0.50 + Math.sin(a) * size * 0.36);
        ctx.stroke();
      }
    });
    Ball.drawTexture(scene, Ball.textureKeys[1], (ctx, size) => {
      Ball.drawBaseBall(ctx, size, '#fff7ed', '#fed7aa');
      ctx.save();
      Ball.clipCircle(ctx, size);
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 4.6;
      ctx.beginPath();
      ctx.moveTo(size * 0.15, size * 0.75);
      ctx.bezierCurveTo(size * 0.45, size * 0.48, size * 0.62, size * 0.30, size * 0.88, size * 0.18);
      ctx.stroke();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(size * 0.04, size * 0.46);
      ctx.bezierCurveTo(size * 0.33, size * 0.30, size * 0.55, size * 0.70, size * 0.96, size * 0.55);
      ctx.stroke();
      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      ctx.arc(size * 0.66, size * 0.67, size * 0.075, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
    Ball.drawTexture(scene, Ball.textureKeys[2], (ctx, size) => {
      Ball.drawBaseBall(ctx, size, '#ffffff', '#e5e7eb');
      ctx.save();
      Ball.clipCircle(ctx, size);
      ctx.fillStyle = '#0f172a';
      Ball.fillPentagon(ctx, size * 0.50, size * 0.50, size * 0.14, Math.PI / 2);
      const panels = [
        { x: 0.28, y: 0.30, r: -0.40 },
        { x: 0.72, y: 0.30, r: 0.40 },
        { x: 0.23, y: 0.69, r: 0.30 },
        { x: 0.77, y: 0.69, r: -0.30 },
      ];
      for (const panel of panels) {
        Ball.fillPentagon(ctx, size * panel.x, size * panel.y, size * 0.105, panel.r);
      }
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 1.35;
      const seams = [
        [0.50, 0.38, 0.30, 0.34],
        [0.50, 0.38, 0.70, 0.34],
        [0.42, 0.57, 0.26, 0.66],
        [0.58, 0.57, 0.74, 0.66],
        [0.37, 0.50, 0.25, 0.36],
        [0.63, 0.50, 0.75, 0.36],
      ];
      for (const [x1, y1, x2, y2] of seams) {
        ctx.beginPath();
        ctx.moveTo(size * x1, size * y1);
        ctx.lineTo(size * x2, size * y2);
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  private static drawTexture(
    scene: Phaser.Scene,
    key: string,
    draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  ): void {
    const size = BALL_PHYSICS.artTextureSize;
    const texture = scene.textures.createCanvas(key, size, size);
    if (!texture) return;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, size, size);
    draw(ctx, size);
    texture.refresh();
  }

  private static clipCircle(ctx: CanvasRenderingContext2D, size: number): void {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.45, 0, Math.PI * 2);
    ctx.clip();
  }

  private static drawBaseBall(ctx: CanvasRenderingContext2D, size: number, fill: string, shade: string): void {
    const gradient = ctx.createRadialGradient(size * 0.34, size * 0.28, size * 0.05, size * 0.50, size * 0.54, size * 0.48);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.46, fill);
    gradient.addColorStop(1, shade);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.405, 0, Math.PI * 2);
    ctx.stroke();
  }

  private static fillPentagon(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, rotation: number): void {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = rotation + i * Math.PI * 0.4;
      const px = x + Math.cos(a) * radius;
      const py = y + Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  updateBall(delta: number): void {
    const scale = Math.min(delta, 50) / 16.67; // cap at ~3 frames to prevent lag teleport
    this.previousX = this.x;
    this.previousY = this.y;
    this.updateTrail();

    if (this.kickCooldown > 0) {
      this.kickCooldown -= Math.min(delta, 50);
      if (this.kickCooldown <= 0) this.kickedById = null;
    }

    for (const [playerId, cooldown] of this.pickupBlockers) {
      const nextCooldown = cooldown - Math.min(delta, 50);
      if (nextCooldown <= 0) {
        this.pickupBlockers.delete(playerId);
      } else {
        this.pickupBlockers.set(playerId, nextCooldown);
      }
    }

    if (this.owner) {
      this.flightHeight = 0;
      this.verticalVelocity = 0;
      const offset = this.owner.getBallCarryOffset?.() ?? { x: 0, y: 0 };
      const targetX = this.owner.x + offset.x;
      const targetY = this.owner.y + offset.y;
      const steering = this.owner.getBallSteeringFactor?.() ?? 1;
      const alpha = 1 - Math.pow(1 - steering, scale);
      this.x += (targetX - this.x) * alpha;
      this.y += (targetY - this.y) * alpha;

      const carriedDist = Math.sqrt((targetX - this.x) ** 2 + (targetY - this.y) ** 2);
      if (carriedDist > 26) {
        this.x = targetX;
        this.y = targetY;
      }
      this.velocity.x = 0;
      this.velocity.y = 0;
    } else {
      this.x += this.velocity.x * scale;
      this.y += this.velocity.y * scale;
      const friction = Math.pow(BALL_PHYSICS.groundFrictionPerFrame, scale);
      this.velocity.x *= friction;
      this.velocity.y *= friction;
      if (Math.abs(this.spin) > 0.005 && this.getSpeed() > 0.5) {
        const magnusFactor = this.spin * BALL_PHYSICS.magnusForcePerSpin * scale;
        const oldVx = this.velocity.x;
        const oldVy = this.velocity.y;
        this.velocity.x += -oldVy * magnusFactor;
        this.velocity.y +=  oldVx * magnusFactor;
      }
      this.updateFlight(scale);
    }

    this.updateSpin(scale);
    this.updateVisualHeight();
  }

  kickTo(targetX: number, targetY: number, power: number, kickerId?: string, options: BallKickOptions = {}): void {
    this.owner = null;
    this.lastKickX = this.x;
    this.lastKickY = this.y;
    const angle = Math.atan2(targetY - this.y, targetX - this.x);
    const lift = options.lift ?? 0;
    this.velocity.x = Math.cos(angle) * power;
    this.velocity.y = Math.sin(angle) * power;
    this.verticalVelocity = Math.max(this.verticalVelocity, lift);
    this.spin = options.spin ?? this.inferKickSpin(power, angle);
    if (this.spin !== 0) {
      const speedRetention = 1 - Math.min(Math.abs(this.spin) * BALL_PHYSICS.spinSpeedCostFactor, 0.35);
      this.velocity.x *= speedRetention;
      this.velocity.y *= speedRetention;
    }
    if (kickerId) {
      this.markTouchedBy(kickerId);
    }
  }

  private updateFlight(scale: number): void {
    if (this.flightHeight <= 0 && this.verticalVelocity <= 0) {
      this.flightHeight = 0;
      this.verticalVelocity = 0;
      return;
    }

    this.flightHeight += this.verticalVelocity * scale;
    this.verticalVelocity -= BALL_PHYSICS.verticalGravityPerFrame * scale;

    if (this.flightHeight >= 0) return;

    this.flightHeight = 0;
    if (Math.abs(this.verticalVelocity) > BALL_PHYSICS.minBounceVelocity) {
      this.verticalVelocity = -this.verticalVelocity * BALL_PHYSICS.verticalBounce;
    } else {
      this.verticalVelocity = 0;
    }
  }

  private updateSpin(scale: number): void {
    const rollingSpin = this.getSpeed() * BALL_PHYSICS.rollingSpinPerSpeed;
    const spinStep = Phaser.Math.Clamp(this.spin + rollingSpin, -BALL_PHYSICS.maxSpinPerFrame, BALL_PHYSICS.maxSpinPerFrame);
    this.spinAngle += spinStep * scale;
    this.spin *= Math.pow(BALL_PHYSICS.spinDecayPerFrame, scale);
    this.setRotation(this.spinAngle);
    this.skin.setRotation(this.spinAngle);
  }

  syncVisuals(): void {
    this.updateVisualHeight();
  }

  private updateVisualHeight(): void {
    const heightT = Math.min(this.flightHeight / BALL_PHYSICS.maxVisualHeight, 1);
    const visualScale = 1 + heightT * BALL_PHYSICS.maxHeightScaleBonus;
    this.setScale(visualScale);
    this.skin.setPosition(this.x, this.y);
    this.skin.setScale(this.skinBaseScale * visualScale);

    this.shadow.x = this.x + 3 + this.flightHeight * 0.10;
    this.shadow.y = this.y + 3 + this.flightHeight * 0.16;
    this.shadow.setScale(1 + heightT * 0.32);
    this.shadow.setAlpha(0.30 - heightT * 0.16);

    this.skin.setAlpha(1);
  }

  private inferKickSpin(power: number, angle: number): number {
    const direction = Math.sin(angle * 1.7 + this.x * 0.013 + this.y * 0.017) >= 0 ? 1 : -1;
    return direction * Math.min(0.06 + power * 0.018, 0.26);
  }

  markTouchedBy(playerId: string, cooldownMs: number = 300): void {
    if (this.lastToucherId !== playerId) {
      this.previousToucherId = this.lastToucherId;
    }
    this.lastToucherId = playerId;
    this.kickedById = playerId;
    this.kickCooldown = cooldownMs;
    this.preventPickup(playerId, cooldownMs);
  }

  preventPickup(playerId: string, cooldownMs: number = 300): void {
    const current = this.pickupBlockers.get(playerId) ?? 0;
    this.pickupBlockers.set(playerId, Math.max(current, cooldownMs));
  }

  isPickupBlocked(playerId: string): boolean {
    return (this.pickupBlockers.get(playerId) ?? 0) > 0;
  }

  release(): void {
    this.owner = null;
    this.targetPlayer = null;
  }

  attachToPlayer(player: IBallCarrier): void {
    let incomingX = this.velocity.x;
    let incomingY = this.velocity.y;
    const incomingSpeed = Math.sqrt(incomingX * incomingX + incomingY * incomingY);
    if (incomingSpeed < 0.25) {
      incomingX = this.x - player.x;
      incomingY = this.y - player.y;
    }
    player.primeBallCarryDirection?.(incomingX, incomingY);

    this.owner = player;
    this.targetPlayer = null;
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.flightHeight = 0;
    this.verticalVelocity = 0;
    this.spin *= 0.35;
    const offset = player.getBallCarryOffset?.() ?? { x: 0, y: 0 };
    this.x = player.x + offset.x;
    this.y = player.y + offset.y;
    this.updateVisualHeight();
  }

  resetFlight(): void {
    this.flightHeight = 0;
    this.verticalVelocity = 0;
    this.spin = 0;
    this.spinAngle = 0;
    this.updateVisualHeight();
  }

  getSpeed(): number {
    return Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
  }

  private updateTrail(): void {
    const speed = this.getSpeed();

    if (!this.owner && speed > 1.0) {
      this.trailFrame++;
      if (this.trailFrame >= Ball.TRAIL_SAMPLE_EVERY) {
        this.trailFrame = 0;
        this.trailPos.push({ x: this.x, y: this.y });
        if (this.trailPos.length > Ball.TRAIL_MAX) this.trailPos.shift();
      }
    } else {
      this.trailPos.length = 0;
      this.trailFrame = 0;
    }

    this.trailGfx.clear();
    if (this.trailPos.length < 2) return;

    // Build draw points: history + current ball pos as virtual head
    const pts = [...this.trailPos, { x: this.x, y: this.y }];
    const total = pts.length;

    // Clip the head back by ball radius so the trail starts at the ball's edge
    const head = pts[total - 1];
    const prev = pts[total - 2];
    const hdx = head.x - prev.x;
    const hdy = head.y - prev.y;
    const hlen = Math.sqrt(hdx * hdx + hdy * hdy);
    if (hlen > BALL_PHYSICS.radius) {
      pts[total - 1] = {
        x: head.x - (hdx / hlen) * BALL_PHYSICS.radius,
        y: head.y - (hdy / hlen) * BALL_PHYSICS.radius,
      };
    }

    const speedFactor = Math.min((speed - 2.0) / 5.0, 1);
    for (let i = 1; i < total; i++) {
      const t = i / total; // 0 = oldest (tail), 1 = newest (head)
      const alpha = t * t * 0.75 * speedFactor;
      const width = (0.3 + t * t * t * 10.0) * speedFactor;
      this.trailGfx.lineStyle(width, 0xffffff, alpha);
      this.trailGfx.beginPath();
      this.trailGfx.moveTo(pts[i - 1].x, pts[i - 1].y);
      this.trailGfx.lineTo(pts[i].x, pts[i].y);
      this.trailGfx.strokePath();
    }
  }

  destroy(fromScene?: boolean): void {
    this.shadow?.destroy(fromScene);
    this.skin?.destroy(fromScene);
    this.trailGfx?.destroy(fromScene);
    super.destroy(fromScene);
  }
}

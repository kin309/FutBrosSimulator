import { clamp } from '../utils/MathUtils';
import { BALL_PHYSICS } from './BallPhysics';
import type { FieldBounds } from '../types';

const BALL_FRICTION = BALL_PHYSICS.groundFrictionPerFrame;
const MAGNUS = BALL_PHYSICS.magnusForcePerSpin;
const SPIN_DECAY = BALL_PHYSICS.spinDecayPerFrame;

function applyWallBounce(vx: number, vy: number, axis: 'horizontal' | 'vertical'): { vx: number; vy: number } {
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed < 0.01) return { vx, vy };
  const reboundSpeed = Math.min(speed * BALL_PHYSICS.wallRestitution, BALL_PHYSICS.maxWallReboundSpeed);
  const factor = reboundSpeed / speed;
  return axis === 'horizontal'
    ? { vx: vx * factor, vy: -vy * factor }
    : { vx: -vx * factor, vy: vy * factor };
}

function applyMagnus(vx: number, vy: number, spin: number): { vx: number; vy: number } {
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed < 0.3) return { vx, vy };
  const invSpeed = 1 / speed;
  return {
    vx: vx + (-vy * invSpeed) * spin * MAGNUS,
    vy: vy + (vx * invSpeed) * spin * MAGNUS,
  };
}

export function projectBallWithBounce(
  ball: BallState,
  frames: number,
  field: FieldBounds,
  spinScale = 1,
): { x: number; y: number } {
  if (frames <= 0) return { x: ball.x, y: ball.y };

  let x = ball.x;
  let y = ball.y;
  let vx = ball.velocity.x;
  let vy = ball.velocity.y;
  let spin = (ball.spin ?? 0) * spinScale;

  const wholeFrames = Math.floor(frames);
  const partial = frames - wholeFrames;

  for (let f = 0; f < wholeFrames; f++) {
    x += vx;
    y += vy;
    vx *= BALL_FRICTION;
    vy *= BALL_FRICTION;

    if (Math.abs(spin) > 0.005) {
      ({ vx, vy } = applyMagnus(vx, vy, spin));
      spin *= SPIN_DECAY;
    }

    if (y < field.top && vy < 0) {
      y = field.top;
      ({ vx, vy } = applyWallBounce(vx, vy, 'horizontal'));
    } else if (y > field.bottom && vy > 0) {
      y = field.bottom;
      ({ vx, vy } = applyWallBounce(vx, vy, 'horizontal'));
    }
    if (x < field.left && vx < 0) {
      x = field.left;
      ({ vx, vy } = applyWallBounce(vx, vy, 'vertical'));
    } else if (x > field.right && vx > 0) {
      x = field.right;
      ({ vx, vy } = applyWallBounce(vx, vy, 'vertical'));
    }
  }

  return { x: x + vx * partial, y: y + vy * partial };
}

export interface BallState {
  x: number;
  y: number;
  velocity: { x: number; y: number };
  spin?: number;
}

export interface PlayerPos {
  x: number;
  y: number;
}

export function projectBallAtFrames(ball: BallState, frames: number, spinScale = 1): { x: number; y: number } {
  if (frames <= 0) return { x: ball.x, y: ball.y };

  const spin = (ball.spin ?? 0) * spinScale;

  // Fast analytical path when no spin
  if (Math.abs(spin) < 0.005) {
    const wholeFrames = Math.max(0, Math.floor(frames));
    const partialFrame = clamp(frames - wholeFrames, 0, 1);
    const fullFrameFactor = wholeFrames > 0
      ? (1 - Math.pow(BALL_FRICTION, wholeFrames)) / (1 - BALL_FRICTION)
      : 0;
    const partialVelocityFactor = Math.pow(BALL_FRICTION, wholeFrames) * partialFrame;
    const displacementFactor = fullFrameFactor + partialVelocityFactor;
    return {
      x: ball.x + ball.velocity.x * displacementFactor,
      y: ball.y + ball.velocity.y * displacementFactor,
    };
  }

  // Iterative path with Magnus force
  let x = ball.x;
  let y = ball.y;
  let vx = ball.velocity.x;
  let vy = ball.velocity.y;
  let currentSpin = spin;

  const wholeFrames = Math.floor(frames);
  const partial = frames - wholeFrames;

  for (let f = 0; f < wholeFrames; f++) {
    x += vx;
    y += vy;
    vx *= BALL_FRICTION;
    vy *= BALL_FRICTION;
    if (Math.abs(currentSpin) > 0.005) {
      ({ vx, vy } = applyMagnus(vx, vy, currentSpin));
      currentSpin *= SPIN_DECAY;
    }
  }

  return { x: x + vx * partial, y: y + vy * partial };
}

export function findBallFramesToX(ball: BallState, lineX: number, maxFrames: number): number | null {
  const dir = Math.sign(lineX - ball.x);
  if (dir === 0) return 0;
  if ((dir < 0 && ball.velocity.x >= 0) || (dir > 0 && ball.velocity.x <= 0)) return null;

  let x = ball.x;
  let vx = ball.velocity.x;
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

export interface PlayerForIntercept {
  x: number;
  y: number;
  stats: { sprintSpeed: number; reactions: number };
  getStaminaFactor(): number;
}

export function projectBallIntercept(ball: BallState, player: PlayerForIntercept, field: FieldBounds): { x: number; y: number } {
  const speed = Math.sqrt(ball.velocity.x * ball.velocity.x + ball.velocity.y * ball.velocity.y);
  if (speed < 0.8) return { x: ball.x, y: ball.y };

  const dx = player.x - ball.x;
  const dy = player.y - ball.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const playerSpeed = Math.max(0.4, (player.stats.sprintSpeed / 100) * 1.85 * player.getStaminaFactor());
  const frames = clamp(d / playerSpeed, 0, 90);

  // 0.62 (reactions=0) → 1.0 (reactions=100)
  const anticipation = 0.62 + (player.stats.reactions / 100) * 0.38;
  const projected = projectBallAtFrames(ball, frames);

  return {
    x: clamp(projected.x * anticipation + ball.x * (1 - anticipation), field.left + 15, field.right - 15),
    y: clamp(projected.y * anticipation + ball.y * (1 - anticipation), field.top + 15, field.bottom - 15),
  };
}

export function planReceptionTarget(
  ball: BallState,
  player: PlayerForIntercept,
  nearestOpp: { x: number; y: number } | null,
  field: FieldBounds,
): { x: number; y: number; urgency: number } {
  const ballSpeed = Math.sqrt(ball.velocity.x * ball.velocity.x + ball.velocity.y * ball.velocity.y);
  const bdx = player.x - ball.x;
  const bdy = player.y - ball.y;
  const ballDist = Math.sqrt(bdx * bdx + bdy * bdy);
  const intercept = projectBallIntercept(ball, player, field);

  if (ballSpeed < 0.8) {
    return { x: ball.x, y: ball.y, urgency: clamp(ballDist / 90, 0, 1) };
  }

  const invSpeed = 1 / ballSpeed;
  const ballDirX = ball.velocity.x * invSpeed;
  const ballDirY = ball.velocity.y * invSpeed;
  const perpX = -ballDirY;
  const perpY = ballDirX;

  let oppDist = 999;
  if (nearestOpp) {
    const odx = player.x - nearestOpp.x;
    const ody = player.y - nearestOpp.y;
    oppDist = Math.sqrt(odx * odx + ody * ody);
  }

  const pressure = clamp((82 - oppDist) / 82, 0, 1);
  const closeControl = clamp((70 - ballDist) / 70, 0, 1);
  const slowBall = clamp((3.4 - ballSpeed) / 3.4, 0, 1);

  const meetBall = slowBall * 0.68 + pressure * 0.18;
  const cushion = 5 + closeControl * 8 + pressure * 4 - slowBall * 4;
  let receiveX = intercept.x * (1 - meetBall) + ball.x * meetBall - ballDirX * cushion;
  let receiveY = intercept.y * (1 - meetBall) + ball.y * meetBall - ballDirY * cushion;

  let lateralSign = player.y < field.centerY ? 1 : -1;
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
    x: clamp(receiveX, field.left + 15, field.right - 15),
    y: clamp(receiveY, field.top + 15, field.bottom - 15),
    urgency,
  };
}

export function findClosestBallFrameToPlayer(ball: BallState, player: PlayerPos, maxFrames: number, spinScale = 1): number {
  const sampleCount = Math.max(1, Math.ceil(maxFrames));
  let bestFrame = 0;
  let bestDistSq = Infinity;

  for (let frame = 0; frame <= sampleCount; frame++) {
    const p = projectBallAtFrames(ball, Math.min(frame, maxFrames), spinScale);
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

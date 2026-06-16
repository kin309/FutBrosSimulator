import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, HUD_HEIGHT, FIELD, GOAL_HEIGHT, GOAL_LEFT, GOAL_RIGHT } from '../constants';

const PENALTY_AREA_H = 396;
const PENALTY_AREA_W = 182;
const GOAL_AREA_H    = 240;
const GOAL_AREA_W    = 62;
const CENTER_CIRCLE_RADIUS = 100;

export function drawField(scene: Phaser.Scene): void {
  const g = scene.add.graphics().setDepth(0);
  const pitchW = FIELD.right - FIELD.left;
  const pitchH = FIELD.bottom - FIELD.top;
  const penaltyW = PENALTY_AREA_W;
  const penaltyH = PENALTY_AREA_H;
  const goalAreaW = GOAL_AREA_W;
  const goalAreaH = GOAL_AREA_H;
  const penaltySpotOffset = 125;

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
      g.fillStyle(0x1f6e1f, 0.62);
    } else {
      g.fillStyle(0x3B7D40, 0.54);
    }
    g.fillRect(sx, FIELD.top, sw, pitchH);
  }

  // Inner-edge shadow — subtle vignette to give the pitch depth
  g.fillStyle(0x000000, 0.08);
  g.fillRect(FIELD.left, FIELD.top, pitchW, 18);
  g.fillRect(FIELD.left, FIELD.bottom - 18, pitchW, 18);
  g.fillRect(FIELD.left, FIELD.top, 18, pitchH);
  g.fillRect(FIELD.right - 18, FIELD.top, 18, pitchH);
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

  // Penalty arc ("D")
  const penaltyArcR = 101;
  const spotToBoxEdge = penaltyW - penaltySpotOffset;
  const dAngle = Math.acos(spotToBoxEdge / penaltyArcR);
  g.lineStyle(2, 0xffffff, 0.9);
  g.beginPath();
  g.arc(FIELD.left + penaltySpotOffset, FIELD.centerY, penaltyArcR, -dAngle, dAngle, false);
  g.strokePath();
  g.beginPath();
  g.arc(FIELD.right - penaltySpotOffset, FIELD.centerY, penaltyArcR, Math.PI - dAngle, Math.PI + dAngle, false);
  g.strokePath();

  // Corner arcs
  const cornerR = 22;
  g.beginPath(); g.arc(FIELD.left,  FIELD.top,    cornerR, 0,              Math.PI * 0.5, false); g.strokePath();
  g.beginPath(); g.arc(FIELD.right, FIELD.top,    cornerR, Math.PI * 0.5,  Math.PI,       false); g.strokePath();
  g.beginPath(); g.arc(FIELD.right, FIELD.bottom, cornerR, Math.PI,        Math.PI * 1.5, false); g.strokePath();
  g.beginPath(); g.arc(FIELD.left,  FIELD.bottom, cornerR, Math.PI * 1.5,  Math.PI * 2,   false); g.strokePath();

  // Goals
  g.fillStyle(0xffffff, 0.2);
  g.fillRect(0, GOAL_LEFT.top, FIELD.left, GOAL_HEIGHT);
  g.lineStyle(3, 0xffffff, 1);
  g.strokeRect(0, GOAL_LEFT.top, FIELD.left, GOAL_HEIGHT);

  g.fillStyle(0xffffff, 0.2);
  g.fillRect(FIELD.right, GOAL_RIGHT.top, GAME_WIDTH - FIELD.right, GOAL_HEIGHT);
  g.strokeRect(FIELD.right, GOAL_RIGHT.top, GAME_WIDTH - FIELD.right, GOAL_HEIGHT);

  // Goal posts
  g.fillStyle(0xffffff);
  g.fillRect(FIELD.left  - 3, GOAL_LEFT.top    - 3, 6, 6);
  g.fillRect(FIELD.left  - 3, GOAL_LEFT.bottom - 3, 6, 6);
  g.fillRect(FIELD.right - 3, GOAL_RIGHT.top   - 3, 6, 6);
  g.fillRect(FIELD.right - 3, GOAL_RIGHT.bottom - 3, 6, 6);

  // HUD strip
  scene.add.rectangle(GAME_WIDTH / 2, HUD_HEIGHT / 2 - 2, GAME_WIDTH, HUD_HEIGHT, 0x0f172a, 0.95).setDepth(18);
}

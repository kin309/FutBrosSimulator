import { Ball } from '../entities/Ball';
import { Player } from '../entities/Player';
import { Team } from '../entities/Team';
import { MatchManager } from './MatchManager';
import { PlayerRole } from '../data/PlayerRole';
import { PlayerState } from '../data/PlayerState';
import { FieldBounds } from '../types';
import { clamp } from '../utils/MathUtils';
import type { MatchContext } from './MatchContext';

const CENTER_CIRCLE_RADIUS = 100;

export class MatchFlowSystem {
  private ball: Ball;
  private teamA: Team;
  private teamB: Team;
  private matchManager: MatchManager;
  private field: FieldBounds;
  private getAllPlayers: () => Player[];

  private advTeamId = '';
  private advText: { destroy(): void } | null = null;
  private advPrevBallX = 0;

  constructor(ctx: MatchContext) {
    this.ball = ctx.ball;
    this.teamA = ctx.teamA;
    this.teamB = ctx.teamB;
    this.matchManager = ctx.matchManager;
    this.field = ctx.field;
    this.getAllPlayers = ctx.allPlayers;
  }

  get isAdvantageActive(): boolean { return !!this.advTeamId; }

  beginAdvantage(teamId: string, ballX: number, text: { destroy(): void }): void {
    this.advTeamId = teamId;
    this.advPrevBallX = ballX;
    this.advText = text;
  }

  updateAdvantage(_delta: number): void {
    const CROSS_BUFFER = 15;
    const prevSide = this.advPrevBallX < this.field.centerX ? -1 : 1;
    const crossedLeft  = prevSide ===  1 && this.ball.x < this.field.centerX - CROSS_BUFFER;
    const crossedRight = prevSide === -1 && this.ball.x > this.field.centerX + CROSS_BUFFER;
    if (crossedLeft || crossedRight) {
      this.endAdvantage();
      return;
    }
    this.advPrevBallX = this.ball.x;
  }

  endAdvantage(): void {
    if (!this.advTeamId) return;
    this.advText?.destroy();
    this.advText = null;
    this.advTeamId = '';
    this.advPrevBallX = 0;
    this.matchManager.forceFinish();
  }

  giveKickoff(teamId: string): void {
    const team = teamId === 'teamA' ? this.teamA : this.teamB;
    const kicker = team.players.find(p =>
      p.role === PlayerRole.Midfielder || p.role === PlayerRole.Striker,
    ) ?? team.players[1];

    const offsetX = team.attackDirection > 0 ? -35 : 35;
    kicker.x = this.field.centerX + offsetX;
    kicker.y = this.field.centerY;
    kicker.targetX = kicker.x;
    kicker.targetY = kicker.y;
    kicker.hasBall = true;
    kicker.state = PlayerState.CarryBall;
    kicker.aiCooldown = 800;
    this.clearCenterCircleForKickoff(kicker);

    this.ball.setPosition(kicker.x, kicker.y);
    this.ball.attachToPlayer(kicker);
  }

  resetPositions(): void {
    this.resetPlayersToKickoffShape();
    this.ball.release();
    this.ball.setPosition(this.field.centerX, this.field.centerY);
    this.ball.velocity = { x: 0, y: 0 };
    this.ball.resetFlight();
    const scorer = this.matchManager.getLastScorer();
    this.giveKickoff(scorer === 'teamA' ? 'teamB' : 'teamA');
  }

  resetPlayersToKickoffShape(): void {
    for (const p of this.getAllPlayers()) {
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

  swapSides(): void {
    const fieldMidX = this.field.centerX * 2;
    for (const p of this.getAllPlayers()) {
      p.baseX = fieldMidX - p.baseX;
      p.attackDirection = (p.attackDirection * -1) as 1 | -1;
    }
    this.teamA.attackDirection = (this.teamA.attackDirection * -1) as 1 | -1;
    this.teamB.attackDirection = (this.teamB.attackDirection * -1) as 1 | -1;
  }

  private kickoffFormationX(baseX: number, attackDirection: 1 | -1): number {
    const FORM_GK_X  = 105;
    const FORM_ATT_X = 900;
    const FORM_RANGE = FORM_ATT_X - FORM_GK_X; // 795

    const buffer = CENTER_CIRCLE_RADIUS + 22;

    if (attackDirection === 1) {
      const ownHalfEnd = this.field.centerX - buffer;
      const ratio = clamp((baseX - FORM_GK_X) / FORM_RANGE, 0, 1);
      return FORM_GK_X + ratio * (ownHalfEnd - FORM_GK_X);
    } else {
      const mirroredGKX  = this.field.left + this.field.right - FORM_GK_X;
      const ownHalfStart = this.field.centerX + buffer;
      const ratio = clamp((mirroredGKX - baseX) / FORM_RANGE, 0, 1);
      return mirroredGKX - ratio * (mirroredGKX - ownHalfStart);
    }
  }

  private clearCenterCircleForKickoff(kicker: Player): void {
    const minRadius = CENTER_CIRCLE_RADIUS + 24;

    for (const p of this.getAllPlayers()) {
      if (p === kicker) continue;

      const dx = p.x - this.field.centerX;
      const dy = p.y - this.field.centerY;
      const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);
      if (distanceFromCenter >= minRadius) continue;

      const side = -p.attackDirection;
      const nx = distanceFromCenter > 1 ? dx / distanceFromCenter : side;
      const ny = distanceFromCenter > 1
        ? dy / distanceFromCenter
        : (p.baseY < this.field.centerY ? -0.45 : 0.45);
      const rawX = this.field.centerX + nx * minRadius;
      const rawY = this.field.centerY + ny * minRadius;
      const ownHalfX = p.attackDirection === 1
        ? Math.min(rawX, this.field.centerX - minRadius * 0.35)
        : Math.max(rawX, this.field.centerX + minRadius * 0.35);

      p.x = clamp(ownHalfX, this.field.left + 20, this.field.right - 20);
      p.y = clamp(rawY, this.field.top + 24, this.field.bottom - 24);
      p.targetX = p.x;
      p.targetY = p.y;
      p.vx = 0;
      p.vy = 0;
    }
  }
}

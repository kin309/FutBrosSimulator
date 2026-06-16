import type { MultiplayerMatchLiveState, SpectatorEvent, SpectatorPlayerState } from '../../draft/MultiplayerLobby';
import type { Player } from '../entities/Player';
import type { MatchContext } from './MatchContext';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class SpectatorSystem {
  private latestState: MultiplayerMatchLiveState | null = null;
  private lastEventAt = 0;
  private playerById = new Map<string, Player>();
  private liveUpdateElapsedMs = 0;

  // Interpolation between snapshots
  private interpElapsedMs = 0;
  private interpDurationMs = 50;
  private lastFrameRealMs = 0;
  private prevBall: { x: number; y: number; vx: number; vy: number } | null = null;
  private targetBall: { x: number; y: number; vx: number; vy: number } | null = null;
  private prevPlayerPos = new Map<string, { x: number; y: number }>();
  private targetPlayers: SpectatorPlayerState[] = [];

  constructor(private readonly ctx: MatchContext) {}

  init(): void {
    for (const p of this.ctx.allPlayers()) this.playerById.set(p.id, p);
    this.ctx.setup?.onSpectatorFrame?.((state) => {
      const now = performance.now();

      if (state.replay) {
        if (this.lastFrameRealMs > 0) {
          const measured = now - this.lastFrameRealMs;
          // Clamp to reasonable range; pad by 20% so we reach target before next frame
          this.interpDurationMs = Math.max(20, Math.min(measured * 1.2, 250));
        }

        // Capture current rendered positions as interpolation origin
        this.prevBall = {
          x: this.ctx.ball.x,
          y: this.ctx.ball.y,
          vx: this.ctx.ball.velocity.x,
          vy: this.ctx.ball.velocity.y,
        };
        for (const pd of state.replay.players) {
          const p = this.playerById.get(pd.id);
          if (p) this.prevPlayerPos.set(pd.id, { x: p.x, y: p.y });
          // Apply non-position state immediately (direction, hasBall, stamina…)
          p?.applySpectatorFrameState(pd);
        }

        this.targetBall = state.replay.ball;
        this.targetPlayers = state.replay.players;
        this.interpElapsedMs = 0;
      }

      this.lastFrameRealMs = now;
      this.latestState = state;
    });
  }

  tickLiveUpdate(simDelta: number): void {
    this.liveUpdateElapsedMs += simDelta;
    if (this.liveUpdateElapsedMs >= 50) {
      this.liveUpdateElapsedMs = 0;
      this.emitLiveUpdate();
    }
  }

  update(delta: number): void {
    const s = this.latestState;
    if (!s) return;

    const { matchManager, scoreboard, ball } = this.ctx;

    matchManager.scoreA = s.scoreHome;
    matchManager.scoreB = s.scoreAway;
    matchManager.spectatorClockOverride = s.clock;
    matchManager.state = s.phase as import('./MatchManager').MatchState;
    scoreboard.update();

    if (s.event && s.updatedAt !== this.lastEventAt) {
      this.lastEventAt = s.updatedAt;
      const ev = s.event;
      if (ev.type === 'goal' && ev.teamId) {
        scoreboard.showGoalBanner(ev.text ?? '');
        this.ctx.spawnGoalConfetti(ev.teamId);
        const teamPlayers = ev.teamId === 'teamA' ? this.ctx.teamA.players : this.ctx.teamB.players;
        const otherPlayers = ev.teamId === 'teamA' ? this.ctx.teamB.players : this.ctx.teamA.players;
        for (const p of teamPlayers) p.showCelebration();
        for (const p of otherPlayers) p.showDisappointment();
      } else if (ev.type === 'halftime') {
        this.ctx.showHalftimeBanner();
      } else if (ev.type === 'finished') {
        scoreboard.showFinished(false);
      }
    }

    if (this.prevBall && this.targetBall) {
      // Smooth interpolation between snapshots
      this.interpElapsedMs += delta;
      const t = Math.min(this.interpElapsedMs / this.interpDurationMs, 1);

      ball.setPosition(
        lerp(this.prevBall.x, this.targetBall.x, t),
        lerp(this.prevBall.y, this.targetBall.y, t),
      );
      ball.velocity = {
        x: lerp(this.prevBall.vx, this.targetBall.vx, t),
        y: lerp(this.prevBall.vy, this.targetBall.vy, t),
      };

      for (const pd of this.targetPlayers) {
        const p = this.playerById.get(pd.id);
        if (!p) continue;
        const prev = this.prevPlayerPos.get(pd.id);
        if (prev) {
          p.setPosition(lerp(prev.x, pd.x, t), lerp(prev.y, pd.y, t));
        }
        p.updateLabelAlpha(ball.x, ball.y);
      }
    } else if (s.replay) {
      // First frame ever: apply directly, no previous positions to lerp from
      ball.setPosition(s.replay.ball.x, s.replay.ball.y);
      ball.velocity = { x: s.replay.ball.vx, y: s.replay.ball.vy };
      for (const pd of s.replay.players) {
        const p = this.playerById.get(pd.id);
        if (!p) continue;
        p.applySpectatorFrame(pd);
        p.updateLabelAlpha(s.replay.ball.x, s.replay.ball.y);
      }
    }
  }

  emitLiveUpdate(eventText?: string, event?: SpectatorEvent): void {
    const { setup, matchManager, ball, allPlayers } = this.ctx;
    if (!setup?.onLiveUpdate) return;
    setup.onLiveUpdate({
      scoreA: matchManager.scoreA,
      scoreB: matchManager.scoreB,
      clock: matchManager.getTimeString(),
      phase: matchManager.state,
      eventText,
      event,
      replay: {
        ball: { x: ball.x, y: ball.y, vx: ball.velocity.x, vy: ball.velocity.y },
        players: allPlayers().map((p) => {
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
}

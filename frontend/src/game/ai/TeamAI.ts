import { Team } from '../entities/Team';
import { Ball } from '../entities/Ball';
import { Player } from '../entities/Player';
import { PlayerRole } from '../data/PlayerRole';
import { PlayerState } from '../data/PlayerState';
import { updatePlayerAI } from './PlayerAI';
import { AIContext } from './DecisionUtils';
import { FieldHeatMap } from './FieldHeatMap';
import { GoalBounds, FieldBounds } from '../types';
import {
  TacticalPhase,
  TacticalDirective,
  GameContext,
  ActiveSetPlay,
  detectPhase,
  tryTriggerSetPlay,
  tickSetPlay,
} from './TacticalAI';

// Minimum gap between two consecutive set plays (ms)
const SET_PLAY_COOLDOWN_MS = 7000;

export class TeamAI {
  private team: Team;
  private directive: TacticalDirective = { phase: 'hold-shape', setPlay: null };
  private setPlayCooldown = 0;
  private manualPhase: TacticalPhase | null = null;

  constructor(team: Team) {
    this.team = team;
  }

  // Human-controlled tactical override (null = auto-detect).
  setManualPhase(phase: TacticalPhase | null): void {
    this.manualPhase = phase;
  }

  getManualPhase(): TacticalPhase | null {
    return this.manualPhase;
  }

  getPhase(): TacticalPhase {
    return this.directive.phase;
  }

  getActiveSetPlay(): ActiveSetPlay | null {
    return this.directive.setPlay;
  }

  update(
    delta: number,
    ball: Ball,
    oppTeam: Team,
    ownGoal: GoalBounds,
    oppGoal: GoalBounds,
    field: FieldBounds,
    gameCtx?: GameContext,
    heatMap?: FieldHeatMap,
  ): void {
    // ── Tick active set play ──────────────────────────────────────────────────
    if (this.directive.setPlay) {
      this.directive.setPlay = tickSetPlay(this.directive.setPlay, delta);
      if (!this.directive.setPlay) {
        // Play just expired — enforce cooldown before the next one can fire
        this.setPlayCooldown = SET_PLAY_COOLDOWN_MS;
      }
    }
    this.setPlayCooldown = Math.max(0, this.setPlayCooldown - delta);

    // ── Detect tactical phase ─────────────────────────────────────────────────
    const phase = detectPhase(
      this.team, oppTeam, ball, field,
      gameCtx ?? { scoreOwn: 0, scoreOpp: 0, elapsedMs: 0, halfLengthMs: 180_000 },
      this.manualPhase,
    );

    // ── Try to trigger a set play ─────────────────────────────────────────────
    let setPlay = this.directive.setPlay;
    if (!setPlay && this.setPlayCooldown <= 0) {
      const candidate = tryTriggerSetPlay(this.team, oppTeam, ball, oppGoal, field, phase);
      if (candidate) setPlay = candidate;
    }

    this.directive = { phase, setPlay };

    // ── Build enriched AI context ─────────────────────────────────────────────
    const ctx: AIContext = {
      ball,
      ownTeam: this.team,
      oppTeam,
      ownGoal,
      oppGoal,
      field,
      directive: this.directive,
      heatMap,
    };

    // ── Presser cap (relaxed for high-press; press-trap players are exempt) ───
    // Allow up to 3 simultaneous pressers in high-press mode; 1 otherwise.
    const maxPressers = phase === 'high-press' ? 3 : 1;
    let presserCount = 0;
    for (const p of this.team.players) {
      if (p.state === PlayerState.PressBall && !p.hasBall) presserCount++;
    }

    for (const player of this.team.players) {
      const isSetPlayPresser = setPlay?.kind === 'press-trap' && setPlay.roles.has(player.id);
      if (
        player.state === PlayerState.PressBall
        && !player.hasBall
        && player.role !== PlayerRole.Goalkeeper
        && presserCount > maxPressers
        && !isSetPlayPresser
      ) {
        player.state = PlayerState.ReturnToShape;
        player.setTarget(player.baseX, player.baseY);
      }
      updatePlayerAI(player, ctx, delta);
    }
  }

  getGoalkeeperFor(_goal: GoalBounds): Player | null {
    return this.team.players.find(p => p.role === PlayerRole.Goalkeeper) ?? null;
  }
}

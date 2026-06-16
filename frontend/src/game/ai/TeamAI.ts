import { Team } from '../entities/Team';
import { Ball } from '../entities/Ball';
import { Player } from '../entities/Player';
import { PlayerRole } from '../data/PlayerRole';
import { PlayerState } from '../data/PlayerState';
import { updatePlayerAI } from './PlayerAI';
import { AIContext } from './DecisionUtils';
import { FieldHeatMap } from './FieldHeatMap';
import { GoalBounds, FieldBounds } from '../types';
import { clamp } from '../utils/MathUtils';
import {
  TacticalPhase,
  TacticalDirective,
  GameContext,
  ActiveSetPlay,
  detectPhase,
  tryTriggerSetPlay,
  tickSetPlay,
} from './TacticalAI';
import { TacticalProfile, DEFAULT_TACTICAL_PROFILE } from '../data/TacticalProfile';
import { PlayerInstructions } from '../data/PlayerInstructions';

// Minimum gap between two consecutive set plays (ms)
const SET_PLAY_COOLDOWN_MS = 7000;

export class TeamAI {
  private team: Team;
  private directive: TacticalDirective = { phase: 'hold-shape', setPlay: null };
  private setPlayCooldown = 0;
  private manualPhase: TacticalPhase | null = null;
  private profile: TacticalProfile = DEFAULT_TACTICAL_PROFILE;
  private appliedLineDepthOffset = 0;
  private playerInstructions: Map<string, PlayerInstructions> = new Map();

  constructor(team: Team) {
    this.team = team;
  }

  setTacticalProfile(profile: TacticalProfile): void {
    const dir = this.team.attackDirection;
    // Undo previous defensive line offset before applying the new one
    if (this.appliedLineDepthOffset !== 0) {
      for (const p of this.team.players) {
        if (p.role === PlayerRole.Defender || p.role === PlayerRole.Midfielder) {
          p.baseX -= this.appliedLineDepthOffset;
        }
      }
    }
    // Positive defensiveLineDepth = deeper line; negative = higher line
    const newOffset = dir * -profile.defensiveLineDepth;
    for (const p of this.team.players) {
      if (p.role === PlayerRole.Defender || p.role === PlayerRole.Midfielder) {
        p.baseX += newOffset;
      }
    }
    this.appliedLineDepthOffset = newOffset;
    this.profile = profile;
  }

  getTacticalProfile(): TacticalProfile {
    return this.profile;
  }

  setPlayerInstructions(map: Map<string, PlayerInstructions>): void {
    this.playerInstructions = map;
  }

  getPlayerInstructions(): Map<string, PlayerInstructions> {
    return this.playerInstructions;
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
      gameCtx ?? { scoreOwn: 0, scoreOpp: 0, elapsedMs: 0, halfLengthMs: 150_000 },
      this.manualPhase,
      this.profile.pressStaminaThreshold,
    );

    // ── Try to trigger a set play ─────────────────────────────────────────────
    let setPlay = this.directive.setPlay;
    if (!setPlay && this.setPlayCooldown <= 0) {
      const candidate = tryTriggerSetPlay(this.team, oppTeam, ball, oppGoal, field, phase, this.profile);
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
      tacticalProfile: this.profile,
      playerInstructions: this.playerInstructions.size > 0 ? this.playerInstructions : undefined,
    };

    // ── Presser cap driven by tactical profile ────────────────────────────────
    const maxPressers = phase === 'high-press'
      ? this.profile.maxPressers
      : Math.min(1, this.profile.maxPressers);
    let presserCount = 0;
    for (const p of this.team.players) {
      if (p.state === PlayerState.PressBall && !p.hasBall) presserCount++;
    }

    for (const player of this.team.players) {
      // "Ficar na frente" (stay) sobrescreve strikersTrackBack por jogador.
      // Instrução 'track-back' força o retorno mesmo para atacantes que normalmente ficam.
      if (!player.hasBall && !this.team.hasPossession()) {
        const inst = this.playerInstructions.get(player.id);
        const defPartic = inst?.defensiveParticipation;
        const shouldStayForward = defPartic === 'stay'
          || (defPartic === undefined && !this.profile.strikersTrackBack && player.role === PlayerRole.Striker);
        if (shouldStayForward) {
          player.state = PlayerState.FindSpace;
        }
      }

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

    // Defensive compactness: defenders and midfielders nudge laterally toward the ball.
    // Near-side players close down space slightly; far-side players barely move (cover).
    // Only applied on ReturnToShape so attackers holding position are not affected.
    if (!this.team.hasPossession()) {
      const fieldHalfH = (field.bottom - field.top) / 2;
      const ballLateral = ball.y - field.centerY;
      for (const p of this.team.players) {
        if (p.hasBall || p.role === PlayerRole.Goalkeeper) continue;
        if (p.role !== PlayerRole.Defender && p.role !== PlayerRole.Midfielder) continue;
        if (p.state !== PlayerState.ReturnToShape) continue;
        const sameSideness = ((p.baseY - field.centerY) / fieldHalfH) * (ballLateral / fieldHalfH);
        const weight   = sameSideness > 0 ? 0.14 : 0.04;
        const maxShift = sameSideness > 0 ? 22   : 8;
        const pull = clamp(ballLateral * weight, -maxShift, maxShift);
        p.setTarget(
          p.targetX,
          clamp(p.targetY + pull, field.top + 20, field.bottom - 20),
        );
      }
    }
  }

  getGoalkeeperFor(_goal: GoalBounds): Player | null {
    return this.team.players.find(p => p.role === PlayerRole.Goalkeeper) ?? null;
  }
}

import type { Player } from '../entities/Player';
import type { PlayerState } from '../data/PlayerState';
import type { DebugDecisionEvent, DebugDecisionKind, DebugPoint } from './DebugTypes';

const DEFAULT_LIMIT = 240;

export class DebugCollector {
  private events: DebugDecisionEvent[] = [];
  private nextId = 1;
  private clock = "0'";

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  setClock(clock: string): void {
    this.clock = clock;
  }

  recordDecision(args: {
    player: Player;
    previousState: PlayerState;
    nextState: PlayerState;
    kind: DebugDecisionKind;
    reason: string;
    target?: DebugPoint;
    targetPlayer?: Player | null;
  }): void {
    const event: DebugDecisionEvent = {
      id: this.nextId++,
      category: 'decision',
      clock: this.clock,
      playerId: args.player.id,
      playerName: args.player.playerName,
      teamId: args.player.teamId,
      previousState: args.previousState,
      nextState: args.nextState,
      kind: args.kind,
      target: args.target,
      targetPlayerId: args.targetPlayer?.id,
      targetPlayerName: args.targetPlayer?.playerName,
      reason: args.reason,
    };

    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
  }

  recordAction(args: {
    player: Player;
    kind: DebugDecisionKind;
    reason: string;
    target?: DebugPoint;
    targetPlayer?: Player | null;
  }): void {
    const event: DebugDecisionEvent = {
      id: this.nextId++,
      category: 'action',
      clock: this.clock,
      playerId: args.player.id,
      playerName: args.player.playerName,
      teamId: args.player.teamId,
      previousState: args.player.state,
      nextState: args.player.state,
      kind: args.kind,
      target: args.target,
      targetPlayerId: args.targetPlayer?.id,
      targetPlayerName: args.targetPlayer?.playerName,
      reason: args.reason,
    };

    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
  }

  recentForPlayer(playerId: string, count = 5): DebugDecisionEvent[] {
    const result: DebugDecisionEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && result.length < count; i--) {
      if (this.isRelatedToPlayer(this.events[i], playerId)) result.push(this.events[i]);
    }
    return result;
  }

  recentActions(count = 5): DebugDecisionEvent[] {
    const result: DebugDecisionEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && result.length < count; i--) {
      if (this.events[i].category === 'action') result.push(this.events[i]);
    }
    return result;
  }

  latestForPlayer(playerId: string): DebugDecisionEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.isRelatedToPlayer(this.events[i], playerId)) return this.events[i];
    }
    return null;
  }

  latestActionForPlayer(playerId: string): DebugDecisionEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.category === 'action' && this.isRelatedToPlayer(event, playerId)) return event;
    }
    return null;
  }

  clear(): void {
    this.events = [];
  }

  private isRelatedToPlayer(event: DebugDecisionEvent, playerId: string): boolean {
    return event.playerId === playerId || event.targetPlayerId === playerId;
  }
}

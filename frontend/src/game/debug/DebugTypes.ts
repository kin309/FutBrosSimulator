import type { PlayerState } from '../data/PlayerState';

export type DebugDecisionKind =
  | 'state-change'
  | 'pass'
  | 'pass-executed'
  | 'pass-completed'
  | 'pass-missed'
  | 'reception-controlled'
  | 'reception-missed'
  | 'shoot'
  | 'shot-executed'
  | 'shot-goal'
  | 'shot-saved'
  | 'shot-missed'
  | 'save'
  | 'carry'
  | 'dribble'
  | 'dribble-won'
  | 'dribble-lost'
  | 'mark'
  | 'press'
  | 'shape'
  | 'clearance'
  | 'clearance-executed'
  | 'interception'
  | 'deflection'
  | 'tackle-won'
  | 'tackle-missed'
  | 'turnover'
  | 'protect';

export type DebugEventCategory = 'decision' | 'action';

export interface DebugPoint {
  x: number;
  y: number;
}

export interface DebugDecisionEvent {
  id: number;
  category: DebugEventCategory;
  clock: string;
  playerId: string;
  playerName: string;
  teamId: string;
  previousState: PlayerState;
  nextState: PlayerState;
  kind: DebugDecisionKind;
  target?: DebugPoint;
  targetPlayerId?: string;
  targetPlayerName?: string;
  reason: string;
}

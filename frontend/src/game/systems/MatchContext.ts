import type { Ball } from '../entities/Ball';
import type { Player } from '../entities/Player';
import type { Team } from '../entities/Team';
import type { MatchManager } from './MatchManager';
import type { Scoreboard } from './Scoreboard';
import type { StatsTracker } from './StatsTracker';
import type { EventResolver } from './EventResolver';
import type { GoalkeeperSystem } from './GoalkeeperSystem';
import type { PlayerKickSystem } from './PlayerKickSystem';
import type { AudioManager } from './AudioManager';
import type { FieldBounds, GoalBounds } from '../types';
import type { MatchSetup } from '../FootballGame';
import type { DebugCollector } from '../debug/DebugCollector';

export interface MatchContext {
  ball: Ball;
  teamA: Team;
  teamB: Team;
  matchManager: MatchManager;
  scoreboard: Scoreboard;
  stats: StatsTracker;
  resolver: EventResolver;
  audio: AudioManager;
  // Assigned after construction (dependency order: gk → kick → contact)
  gkSystem: GoalkeeperSystem | null;
  kickSystem: PlayerKickSystem | null;
  tackleCooldowns: Map<string, number>;
  field: FieldBounds;
  goalLeft: GoalBounds;
  goalRight: GoalBounds;
  setup: MatchSetup | undefined;
  debugCollector?: DebugCollector;
  allPlayers: () => Player[];
  recalculateRoutesAfterBallTrajectoryChange: (previousTarget?: Player | null) => void;
  shouldSprintForRace: (player: Player, opponent: Player, targetX: number, targetY: number) => boolean;
  isBallInDangerArea: () => boolean;
  spawnGoalConfetti: (teamId: string) => void;
  showHalftimeBanner: () => void;
}

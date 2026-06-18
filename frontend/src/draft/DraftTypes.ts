import { PlayerRole } from '../game/data/PlayerRole';
import { PlayerStats } from '../game/data/PlayerStats';

export interface DraftPlayer {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  commonName: string;
  nationality: string;
  team: string;
  leagueName: string;
  position: string;
  role: PlayerRole;
  overall: number;
  heightCm: number;
  weightKg: number;
  stats: PlayerStats;
  alternatePositions: string[];
  alternateRoles: PlayerRole[];
  playstyles: string[];
  playstylesPlus: string[];
}

export type DraftRoundKind = 'normal' | 'famous-clubs' | 'elite' | `nationality:${string}` | `position:${string}`;

export interface DraftRound {
  number: number;
  kind: DraftRoundKind;
  title: string;
  players: DraftPlayer[];
  rerollsLeft: number;
  picked: DraftPlayer[];
  isComplete: boolean;
}

export interface DraftConfig {
  totalPicks: number;
  totalRerolls: number;
  boosterSize: number;
  famousRoundChance: number;
  maxFamousRounds: number;
}

export interface BotTeam {
  name: string;
  overall: number;
  players: DraftPlayer[];
}

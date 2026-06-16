import { PlayerRole } from './PlayerRole';
import { PlayerStats } from './PlayerStats';

export interface PlayerData {
  id: string;
  name: string;
  jerseyNumber: number;
  role: PlayerRole;
  stats: PlayerStats;
  heightCm?: number;
  weightKg?: number;
  baseX: number;
  baseY: number;
  playstyles?: string[];
  playstylesPlus?: string[];
}

export type KitPattern = 'solid' | 'stripes-h' | 'stripes-v' | 'checkered' | 'sash';

export interface KitColors {
  primary: number;
  secondary: number;
  numberColor: number;
  pattern: KitPattern;
}

export interface TeamData {
  id: string;
  name: string;
  color: number;
  secondaryColor?: number;
  numberColor?: number;
  kitPattern?: KitPattern;
  attackDirection: 1 | -1;
  formationName: string;
  players: PlayerData[];
  bench?: PlayerData[];
}

// Formation definitions (Team A perspective: attacking left -> right).
// Each formation has exactly 11 slots: [GK, DEF/WING/MID/STR lines].
export interface FormationSlot { role: PlayerRole; x: number; y: number }

export interface FormationDefinition {
  name: string;
  slots: FormationSlot[];
}

export const FORMATIONS: FormationDefinition[] = [
  {
    // Balanced: four defenders, wide midfielders and two forwards.
    name: '4-4-2',
    slots: [
      { role: PlayerRole.Goalkeeper, x: 105, y: 410 },
      { role: PlayerRole.Defender,   x: 285, y: 150 },
      { role: PlayerRole.Defender,   x: 285, y: 320 },
      { role: PlayerRole.Defender,   x: 285, y: 500 },
      { role: PlayerRole.Defender,   x: 285, y: 670 },
      { role: PlayerRole.Midfielder, x: 535, y: 135 },
      { role: PlayerRole.Midfielder, x: 535, y: 320 },
      { role: PlayerRole.Midfielder, x: 535, y: 500 },
      { role: PlayerRole.Midfielder, x: 535, y: 685 },
      { role: PlayerRole.Striker,    x: 835, y: 315 },
      { role: PlayerRole.Striker,    x: 835, y: 505 },
    ],
  },
  {
    // Midfield dominant: wingbacks stretch the pitch with two forwards ahead.
    name: '3-5-2',
    slots: [
      { role: PlayerRole.Goalkeeper, x: 105, y: 410 },
      { role: PlayerRole.Defender,   x: 290, y: 210 },
      { role: PlayerRole.Defender,   x: 290, y: 410 },
      { role: PlayerRole.Defender,   x: 290, y: 610 },
      { role: PlayerRole.Midfielder, x: 520, y: 130 },
      { role: PlayerRole.Midfielder, x: 505, y: 285 },
      { role: PlayerRole.Midfielder, x: 535, y: 410 },
      { role: PlayerRole.Midfielder, x: 505, y: 535 },
      { role: PlayerRole.Midfielder, x: 520, y: 690 },
      { role: PlayerRole.Striker,    x: 825, y: 300 },
      { role: PlayerRole.Striker,    x: 825, y: 520 },
    ],
  },
  {
    // Attacking: back four, two wide forwards and a central striker.
    name: '4-3-3',
    slots: [
      { role: PlayerRole.Goalkeeper, x: 105, y: 410 },
      { role: PlayerRole.Defender,   x: 280, y: 160 },
      { role: PlayerRole.Defender,   x: 280, y: 325 },
      { role: PlayerRole.Defender,   x: 280, y: 495 },
      { role: PlayerRole.Defender,   x: 280, y: 660 },
      { role: PlayerRole.Midfielder, x: 520, y: 285 },
      { role: PlayerRole.Midfielder, x: 555, y: 410 },
      { role: PlayerRole.Midfielder, x: 520, y: 535 },
      { role: PlayerRole.Winger,     x: 835, y: 170 },
      { role: PlayerRole.Striker,    x: 850, y: 410 },
      { role: PlayerRole.Winger,     x: 835, y: 650 },
    ],
  },
  {
    // Defensive block with single striker: two holding mids screen the back four.
    name: '4-2-3-1',
    slots: [
      { role: PlayerRole.Goalkeeper, x: 105, y: 410 },
      { role: PlayerRole.Defender,   x: 280, y: 160 },
      { role: PlayerRole.Defender,   x: 280, y: 325 },
      { role: PlayerRole.Defender,   x: 280, y: 495 },
      { role: PlayerRole.Defender,   x: 280, y: 660 },
      { role: PlayerRole.Midfielder, x: 465, y: 325 },
      { role: PlayerRole.Midfielder, x: 465, y: 495 },
      { role: PlayerRole.Winger,     x: 690, y: 175 },
      { role: PlayerRole.Midfielder, x: 710, y: 410 },
      { role: PlayerRole.Winger,     x: 690, y: 645 },
      { role: PlayerRole.Striker,    x: 900, y: 410 },
    ],
  },
  {
    // Midfield overload: five midfielders support a lone striker.
    name: '4-5-1',
    slots: [
      { role: PlayerRole.Goalkeeper, x: 105, y: 410 },
      { role: PlayerRole.Defender,   x: 280, y: 160 },
      { role: PlayerRole.Defender,   x: 280, y: 325 },
      { role: PlayerRole.Defender,   x: 280, y: 495 },
      { role: PlayerRole.Defender,   x: 280, y: 660 },
      { role: PlayerRole.Midfielder, x: 540, y: 130 },
      { role: PlayerRole.Midfielder, x: 540, y: 275 },
      { role: PlayerRole.Midfielder, x: 540, y: 410 },
      { role: PlayerRole.Midfielder, x: 540, y: 545 },
      { role: PlayerRole.Midfielder, x: 540, y: 690 },
      { role: PlayerRole.Striker,    x: 870, y: 410 },
    ],
  },
  {
    // High press: back three, four midfielders and a front three.
    name: '3-4-3',
    slots: [
      { role: PlayerRole.Goalkeeper, x: 105, y: 410 },
      { role: PlayerRole.Defender,   x: 290, y: 215 },
      { role: PlayerRole.Defender,   x: 290, y: 410 },
      { role: PlayerRole.Defender,   x: 290, y: 605 },
      { role: PlayerRole.Midfielder, x: 530, y: 160 },
      { role: PlayerRole.Midfielder, x: 530, y: 330 },
      { role: PlayerRole.Midfielder, x: 530, y: 490 },
      { role: PlayerRole.Midfielder, x: 530, y: 660 },
      { role: PlayerRole.Winger,     x: 840, y: 175 },
      { role: PlayerRole.Striker,    x: 860, y: 410 },
      { role: PlayerRole.Winger,     x: 840, y: 645 },
    ],
  },
  {
    // Defensive: five-man backline with three midfielders and two forwards.
    name: '5-3-2',
    slots: [
      { role: PlayerRole.Goalkeeper, x: 105, y: 410 },
      { role: PlayerRole.Defender,   x: 285, y: 100 },
      { role: PlayerRole.Defender,   x: 285, y: 248 },
      { role: PlayerRole.Defender,   x: 285, y: 410 },
      { role: PlayerRole.Defender,   x: 285, y: 572 },
      { role: PlayerRole.Defender,   x: 285, y: 720 },
      { role: PlayerRole.Midfielder, x: 540, y: 270 },
      { role: PlayerRole.Midfielder, x: 555, y: 410 },
      { role: PlayerRole.Midfielder, x: 540, y: 550 },
      { role: PlayerRole.Striker,    x: 840, y: 300 },
      { role: PlayerRole.Striker,    x: 840, y: 520 },
    ],
  },
  {
    // Pressing: single holding mid sits between the back four and an attacking quartet.
    name: '4-1-4-1',
    slots: [
      { role: PlayerRole.Goalkeeper, x: 105, y: 410 },
      { role: PlayerRole.Defender,   x: 280, y: 160 },
      { role: PlayerRole.Defender,   x: 280, y: 325 },
      { role: PlayerRole.Defender,   x: 280, y: 495 },
      { role: PlayerRole.Defender,   x: 280, y: 660 },
      { role: PlayerRole.Midfielder, x: 415, y: 410 },
      { role: PlayerRole.Midfielder, x: 610, y: 155 },
      { role: PlayerRole.Midfielder, x: 610, y: 325 },
      { role: PlayerRole.Midfielder, x: 610, y: 495 },
      { role: PlayerRole.Midfielder, x: 610, y: 665 },
      { role: PlayerRole.Striker,    x: 900, y: 410 },
    ],
  },
];

// Player stat pools (index matches formation slot order).
// Players 0=GK, 1-4=DEF/versatile, 5-8=MID/WING, 9-10=advanced attackers.
const ROSTER_A: Array<{ name: string; stats: PlayerStats }> = [
  // GK
  { name: 'Carlos', stats: { overall: 78, speed: 60, shooting: 30, passing: 68, intelligence: 78,
    acceleration: 60, sprintSpeed: 60,
    finishing: 20, shotPower: 30, longShots: 20,
    shortPassing: 68, longPassing: 68, crossing: 20, vision: 65,
    dribbling: 55, agility: 55, ballControl: 55, skillMoves: 1, weakFootAbility: 3, preferredFoot: 1,
    defending: 82, interceptions: 82,
    physical: 75, strength: 75, balance: 60,
    composure: 78, reactions: 78,
    stamina: 80, aggression: 62 } },
  // DEF
  { name: 'Silva',  stats: { overall: 76, speed: 70, shooting: 45, passing: 65, intelligence: 74,
    acceleration: 70, sprintSpeed: 70,
    finishing: 40, shotPower: 45, longShots: 38,
    shortPassing: 65, longPassing: 62, crossing: 52, vision: 64,
    dribbling: 58, agility: 58, ballControl: 58, skillMoves: 2, weakFootAbility: 3, preferredFoot: 1,
    defending: 80, interceptions: 80,
    physical: 78, strength: 78, balance: 62,
    composure: 74, reactions: 72,
    stamina: 78, aggression: 72 } },
  { name: 'Marcos', stats: { overall: 74, speed: 68, shooting: 42, passing: 63, intelligence: 72,
    acceleration: 68, sprintSpeed: 68,
    finishing: 38, shotPower: 42, longShots: 36,
    shortPassing: 63, longPassing: 60, crossing: 50, vision: 62,
    dribbling: 56, agility: 56, ballControl: 56, skillMoves: 2, weakFootAbility: 3, preferredFoot: 1,
    defending: 78, interceptions: 78,
    physical: 76, strength: 76, balance: 60,
    composure: 72, reactions: 70,
    stamina: 76, aggression: 70 } },
  { name: 'Thiago', stats: { overall: 77, speed: 74, shooting: 53, passing: 72, intelligence: 76,
    acceleration: 74, sprintSpeed: 74,
    finishing: 48, shotPower: 52, longShots: 48,
    shortPassing: 72, longPassing: 72, crossing: 62, vision: 72,
    dribbling: 65, agility: 65, ballControl: 65, skillMoves: 2, weakFootAbility: 3, preferredFoot: 1,
    defending: 73, interceptions: 73,
    physical: 72, strength: 72, balance: 68,
    composure: 76, reactions: 74,
    stamina: 80, aggression: 65 } },
  // MID
  { name: 'Rafa',   stats: { overall: 82, speed: 78, shooting: 72, passing: 84, intelligence: 83,
    acceleration: 78, sprintSpeed: 78,
    finishing: 68, shotPower: 70, longShots: 68,
    shortPassing: 84, longPassing: 83, crossing: 76, vision: 85,
    dribbling: 79, agility: 79, ballControl: 79, skillMoves: 3, weakFootAbility: 3, preferredFoot: 1,
    defending: 60, interceptions: 60,
    physical: 70, strength: 70, balance: 78,
    composure: 83, reactions: 81,
    stamina: 85, aggression: 60 } },
  { name: 'Lucas',  stats: { overall: 80, speed: 74, shooting: 70, passing: 80, intelligence: 80,
    acceleration: 74, sprintSpeed: 74,
    finishing: 66, shotPower: 68, longShots: 65,
    shortPassing: 80, longPassing: 78, crossing: 72, vision: 80,
    dribbling: 75, agility: 75, ballControl: 75, skillMoves: 3, weakFootAbility: 3, preferredFoot: 1,
    defending: 62, interceptions: 62,
    physical: 68, strength: 68, balance: 74,
    composure: 80, reactions: 78,
    stamina: 82, aggression: 62 } },
  { name: 'Andre',  stats: { overall: 79, speed: 76, shooting: 69, passing: 78, intelligence: 79,
    acceleration: 76, sprintSpeed: 76,
    finishing: 65, shotPower: 67, longShots: 64,
    shortPassing: 78, longPassing: 76, crossing: 70, vision: 78,
    dribbling: 74, agility: 74, ballControl: 74, skillMoves: 3, weakFootAbility: 3, preferredFoot: 1,
    defending: 58, interceptions: 58,
    physical: 67, strength: 67, balance: 73,
    composure: 79, reactions: 77,
    stamina: 81, aggression: 61 } },
  // WIN
  { name: 'Gabi',   stats: { overall: 89, speed: 91, shooting: 84, passing: 85, intelligence: 86,
    acceleration: 93, sprintSpeed: 91,
    finishing: 80, shotPower: 82, longShots: 78,
    shortPassing: 85, longPassing: 80, crossing: 88, vision: 82,
    dribbling: 87, agility: 87, ballControl: 87, skillMoves: 4, weakFootAbility: 4, preferredFoot: 1,
    defending: 53, interceptions: 53,
    physical: 75, strength: 75, balance: 88,
    composure: 86, reactions: 85,
    stamina: 91, aggression: 65 } },
  { name: 'Nando',  stats: { overall: 78, speed: 82, shooting: 71, passing: 76, intelligence: 78,
    acceleration: 85, sprintSpeed: 82,
    finishing: 67, shotPower: 70, longShots: 65,
    shortPassing: 76, longPassing: 72, crossing: 80, vision: 76,
    dribbling: 80, agility: 80, ballControl: 80, skillMoves: 3, weakFootAbility: 3, preferredFoot: 1,
    defending: 55, interceptions: 55,
    physical: 66, strength: 66, balance: 80,
    composure: 78, reactions: 76,
    stamina: 84, aggression: 63 } },
  // STR
  { name: 'Breno',  stats: { overall: 83, speed: 86, shooting: 80, passing: 79, intelligence: 82,
    acceleration: 88, sprintSpeed: 86,
    finishing: 83, shotPower: 82, longShots: 75,
    shortPassing: 79, longPassing: 74, crossing: 65, vision: 76,
    dribbling: 82, agility: 82, ballControl: 82, skillMoves: 3, weakFootAbility: 3, preferredFoot: 1,
    defending: 50, interceptions: 50,
    physical: 72, strength: 76, balance: 78,
    composure: 82, reactions: 80,
    stamina: 86, aggression: 70 } },
  { name: 'Dudu',   stats: { overall: 84, speed: 88, shooting: 81, passing: 80, intelligence: 83,
    acceleration: 90, sprintSpeed: 88,
    finishing: 85, shotPower: 83, longShots: 76,
    shortPassing: 80, longPassing: 75, crossing: 65, vision: 77,
    dribbling: 84, agility: 84, ballControl: 84, skillMoves: 4, weakFootAbility: 4, preferredFoot: 1,
    defending: 48, interceptions: 48,
    physical: 70, strength: 74, balance: 80,
    composure: 83, reactions: 81,
    stamina: 87, aggression: 68 } },
];

const ROSTER_B: Array<{ name: string; stats: PlayerStats }> = [
  // GK
  { name: 'Diego',  stats: { overall: 80, speed: 62, shooting: 35, passing: 70, intelligence: 80,
    acceleration: 62, sprintSpeed: 62,
    finishing: 20, shotPower: 35, longShots: 20,
    shortPassing: 70, longPassing: 70, crossing: 20, vision: 67,
    dribbling: 58, agility: 58, ballControl: 58, skillMoves: 1, weakFootAbility: 3, preferredFoot: 1,
    defending: 84, interceptions: 84,
    physical: 76, strength: 76, balance: 62,
    composure: 80, reactions: 80,
    stamina: 78, aggression: 62 } },
  // DEF
  { name: 'Bruno',  stats: { overall: 75, speed: 72, shooting: 42, passing: 63, intelligence: 72,
    acceleration: 72, sprintSpeed: 72,
    finishing: 38, shotPower: 42, longShots: 35,
    shortPassing: 63, longPassing: 60, crossing: 50, vision: 62,
    dribbling: 55, agility: 55, ballControl: 55, skillMoves: 2, weakFootAbility: 3, preferredFoot: 1,
    defending: 79, interceptions: 79,
    physical: 80, strength: 80, balance: 60,
    composure: 72, reactions: 70,
    stamina: 76, aggression: 75 } },
  { name: 'Rafael', stats: { overall: 74, speed: 70, shooting: 40, passing: 62, intelligence: 71,
    acceleration: 70, sprintSpeed: 70,
    finishing: 36, shotPower: 40, longShots: 33,
    shortPassing: 62, longPassing: 58, crossing: 48, vision: 61,
    dribbling: 54, agility: 54, ballControl: 54, skillMoves: 2, weakFootAbility: 3, preferredFoot: 1,
    defending: 77, interceptions: 77,
    physical: 78, strength: 78, balance: 58,
    composure: 71, reactions: 69,
    stamina: 75, aggression: 73 } },
  { name: 'Alex',   stats: { overall: 78, speed: 75, shooting: 54, passing: 72, intelligence: 77,
    acceleration: 75, sprintSpeed: 75,
    finishing: 50, shotPower: 53, longShots: 49,
    shortPassing: 72, longPassing: 71, crossing: 63, vision: 72,
    dribbling: 66, agility: 66, ballControl: 66, skillMoves: 2, weakFootAbility: 3, preferredFoot: 1,
    defending: 71, interceptions: 71,
    physical: 73, strength: 73, balance: 68,
    composure: 77, reactions: 75,
    stamina: 79, aggression: 68 } },
  // MID
  { name: 'Pedro',  stats: { overall: 81, speed: 76, shooting: 71, passing: 82, intelligence: 81,
    acceleration: 76, sprintSpeed: 76,
    finishing: 67, shotPower: 69, longShots: 67,
    shortPassing: 82, longPassing: 81, crossing: 74, vision: 83,
    dribbling: 77, agility: 77, ballControl: 77, skillMoves: 3, weakFootAbility: 3, preferredFoot: 1,
    defending: 61, interceptions: 61,
    physical: 71, strength: 71, balance: 76,
    composure: 81, reactions: 79,
    stamina: 83, aggression: 62 } },
  { name: 'Felipe', stats: { overall: 79, speed: 73, shooting: 68, passing: 78, intelligence: 79,
    acceleration: 73, sprintSpeed: 73,
    finishing: 64, shotPower: 66, longShots: 64,
    shortPassing: 78, longPassing: 76, crossing: 70, vision: 78,
    dribbling: 73, agility: 73, ballControl: 73, skillMoves: 3, weakFootAbility: 3, preferredFoot: 1,
    defending: 63, interceptions: 63,
    physical: 67, strength: 67, balance: 72,
    composure: 79, reactions: 77,
    stamina: 80, aggression: 61 } },
  { name: 'Mateus', stats: { overall: 78, speed: 74, shooting: 66, passing: 76, intelligence: 78,
    acceleration: 74, sprintSpeed: 74,
    finishing: 62, shotPower: 64, longShots: 61,
    shortPassing: 76, longPassing: 74, crossing: 68, vision: 76,
    dribbling: 71, agility: 71, ballControl: 71, skillMoves: 2, weakFootAbility: 3, preferredFoot: 1,
    defending: 60, interceptions: 60,
    physical: 66, strength: 66, balance: 70,
    composure: 78, reactions: 76,
    stamina: 79, aggression: 60 } },
  // WIN
  { name: 'Enzo',   stats: { overall: 87, speed: 88, shooting: 86, passing: 82, intelligence: 84,
    acceleration: 90, sprintSpeed: 88,
    finishing: 83, shotPower: 84, longShots: 80,
    shortPassing: 82, longPassing: 78, crossing: 86, vision: 82,
    dribbling: 85, agility: 85, ballControl: 85, skillMoves: 4, weakFootAbility: 4, preferredFoot: 1,
    defending: 50, interceptions: 50,
    physical: 77, strength: 77, balance: 86,
    composure: 84, reactions: 83,
    stamina: 89, aggression: 72 } },
  { name: 'Caio',   stats: { overall: 77, speed: 81, shooting: 70, passing: 75, intelligence: 77,
    acceleration: 83, sprintSpeed: 81,
    finishing: 66, shotPower: 68, longShots: 64,
    shortPassing: 75, longPassing: 71, crossing: 78, vision: 76,
    dribbling: 78, agility: 78, ballControl: 78, skillMoves: 3, weakFootAbility: 3, preferredFoot: 1,
    defending: 54, interceptions: 54,
    physical: 65, strength: 65, balance: 78,
    composure: 77, reactions: 75,
    stamina: 83, aggression: 64 } },
  // STR
  { name: 'Vitor',  stats: { overall: 82, speed: 85, shooting: 79, passing: 78, intelligence: 81,
    acceleration: 87, sprintSpeed: 85,
    finishing: 82, shotPower: 81, longShots: 74,
    shortPassing: 78, longPassing: 73, crossing: 64, vision: 78,
    dribbling: 81, agility: 81, ballControl: 81, skillMoves: 3, weakFootAbility: 3, preferredFoot: 1,
    defending: 51, interceptions: 51,
    physical: 71, strength: 75, balance: 77,
    composure: 81, reactions: 79,
    stamina: 85, aggression: 68 } },
  { name: 'Igor',   stats: { overall: 83, speed: 87, shooting: 80, passing: 79, intelligence: 82,
    acceleration: 89, sprintSpeed: 87,
    finishing: 83, shotPower: 82, longShots: 75,
    shortPassing: 79, longPassing: 74, crossing: 65, vision: 79,
    dribbling: 83, agility: 83, ballControl: 83, skillMoves: 4, weakFootAbility: 3, preferredFoot: 1,
    defending: 49, interceptions: 49,
    physical: 70, strength: 74, balance: 79,
    composure: 82, reactions: 80,
    stamina: 86, aggression: 66 } },
];

export function createTeams(): [TeamData, TeamData] {
  const formIdxA = Math.floor(Math.random() * FORMATIONS.length);
  const formIdxB = Math.floor(Math.random() * FORMATIONS.length);

  const formA = FORMATIONS[formIdxA];
  const formB = FORMATIONS[formIdxB];

  const teamA: TeamData = {
    id: 'teamA',
    name: 'Time Azul',
    color: 0x3b82f6,
    attackDirection: 1,
    formationName: formA.name,
    players: ROSTER_A.map((p, i) => ({
      id: `a${i}`,
      name: p.name,
      jerseyNumber: i + 1,
      role: formA.slots[i].role,
      stats: p.stats,
      baseX: formA.slots[i].x,
      baseY: formA.slots[i].y,
    })),
  };

  const teamB: TeamData = {
    id: 'teamB',
    name: 'Time Vermelho',
    color: 0xef4444,
    attackDirection: -1,
    formationName: formB.name,
    players: ROSTER_B.map((p, i) => ({
      id: `b${i}`,
      name: p.name,
      jerseyNumber: i + 1,
      role: formB.slots[i].role,
      stats: p.stats,
      baseX: 1200 - formB.slots[i].x,
      baseY: formB.slots[i].y,
    })),
  };

  return [teamA, teamB];
}

export function createOpponentTeam(name = 'Time Vermelho'): TeamData {
  return {
    ...createTeams()[1],
    name,
  };
}

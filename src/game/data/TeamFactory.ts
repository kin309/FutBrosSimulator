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

export interface TeamData {
  id: string;
  name: string;
  color: number;
  attackDirection: 1 | -1;
  formationName: string;
  players: PlayerData[];
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
  { name: 'Carlos', stats: { overall: 78, speed: 60, passing: 68, shooting: 30, dribbling: 55, defending: 82, physical: 75, intelligence: 78, stamina: 80 } },
  { name: 'Silva',  stats: { overall: 76, speed: 70, passing: 65, shooting: 45, dribbling: 58, defending: 80, physical: 78, intelligence: 74, stamina: 78 } },
  { name: 'Marcos', stats: { overall: 74, speed: 68, passing: 63, shooting: 42, dribbling: 56, defending: 78, physical: 76, intelligence: 72, stamina: 76 } },
  { name: 'Thiago', stats: { overall: 77, speed: 74, passing: 72, shooting: 53, dribbling: 65, defending: 73, physical: 72, intelligence: 76, stamina: 80 } },
  { name: 'Rafa',   stats: { overall: 82, speed: 78, passing: 84, shooting: 72, dribbling: 79, defending: 60, physical: 70, intelligence: 83, stamina: 85 } },
  { name: 'Lucas',  stats: { overall: 80, speed: 74, passing: 80, shooting: 70, dribbling: 75, defending: 62, physical: 68, intelligence: 80, stamina: 82 } },
  { name: 'Andre',  stats: { overall: 79, speed: 76, passing: 78, shooting: 69, dribbling: 74, defending: 58, physical: 67, intelligence: 79, stamina: 81 } },
  { name: 'Gabi',   stats: { overall: 89, speed: 91, passing: 85, shooting: 84, dribbling: 87, defending: 53, physical: 75, intelligence: 86, stamina: 91 } },
  { name: 'Nando',  stats: { overall: 78, speed: 82, passing: 76, shooting: 71, dribbling: 80, defending: 55, physical: 66, intelligence: 78, stamina: 84 } },
  { name: 'Breno',  stats: { overall: 83, speed: 86, passing: 79, shooting: 80, dribbling: 82, defending: 50, physical: 72, intelligence: 82, stamina: 86 } },
  { name: 'Dudu',   stats: { overall: 84, speed: 88, passing: 80, shooting: 81, dribbling: 84, defending: 48, physical: 70, intelligence: 83, stamina: 87 } },
];

const ROSTER_B: Array<{ name: string; stats: PlayerStats }> = [
  { name: 'Diego',  stats: { overall: 80, speed: 62, passing: 70, shooting: 35, dribbling: 58, defending: 84, physical: 76, intelligence: 80, stamina: 78 } },
  { name: 'Bruno',  stats: { overall: 75, speed: 72, passing: 63, shooting: 42, dribbling: 55, defending: 79, physical: 80, intelligence: 72, stamina: 76 } },
  { name: 'Rafael', stats: { overall: 74, speed: 70, passing: 62, shooting: 40, dribbling: 54, defending: 77, physical: 78, intelligence: 71, stamina: 75 } },
  { name: 'Alex',   stats: { overall: 78, speed: 75, passing: 72, shooting: 54, dribbling: 66, defending: 71, physical: 73, intelligence: 77, stamina: 79 } },
  { name: 'Pedro',  stats: { overall: 81, speed: 76, passing: 82, shooting: 71, dribbling: 77, defending: 61, physical: 71, intelligence: 81, stamina: 83 } },
  { name: 'Felipe', stats: { overall: 79, speed: 73, passing: 78, shooting: 68, dribbling: 73, defending: 63, physical: 67, intelligence: 79, stamina: 80 } },
  { name: 'Mateus', stats: { overall: 78, speed: 74, passing: 76, shooting: 66, dribbling: 71, defending: 60, physical: 66, intelligence: 78, stamina: 79 } },
  { name: 'Enzo',   stats: { overall: 87, speed: 88, passing: 82, shooting: 86, dribbling: 85, defending: 50, physical: 77, intelligence: 84, stamina: 89 } },
  { name: 'Caio',   stats: { overall: 77, speed: 81, passing: 75, shooting: 70, dribbling: 78, defending: 54, physical: 65, intelligence: 77, stamina: 83 } },
  { name: 'Vitor',  stats: { overall: 82, speed: 85, passing: 78, shooting: 79, dribbling: 81, defending: 51, physical: 71, intelligence: 81, stamina: 85 } },
  { name: 'Igor',   stats: { overall: 83, speed: 87, passing: 79, shooting: 80, dribbling: 83, defending: 49, physical: 70, intelligence: 82, stamina: 86 } },
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

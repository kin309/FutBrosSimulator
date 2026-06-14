import { Player } from './Player';
import { dist } from '../utils/MathUtils';

export class Team {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  attackDirection: 1 | -1;
  readonly formationName: string;
  players: Player[] = [];

  constructor(id: string, name: string, color: number, attackDirection: 1 | -1, formationName: string) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.attackDirection = attackDirection;
    this.formationName = formationName;
  }

  getBallCarrier(): Player | null {
    return this.players.find(p => p.hasBall) ?? null;
  }

  getNearestPlayerTo(x: number, y: number, exclude?: Player): Player | null {
    let nearest: Player | null = null;
    let bestDist = Infinity;
    for (const p of this.players) {
      if (p === exclude) continue;
      const d = dist(p.x, p.y, x, y);
      if (d < bestDist) {
        bestDist = d;
        nearest = p;
      }
    }
    return nearest;
  }

  hasPossession(): boolean {
    return this.players.some(p => p.hasBall);
  }
}

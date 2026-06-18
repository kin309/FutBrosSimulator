export interface GoalRecord {
  scorerTeamId: string;
  scorerName: string;
  assistName: string | null;
}

export interface TeamStats {
  shots: number;
  shotsOnTarget: number;
  passes: number;
  passesCompleted: number;
  tacklesWon: number;
  interceptions: number;
  saves: number;
  possessionMs: number;
}

export class StatsTracker {
  private a: TeamStats = this.blank();
  private b: TeamStats = this.blank();
  private goalList: GoalRecord[] = [];

  private blank(): TeamStats {
    return {
      shots: 0, shotsOnTarget: 0,
      passes: 0, passesCompleted: 0,
      tacklesWon: 0, interceptions: 0,
      saves: 0, possessionMs: 0,
    };
  }

  private team(id: string): TeamStats {
    return id === 'teamA' ? this.a : this.b;
  }

  // A shot on target is one that went toward the goal (inGoal).
  // If the GK stopped it, the opposing team also gets a save.
  recordShot(shooterTeamId: string, onTarget: boolean, saved: boolean): void {
    const s = this.team(shooterTeamId);
    s.shots++;
    if (onTarget) s.shotsOnTarget++;
    if (saved) {
      this.recordSave(shooterTeamId === 'teamA' ? 'teamB' : 'teamA');
    }
  }

  recordSave(teamId: string): void { this.team(teamId).saves++; }

  recordPass(teamId: string): void { this.team(teamId).passes++; }

  recordPassCompleted(teamId: string): void { this.team(teamId).passesCompleted++; }

  recordTackleWon(teamId: string): void { this.team(teamId).tacklesWon++; }

  recordInterception(teamId: string): void { this.team(teamId).interceptions++; }

  recordGoal(scorerTeamId: string, scorerName: string, assistName?: string): void {
    this.goalList.push({ scorerTeamId, scorerName, assistName: assistName ?? null });
  }

  getGoals(): readonly GoalRecord[] { return this.goalList; }

  tickPossession(teamId: string | null, delta: number): void {
    if (teamId) this.team(teamId).possessionMs += delta;
  }

  getStats(teamId: string): Readonly<TeamStats> {
    return this.team(teamId);
  }

  totalPossessionMs(): number {
    return this.a.possessionMs + this.b.possessionMs;
  }

  reset(): void {
    this.a = this.blank();
    this.b = this.blank();
    this.goalList = [];
  }
}

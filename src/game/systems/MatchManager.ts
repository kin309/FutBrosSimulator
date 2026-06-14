export type MatchState = 'kickoff' | 'playing' | 'goalScored' | 'halftime' | 'advantage' | 'finished';

export class MatchManager {
  scoreA: number = 0;
  scoreB: number = 0;
  matchTime: number = 0;
  readonly halfDuration: number = 90_000; // 1.5 real minutes = 45 game minutes
  isPaused: boolean = false;
  state: MatchState = 'kickoff';
  half: 1 | 2 = 1;

  readonly stoppageMin: [number, number] = [
    1 + Math.floor(Math.random() * 3),
    1 + Math.floor(Math.random() * 3),
  ];

  private goalDelay: number = 0;
  private halftimeDelay: number = 0;
  private lastScorerTeam: string = '';

  onGoal?: (teamId: string) => void;
  onReset?: () => void;
  onFinished?: () => void;
  onHalftime?: () => void;
  onHalftimeEnd?: () => void;
  /** Called when time runs out; state is already 'advantage'. Caller may call forceFinish() immediately. */
  onTimeUp?: () => void;

  private get msPerGameMin(): number {
    return this.halfDuration / 45;
  }

  private stoppageMs(halfIdx: 0 | 1): number {
    return this.stoppageMin[halfIdx] * this.msPerGameMin;
  }

  update(delta: number): void {
    if (this.isPaused) return;

    if (this.state === 'goalScored') {
      this.goalDelay -= delta;
      if (this.goalDelay <= 0) {
        this.state = 'kickoff';
        this.onReset?.();
      }
      return;
    }

    if (this.state === 'halftime') {
      this.halftimeDelay -= delta;
      if (this.halftimeDelay <= 0) {
        this.half = 2;
        this.matchTime = 0;
        this.state = 'kickoff';
        this.onHalftimeEnd?.();
      }
      return;
    }

    if (this.state === 'finished') return;
    // During advantage, time is frozen — MatchScene drives the end condition
    if (this.state === 'advantage') return;

    if (this.state === 'kickoff') this.state = 'playing';

    this.matchTime += delta;

    const halfIdx = (this.half - 1) as 0 | 1;
    const limit = this.halfDuration + this.stoppageMs(halfIdx);

    if (this.half === 1 && this.matchTime >= limit) {
      this.matchTime = limit;
      this.state = 'halftime';
      this.halftimeDelay = 4_000;
      this.onHalftime?.();
      return;
    }

    if (this.half === 2 && this.matchTime >= limit) {
      this.matchTime = limit;
      // Tentatively enter advantage; onTimeUp decides whether to keep it or finish immediately
      this.state = 'advantage';
      if (this.onTimeUp) {
        this.onTimeUp();
      } else {
        this.state = 'finished';
        this.onFinished?.();
      }
    }
  }

  goalScored(teamId: string): void {
    if (this.state !== 'playing' && this.state !== 'advantage') return;
    if (teamId === 'teamA') this.scoreA++;
    else this.scoreB++;
    this.lastScorerTeam = teamId;
    this.state = 'goalScored';
    this.goalDelay = 2500;
    this.onGoal?.(teamId);
  }

  /** Immediately end the match, skipping any remaining advantage. */
  forceFinish(): void {
    this.state = 'finished';
    this.onFinished?.();
  }

  togglePause(): void {
    this.isPaused = !this.isPaused;
  }

  reset(): void {
    this.scoreA = 0;
    this.scoreB = 0;
    this.matchTime = 0;
    this.half = 1;
    this.state = 'kickoff';
    this.isPaused = false;
    this.goalDelay = 0;
    this.halftimeDelay = 0;
  }

  getTimeString(): string {
    if (this.state === 'halftime') return `45' (Intervalo)`;
    if (this.state === 'advantage') {
      const baseMin = this.half === 1 ? 45 : 90;
      return `${baseMin}'+`;
    }

    const halfIdx = (this.half - 1) as 0 | 1;
    const baseMin = this.half === 1 ? 0 : 45;

    if (this.matchTime > this.halfDuration) {
      const extraGameMin = Math.min(
        Math.ceil((this.matchTime - this.halfDuration) / this.msPerGameMin),
        this.stoppageMin[halfIdx],
      );
      return `${baseMin + 45}+${extraGameMin}'`;
    }

    const gameMin = Math.floor((this.matchTime / this.halfDuration) * 45);
    return `${baseMin + gameMin}'`;
  }

  getLastScorer(): string {
    return this.lastScorerTeam;
  }
}

import { DraftConfig, DraftPlayer, DraftRound, DraftRoundKind } from './DraftTypes';

const DEFAULT_CONFIG: DraftConfig = {
  totalPicks: 15,
  totalRerolls: 2,
  boosterSize: 6,
  famousRoundChance: 0.06,
  maxFamousRounds: 1,
};

/**
 * Gera a sequência de tipos de rodada para todo o draft.
 * Deve ser chamada UMA vez pelo host e repassada a todos os DraftManagers,
 * garantindo que a rodada especial apareça na mesma posição para todos.
 */
export function generateRoundSequence(
  famousPool: DraftPlayer[],
  config: Partial<DraftConfig> = {},
): DraftRoundKind[] {
  const { totalPicks, maxFamousRounds, famousRoundChance, boosterSize } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  let famousSeen = 0;
  return Array.from({ length: totalPicks }, () => {
    if (
      famousSeen < maxFamousRounds
      && famousPool.length >= boosterSize
      && Math.random() < famousRoundChance
    ) {
      famousSeen += 1;
      return 'famous-clubs';
    }
    return 'normal';
  });
}

export class DraftManager {
  private readonly config: DraftConfig;
  private readonly fullPool: DraftPlayer[];
  private readonly famousPool: DraftPlayer[];
  private readonly roundKinds: DraftRoundKind[] | null;
  private picked: DraftPlayer[] = [];
  private currentPlayers: DraftPlayer[] = [];
  private currentKind: DraftRoundKind = 'normal';
  private rerollsLeft: number;
  private famousRoundsSeen = 0;
  private pickedThisRound = false;

  /**
   * @param roundKinds Sequência pré-gerada pelo host (multiplayer).
   *   Quando ausente, cada instância sorteia de forma independente (solo).
   */
  constructor(
    fullPool: DraftPlayer[],
    famousPool: DraftPlayer[],
    config: Partial<DraftConfig> = {},
    roundKinds?: DraftRoundKind[],
  ) {
    this.fullPool = fullPool;
    this.famousPool = famousPool;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rerollsLeft = this.config.totalRerolls;
    this.roundKinds = roundKinds ?? null;
    this.startNextRound();
  }

  getRound(): DraftRound {
    return {
      number: this.picked.length + 1,
      kind: this.currentKind,
      title: this.currentKind === 'famous-clubs' ? 'Rodada Clubes Famosos' : 'Rodada Normal',
      players: this.currentPlayers,
      rerollsLeft: this.rerollsLeft,
      picked: this.picked,
      isComplete: this.isComplete(),
    };
  }

  /** Registra a escolha sem avançar para a próxima rodada. */
  pick(playerId: string): DraftRound {
    if (this.isComplete() || this.pickedThisRound) return this.getRound();

    const player = this.currentPlayers.find((candidate) => candidate.id === playerId);
    if (!player) return this.getRound();

    this.picked = [...this.picked, player];
    this.pickedThisRound = true;

    return this.getRound();
  }

  /** Avança para a próxima rodada. Chamado pelo host quando TODOS escolheram. */
  advanceRound(): void {
    if (!this.pickedThisRound || this.isComplete()) return;
    this.pickedThisRound = false;
    this.startNextRound();
  }

  hasPickedThisRound(): boolean {
    return this.pickedThisRound;
  }

  reroll(): DraftRound {
    if (this.rerollsLeft <= 0 || this.isComplete() || this.pickedThisRound) return this.getRound();
    this.rerollsLeft -= 1;
    this.currentPlayers = this.createBooster(this.currentKind);
    return this.getRound();
  }

  isComplete(): boolean {
    return this.picked.length >= this.config.totalPicks;
  }

  private startNextRound(): void {
    // Em multiplayer usa a sequência do host; em solo sorteia independente
    const kind = this.roundKinds
      ? (this.roundKinds[this.picked.length] ?? 'normal')
      : this.chooseRoundKind();

    this.currentKind = kind;
    this.currentPlayers = this.createBooster(kind);
  }

  private chooseRoundKind(): DraftRoundKind {
    if (
      this.famousRoundsSeen < this.config.maxFamousRounds
      && this.famousPool.length >= this.config.boosterSize
      && Math.random() < this.config.famousRoundChance
    ) {
      this.famousRoundsSeen += 1;
      return 'famous-clubs';
    }
    return 'normal';
  }

  private createBooster(kind: DraftRoundKind): DraftPlayer[] {
    const pickedIds = new Set(this.picked.map((player) => player.id));
    const currentIds = new Set<string>();
    const source = kind === 'famous-clubs' ? this.famousPool : this.fullPool;
    const available = source.filter((player) => !pickedIds.has(player.id));
    const booster: DraftPlayer[] = [];

    if (kind === 'famous-clubs') {
      const elite = available.filter((player) => player.overall >= 83);
      const guaranteed = randomItem(elite.length > 0 ? elite : available);
      if (guaranteed) {
        booster.push(guaranteed);
        currentIds.add(guaranteed.id);
      }
    }

    while (booster.length < this.config.boosterSize) {
      const player = this.drawWeighted(available, currentIds, kind);
      if (!player) break;
      booster.push(player);
      currentIds.add(player.id);
    }

    return shuffle(booster);
  }

  private drawWeighted(pool: DraftPlayer[], blockedIds: Set<string>, kind: DraftRoundKind): DraftPlayer | null {
    const candidates = pool.filter((player) => !blockedIds.has(player.id));
    if (candidates.length === 0) return null;

    const roll = Math.random();
    const target = kind === 'famous-clubs' ? specialTier(roll) : normalTier(roll);

    const tierCandidates = candidates.filter((player) => isInTier(player.overall, target));
    return randomItem(tierCandidates.length > 0 ? tierCandidates : candidates);
  }
}

function normalTier(roll: number): [number, number] {
  if (roll < 0.48) return [60, 69];
  if (roll < 0.82) return [70, 79];
  if (roll < 0.97) return [80, 84];
  return [85, 99];
}

function specialTier(roll: number): [number, number] {
  if (roll < 0.20) return [70, 79];
  if (roll < 0.70) return [80, 84];
  return [85, 99];
}

function isInTier(overall: number, [min, max]: [number, number]): boolean {
  return overall >= min && overall <= max;
}

function randomItem<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

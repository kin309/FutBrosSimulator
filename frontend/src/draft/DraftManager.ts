import { DraftConfig, DraftPlayer, DraftRound, DraftRoundKind } from './DraftTypes';
import { PlayerRole } from '../game/data/PlayerRole';

const DEFAULT_CONFIG: DraftConfig = {
  totalPicks: 15,
  totalRerolls: 2,
  boosterSize: 6,
  famousRoundChance: 0.06,
  maxFamousRounds: 1,
};

const ELITE_ROUND_CHANCE = 0.03;
const MAX_ELITE_ROUNDS = 1;
const ELITE_MIN_OVERALL = 85;
const NATIONALITY_ROUND_CHANCE = 0.08;
const MAX_NATIONALITY_ROUNDS = 1;
const POSITION_ROUND_CHANCE = 0.08;
const MAX_POSITION_ROUNDS = 1;

const POSITION_LABELS: Record<string, string> = {
  [PlayerRole.Goalkeeper]: 'Goleiros',
  [PlayerRole.Defender]: 'Defensores',
  [PlayerRole.Midfielder]: 'Meias',
  [PlayerRole.Winger]: 'Alas',
  [PlayerRole.Striker]: 'Atacantes',
};

function pickNationality(pool: DraftPlayer[], boosterSize: number): string | null {
  const counts = new Map<string, number>();
  for (const player of pool) {
    counts.set(player.nationality, (counts.get(player.nationality) ?? 0) + 1);
  }
  const eligible = [...counts.entries()]
    .filter(([, count]) => count >= boosterSize)
    .map(([nat]) => nat);
  return randomItem(eligible);
}

function pickPosition(pool: DraftPlayer[], boosterSize: number): PlayerRole | null {
  const roles = Object.values(PlayerRole);
  const eligible = roles.filter((role) => pool.filter((p) => p.role === role).length >= boosterSize);
  return randomItem(eligible);
}

/**
 * Gera a sequência de tipos de rodada para todo o draft.
 * Deve ser chamada UMA vez pelo host e repassada a todos os DraftManagers,
 * garantindo que as rodadas especiais apareçam na mesma posição para todos.
 */
export function generateRoundSequence(
  famousPool: DraftPlayer[],
  fullPool: DraftPlayer[] = [],
  config: Partial<DraftConfig> = {},
): DraftRoundKind[] {
  const { totalPicks, maxFamousRounds, famousRoundChance, boosterSize } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  let famousSeen = 0;
  let eliteSeen = 0;
  let nationalitySeen = 0;
  let positionSeen = 0;

  return Array.from({ length: totalPicks }, () => {
    if (
      famousSeen < maxFamousRounds
      && famousPool.length >= boosterSize
      && Math.random() < famousRoundChance
    ) {
      famousSeen += 1;
      return 'famous-clubs' as DraftRoundKind;
    }
    if (eliteSeen < MAX_ELITE_ROUNDS && Math.random() < ELITE_ROUND_CHANCE) {
      const elitePool = fullPool.filter((p) => p.overall >= ELITE_MIN_OVERALL);
      if (elitePool.length >= boosterSize) {
        eliteSeen += 1;
        return 'elite' as DraftRoundKind;
      }
    }
    if (nationalitySeen < MAX_NATIONALITY_ROUNDS && Math.random() < NATIONALITY_ROUND_CHANCE) {
      const nat = pickNationality(fullPool, boosterSize);
      if (nat) {
        nationalitySeen += 1;
        return `nationality:${nat}` as DraftRoundKind;
      }
    }
    if (positionSeen < MAX_POSITION_ROUNDS && Math.random() < POSITION_ROUND_CHANCE) {
      const role = pickPosition(fullPool, boosterSize);
      if (role) {
        positionSeen += 1;
        return `position:${role}` as DraftRoundKind;
      }
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
  private eliteRoundsSeen = 0;
  private nationalityRoundsSeen = 0;
  private positionRoundsSeen = 0;
  private pickedThisRound = false;

  /**
   * @param roundKinds Sequência pré-gerada pelo host (multiplayer).
   *   Quando ausente, cada instância sorteia de forma independente (solo).
   * @param restore Estado salvo para retomar um draft em andamento.
   */
  constructor(
    fullPool: DraftPlayer[],
    famousPool: DraftPlayer[],
    config: Partial<DraftConfig> = {},
    roundKinds?: DraftRoundKind[],
    restore?: { picked: DraftPlayer[]; rerollsLeft: number; pickedThisRound?: boolean },
  ) {
    this.fullPool = fullPool;
    this.famousPool = famousPool;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.roundKinds = roundKinds ?? null;

    if (restore) {
      this.picked = [...restore.picked];
      this.rerollsLeft = restore.rerollsLeft;
      this.pickedThisRound = restore.pickedThisRound ?? false;
    } else {
      this.rerollsLeft = this.config.totalRerolls;
    }

    if (!this.isComplete()) {
      if (restore) {
        // Se já escolheu nesta rodada, o booster é o da rodada atual (índice N-1).
        // Se ainda não escolheu, gera o booster da próxima rodada a ser jogada (índice N).
        const roundIndex = this.pickedThisRound && this.picked.length > 0
          ? this.picked.length - 1
          : this.picked.length;
        const kind = this.roundKinds ? (this.roundKinds[roundIndex] ?? 'normal') : this.chooseRoundKind();
        this.currentKind = kind;
        this.currentPlayers = this.createBooster(kind);
      } else {
        this.startNextRound();
      }
    }
  }

  getRound(): DraftRound {
    return {
      number: this.picked.length + 1,
      kind: this.currentKind,
      title: roundTitle(this.currentKind),
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
    if (this.eliteRoundsSeen < MAX_ELITE_ROUNDS && Math.random() < ELITE_ROUND_CHANCE) {
      const elitePool = this.fullPool.filter((p) => p.overall >= ELITE_MIN_OVERALL);
      if (elitePool.length >= this.config.boosterSize) {
        this.eliteRoundsSeen += 1;
        return 'elite';
      }
    }
    if (this.nationalityRoundsSeen < MAX_NATIONALITY_ROUNDS && Math.random() < NATIONALITY_ROUND_CHANCE) {
      const nat = pickNationality(this.fullPool, this.config.boosterSize);
      if (nat) {
        this.nationalityRoundsSeen += 1;
        return `nationality:${nat}`;
      }
    }
    if (this.positionRoundsSeen < MAX_POSITION_ROUNDS && Math.random() < POSITION_ROUND_CHANCE) {
      const role = pickPosition(this.fullPool, this.config.boosterSize);
      if (role) {
        this.positionRoundsSeen += 1;
        return `position:${role}`;
      }
    }
    return 'normal';
  }

  private createBooster(kind: DraftRoundKind): DraftPlayer[] {
    const pickedIds = new Set(this.picked.map((player) => player.id));
    const currentIds = new Set<string>();
    const booster: DraftPlayer[] = [];

    let source: DraftPlayer[];
    if (kind === 'famous-clubs') {
      source = this.famousPool;
    } else if (kind === 'elite') {
      source = this.fullPool.filter((p) => p.overall >= ELITE_MIN_OVERALL);
    } else if (kind.startsWith('nationality:')) {
      const nat = kind.slice('nationality:'.length);
      source = this.fullPool.filter((p) => p.nationality === nat);
    } else if (kind.startsWith('position:')) {
      const role = kind.slice('position:'.length);
      source = this.fullPool.filter((p) => p.role === role);
    } else {
      source = this.fullPool;
    }

    const available = source.filter((player) => !pickedIds.has(player.id));

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
    const isSpecial = kind === 'famous-clubs' || kind === 'elite' || kind.startsWith('nationality:') || kind.startsWith('position:');
    const target = isSpecial ? specialTier(roll) : normalTier(roll);

    const tierCandidates = candidates.filter((player) => isInTier(player.overall, target));
    return randomItem(tierCandidates.length > 0 ? tierCandidates : candidates);
  }
}

export function roundTitle(kind: DraftRoundKind): string {
  if (kind === 'famous-clubs') return 'Rodada Clubes Famosos';
  if (kind === 'elite') return 'Rodada Elite';
  if (kind.startsWith('nationality:')) return `Rodada ${kind.slice('nationality:'.length)}`;
  if (kind.startsWith('position:')) {
    const role = kind.slice('position:'.length);
    return `Rodada ${POSITION_LABELS[role] ?? role}`;
  }
  return 'Rodada Normal';
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

import { Player } from '../entities/Player';
import { roll, clamp } from '../utils/MathUtils';
import { traitBonus, TRAITS } from '../data/PlayerTraits';
import { statsNormalizer } from '../data/StatsNormalizer';

const n = (value: number, stat: Parameters<typeof statsNormalizer.norm>[1]) =>
  statsNormalizer.norm(value, stat);

export class EventResolver {
  resolveFirstTouch(receiver: Player, passer: Player, nearestOpponent: Player | null, ballSpeed: number): boolean {
    const oppDefNorm = nearestOpponent ? n(nearestOpponent.stats.defending, 'defending') : 0;
    const firstTouchBonus = traitBonus(receiver, TRAITS.FIRST_TOUCH, 12, 8);
    let chance = 50
      + n(passer.stats.passing, 'passing') * 25
      + n(receiver.stats.dribbling, 'dribbling') * 20
      + n(receiver.stats.intelligence, 'intelligence') * 15
      - oppDefNorm * 20
      + firstTouchBonus;
    const speedFactor = clamp((ballSpeed - 4.0) / 8.0, 0, 1);
    chance -= speedFactor * 38;
    return roll(clamp(chance, 12, 95));
  }

  resolveTackle(defender: Player, ballCarrier: Player, positioningBonus = 0): boolean {
    const defScore = n(defender.stats.defending, 'defending') * 55
      + n(defender.stats.physical, 'physical') * 30
      + n(defender.stats.intelligence, 'intelligence') * 20;
    const attScore = n(ballCarrier.stats.dribbling, 'dribbling') * 55
      + n(ballCarrier.stats.speed, 'speed') * 22
      + n(ballCarrier.stats.intelligence, 'intelligence') * 14;
    const defFatigue = (1 - defender.getStaminaFactor()) * 14;
    const attFatigue = (1 - ballCarrier.getStaminaFactor()) * 9;
    const chance = 20 + (defScore - attScore) - defFatigue + attFatigue + positioningBonus;
    return roll(clamp(chance, 10, 82));
  }

  resolveDuel(playerA: Player, playerB: Player): Player {
    const scoreA = n(playerA.stats.speed, 'speed') * 25
      + n(playerA.stats.physical, 'physical') * 25
      + n(playerA.stats.defending, 'defending') * 25
      + n(playerA.stats.intelligence, 'intelligence') * 25
      + (playerA.getBodyMassFactor() - 1) * 12;
    const scoreB = n(playerB.stats.speed, 'speed') * 25
      + n(playerB.stats.physical, 'physical') * 25
      + n(playerB.stats.defending, 'defending') * 25
      + n(playerB.stats.intelligence, 'intelligence') * 25
      + (playerB.getBodyMassFactor() - 1) * 12;
    const total = scoreA + scoreB;
    return Math.random() * total < scoreA ? playerA : playerB;
  }

  resolveGkSave(gk: Player, isDive: boolean, ballSpeed: number): 'catch' | 'parry' | 'miss' {
    const quality = n(gk.stats.defending, 'defending') * 55
      + n(gk.stats.speed, 'speed') * 20
      + n(gk.stats.intelligence, 'intelligence') * 20
      + n(gk.stats.physical, 'physical') * 5;
    const r = Math.random() * 100;
    const speedFactor = clamp((ballSpeed - 4.5) / 7.5, 0, 1);

    if (isDive) {
      const catchPenalty = speedFactor * 14;
      const parryPenalty = speedFactor * 10;
      const catchT = Math.max(0, 0.10 * quality * 0.18 - catchPenalty);
      const parryT = catchT + Math.max(0, quality * 0.43 - parryPenalty);
      if (r < catchT) return 'catch';
      if (r < parryT) return 'parry';
      return 'miss';
    }

    const catchPenalty = speedFactor * 24;
    const parryPenalty = speedFactor * 12;
    const catchT = Math.max(0, 28 + quality * 0.58 - catchPenalty);
    const parryT = catchT + Math.max(0, 18 + quality * 0.16 - parryPenalty);
    if (r < catchT) return 'catch';
    if (r < parryT) return 'parry';
    return 'miss';
  }

  resolveDribble(carrier: Player, defender: Player): boolean {
    const technicalBonus = traitBonus(carrier, TRAITS.TECHNICAL, 8, 4);
    const carrierFatigue = (1 - carrier.getStaminaFactor()) * 10;
    const defFatigue     = (1 - defender.getStaminaFactor()) * 7;
    const chance = n(carrier.stats.dribbling, 'dribbling') * 45
      + n(carrier.stats.speed, 'speed') * 25
      + n(carrier.stats.intelligence, 'intelligence') * 15
      - n(defender.stats.defending, 'defending') * 35
      - n(defender.stats.physical, 'physical') * 10
      + technicalBonus
      - carrierFatigue
      + defFatigue;
    return roll(clamp(chance, 10, 85));
  }

  resolveAerialDuel(attacker: Player, defender: Player): Player {
    const attScore = n(attacker.stats.physical, 'physical') * 50
      + n(attacker.stats.intelligence, 'intelligence') * 30
      + n(attacker.stats.speed, 'speed') * 20
      + attacker.getAerialBodyScore()
      + (1 - attacker.getStaminaFactor()) * -12;
    const defScore = n(defender.stats.physical, 'physical') * 45
      + n(defender.stats.defending, 'defending') * 35
      + n(defender.stats.intelligence, 'intelligence') * 20
      + defender.getAerialBodyScore()
      + (1 - defender.getStaminaFactor()) * -10;
    const total = Math.max(attScore, 1) + Math.max(defScore, 1);
    return Math.random() * total < Math.max(attScore, 1) ? attacker : defender;
  }
}

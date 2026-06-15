import { Player } from '../entities/Player';
import { roll, clamp } from '../utils/MathUtils';
import { traitBonus, TRAITS } from '../data/PlayerTraits';

export class EventResolver {
  resolveFirstTouch(receiver: Player, passer: Player, nearestOpponent: Player | null, ballSpeed: number): boolean {
    const oppDef = nearestOpponent ? nearestOpponent.stats.defending / 100 : 0;
    const firstTouchBonus = traitBonus(receiver, TRAITS.FIRST_TOUCH, 12, 8);
    let chance = 50
      + (passer.stats.shortPassing / 100) * 25
      + (receiver.stats.dribbling   / 100) * 20
      + (receiver.stats.reactions   / 100) * 15
      - oppDef * 20
      + firstTouchBonus;
    const speedFactor = clamp((ballSpeed - 4.0) / 8.0, 0, 1);
    chance -= speedFactor * 38;
    return roll(clamp(chance, 12, 95));
  }

  resolveTackle(defender: Player, ballCarrier: Player, positioningBonus = 0): boolean {
    const defScore = (defender.stats.defending   / 100) * 55
      + (defender.stats.physical  / 100) * 30
      + (defender.stats.reactions / 100) * 20;
    const attScore = (ballCarrier.stats.dribbling   / 100) * 55
      + (ballCarrier.stats.sprintSpeed / 100) * 22
      + (ballCarrier.stats.reactions   / 100) * 14;
    const defFatigue = (1 - defender.getStaminaFactor()) * 14;
    const attFatigue = (1 - ballCarrier.getStaminaFactor()) * 9;
    const chance = 20 + (defScore - attScore) - defFatigue + attFatigue + positioningBonus;
    return roll(clamp(chance, 10, 82));
  }

  resolveDuel(playerA: Player, playerB: Player): Player {
    const scoreA = (playerA.stats.sprintSpeed / 100) * 25
      + (playerA.stats.strength  / 100) * 25
      + (playerA.stats.defending / 100) * 25
      + (playerA.stats.reactions / 100) * 25
      + (playerA.getBodyMassFactor() - 1) * 12;
    const scoreB = (playerB.stats.sprintSpeed / 100) * 25
      + (playerB.stats.strength  / 100) * 25
      + (playerB.stats.defending / 100) * 25
      + (playerB.stats.reactions / 100) * 25
      + (playerB.getBodyMassFactor() - 1) * 12;
    const total = scoreA + scoreB;
    return Math.random() * total < scoreA ? playerA : playerB;
  }

  resolveGkSave(gk: Player, isDive: boolean, ballSpeed: number): 'catch' | 'parry' | 'miss' {
    const quality = (gk.stats.defending   / 100) * 55
      + (gk.stats.sprintSpeed / 100) * 20
      + (gk.stats.reactions   / 100) * 20
      + (gk.stats.physical    / 100) * 5;
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
    const chance = (carrier.stats.dribbling   / 100) * 45
      + (carrier.stats.sprintSpeed / 100) * 25
      + (carrier.stats.agility     / 100) * 15
      - (defender.stats.defending  / 100) * 35
      - (defender.stats.physical   / 100) * 10
      + technicalBonus
      - carrierFatigue
      + defFatigue;
    return roll(clamp(chance, 10, 85));
  }

  resolveAerialDuel(attacker: Player, defender: Player): Player {
    const attScore = (attacker.stats.physical    / 100) * 50
      + (attacker.stats.reactions  / 100) * 30
      + (attacker.stats.sprintSpeed / 100) * 20
      + attacker.getAerialBodyScore()
      + (1 - attacker.getStaminaFactor()) * -12;
    const defScore = (defender.stats.physical    / 100) * 45
      + (defender.stats.defending  / 100) * 35
      + (defender.stats.reactions  / 100) * 20
      + defender.getAerialBodyScore()
      + (1 - defender.getStaminaFactor()) * -10;
    const total = Math.max(attScore, 1) + Math.max(defScore, 1);
    return Math.random() * total < Math.max(attScore, 1) ? attacker : defender;
  }
}

// ─── Instruções Individuais de Jogador ───────────────────────────────────────
// Camada separada da tática coletiva. Cada campo é opcional — quando ausente,
// o jogador usa os defaults do TacticalProfile do time.
// As instruções funcionam como modificadores de peso nas decisões da IA,
// não como regras rígidas. O jogador continua reagindo ao contexto, mas com
// tendências diferentes.

// ── 1. Posicionamento ─────────────────────────────────────────────────────────
/**
 * Quão rigidamente o jogador segue sua posição base.
 * 'stay'   → muito colado ao baseX/baseY (volante de contenção, CB)
 * 'freedom'→ pode sair da posição para criar (meia-atacante)
 * 'roam'   → movimentação totalmente livre (falso 9, camisa 10)
 */
export type PositioningInstruction = 'stay' | 'freedom' | 'roam';

// ── 2. Apoio ao Ataque ────────────────────────────────────────────────────────
/**
 * Quão para frente o jogador vai quando o time ataca.
 * Controla o push de avançar em relação à posição base.
 */
export type AttackSupportInstruction =
  | 'very-defensive'  // raramente sobe; foco em cobrir retaguarda
  | 'defensive'       // sobe pouco
  | 'balanced'        // padrão
  | 'offensive'       // overlaps e entradas frequentes na área
  | 'very-offensive'; // quase um atacante extra

// ── 3. Movimentação ───────────────────────────────────────────────────────────
/**
 * Tipo preferido de corrida/movimentação sem bola no ataque.
 * Sobrescreve o wingerBehavior/strikerBehavior do TacticalScheme para este jogador.
 */
export type MovementInstruction =
  | 'open-space'    // abrir campo: ficar colado à linha lateral
  | 'cut-inside'    // cortar para dentro: diagonal ao gol
  | 'attack-depth'  // atacar profundidade: corridas atrás da última linha
  | 'come-short'    // aproximar para tabela: receber perto do portador
  | 'free';         // movimento livre (padrão)

// ── 4. Com a Bola ─────────────────────────────────────────────────────────────
/**
 * Tendência do jogador quando tem a bola.
 * Modificadores de peso — não garante que a ação seja sempre escolhida.
 */
export type WithBallInstruction =
  | 'dribble'   // driblar mais: menor limiar para tentar o 1×1
  | 'pass'      // passar mais: preferência por passes vs. carregar
  | 'cross'     // cruzar mais: maior tendência a cruzar na área adversária
  | 'shoot'     // finalizar mais: range estendido de chute
  | 'retain';   // reter posse: preferir passes seguros, não arriscar

// ── 5. Pressão ────────────────────────────────────────────────────────────────
/** Intensidade de pressão individual quando o time perde a bola */
export type PressInstruction =
  | 'high'    // pressionar muito: range de press aumentado
  | 'normal'  // padrão do time
  | 'save';   // poupar energia: não perseguir portador, manter posição

// ── 6. Marcação ───────────────────────────────────────────────────────────────
export type MarkingInstruction =
  | 'normal'    // segue a marcação coletiva do time
  | 'man'       // marca adversário específico (targetPlayerId obrigatório)
  | 'sector';   // cobre setor (posição base, ignora adversário específico)

// ── 7. Participação Defensiva ─────────────────────────────────────────────────
/**
 * Quando o time perde a bola, o quanto o jogador volta para defender.
 * Sobrescreve o strikersTrackBack do TacticalProfile para este jogador.
 */
export type DefensiveParticipationInstruction =
  | 'track-back'  // voltar para defender completamente
  | 'partial'     // voltar até o meio-campo
  | 'stay';       // ficar na frente (não recua)

// ── Instruções completas por jogador ─────────────────────────────────────────

export interface PlayerInstructions {
  positioning?:            PositioningInstruction;
  attackSupport?:          AttackSupportInstruction;
  movement?:               MovementInstruction;
  withBall?:               WithBallInstruction;
  press?:                  PressInstruction;
  marking?:                MarkingInstruction;
  /** Usado quando marking === 'man' — ID do jogador adversário a marcar */
  markTargetPlayerId?:     string;
  defensiveParticipation?: DefensiveParticipationInstruction;
}

// ── Helpers de compilação para modificadores numéricos ───────────────────────

/** Quanto o jogador avança além da posição base (multiplicador do push, 0–2) */
export function attackSupportMultiplier(inst?: PlayerInstructions): number {
  switch (inst?.attackSupport) {
    case 'very-defensive':  return 0.2;
    case 'defensive':       return 0.6;
    case 'balanced':        return 1.0;
    case 'offensive':       return 1.5;
    case 'very-offensive':  return 2.0;
    default:                return 1.0;
  }
}

/** Range de pressão individual (multiplicador do range base) */
export function pressRangeMultiplier(inst?: PlayerInstructions): number {
  switch (inst?.press) {
    case 'high':    return 1.6;
    case 'normal':  return 1.0;
    case 'save':    return 0.25;
    default:        return 1.0;
  }
}

/** Bônus de pixels no range de chute (instrução 'shoot') */
export function shootRangeBonus(inst?: PlayerInstructions): number {
  return inst?.withBall === 'shoot' ? 50 : 0;
}

/** Multiplicador sobre a habilidade de drible (instrução 'dribble' ou 'retain') */
export function dribbleAbilityMult(inst?: PlayerInstructions): number {
  return inst?.withBall === 'dribble' ? 1.38 : inst?.withBall === 'retain' ? 0.65 : 1.0;
}

/** Bônus adicionado à vantagem mínima para preferir passe sobre carregar */
export function passAdvantageBonus(inst?: PlayerInstructions): number {
  if (inst?.withBall === 'pass' || inst?.withBall === 'retain') return 18;
  if (inst?.withBall === 'dribble') return -12;
  return 0;
}

/** Bônus subtraído do limiar do service pass (cruzamento) */
export function crossThresholdBonus(inst?: PlayerInstructions): number {
  return inst?.withBall === 'cross' ? 16 : 0;
}

/**
 * Rigid position pull (0–1): quão fortemente o jogador é puxado ao baseX/baseY
 * 0 = ignora a posição base (roam), 1 = segue estritamente (stay)
 */
export function positioningPull(inst?: PlayerInstructions): number {
  switch (inst?.positioning) {
    case 'stay':    return 1.0;
    case 'freedom': return 0.55;
    case 'roam':    return 0.15;
    default:        return 0.55;
  }
}

/** Labels em português */
export const POSITIONING_LABELS: Record<PositioningInstruction, string> = {
  stay:    'Ficar na posição',
  freedom: 'Mais liberdade',
  roam:    'Movimentação livre',
};

export const ATTACK_SUPPORT_LABELS: Record<AttackSupportInstruction, string> = {
  'very-defensive': 'Muito defensivo',
  'defensive':      'Defensivo',
  'balanced':       'Equilibrado',
  'offensive':      'Ofensivo',
  'very-offensive': 'Muito ofensivo',
};

export const MOVEMENT_LABELS: Record<MovementInstruction, string> = {
  'open-space':   'Abrir campo',
  'cut-inside':   'Cortar para dentro',
  'attack-depth': 'Atacar profundidade',
  'come-short':   'Aproximar para tabela',
  'free':         'Movimento livre',
};

export const WITH_BALL_LABELS: Record<WithBallInstruction, string> = {
  dribble: 'Driblar mais',
  pass:    'Passar mais',
  cross:   'Cruzar mais',
  shoot:   'Finalizar mais',
  retain:  'Reter posse',
};

export const PRESS_LABELS: Record<PressInstruction, string> = {
  high:   'Pressionar muito',
  normal: 'Pressionar normal',
  save:   'Poupar energia',
};

export const MARKING_LABELS: Record<MarkingInstruction, string> = {
  normal: 'Marcação normal',
  man:    'Marcar jogador específico',
  sector: 'Cobrir setor',
};

export const DEFENSIVE_PARTICIPATION_LABELS: Record<DefensiveParticipationInstruction, string> = {
  'track-back': 'Voltar para defender',
  'partial':    'Voltar parcialmente',
  'stay':       'Ficar na frente',
};

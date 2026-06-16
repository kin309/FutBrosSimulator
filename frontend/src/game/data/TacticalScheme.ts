// ─── Camada declarativa de tática ────────────────────────────────────────────
// TacticalScheme é a linguagem humana de tática (14 dimensões independentes).
// compileScheme() traduz isso para TacticalProfile — pesos numéricos que a IA
// consome diretamente. Cada dimensão é independente: podem ser combinadas
// livremente para gerar centenas de identidades táticas distintas.

// ── 1. Foco do Ataque ─────────────────────────────────────────────────────────
/** Por onde o time prefere construir e criar */
export type AttackFocus =
  | 'very-wings'   // muito pelas pontas
  | 'wings'        // pelas pontas
  | 'balanced'     // equilibrado
  | 'center'       // pelo meio
  | 'very-center'; // muito pelo meio

// ── 2. Tipo de Construção ─────────────────────────────────────────────────────
/** Como o time progride com a bola */
export type BuildUpStyle =
  | 'patient'    // posse paciente: muitos passes, baixo risco, ritmo lento
  | 'vertical'   // posse vertical: rápido para frente, menos lateral
  | 'balanced'   // equilibrado: mistura passes e progressão direta
  | 'direct'     // jogo direto: menos passes, mais fisicalidade
  | 'long-ball'; // bola longa: lançamentos, pressão, ganha segunda bola

// ── 3. Ritmo ──────────────────────────────────────────────────────────────────
/** Velocidade das decisões e circulação */
export type Tempo =
  | 'very-slow'   // muito lento
  | 'slow'        // lento
  | 'normal'      // normal
  | 'fast'        // rápido
  | 'very-fast';  // muito rápido

// ── 4. Amplitude ──────────────────────────────────────────────────────────────
/** Quão aberto o time joga no eixo lateral */
export type Width =
  | 'very-narrow'  // muito estreito: triangulações, overload central
  | 'narrow'       // estreito
  | 'normal'       // normal
  | 'wide'         // aberto: pontas colados à linha, laterais projetados
  | 'very-wide';   // muito aberto

// ── 5. Risco ─────────────────────────────────────────────────────────────────
/** Quanto o time aceita perder a bola */
export type RiskLevel =
  | 'very-safe'    // muito seguro
  | 'safe'         // seguro
  | 'balanced'     // equilibrado
  | 'risky'        // arriscado
  | 'very-risky';  // muito arriscado

// ── 6. Criação de Chances ─────────────────────────────────────────────────────
/**
 * Pesos de preferência para cada tipo de jogada ofensiva.
 * Proporções — não precisam somar 1; compileScheme() normaliza.
 * Exemplo: { crosses: 3, throughBalls: 1, runs: 2, longShots: 0 }
 */
export interface ChanceCreationWeights {
  crosses: number;      // cruzamentos das laterais
  throughBalls: number; // passes em profundidade
  runs: number;         // infiltrações / corridas diagonais
  longShots: number;    // chutes de longe
}

// ── 7. Altura da Linha Defensiva ──────────────────────────────────────────────
export type DefensiveLine =
  | 'very-high'  // muito alta: pressiona mais, cede espaço nas costas
  | 'high'       // alta
  | 'medium'     // média
  | 'low'        // baixa
  | 'very-low';  // muito baixa: protege a área, aceita pressão

// ── 8. Intensidade de Pressão ─────────────────────────────────────────────────
export type PressureIntensity =
  | 'very-high'   // muito agressiva: gasto físico alto, recuperação de posse
  | 'high'        // agressiva
  | 'medium'      // normal
  | 'low'         // conservadora
  | 'very-low';   // muito conservadora: não pressiona, mantém bloco

// ── 9. Tipo de Marcação ───────────────────────────────────────────────────────
/** Filosofia defensiva dos jogadores sem bola */
export type MarkingStyle =
  | 'zone'    // zona: defende espaços, mantém posição
  | 'man'     // individual: segue o adversário
  | 'mixed';  // mista: combina as duas

// ── 10. Transição Ofensiva ────────────────────────────────────────────────────
/** O que o time faz ao recuperar a bola */
export type OffensiveTransition =
  | 'counter'     // contra-atacar imediatamente
  | 'vertical'    // verticalizar rápido
  | 'possession'  // manter posse antes de avançar
  | 'reorganize'; // reorganizar antes de atacar

// ── 11. Transição Defensiva ───────────────────────────────────────────────────
/** O que o time faz ao perder a bola */
export type DefensiveTransition =
  | 'immediate'  // pressão imediata: tentar recuperar no local
  | 'moderate'   // pressão moderada
  | 'retreat';   // recuar rapidamente ao bloco

// ── 12. Comportamento dos Laterais ────────────────────────────────────────────
export type FullbackBehavior =
  | 'very-defensive'  // muito defensivos: raramente sobem
  | 'defensive'       // defensivos
  | 'balanced'        // equilibrados
  | 'offensive'       // ofensivos: overlap frequente
  | 'very-offensive'; // muito ofensivos: quase pontas

// ── 13. Comportamento dos Pontas ──────────────────────────────────────────────
export type WingerBehavior =
  | 'open-space'      // abrir campo: ficar colado à linha lateral
  | 'cut-inside'      // cortar para dentro: finalizar, criar pelo centro
  | 'attack-depth'    // atacar a profundidade: corridas atrás da defesa
  | 'receive-feet'    // receber no pé: segurar a bola, paciência
  | 'free';           // livre: sem restrição específica

// ── 14. Comportamento do Centroavante ─────────────────────────────────────────
export type StrikerBehavior =
  | 'target-man'  // homem-alvo: fixo, ganha duelos aéreos, protege a bola
  | 'finisher'    // finalizador: fica próximo ao gol, espera o momento
  | 'false-9'     // falso 9: cai para o meio, cria espaço para meias subirem
  | 'presser'     // pressionador: pressiona a defesa adversária
  | 'mobile';     // móvel: varia as movimentações

// ── Esquema completo (14 dimensões) ──────────────────────────────────────────

export interface TacticalScheme {
  name: string;
  label: string;
  description: string;

  // 1. Foco do Ataque
  attackFocus: AttackFocus;
  // 2. Tipo de Construção
  buildUpStyle: BuildUpStyle;
  // 3. Ritmo
  tempo: Tempo;
  // 4. Amplitude
  width: Width;
  // 5. Risco
  riskLevel: RiskLevel;
  // 6. Criação de Chances
  chanceCreation: ChanceCreationWeights;
  // 7. Linha Defensiva
  defensiveLine: DefensiveLine;
  // 8. Intensidade de Pressão
  pressure: PressureIntensity;
  // 9. Tipo de Marcação
  marking: MarkingStyle;
  // 10. Transição Ofensiva
  offensiveTransition: OffensiveTransition;
  // 11. Transição Defensiva
  defensiveTransition: DefensiveTransition;
  // 12. Comportamento dos Laterais
  fullbackBehavior: FullbackBehavior;
  // 13. Comportamento dos Pontas
  wingerBehavior: WingerBehavior;
  // 14. Comportamento do Centroavante
  strikerBehavior: StrikerBehavior;
}

// ── Labels em português (para UI) ────────────────────────────────────────────

export const ATTACK_FOCUS_LABELS: Record<AttackFocus, string> = {
  'very-wings':  'Muito pelas pontas',
  'wings':       'Pelas pontas',
  'balanced':    'Equilibrado',
  'center':      'Pelo meio',
  'very-center': 'Muito pelo meio',
};

export const BUILD_UP_STYLE_LABELS: Record<BuildUpStyle, string> = {
  'patient':   'Posse paciente',
  'vertical':  'Posse vertical',
  'balanced':  'Equilibrado',
  'direct':    'Jogo direto',
  'long-ball': 'Bola longa',
};

export const TEMPO_LABELS: Record<Tempo, string> = {
  'very-slow':  'Muito lento',
  'slow':       'Lento',
  'normal':     'Normal',
  'fast':       'Rápido',
  'very-fast':  'Muito rápido',
};

export const WIDTH_LABELS: Record<Width, string> = {
  'very-narrow': 'Muito estreito',
  'narrow':      'Estreito',
  'normal':      'Normal',
  'wide':        'Aberto',
  'very-wide':   'Muito aberto',
};

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  'very-safe':   'Muito seguro',
  'safe':        'Seguro',
  'balanced':    'Equilibrado',
  'risky':       'Arriscado',
  'very-risky':  'Muito arriscado',
};

export const DEFENSIVE_LINE_LABELS: Record<DefensiveLine, string> = {
  'very-high': 'Muito alta',
  'high':      'Alta',
  'medium':    'Média',
  'low':       'Baixa',
  'very-low':  'Muito baixa',
};

export const PRESSURE_INTENSITY_LABELS: Record<PressureIntensity, string> = {
  'very-high': 'Muito agressiva',
  'high':      'Agressiva',
  'medium':    'Normal',
  'low':       'Conservadora',
  'very-low':  'Muito conservadora',
};

export const MARKING_STYLE_LABELS: Record<MarkingStyle, string> = {
  zone:   'Zona',
  man:    'Individual',
  mixed:  'Mista',
};

export const OFFENSIVE_TRANSITION_LABELS: Record<OffensiveTransition, string> = {
  counter:     'Contra-atacar imediatamente',
  vertical:    'Verticalizar rápido',
  possession:  'Manter posse',
  reorganize:  'Reorganizar antes de atacar',
};

export const DEFENSIVE_TRANSITION_LABELS: Record<DefensiveTransition, string> = {
  immediate: 'Pressão imediata',
  moderate:  'Pressão moderada',
  retreat:   'Recuar rapidamente',
};

export const FULLBACK_BEHAVIOR_LABELS: Record<FullbackBehavior, string> = {
  'very-defensive':  'Muito defensivos',
  'defensive':       'Defensivos',
  'balanced':        'Equilibrados',
  'offensive':       'Ofensivos',
  'very-offensive':  'Muito ofensivos',
};

export const WINGER_BEHAVIOR_LABELS: Record<WingerBehavior, string> = {
  'open-space':    'Abrir campo',
  'cut-inside':    'Cortar para dentro',
  'attack-depth':  'Atacar profundidade',
  'receive-feet':  'Receber no pé',
  'free':          'Livre',
};

export const STRIKER_BEHAVIOR_LABELS: Record<StrikerBehavior, string> = {
  'target-man': 'Homem-alvo',
  'finisher':   'Finalizador',
  'false-9':    'Falso 9',
  'presser':    'Pressionador',
  'mobile':     'Móvel',
};

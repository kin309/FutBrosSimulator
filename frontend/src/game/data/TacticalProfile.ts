import {
  TacticalScheme,
  AttackFocus,
  BuildUpStyle,
  Tempo,
  Width,
  RiskLevel,
  DefensiveLine,
  PressureIntensity,
  MarkingStyle,
  OffensiveTransition,
  FullbackBehavior,
  WingerBehavior,
  StrikerBehavior,
} from './TacticalScheme';

export type { TacticalScheme };

// ─── Runtime profile (o que a IA lê) ─────────────────────────────────────────
// Não edite manualmente — derive via compileScheme().

export interface TacticalProfile {
  name: string;
  label: string;
  description: string;

  // ── Campos legados (mantidos para compatibilidade) ────────────────────────
  /** 0–1: preferência por passes seguros/laterais vs. progressão direta */
  possessionBias: number;
  /** Máximo de jogadores pressionando ao mesmo tempo */
  maxPressers: number;
  /** Stamina mínima para pressionar (0 = sempre pressiona) */
  pressStaminaThreshold: number;
  /** Atacantes voltam a defender */
  strikersTrackBack: boolean;
  /** Deslocamento da linha defensiva em px (positivo = mais fundo, negativo = mais alta) */
  defensiveLineDepth: number;
  /** 0–1: preferência por passes curtos */
  shortPassPreference: number;
  /** 0–1: intensidade das corridas e trocas de posição sem bola */
  supportRunIntensity: number;
  /** 0–1: coordenação do bloco de pressão */
  pressCoordination: number;

  // ── Campos derivados das 14 dimensões ────────────────────────────────────

  /** 0–1: largura de jogo — 0=muito estreita, 1=muito aberta */
  widthBias: number;

  /**
   * -1–1: foco do ataque no eixo lateral
   *  -1 = muito pelo centro  |  0 = equilibrado  |  +1 = muito pelas pontas
   */
  attackFocusBias: number;

  /** 0–1: ritmo — 0=muito lento, 0.5=normal, 1=muito rápido */
  tempoBias: number;

  /** 0–1: apetite por risco — 0=muito seguro, 1=muito arriscado */
  riskTolerance: number;

  // Pesos de criação de chances (normalizados: somam 1.0)
  crossWeight: number;
  throughBallWeight: number;
  runWeight: number;
  longShotWeight: number;

  /** 0–1: zona=0, individual=1 */
  manMarkingBias: number;

  /** 0–1: transição ofensiva — 0=reorganizar, 1=contra-atacar imediatamente */
  offensiveTransitionBias: number;

  /** 0–1: transição defensiva — 0=recuar, 1=pressão imediata */
  defensiveTransitionBias: number;

  /**
   * 0–1: quão ofensivos são os laterais quando o time ataca
   * 0=muito defensivos, 1=muito ofensivos
   */
  fullbackAttackBias: number;

  /**
   * 0–1: posicionamento lateral dos pontas
   * 0=corta para dentro (cut-inside), 1=fica aberto (open-space/wide)
   */
  wingerWidthBias: number;

  /**
   * 0–1: tendência dos pontas a atacar a profundidade
   * 0=recebe no pé/fica parado, 1=corre atrás da defesa
   */
  wingerDepthBias: number;

  /**
   * 0–1: quão fundo o atacante cai para receber
   * 0=fica alto (target-man/finisher), 1=cai para o meio (falso 9)
   */
  strikerDropBias: number;

  /**
   * 0–1: disposição do atacante para pressionar a defesa adversária
   * 0=não pressiona, 1=pressiona sempre
   */
  strikerPressBias: number;

  /**
   * 0–1: liberdade posicional — define o raio do heatmap individual de cada jogador.
   * 0=manter forma estrita, 1=movimento livre pelo campo.
   * Deriva da largura, transição ofensiva e pressão do esquema tático.
   */
  positionFreedom: number;
}

// ─── Compilador: TacticalScheme → TacticalProfile ────────────────────────────

function normalizeCc(cc: { crosses: number; throughBalls: number; runs: number; longShots: number }) {
  const total = cc.crosses + cc.throughBalls + cc.runs + cc.longShots;
  if (total === 0) return { crossWeight: 0.25, throughBallWeight: 0.25, runWeight: 0.25, longShotWeight: 0.25 };
  return {
    crossWeight:       cc.crosses      / total,
    throughBallWeight: cc.throughBalls / total,
    runWeight:         cc.runs         / total,
    longShotWeight:    cc.longShots    / total,
  };
}

// Mapas lineares 5 níveis → número
const ATTACK_FOCUS_MAP: Record<AttackFocus, number> = {
  'very-wings':   1.0,
  'wings':        0.5,
  'balanced':     0.0,
  'center':      -0.5,
  'very-center': -1.0,
};

const TEMPO_MAP: Record<Tempo, number> = {
  'very-slow':  0.0,
  'slow':       0.25,
  'normal':     0.5,
  'fast':       0.75,
  'very-fast':  1.0,
};

const WIDTH_MAP: Record<Width, number> = {
  'very-narrow':  0.0,
  'narrow':       0.25,
  'normal':       0.5,
  'wide':         0.75,
  'very-wide':    1.0,
};

const RISK_MAP: Record<RiskLevel, number> = {
  'very-safe':   0.0,
  'safe':        0.25,
  'balanced':    0.5,
  'risky':       0.75,
  'very-risky':  1.0,
};

// Linha defensiva: positivo = mais fundo (campo próprio), negativo = mais alta (campo adversário)
const DEFENSIVE_LINE_DEPTH_MAP: Record<DefensiveLine, number> = {
  'very-high': -110,
  'high':       -60,
  'medium':       0,
  'low':         65,
  'very-low':   120,
};

const PRESSURE_MAP: Record<PressureIntensity, {
  maxPressers: number; threshold: number; coord: number;
}> = {
  'very-high': { maxPressers: 5, threshold: 10, coord: 1.0 },
  'high':      { maxPressers: 4, threshold: 15, coord: 0.9 },
  'medium':    { maxPressers: 2, threshold: 25, coord: 0.5 },
  'low':       { maxPressers: 1, threshold:  0, coord: 0.2 },
  'very-low':  { maxPressers: 1, threshold:  0, coord: 0.1 },
};

const MARKING_MAP: Record<MarkingStyle, number> = {
  zone:  0.0,
  mixed: 0.5,
  man:   1.0,
};

const PRESSURE_FREEDOM_MAP: Record<PressureIntensity, number> = {
  'very-low':  0.10,
  'low':       0.25,
  'medium':    0.50,
  'high':      0.75,
  'very-high': 0.90,
};

const OFFENSIVE_TRANSITION_MAP: Record<OffensiveTransition, number> = {
  counter:    1.0,
  vertical:   0.7,
  possession: 0.3,
  reorganize: 0.0,
};

const FULLBACK_MAP: Record<FullbackBehavior, number> = {
  'very-defensive':  0.0,
  'defensive':       0.25,
  'balanced':        0.5,
  'offensive':       0.75,
  'very-offensive':  1.0,
};

const WINGER_MAP: Record<WingerBehavior, { widthBias: number; depthBias: number }> = {
  'open-space':    { widthBias: 1.0, depthBias: 0.5 },
  'cut-inside':    { widthBias: 0.0, depthBias: 0.4 },
  'attack-depth':  { widthBias: 0.6, depthBias: 1.0 },
  'receive-feet':  { widthBias: 0.5, depthBias: 0.0 },
  'free':          { widthBias: 0.5, depthBias: 0.5 },
};

const STRIKER_MAP: Record<StrikerBehavior, { dropBias: number; pressBias: number }> = {
  'target-man': { dropBias: 0.1, pressBias: 0.2 },
  'finisher':   { dropBias: 0.0, pressBias: 0.1 },
  'false-9':    { dropBias: 1.0, pressBias: 0.3 },
  'presser':    { dropBias: 0.2, pressBias: 1.0 },
  'mobile':     { dropBias: 0.3, pressBias: 0.4 },
};

function buildUpToPossessionBias(style: BuildUpStyle): number {
  return { patient: 0.80, vertical: 0.40, balanced: 0.25, direct: 0.10, 'long-ball': 0.05 }[style];
}

function buildUpToShortPassPreference(style: BuildUpStyle): number {
  return { patient: 0.90, vertical: 0.50, balanced: 0.35, direct: 0.15, 'long-ball': 0.05 }[style];
}

function buildUpToSupportRunIntensity(style: BuildUpStyle, offTrans: OffensiveTransition): number {
  const base = { patient: 0.70, vertical: 0.65, balanced: 0.55, direct: 0.45, 'long-ball': 0.40 }[style];
  const transBonus = offTrans === 'counter' ? 0.20 : offTrans === 'vertical' ? 0.10 : 0;
  return Math.min(1, base + transBonus);
}

export function compileScheme(scheme: TacticalScheme): TacticalProfile {
  const press    = PRESSURE_MAP[scheme.pressure];
  const ccW      = normalizeCc(scheme.chanceCreation);
  const winger   = WINGER_MAP[scheme.wingerBehavior];
  const striker  = STRIKER_MAP[scheme.strikerBehavior];

  const strikersTrackBack =
    scheme.defensiveTransition === 'immediate'
    || (scheme.defensiveTransition === 'moderate' && scheme.pressure !== 'low' && scheme.pressure !== 'very-low');

  return {
    name:        scheme.name,
    label:       scheme.label,
    description: scheme.description,

    // Legados
    possessionBias:        buildUpToPossessionBias(scheme.buildUpStyle),
    maxPressers:           press.maxPressers,
    pressStaminaThreshold: press.threshold,
    strikersTrackBack,
    defensiveLineDepth:    DEFENSIVE_LINE_DEPTH_MAP[scheme.defensiveLine],
    shortPassPreference:   buildUpToShortPassPreference(scheme.buildUpStyle),
    supportRunIntensity:   buildUpToSupportRunIntensity(scheme.buildUpStyle, scheme.offensiveTransition),
    pressCoordination:     press.coord,

    // Novos
    widthBias:              WIDTH_MAP[scheme.width],
    attackFocusBias:        ATTACK_FOCUS_MAP[scheme.attackFocus],
    tempoBias:              TEMPO_MAP[scheme.tempo],
    riskTolerance:          RISK_MAP[scheme.riskLevel],
    ...ccW,
    manMarkingBias:         MARKING_MAP[scheme.marking],
    offensiveTransitionBias: OFFENSIVE_TRANSITION_MAP[scheme.offensiveTransition],
    defensiveTransitionBias: ({ immediate: 1.0, moderate: 0.5, retreat: 0.0 } as const)[scheme.defensiveTransition],
    fullbackAttackBias:     FULLBACK_MAP[scheme.fullbackBehavior],
    wingerWidthBias:        winger.widthBias,
    wingerDepthBias:        winger.depthBias,
    strikerDropBias:        striker.dropBias,
    strikerPressBias:       striker.pressBias,
    positionFreedom:
      WIDTH_MAP[scheme.width] * 0.35
      + OFFENSIVE_TRANSITION_MAP[scheme.offensiveTransition] * 0.40
      + PRESSURE_FREEDOM_MAP[scheme.pressure] * 0.25,
  };
}

// ─── Os 5 perfis declarados como TacticalScheme ───────────────────────────────

export const TACTICAL_SCHEMES: TacticalScheme[] = [
  {
    name: 'balanced',
    label: 'Balanceado',
    description: 'Estilo equilibrado sem prioridade específica.',
    attackFocus:         'balanced',
    buildUpStyle:        'balanced',
    tempo:               'normal',
    width:               'normal',
    riskLevel:           'balanced',
    chanceCreation:      { crosses: 1, throughBalls: 1, runs: 1, longShots: 1 },
    defensiveLine:       'medium',
    pressure:            'medium',
    marking:             'mixed',
    offensiveTransition: 'vertical',
    defensiveTransition: 'moderate',
    fullbackBehavior:    'balanced',
    wingerBehavior:      'free',
    strikerBehavior:     'mobile',
  },
  {
    name: 'possession',
    label: 'Posse de Bola',
    description: 'Circula a bola com paciência, domina pelo meio, laterais ofensivos.',
    attackFocus:         'center',
    buildUpStyle:        'patient',
    tempo:               'slow',
    width:               'wide',
    riskLevel:           'safe',
    chanceCreation:      { crosses: 0.5, throughBalls: 2.5, runs: 3, longShots: 0.5 },
    defensiveLine:       'high',
    pressure:            'medium',
    marking:             'zone',
    offensiveTransition: 'possession',
    defensiveTransition: 'moderate',
    fullbackBehavior:    'offensive',
    wingerBehavior:      'open-space',
    strikerBehavior:     'mobile',
  },
  {
    name: 'high-press',
    label: 'Pressão Alta',
    description: 'Pressiona agressivamente, linha muito alta, recupera no campo adversário.',
    attackFocus:         'balanced',
    buildUpStyle:        'vertical',
    tempo:               'fast',
    width:               'wide',
    riskLevel:           'risky',
    chanceCreation:      { crosses: 2, throughBalls: 2, runs: 3.5, longShots: 0.5 },
    defensiveLine:       'very-high',
    pressure:            'very-high',
    marking:             'mixed',
    offensiveTransition: 'vertical',
    defensiveTransition: 'immediate',
    fullbackBehavior:    'very-offensive',
    wingerBehavior:      'attack-depth',
    strikerBehavior:     'presser',
  },
  {
    name: 'counter',
    label: 'Contra-Ataque',
    description: 'Defende organizado e explora espaços em transições rápidas pelas pontas.',
    attackFocus:         'very-wings',
    buildUpStyle:        'long-ball',
    tempo:               'fast',
    width:               'very-wide',
    riskLevel:           'safe',
    chanceCreation:      { crosses: 1, throughBalls: 3, runs: 4, longShots: 0.5 },
    defensiveLine:       'low',
    pressure:            'low',
    marking:             'zone',
    offensiveTransition: 'counter',
    defensiveTransition: 'retreat',
    fullbackBehavior:    'defensive',
    wingerBehavior:      'attack-depth',
    strikerBehavior:     'mobile',
  },
  {
    name: 'park-the-bus',
    label: 'Retrancado',
    description: 'Bloco defensivo profundo, mínima pressão, bola longa e chutes de longe.',
    attackFocus:         'center',
    buildUpStyle:        'direct',
    tempo:               'very-slow',
    width:               'very-narrow',
    riskLevel:           'very-safe',
    chanceCreation:      { crosses: 2, throughBalls: 0.5, runs: 0.5, longShots: 3 },
    defensiveLine:       'very-low',
    pressure:            'very-low',
    marking:             'man',
    offensiveTransition: 'reorganize',
    defensiveTransition: 'retreat',
    fullbackBehavior:    'very-defensive',
    wingerBehavior:      'receive-feet',
    strikerBehavior:     'target-man',
  },
];

// ─── Perfis compilados (usados pela IA) ──────────────────────────────────────

export const TACTICAL_PROFILES: TacticalProfile[] = TACTICAL_SCHEMES.map(compileScheme);

export const DEFAULT_TACTICAL_PROFILE = TACTICAL_PROFILES[0];

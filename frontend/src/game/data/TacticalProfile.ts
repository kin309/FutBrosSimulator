export interface TacticalProfile {
  name: string;
  label: string;
  description: string;
  /** 0–1: higher = prefer safe/lateral passes over forward carries */
  possessionBias: number;
  /** Max players allowed to press simultaneously */
  maxPressers: number;
  /** Stamina floor below which team stops pressing (0 = always press) */
  pressStaminaThreshold: number;
  /** Whether strikers track back when team is defending */
  strikersTrackBack: boolean;
  /** Shifts defenders' base X toward own goal (positive = deeper) */
  defensiveLineDepth: number;
  /** 0–1: preference for short passes; drives chain-pass bonus and triangle positioning */
  shortPassPreference: number;
  /** 0–1: how eagerly off-ball players make support runs and rotate positions */
  supportRunIntensity: number;
  /** 0–1: how coordinated the press is (unit-based vs individual) */
  pressCoordination: number;
}

export const TACTICAL_PROFILES: TacticalProfile[] = [
  {
    name: 'balanced',
    label: 'Balanceado',
    description: 'Estilo equilibrado sem prioridade específica.',
    possessionBias: 0.35,
    maxPressers: 2,
    pressStaminaThreshold: 20,
    strikersTrackBack: false,
    defensiveLineDepth: 0,
    shortPassPreference: 0.4,
    supportRunIntensity: 0.5,
    pressCoordination: 0.4,
  },
  {
    name: 'possession',
    label: 'Posse de Bola',
    description: 'Circula a bola com paciência, prioriza passes seguros antes de avançar.',
    possessionBias: 0.75,
    maxPressers: 2,
    pressStaminaThreshold: 35,
    strikersTrackBack: false,
    defensiveLineDepth: 0,
    shortPassPreference: 0.9,
    supportRunIntensity: 0.8,
    pressCoordination: 0.3,
  },
  {
    name: 'high-press',
    label: 'Pressão Alta',
    description: 'Pressiona agressivamente, linha alta, recupera a bola no campo adversário.',
    possessionBias: 0.1,
    maxPressers: 4,
    pressStaminaThreshold: 15,
    strikersTrackBack: true,
    defensiveLineDepth: -60,
    shortPassPreference: 0.3,
    supportRunIntensity: 0.5,
    pressCoordination: 0.9,
  },
  {
    name: 'counter',
    label: 'Contra-Ataque',
    description: 'Defende organizado e explora os espaços em transições rápidas.',
    possessionBias: 0.1,
    maxPressers: 1,
    pressStaminaThreshold: 0,
    strikersTrackBack: false,
    defensiveLineDepth: 40,
    shortPassPreference: 0.1,
    supportRunIntensity: 0.9,
    pressCoordination: 0.2,
  },
  {
    name: 'park-the-bus',
    label: 'Retrancado',
    description: 'Bloco defensivo profundo, mínima pressão, aposta em bolas paradas.',
    possessionBias: 0.2,
    maxPressers: 1,
    pressStaminaThreshold: 0,
    strikersTrackBack: true,
    defensiveLineDepth: 90,
    shortPassPreference: 0.2,
    supportRunIntensity: 0.2,
    pressCoordination: 0.5,
  },
];

export const DEFAULT_TACTICAL_PROFILE = TACTICAL_PROFILES[0];

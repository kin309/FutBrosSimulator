import { TACTICAL_PROFILES, TacticalProfile, TACTICAL_SCHEMES, compileScheme } from '../game/data/TacticalProfile';
import type { TacticalScheme } from '../game/data/TacticalScheme';
import { PlayerRole } from '../game/data/PlayerRole';
import {
  ATTACK_FOCUS_LABELS, BUILD_UP_STYLE_LABELS, TEMPO_LABELS, WIDTH_LABELS,
  RISK_LEVEL_LABELS, DEFENSIVE_LINE_LABELS, PRESSURE_INTENSITY_LABELS,
  MARKING_STYLE_LABELS, OFFENSIVE_TRANSITION_LABELS, DEFENSIVE_TRANSITION_LABELS,
  FULLBACK_BEHAVIOR_LABELS, WINGER_BEHAVIOR_LABELS, STRIKER_BEHAVIOR_LABELS,
} from '../game/data/TacticalScheme';

export interface HalftimePlayerSnapshot {
  id: string;
  name: string;
  role: PlayerRole;
  jerseyNumber: number;
  stamina: number; // 0–100
}

export interface HalftimeContext {
  scoreA: number;
  scoreB: number;
  teamAName: string;
  teamBName: string;
  currentProfile: TacticalProfile;
  currentProfileB?: TacticalProfile;
  applyTactic: (profile: TacticalProfile) => void;
  applyTacticB?: (profile: TacticalProfile) => void;
  resume: () => void;
  starters?: HalftimePlayerSnapshot[];
  bench?: HalftimePlayerSnapshot[];
  applySubstitution?: (starterIndex: number, benchIndex: number) => void;
}

const CC_LEVEL_LABELS = ['—', 'Baixo', 'Normal', 'Alto', 'Muito'];

const MAX_SUBS = 3;

const ROLE_ABBR: Record<PlayerRole, string> = {
  [PlayerRole.Goalkeeper]: 'GR',
  [PlayerRole.Defender]:   'DEF',
  [PlayerRole.Midfielder]: 'MEI',
  [PlayerRole.Winger]:     'ALA',
  [PlayerRole.Striker]:    'ATA',
};

export function showHalftimePanel(ctx: HalftimeContext): void {
  const overlay = document.createElement('div');
  overlay.className = 'halftime-overlay';

  let selectedScheme: TacticalScheme =
    TACTICAL_SCHEMES.find(s => s.name === ctx.currentProfile.name) ?? TACTICAL_SCHEMES[0];
  let tacticViewMode: 'preset' | 'advanced' = 'preset';

  // ── Substitution state ───────────────────────────────────────────────────────
  const currentStarters: HalftimePlayerSnapshot[] = [...(ctx.starters ?? [])];
  const currentBench: HalftimePlayerSnapshot[] = [...(ctx.bench ?? [])];
  let selectedStarterIdx: number | null = null;
  let subsUsed = 0;
  const usedBenchIndices = new Set<number>();
  const hasSubsSection = ctx.applySubstitution && currentBench.length > 0;

  function renderPanel(): void {
    overlay.innerHTML = `
      <div class="halftime-panel">
        <p class="halftime-label">Intervalo</p>
        <div class="halftime-score">
          <span class="halftime-team">${escapeHtml(ctx.teamAName)}</span>
          <strong class="halftime-scoreline">${ctx.scoreA} — ${ctx.scoreB}</strong>
          <span class="halftime-team">${escapeHtml(ctx.teamBName)}</span>
        </div>
        ${hasSubsSection ? subsectionHtml() : ''}
        <div class="halftime-section">
          <div class="halftime-tactic-view-row">
            <p class="halftime-section-label" style="margin:0">Tática para o 2º Tempo</p>
            <div style="display:flex;gap:4px">
              <button class="halftime-tactic-view-btn ${tacticViewMode === 'preset' ? 'is-active' : ''}" data-ht-view="preset">Presets</button>
              <button class="halftime-tactic-view-btn ${tacticViewMode === 'advanced' ? 'is-active' : ''}" data-ht-view="advanced">Avançado</button>
            </div>
          </div>
          ${tacticViewMode === 'preset' ? presetTabsHtml() : advancedPanelHtml()}
        </div>
        <button class="start-button" data-continue>Continuar</button>
      </div>
    `;
    wirePanel();
  }

  // ── Substitution section HTML ─────────────────────────────────────────────

  function subsectionHtml(): string {
    const canSub = subsUsed < MAX_SUBS;
    return `
      <div class="halftime-section halftime-subs-section">
        <div class="halftime-tactic-view-row">
          <p class="halftime-section-label" style="margin:0">Substituições</p>
          <span class="ht-subs-counter">${subsUsed}/${MAX_SUBS}</span>
        </div>
        <div class="halftime-subs-grid">
          <div class="halftime-subs-col">
            <div class="halftime-subs-col-header">Titulares</div>
            ${currentStarters.map((p, i) => starterRowHtml(p, i, canSub)).join('')}
          </div>
          <div class="halftime-subs-col">
            <div class="halftime-subs-col-header">Banco</div>
            ${currentBench.map((p, i) => benchRowHtml(p, i)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function starterRowHtml(p: HalftimePlayerSnapshot, i: number, canSub: boolean): string {
    const isSelected = i === selectedStarterIdx;
    const isReplaced = (() => {
      // If this starter was already substituted, their id changed - detect by checking
      // if any bench index was used for this slot (tracked via currentStarters mutations)
      return false; // actual substituted state tracked via currentStarters update
    })();
    const disabled = !canSub || isReplaced ? 'disabled' : '';
    const selClass = isSelected ? 'is-selected' : '';
    const stamPct = Math.round(p.stamina);
    const stamClass = p.stamina >= 70 ? 'ht-stamina-high' : p.stamina >= 40 ? 'ht-stamina-med' : 'ht-stamina-low';

    return `
      <button class="ht-player-row ${selClass}" data-sub-starter="${i}" ${disabled}>
        <span class="ht-player-num">${escapeHtml(String(p.jerseyNumber))}</span>
        <span class="ht-player-role">${escapeHtml(ROLE_ABBR[p.role] ?? '?')}</span>
        <span class="ht-player-name">${escapeHtml(p.name)}</span>
        <div class="ht-stamina-bar" title="${stamPct}%">
          <div class="ht-stamina-fill ${stamClass}" style="width:${stamPct}%"></div>
        </div>
      </button>
    `;
  }

  function benchRowHtml(p: HalftimePlayerSnapshot, i: number): string {
    const isUsed = usedBenchIndices.has(i);
    const isActive = selectedStarterIdx !== null && !isUsed;
    const disabled = !isActive ? 'disabled' : '';
    const usedClass = isUsed ? 'is-used' : '';

    return `
      <button class="ht-player-row ht-bench-row ${usedClass}" data-sub-bench="${i}" ${disabled}>
        <span class="ht-player-num">${escapeHtml(String(p.jerseyNumber))}</span>
        <span class="ht-player-role ht-bench-role">${escapeHtml(ROLE_ABBR[p.role] ?? '?')}</span>
        <span class="ht-player-name">${escapeHtml(p.name)}</span>
        ${isUsed ? '<span class="ht-used-badge">campo</span>' : '<span class="ht-stamina-pip"></span>'}
      </button>
    `;
  }

  // ── Tactic HTML ──────────────────────────────────────────────────────────

  function presetTabsHtml(): string {
    return `
      <div class="formation-tabs halftime-tactic-tabs">
        ${TACTICAL_PROFILES.map((p) => `
          <button
            class="${p.name === selectedScheme.name ? 'is-active' : ''}"
            data-tactic="${escapeHtml(p.name)}"
          >${escapeHtml(p.label)}</button>
        `).join('')}
      </div>
    `;
  }

  function advancedPanelHtml(): string {
    const s = selectedScheme;
    return `
      <div class="halftime-advanced-section tactic-advanced-panel">
        ${tacticGroupHtml('Ataque', [
          tacticRowHtml('Foco', schemeOptBtns('attackFocus',
            ['very-wings','wings','balanced','center','very-center'], ATTACK_FOCUS_LABELS, s.attackFocus)),
          tacticRowHtml('Amplitude', schemeOptBtns('width',
            ['very-narrow','narrow','normal','wide','very-wide'], WIDTH_LABELS, s.width)),
          tacticRowHtml('Ritmo', schemeOptBtns('tempo',
            ['very-slow','slow','normal','fast','very-fast'], TEMPO_LABELS, s.tempo)),
          tacticRowHtml('Risco', schemeOptBtns('riskLevel',
            ['very-safe','safe','balanced','risky','very-risky'], RISK_LEVEL_LABELS, s.riskLevel)),
        ])}
        ${tacticGroupHtml('Construção', [
          tacticRowHtml('Estilo', schemeOptBtns('buildUpStyle',
            ['patient','vertical','balanced','direct','long-ball'], BUILD_UP_STYLE_LABELS, s.buildUpStyle)),
          tacticRowHtml('Cruzamentos', ccLevelBtns('crosses', s.chanceCreation.crosses), 'tactic-level-opts'),
          tacticRowHtml('Passes prof.', ccLevelBtns('throughBalls', s.chanceCreation.throughBalls), 'tactic-level-opts'),
          tacticRowHtml('Infiltrações', ccLevelBtns('runs', s.chanceCreation.runs), 'tactic-level-opts'),
          tacticRowHtml('Chutes longe', ccLevelBtns('longShots', s.chanceCreation.longShots), 'tactic-level-opts'),
        ])}
        ${tacticGroupHtml('Defesa', [
          tacticRowHtml('Linha def.', schemeOptBtns('defensiveLine',
            ['very-high','high','medium','low','very-low'], DEFENSIVE_LINE_LABELS, s.defensiveLine)),
          tacticRowHtml('Pressão', schemeOptBtns('pressure',
            ['very-high','high','medium','low','very-low'], PRESSURE_INTENSITY_LABELS, s.pressure)),
          tacticRowHtml('Marcação', schemeOptBtns('marking',
            ['zone','mixed','man'], MARKING_STYLE_LABELS, s.marking)),
        ])}
        ${tacticGroupHtml('Transições', [
          tacticRowHtml('Ofensiva', schemeOptBtns('offensiveTransition',
            ['counter','vertical','possession','reorganize'], OFFENSIVE_TRANSITION_LABELS, s.offensiveTransition)),
          tacticRowHtml('Defensiva', schemeOptBtns('defensiveTransition',
            ['immediate','moderate','retreat'], DEFENSIVE_TRANSITION_LABELS, s.defensiveTransition)),
        ])}
        ${tacticGroupHtml('Papel dos Jogadores', [
          tacticRowHtml('Laterais', schemeOptBtns('fullbackBehavior',
            ['very-defensive','defensive','balanced','offensive','very-offensive'], FULLBACK_BEHAVIOR_LABELS, s.fullbackBehavior)),
          tacticRowHtml('Pontas', schemeOptBtns('wingerBehavior',
            ['open-space','cut-inside','attack-depth','receive-feet','free'], WINGER_BEHAVIOR_LABELS, s.wingerBehavior)),
          tacticRowHtml('Centroavante', schemeOptBtns('strikerBehavior',
            ['target-man','finisher','false-9','presser','mobile'], STRIKER_BEHAVIOR_LABELS, s.strikerBehavior)),
        ])}
      </div>
    `;
  }

  // ── Wire interactions ─────────────────────────────────────────────────────

  function wirePanel(): void {
    // Tactic view mode toggle
    overlay.querySelectorAll<HTMLButtonElement>('[data-ht-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        tacticViewMode = btn.dataset.htView as 'preset' | 'advanced';
        renderPanel();
      });
    });

    // Preset tactic selection
    overlay.querySelectorAll<HTMLButtonElement>('[data-tactic]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const scheme = TACTICAL_SCHEMES.find(s => s.name === btn.dataset.tactic);
        if (!scheme) return;
        selectedScheme = scheme;
        ctx.applyTactic(compileScheme(scheme));
        renderPanel();
      });
    });

    // Advanced scheme dimensions
    overlay.querySelectorAll<HTMLButtonElement>('[data-scheme-dim]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dim = btn.dataset.schemeDim as keyof TacticalScheme;
        const val = btn.dataset.schemeVal!;
        selectedScheme = { ...selectedScheme, [dim]: val };
        ctx.applyTactic(compileScheme(selectedScheme));
        renderPanel();
      });
    });

    // Chance-creation level buttons
    overlay.querySelectorAll<HTMLButtonElement>('[data-cc-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.ccKey as keyof typeof selectedScheme.chanceCreation;
        const val = parseInt(btn.dataset.ccVal ?? '0', 10);
        selectedScheme = {
          ...selectedScheme,
          chanceCreation: { ...selectedScheme.chanceCreation, [key]: val },
        };
        ctx.applyTactic(compileScheme(selectedScheme));
        renderPanel();
      });
    });

    // Substitution — select starter
    overlay.querySelectorAll<HTMLButtonElement>('[data-sub-starter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.subStarter!);
        selectedStarterIdx = selectedStarterIdx === idx ? null : idx;
        renderPanel();
      });
    });

    // Substitution — confirm with bench player
    overlay.querySelectorAll<HTMLButtonElement>('[data-sub-bench]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (selectedStarterIdx === null || subsUsed >= MAX_SUBS) return;
        const benchIdx = parseInt(btn.dataset.subBench!);
        if (usedBenchIndices.has(benchIdx)) return;

        ctx.applySubstitution?.(selectedStarterIdx, benchIdx);

        // Reflect in panel state
        currentStarters[selectedStarterIdx] = { ...currentBench[benchIdx], stamina: 100 };
        usedBenchIndices.add(benchIdx);
        subsUsed++;
        selectedStarterIdx = null;
        renderPanel();
      });
    });

    overlay.querySelector('[data-continue]')?.addEventListener('click', () => {
      overlay.remove();
      ctx.resume();
    });
  }

  renderPanel();
  document.body.appendChild(overlay);
}

function schemeOptBtns(dim: string, options: string[], labels: Record<string, string>, current: string): string {
  return options.map(opt =>
    `<button class="${current === opt ? 'is-active' : ''}" data-scheme-dim="${escapeHtml(dim)}" data-scheme-val="${escapeHtml(opt)}">${escapeHtml(labels[opt] ?? opt)}</button>`
  ).join('');
}

function ccLevelBtns(key: string, currentVal: number): string {
  const level = Math.round(Math.min(4, Math.max(0, currentVal)));
  return CC_LEVEL_LABELS.map((label, idx) =>
    `<button class="${level === idx ? 'is-active' : ''}" data-cc-key="${escapeHtml(key)}" data-cc-val="${idx}">${escapeHtml(label)}</button>`
  ).join('');
}

function tacticGroupHtml(header: string, rows: string[]): string {
  return `<div class="tactic-group"><div class="tactic-group-header">${escapeHtml(header)}</div>${rows.join('')}</div>`;
}

function tacticRowHtml(label: string, optionsHtml: string, extraClass = ''): string {
  return `<div class="tactic-row"><span class="tactic-row-label">${escapeHtml(label)}</span><div class="tactic-options${extraClass ? ' ' + extraClass : ''}">${optionsHtml}</div></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

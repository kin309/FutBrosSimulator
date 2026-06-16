import { TACTICAL_PROFILES, TacticalProfile } from '../game/data/TacticalProfile';

export interface HalftimeContext {
  scoreA: number;
  scoreB: number;
  teamAName: string;
  teamBName: string;
  currentProfile: TacticalProfile;
  applyTactic: (profile: TacticalProfile) => void;
  resume: () => void;
}

export function showHalftimePanel(ctx: HalftimeContext): void {
  const overlay = document.createElement('div');
  overlay.className = 'halftime-overlay';

  overlay.innerHTML = `
    <div class="halftime-panel">
      <p class="halftime-label">Intervalo</p>
      <div class="halftime-score">
        <span class="halftime-team">${escapeHtml(ctx.teamAName)}</span>
        <strong class="halftime-scoreline">${ctx.scoreA} — ${ctx.scoreB}</strong>
        <span class="halftime-team">${escapeHtml(ctx.teamBName)}</span>
      </div>
      <div class="halftime-section">
        <p class="halftime-section-label">Tática para o 2º Tempo</p>
        <div class="formation-tabs halftime-tactic-tabs">
          ${TACTICAL_PROFILES.map((p) => `
            <button
              class="${p.name === ctx.currentProfile.name ? 'is-active' : ''}"
              data-tactic="${escapeHtml(p.name)}"
            >${escapeHtml(p.label)}</button>
          `).join('')}
        </div>
      </div>
      <button class="start-button" data-continue>Continuar</button>
    </div>
  `;

  let selectedProfile = ctx.currentProfile;

  overlay.querySelectorAll<HTMLButtonElement>('[data-tactic]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profile = TACTICAL_PROFILES.find((p) => p.name === btn.dataset.tactic);
      if (!profile) return;
      selectedProfile = profile;
      ctx.applyTactic(profile);
      overlay.querySelectorAll('[data-tactic]').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });
  });

  overlay.querySelector('[data-continue]')?.addEventListener('click', () => {
    overlay.remove();
    ctx.resume();
  });

  document.body.appendChild(overlay);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

import { DraftPlayer, DraftRound } from './DraftTypes';
import { FORMATIONS, FormationDefinition } from '../game/data/TeamFactory';
import { PlayerRole } from '../game/data/PlayerRole';
import { TournamentPlan, TournamentMode, TOURNAMENT_MODES } from './Tournament';
import { GroupPlacement } from './MultiplayerLobby';
import { nationalityFlagCode } from './NationalityFlags';
import { positionLabel } from './PositionLabels';
import { PenaltyResult } from './PenaltySimulator';

// ── Constants ─────────────────────────────────────────────────────────────────

export const SQUAD_TARGETS: Array<{ role: PlayerRole; label: string; target: number }> = [
  { role: PlayerRole.Goalkeeper, label: 'GOL', target: 2 },
  { role: PlayerRole.Defender, label: 'DEF', target: 5 },
  { role: PlayerRole.Midfielder, label: 'MEI', target: 4 },
  { role: PlayerRole.Winger, label: 'ALA', target: 2 },
  { role: PlayerRole.Striker, label: 'ATA', target: 2 },
];

const PREVIEW_FORMATION: FormationDefinition = FORMATIONS[0];

const POSITION_ORDER = ['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'];

const TRAIT_PT_LABELS: Record<string, string> = {
  'Acrobatic':          'Acrobático',
  'Aerial Fortress':    'Fortaleza Aérea',
  'Anticipate':         'Antecipação',
  'Block':              'Bloqueio',
  'Bruiser':            'Brutão',
  'Chip Shot':          'Chapéu',
  'Clinical':           'Finalizador',
  'Cross Claimer':      'Dom. Cruzamentos',
  'Crosser':            'Cruzador',
  'Dead Ball':          'Bola Parada',
  'Deflector':          'Deflector',
  'Enforcer':           'Executor',
  'Far Reach':          'Longo Alcance',
  'Far Throw':          'Arremesso Longo',
  'Finesse Shot':       'Chute com Efeito',
  'First Touch':        '1º Toque',
  'Footwork':           'Pé de Anjo',
  'Gamechanger':        'Decisivo',
  'Incisive Pass':      'Passe Incisivo',
  'Intercept':          'Interceptador',
  'Inventive':          'Inventivo',
  'Jockey':             'Marcação',
  'Long Ball Pass':     'Lançamento',
  'Long Shot':          'Chute de Longe',
  'Long Throw':         'Lateral Longo',
  'Low Driven Shot':    'Chute Rasteiro',
  'Pinged Pass':        'Passe Tenso',
  'Power Shot':         'Chute Potente',
  'Precision Header':   'Cabeceio Preciso',
  'Press Proven':       'Pressão Resistente',
  'Quick Step':         'Arrancada',
  'Rapid':              'Veloz',
  'Relentless':         'Incansável',
  'Rush Out':           'Saída Rápida',
  'Slide Tackle':       'Carrinho',
  'Technical':          'Técnico',
  'Tiki Taka':          'Tiki-Taka',
  'Trickster':          'Driblador',
  'Whipped Pass':       'Passe Forte',
};

const TRAIT_PT_DESCRIPTIONS: Record<string, string> = {
  'Acrobatic':          'Finaliza com chutes acrobáticos em posições difíceis.',
  'Aerial Fortress':    'Domina duelos aéreos e cabeceios defensivos.',
  'Anticipate':         'Lê o jogo e antecipa os movimentos do adversário.',
  'Block':              'Bloqueia chutes e passes com posicionamento preciso.',
  'Bruiser':            'Usa força física para vencer disputas de bola.',
  'Chip Shot':          'Toca por cima do goleiro com precisão e leveza.',
  'Clinical':           'Finaliza com frieza na grande área.',
  'Cross Claimer':      'Goleiro que sai com segurança em cruzamentos.',
  'Crosser':            'Envia cruzamentos precisos e perigosos.',
  'Dead Ball':          'Cobra faltas e escanteios com maior precisão.',
  'Deflector':          'Goleiro que rebate chutes com segurança e controle.',
  'Enforcer':           'Pressiona e marca com intensidade física.',
  'Far Reach':          'Goleiro com maior alcance de defesa e mergulho.',
  'Far Throw':          'Goleiro que distribui a bola com grande distância.',
  'Finesse Shot':       'Finaliza com curva e precisão nos cantos do gol.',
  'First Touch':        'Controla passes difíceis com o primeiro toque.',
  'Footwork':           'Goleiro com habilidade nos pés para sair jogando.',
  'Gamechanger':        'Aparece nos momentos decisivos da partida.',
  'Incisive Pass':      'Envia passes cortantes que rompem linhas defensivas.',
  'Intercept':          'Antecipa passes adversários e recupera a bola.',
  'Inventive':          'Cria jogadas inesperadas e imprevisíveis.',
  'Jockey':             'Pressiona o adversário sem se desequilibrar.',
  'Long Ball Pass':     'Distribui bolas longas com precisão e potência.',
  'Long Shot':          'Chuta de fora da área com precisão e força.',
  'Long Throw':         'Arremessa laterais com grande alcance.',
  'Low Driven Shot':    'Finaliza rasteiro e preciso nos cantos do gol.',
  'Pinged Pass':        'Executa passes curtos e rápidos com boa cadência.',
  'Power Shot':         'Chutes de altíssima potência que surpreendem o goleiro.',
  'Precision Header':   'Direciona cabeceios com grande precisão.',
  'Press Proven':       'Mantém a posse da bola sob pressão intensa.',
  'Quick Step':         'Reage mais rápido na arrancada e ao receber a bola.',
  'Rapid':              'Ganha velocidade extra durante corridas aceleradas.',
  'Relentless':         'Mantém o ritmo alto e recupera energia mais rápido.',
  'Rush Out':           'Goleiro que avança rapidamente para cortar jogadas.',
  'Slide Tackle':       'Realiza carrinhos com precisão e segurança.',
  'Technical':          'Dribla adversários com maior facilidade e controle.',
  'Tiki Taka':          'Troca passes curtos com velocidade e fluidez.',
  'Trickster':          'Usa fintas e dribles especiais para superar adversários.',
  'Whipped Pass':       'Lança cruzamentos e passes com velocidade e efeito.',
};

const IMPLEMENTED_TRAITS = new Set([
  'Rapid', 'Quick Step', 'Relentless', 'Technical', 'First Touch',
  'Incisive Pass', 'Whipped Pass', 'Intercept', 'Jockey', 'Clinical',
  'Long Shot', 'Crosser', 'Far Reach', 'Finesse Shot', 'Bruiser', 'Aerial Fortress', 'Long Ball Pass',
  'Power Shot', 'Low Driven Shot', 'Block', 'Precision Header', 'Enforcer',
]);

// ── Shared utilities ──────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function shortPlayerName(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  return (parts[parts.length - 1] ?? name).slice(0, 8);
}

export function posStringRoleClass(pos: string): string {
  if (pos === 'GK') return 'role-gk';
  if (['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(pos)) return 'role-def';
  if (['LW', 'RW', 'ST', 'CF'].includes(pos)) return 'role-attack';
  return 'role-mid';
}

export function posRoleClass(role: PlayerRole): string {
  switch (role) {
    case PlayerRole.Goalkeeper: return 'role-gk';
    case PlayerRole.Defender: return 'role-def';
    case PlayerRole.Midfielder: return 'role-mid';
    case PlayerRole.Winger:
    case PlayerRole.Striker: return 'role-attack';
  }
}

export function boosterKindLabel(kind: DraftRound['kind']): { tag: string; label: string } {
  if (kind === 'famous-clubs') return { tag: 'Evento raro', label: 'Clubes famosos' };
  if (kind === 'elite') return { tag: 'Evento ultra raro', label: 'Elite 85+' };
  if (kind.startsWith('nationality:')) return { tag: 'Evento raro', label: kind.slice('nationality:'.length) };
  if (kind.startsWith('position:')) return { tag: 'Evento raro', label: kind.slice('position:'.length) };
  return { tag: 'Booster', label: 'Pool completo' };
}

// ── Player card helpers ───────────────────────────────────────────────────────

function cardTierClass(overall: number): string {
  if (overall >= 85) return 'tier-gold';
  if (overall >= 80) return 'tier-silver';
  if (overall >= 70) return 'tier-bronze';
  return 'tier-gray';
}

function statColor(v: number): string {
  if (v >= 85) return '#2dd4bf';
  if (v >= 75) return '#60a5fa';
  if (v >= 60) return '#fb923c';
  return '#f87171';
}

function statBar(label: string, value: number): string {
  return `
    <div class="stat-bar">
      <span>${label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${value}%;--v:${value}"></div></div>
      <b>${value}</b>
    </div>`;
}

function starRating(value: number, max = 5): string {
  const clamped = Math.max(0, Math.min(max, value));
  return '★'.repeat(clamped) + '☆'.repeat(max - clamped);
}

function substatItem(label: string, value: number | string): string {
  return `<div class="substat"><em>${escapeHtml(label)}</em><b>${typeof value === 'number' ? value : escapeHtml(String(value))}</b></div>`;
}

function extraStatsContent(player: DraftPlayer): string {
  const s = player.stats;
  const foot = s.preferredFoot === 2 ? 'Esq' : 'Dir';
  return `
    <div class="substat-grid">
      ${substatItem('Acel', s.acceleration)}
      ${substatItem('V.Máx', s.sprintSpeed)}
      ${substatItem('Agilidade', s.agility)}
      ${substatItem('Finaliz', s.finishing)}
      ${substatItem('Potência', s.shotPower)}
      ${substatItem('L.Alcance', s.longShots)}
      ${substatItem('P.Curto', s.shortPassing)}
      ${substatItem('P.Longo', s.longPassing)}
      ${substatItem('Visão', s.vision)}
      ${substatItem('Intercept', s.interceptions)}
      ${substatItem('Força', s.strength)}
      ${substatItem('Stamina', s.stamina)}
    </div>
    <div class="substat-grid proficiency-row">
      ${substatItem('Habilidades', starRating(s.skillMoves))}
      ${substatItem('Pé Fraco', starRating(s.weakFootAbility))}
      ${substatItem('Pé', foot)}
    </div>
  `;
}

function traitBadges(player: DraftPlayer): string {
  const badges = [
    ...player.playstylesPlus.map(t => ({ name: t, plus: true })),
    ...player.playstyles.map(t => ({ name: t, plus: false })),
  ];
  if (badges.length === 0) return '';
  const spans = badges.map(({ name, plus }) => {
    const label = TRAIT_PT_LABELS[name] ?? name;
    const implemented = IMPLEMENTED_TRAITS.has(name);
    const baseDesc = TRAIT_PT_DESCRIPTIONS[name] ?? '';
    const desc = implemented ? baseDesc : `${baseDesc}${baseDesc ? ' ' : ''}(sem efeito neste jogo)`;
    const tooltip = desc ? ` data-tooltip="${escapeHtml(desc)}"` : '';
    const cls = `trait${plus ? ' is-plus' : ''}${implemented ? '' : ' is-inactive'}`;
    return `<span class="${cls}"${tooltip}><span class="trait-star">★</span> ${escapeHtml(label)}${plus ? '+' : ''}</span>`;
  }).join('');
  return `<div class="trait-row">${spans}</div>`;
}

function isPositionNeeded(player: DraftPlayer, picked: DraftPlayer[]): boolean {
  const target = SQUAD_TARGETS.find((t) => t.role === player.role);
  if (!target) return false;
  const filled = picked.filter((p) =>
    p.role === player.role || p.alternateRoles.includes(player.role),
  ).length;
  return filled < target.target;
}

function playerMeta(player: DraftPlayer, includeTeam = false): string {
  const flagCode = nationalityFlagCode(player.nationality);
  const flag = flagCode
    ? `<img class="flag" src="https://flagcdn.com/20x15/${flagCode}.png" alt="" loading="lazy"> `
    : '';
  const nationality = `${flag}${escapeHtml(player.nationality)}`;
  const team = includeTeam ? `${escapeHtml(player.team)} · ` : '';
  return `${team}${nationality} · ${escapeHtml(player.leagueName)}`;
}

function formatHeight(player: DraftPlayer): string {
  return player.heightCm > 0 ? `${Math.round(player.heightCm)}cm` : '--';
}

function formatWeight(player: DraftPlayer): string {
  return player.weightKg > 0 ? `${Math.round(player.weightKg)}kg` : '--';
}

function roleLabel(role: PlayerRole): string {
  switch (role) {
    case PlayerRole.Goalkeeper: return 'GOL';
    case PlayerRole.Defender: return 'DEF';
    case PlayerRole.Midfielder: return 'MEI';
    case PlayerRole.Winger: return 'ALA';
    case PlayerRole.Striker: return 'ATA';
  }
}

// ── Player card ───────────────────────────────────────────────────────────────

export function playerCard(player: DraftPlayer, picked: DraftPlayer[] = [], index = 0): string {
  const tier = cardTierClass(player.overall);
  const needed = isPositionNeeded(player, picked);
  const fitClass = needed ? 'is-needed' : 'is-full';
  const fitTitle = needed ? 'Posição necessária no elenco' : 'Posição já preenchida';
  const { speed, shooting, passing, dribbling, defending, physical } = player.stats;

  return `
    <div class="card-flip-wrapper ${tier}" style="--i:${index}">
    <button class="player-card ${tier}" data-pick-id="${escapeHtml(player.id)}">
      <div class="card-header-row">
        <div class="card-rating">
          <span class="overall">${player.overall}</span>
          <div class="position-group">
            <span class="position pos-badge ${posStringRoleClass(player.position)}">${escapeHtml(positionLabel(player.position))}</span>
            ${player.alternatePositions.map((pos) => `<span class="position-alt pos-badge ${posStringRoleClass(pos)}">${escapeHtml(positionLabel(pos))}</span>`).join('')}
          </div>
        </div>
        <span class="fit-dot ${fitClass}" title="${fitTitle}"></span>
      </div>
      <strong class="card-name">${escapeHtml(player.name)}</strong>
      <small class="card-club">${escapeHtml(player.team)}</small>
      <span class="meta">${playerMeta(player)}</span>
      <div class="body-row">
        <span>${formatHeight(player)}</span>
        <span>${formatWeight(player)}</span>
      </div>
      <div class="stat-bars">
        ${statBar('PAC', speed)}
        ${statBar('FIN', shooting)}
        ${statBar('PAS', passing)}
        ${statBar('DRI', dribbling)}
        ${statBar('DEF', defending)}
        ${statBar('FIS', physical)}
      </div>
      ${traitBadges(player)}
      <div class="extra-stats" hidden>
        ${extraStatsContent(player)}
      </div>
      <span class="card-details-toggle" data-toggle-details aria-expanded="false">▸ Ver detalhes</span>
    </button>
    </div>
  `;
}

// ── Squad panel helpers ───────────────────────────────────────────────────────

export function pickedPlayerItem(player: DraftPlayer): string {
  const altBadges = (player.alternatePositions ?? [])
    .map((pos) => `<span class="pos-badge pos-badge-sm ${posStringRoleClass(pos)}">${escapeHtml(positionLabel(pos))}</span>`)
    .join('');
  return `
    <li>
      <span>${player.overall}</span>
      <div>
        <strong>${escapeHtml(player.name)}</strong>
        <div class="picked-pos-row">
          <span class="pos-badge pos-badge-sm ${posStringRoleClass(player.position)}">${escapeHtml(positionLabel(player.position))}</span>
          ${altBadges}
        </div>
        <small>${escapeHtml(player.team)} · ${playerMeta(player)}</small>
        ${traitBadges(player)}
      </div>
    </li>
  `;
}

function groupedPickedList(picked: DraftPlayer[]): string {
  if (picked.length === 0) {
    return '<li class="empty-pick"><div><strong>Nenhum jogador ainda</strong><small>Escolha no booster para preencher o elenco.</small></div></li>';
  }
  return SQUAD_TARGETS.flatMap(({ role, label }) => {
    const group = picked.filter((p) => p.role === role);
    if (group.length === 0) return [];
    const header = `<li class="position-group-label"><span class="pg-badge">${label}</span><span class="pg-count">${group.length}</span></li>`;
    return [header, ...group.map(pickedPlayerItem)];
  }).join('');
}

export function positionNeedsView(picked: DraftPlayer[], density: 'normal' | 'compact' = 'normal'): string {
  if (picked.length === 0) return '';
  const className = density === 'compact' ? 'position-needs is-compact' : 'position-needs';

  const counts = new Map<string, number>();
  for (const p of picked) {
    counts.set(p.position, (counts.get(p.position) ?? 0) + 1);
    for (const alt of p.alternatePositions) {
      counts.set(alt, (counts.get(alt) ?? 0) + 1);
    }
  }

  const ordered = [
    ...POSITION_ORDER.filter((pos) => counts.has(pos)),
    ...[...counts.keys()].filter((pos) => !POSITION_ORDER.includes(pos)),
  ];

  return `
    <div class="${className}">
      ${ordered.map((pos) => `
        <span class="is-complete pos-badge ${posStringRoleClass(pos)}">
          <strong>${positionLabel(pos)}</strong>
          <em>${counts.get(pos)}</em>
        </span>
      `).join('')}
    </div>
  `;
}

function pickPreviewPlayer(players: DraftPlayer[], used: Set<string>, role: PlayerRole): DraftPlayer | null {
  const available = players.filter((player) => !used.has(player.id));
  if (available.length === 0) return null;
  return [...available].sort((a, b) => previewFitScore(b, role) - previewFitScore(a, role))[0] ?? null;
}

function previewFitScore(player: DraftPlayer, role: PlayerRole): number {
  const exact = player.role === role ? 160 : 0;
  const close =
    role === PlayerRole.Winger && player.role === PlayerRole.Midfielder ? 45 :
    role === PlayerRole.Midfielder && player.role === PlayerRole.Winger ? 35 :
    role === PlayerRole.Striker && player.role === PlayerRole.Winger ? 25 :
    role === PlayerRole.Defender && player.role === PlayerRole.Midfielder ? 20 :
    0;

  if (role === PlayerRole.Goalkeeper) {
    return exact + player.stats.defending + player.stats.physical * 0.35 + player.overall;
  }
  return exact + close + player.overall + player.stats.intelligence * 0.2;
}

function formationPreview(picked: DraftPlayer[], formation: FormationDefinition): string {
  const used = new Set<string>();
  const slots = formation.slots.map((slot) => {
    const player = pickPreviewPlayer(picked, used, slot.role);
    if (player) used.add(player.id);
    return { ...slot, player };
  });

  return `
    <section class="draft-formation-preview" aria-label="Previa da formacao">
      <header>
        <strong>${formation.name}</strong>
        <span>${slots.filter((slot) => slot.player).length}/11</span>
      </header>
      <div class="draft-mini-pitch">
        ${slots.map((slot) => `
          <div
            class="draft-mini-player ${slot.player ? 'is-filled' : 'is-empty'}"
            style="left: ${(slot.x / 1200) * 100}%; top: ${((slot.y - 76) / (744 - 76)) * 100}%"
          >
            ${slot.player
              ? `<span>${slot.player.overall}</span><strong>${escapeHtml(shortPlayerName(slot.player.name))}</strong>`
              : `<span>${roleLabel(slot.role)}</span><strong>Falta</strong>`}
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

export function squadDraftPanel(picked: DraftPlayer[], title: string): string {
  return `
    <div class="squad-header">
      <h2>${escapeHtml(title)}</h2>
      <span>${picked.length}</span>
    </div>
    ${positionNeedsView(picked)}
    ${formationPreview(picked, PREVIEW_FORMATION)}
    <ol class="picked-list picked-list-large">
      ${groupedPickedList(picked)}
    </ol>
  `;
}

// ── Draft views ───────────────────────────────────────────────────────────────

export function loadingView(): string {
  return `
    <main class="draft-shell">
      <section class="draft-loading">
        <h1>Carregando draft</h1>
        <p>Preparando boosters...</p>
      </section>
    </main>
  `;
}

export function boosterView(round: DraftRound): string {
  const isSpecial = round.kind !== 'normal';
  const specialClass = isSpecial ? 'is-special' : '';
  const { tag, label } = boosterKindLabel(round.kind);
  const total = 15;

  return `
    <div class="round-toolbar ${specialClass}">
      <div>
        <span>${tag}</span>
        <strong>${label}</strong>
      </div>
      <div class="round-progress">
        <span class="round-label">Rodada ${round.number}/${total}</span>
        <div class="round-dots">
          ${Array.from({ length: total }, (_, i) => {
            const cls = i < round.number - 1 ? 'is-done' : i === round.number - 1 ? 'is-current' : '';
            return `<span class="round-dot ${cls}"></span>`;
          }).join('')}
        </div>
      </div>
      <button class="reroll-button" data-action="reroll" ${round.rerollsLeft <= 0 ? 'disabled' : ''}>
        Reroll (${round.rerollsLeft})
      </button>
    </div>

    <div class="booster-grid">
      ${round.players.map((player, i) => playerCard(player, round.picked, i)).join('')}
    </div>
  `;
}

export function completeView(picked: DraftPlayer[]): string {
  const avg = Math.round(picked.reduce((sum, player) => sum + player.overall, 0) / picked.length);
  const best = [...picked].sort((a, b) => b.overall - a.overall).slice(0, 3);

  return `
    <section class="draft-complete">
      <div>
        <span>OVR médio</span>
        <strong>${avg}</strong>
      </div>
      <div>
        <span>Destaques</span>
        <p>${best.map((player) => player.name).join(', ')}</p>
      </div>
      <div class="complete-actions">
        <button class="ghost-button" data-action="view-table">Ver Tabela</button>
        <button class="start-button" data-action="start-match">Começar partida</button>
      </div>
    </section>
  `;
}

export function openingOpponentName(tournament: TournamentPlan): string {
  const ownTeam = tournament.competitors.find((team) => team.kind === 'player') ?? tournament.competitors[0];
  const opening = tournament.openingMatch;
  return opening.home.id === ownTeam.id ? opening.away.name : opening.home.name;
}

export function openingOpponentNameFor(tournament: TournamentPlan, playerIndex: number): string {
  const ownTeam = tournament.competitors[playerIndex] ?? tournament.competitors[0];
  const ownMatch = tournament.matches.find((match) => (
    match.home.id === ownTeam.id || match.away.id === ownTeam.id
  )) ?? tournament.openingMatch;
  return ownMatch.home.id === ownTeam.id ? ownMatch.away.name : ownMatch.home.name;
}

export function draftView(round: DraftRound, tournament: TournamentPlan): string {
  const pickedCount = round.picked.length;
  const totalPicks = 15;

  return `
    <main class="draft-shell">
      <section class="draft-board">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">${escapeHtml(tournament.title)} / ${round.isComplete ? 'Elenco completo' : round.title}</p>
            <h1>Draft do elenco</h1>
            <p class="match-context">Estreia contra ${escapeHtml(openingOpponentName(tournament))}</p>
          </div>
          <div class="draft-meter">
            <span>${pickedCount}/${totalPicks}</span>
            <div class="draft-progress" aria-hidden="true">
              <div style="width: ${(pickedCount / totalPicks) * 100}%"></div>
            </div>
          </div>
        </header>

        ${round.isComplete ? completeView(round.picked) : boosterView(round)}
      </section>

      <aside class="squad-panel">
        <div class="tournament-mini">
          <span>${escapeHtml(tournament.subtitle)}</span>
          <strong>${tournament.competitors.filter((team) => team.kind === 'player').length} humanos / ${tournament.competitors.filter((team) => team.kind === 'bot').length} bots</strong>
        </div>
        ${squadDraftPanel(round.picked, 'Escolhidos')}
      </aside>
    </main>
  `;
}

export function tournamentSetupView(
  mode: TournamentMode,
  playerCount: number,
  names: string[],
  plan: TournamentPlan,
  groupPlacement: GroupPlacement = 'separated',
): string {
  return `
    <main class="tournament-shell">
      <section class="tournament-main">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">Novo campeonato</p>
            <h1>Criar campeonato</h1>
          </div>
          <button class="start-button tournament-start" data-action="create-tournament">Ir para o draft</button>
        </header>

        <div class="option-group">
          <p class="option-group-label">Formato</p>
          <div class="mode-grid">
            ${Object.entries(TOURNAMENT_MODES).map(([key, option]) => `
              <button class="mode-card ${key === mode ? 'is-active' : ''}" data-mode="${key}">
                <span class="mode-card-radio"></span>
                <strong>${escapeHtml(option.title)}</strong>
                <span>${escapeHtml(option.subtitle)}</span>
              </button>
            `).join('')}
          </div>
        </div>

        <div class="option-group">
          <p class="option-group-label">Posicionamento nos grupos</p>
          <div class="visibility-grid">
            <button class="mode-card ${groupPlacement === 'separated' ? 'is-active' : ''}" data-placement="separated">
              <span class="mode-card-radio"></span>
              <strong>Grupos separados</strong>
              <span>Participantes distribuidos em grupos distintos — so se enfrentam nas quartas ou depois.</span>
            </button>
            <button class="mode-card ${groupPlacement === 'random' ? 'is-active' : ''}" data-placement="random">
              <span class="mode-card-radio"></span>
              <strong>Grupos aleatorios</strong>
              <span>Posicoes totalmente sortadas — participantes podem cair no mesmo grupo.</span>
            </button>
          </div>
        </div>

        <section class="player-count-panel">
          <label>
            Jogadores humanos
            <input data-player-count type="number" min="0" max="16" value="${playerCount}">
          </label>
          <p>O campeonato fecha sempre com 16 times. As vagas vazias viram bots automaticamente.</p>
        </section>

        <div class="name-grid">
          ${Array.from({ length: playerCount }, (_, index) => `
            <label>
              Time ${index + 1}
              <input data-player-name="${index}" value="${escapeHtml(names[index] ?? `Jogador ${index + 1}`)}">
            </label>
          `).join('')}
        </div>
      </section>

      <aside class="squad-panel">
        <div class="squad-header">
          <h2>Participantes</h2>
          <span>16</span>
        </div>
        <ol class="picked-list tournament-list">
          ${plan.competitors.map((team) => `
            <li>
              <span>${team.seed}</span>
              <div>
                <strong>${escapeHtml(team.name)}</strong>
                <small>${team.kind === 'player' ? 'Jogador' : 'Bot'}</small>
              </div>
            </li>
          `).join('')}
        </ol>
      </aside>
    </main>
  `;
}

// ── Penalty screen view ───────────────────────────────────────────────────────

export function penaltyScreenView(
  userName: string,
  botName: string,
  drawScore: number,
  result: PenaltyResult,
): string {
  const kickLine = (kick: { name: string; scored: boolean }, index: number): string => `
    <div class="pen-kick ${kick.scored ? 'pen-scored' : 'pen-missed'}">
      <span class="pen-index">${index + 1}</span>
      <span class="pen-dot">${kick.scored ? '●' : '○'}</span>
      <span class="pen-name">${escapeHtml(kick.name)}</span>
    </div>
  `;

  const isSuddenDeath = result.userKicks.length > 5;
  const verdict = result.userWins ? 'Você venceu nos pênaltis!' : 'Eliminado nos pênaltis';
  const verdictClass = result.userWins ? 'pen-win' : 'pen-loss';

  return `
    <main class="draft-shell penalty-screen">
      <section class="draft-board">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">Disputa de Pênaltis${isSuddenDeath ? ' · Morte Súbita' : ''}</p>
            <h1>${drawScore}–${drawScore} após 90 min</h1>
          </div>
          <div class="penalty-verdict-header ${verdictClass}">${escapeHtml(verdict)}</div>
        </header>

        <div class="penalty-board">
          <div class="penalty-col">
            <h2 class="penalty-team-name">${escapeHtml(userName)}</h2>
            <div class="penalty-kicks">${result.userKicks.map(kickLine).join('')}</div>
            <div class="penalty-subtotal">${result.userScore}</div>
          </div>

          <div class="penalty-center">
            <div class="penalty-total-score">${result.userScore}–${result.botScore}</div>
          </div>

          <div class="penalty-col penalty-col-right">
            <h2 class="penalty-team-name">${escapeHtml(botName)}</h2>
            <div class="penalty-kicks">${result.botKicks.map(kickLine).join('')}</div>
            <div class="penalty-subtotal">${result.botScore}</div>
          </div>
        </div>

        <div class="complete-actions" style="margin-top:32px">
          <button class="start-button" data-action="continue-penalty">Continuar</button>
        </div>
      </section>
    </main>
  `;
}

import {
  TournamentState,
  TournamentMatch,
  GroupStanding,
  PlayerTournamentStats,
  computeGroupStandings,
  getNextUserMatch,
  getTournamentChampion,
  isTournamentComplete,
  isUserEliminated,
} from './Tournament';

export function renderTournamentTable(
  root: HTMLDivElement,
  state: TournamentState,
  onPlayNext: (match: TournamentMatch) => void,
  onBack?: () => void,
  options: { canPlayNext?: boolean } = {},
): void {
  root.innerHTML = tableView(state, onBack !== undefined, options.canPlayNext ?? true);
  if (!(options.canPlayNext ?? true)) {
    root.querySelector<HTMLButtonElement>('[data-action="play-next"]')?.replaceWith(
      Object.assign(document.createElement('span'), {
        className: 'draft-kicker',
        textContent: 'Aguardando o host iniciar a proxima partida',
      }),
    );
  }

  const nextMatch = getNextUserMatch(state);
  root.querySelector<HTMLButtonElement>('[data-action="play-next"]')?.addEventListener('click', () => {
    if (nextMatch && (options.canPlayNext ?? true)) onPlayNext(nextMatch);
  });
  root.querySelector<HTMLButtonElement>('[data-action="back-draft"]')?.addEventListener('click', () => {
    onBack?.();
  });
}

function tableView(state: TournamentState, showBack: boolean, canPlayNext: boolean): string {
  const nextMatch = getNextUserMatch(state);
  const complete = isTournamentComplete(state);
  const eliminated = !complete && isUserEliminated(state);
  const champion = complete ? getTournamentChampion(state) : null;
  const isChampions = state.plan.mode === 'champions-16';

  const headerRight = nextMatch
    ? '<button class="start-button tournament-start" data-action="play-next">Jogar próxima partida</button>'
    : complete
      ? `<span class="draft-kicker champion-label">Campeao: <strong>${escapeHtml(champion?.name ?? '')}</strong>${champion?.kind === 'player' ? ' — Voce!' : ''}</span>`
      : eliminated
        ? '<span class="draft-kicker eliminated-label">Voce foi eliminado — aguardando final...</span>'
        : '<span class="draft-kicker">Aguardando proxima fase...</span>';

  return `
    <main class="tournament-shell">
      <section class="tournament-main">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">${escapeHtml(state.plan.title)}</p>
            <h1>Tabela</h1>
          </div>
          <div style="display:flex;gap:10px;align-items:center">
            ${showBack ? '<button class="ghost-button" data-action="back-draft">Voltar ao Draft</button>' : ''}
            ${headerRight}
          </div>
        </header>

        ${nextMatch ? matchdaySchedule(state, nextMatch) : ''}
        ${isChampions ? championsTable(state) : knockoutTable(state)}
      </section>

      <aside class="squad-panel">
        ${nextMatch
          ? nextMatchPanel(nextMatch)
          : complete
            ? championPanel(champion)
            : eliminated
              ? eliminatedPanel(state)
              : '<p class="draft-kicker" style="padding:16px">Aguardando outros jogos...</p>'}
        ${topScorersPanel(state)}
      </aside>
    </main>
  `;
}

function matchdaySchedule(state: TournamentState, nextMatch: TournamentMatch | null): string {
  if (!nextMatch) return '';

  const round = nextMatch.round;
  const userOrder = nextMatch.matchdayOrder;
  const allRoundMatches = state.plan.matches
    .filter((m) => m.round === round)
    .sort((a, b) => a.matchdayOrder - b.matchdayOrder);

  const items = allRoundMatches.map((m) => {
    const result = state.results[m.id];
    const isUser = m.id === nextMatch.id;
    const isPast = m.matchdayOrder < userOrder && result;
    const isFuture = m.matchdayOrder > userOrder && !result;

    let statusClass = '';
    if (isUser) statusClass = 'schedule-user';
    else if (isPast) statusClass = 'schedule-done';
    else if (isFuture) statusClass = 'schedule-future';

    const scoreStr = result
      ? `<strong>${result.scoreHome}–${result.scoreAway}</strong>`
      : '<span class="schedule-vs">vs</span>';

    return `
      <div class="schedule-item ${statusClass}">
        <span class="schedule-order">${m.matchdayOrder}</span>
        <span class="schedule-home">${escapeHtml(m.home.name)}</span>
        ${scoreStr}
        <span class="schedule-away">${escapeHtml(m.away.name)}</span>
        ${isUser ? '<span class="schedule-badge">Seu jogo</span>' : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="matchday-schedule">
      <h2 class="group-title">Rodada ${round} — Programação</h2>
      <div class="schedule-list">${items}</div>
    </div>
  `;
}

function championsTable(state: TournamentState): string {
  const groups = ['Grupo A', 'Grupo B', 'Grupo C', 'Grupo D'];
  const groupHtml = groups.map((stage, groupIndex) => {
    const start = groupIndex * 4;
    const competitors = state.plan.competitors.slice(start, start + 4);
    const standings = computeGroupStandings(stage, competitors, state);
    const matches = state.plan.matches.filter((m) => m.stage === stage);
    return groupSection(stage, standings, matches, state);
  }).join('');

  return groupHtml + knockoutTable(state);
}

function groupSection(
  stage: string,
  standings: GroupStanding[],
  matches: TournamentMatch[],
  state: TournamentState,
): string {
  return `
    <div class="tournament-group">
      <h2 class="group-title">${escapeHtml(stage)}</h2>
      <table class="standings-table">
        <thead>
          <tr>
            <th class="col-name">Time</th>
            <th>PJ</th><th>V</th><th>E</th><th>D</th>
            <th>GP</th><th>GC</th><th>SG</th><th class="col-pts">PTS</th>
          </tr>
        </thead>
        <tbody>
          ${standings.map((row, i) => standingRow(row, i < 2)).join('')}
        </tbody>
      </table>
      <div class="group-results">
        ${matches
          .slice()
          .sort((a, b) => a.round - b.round || a.matchdayOrder - b.matchdayOrder)
          .map((m) => matchResultLine(m, state))
          .join('')}
      </div>
    </div>
  `;
}

function standingRow(row: GroupStanding, qualifies: boolean): string {
  const isPlayer = row.competitor.kind === 'player';
  return `
    <tr class="${qualifies ? 'qualifies' : ''} ${isPlayer ? 'is-player-row' : ''}">
      <td class="col-name">
        ${escapeHtml(row.competitor.name)}
        ${isPlayer ? '<span class="you-badge">Você</span>' : ''}
        <small class="ovr-inline">${row.competitor.overall}</small>
      </td>
      <td>${row.played}</td>
      <td>${row.won}</td>
      <td>${row.drawn}</td>
      <td>${row.lost}</td>
      <td>${row.goalsFor}</td>
      <td>${row.goalsAgainst}</td>
      <td>${row.goalDiff >= 0 ? '+' : ''}${row.goalDiff}</td>
      <td class="col-pts"><strong>${row.points}</strong></td>
    </tr>
  `;
}

function matchResultLine(match: TournamentMatch, state: TournamentState): string {
  const result = state.results[match.id];
  const roundLabel = `R${match.round}`;
  if (!result) {
    return `<span class="result-line result-pending">${roundLabel}: ${escapeHtml(match.home.name)} vs ${escapeHtml(match.away.name)}</span>`;
  }
  const isPlayer = match.home.kind === 'player' || match.away.kind === 'player';
  if (result.penaltiesHome !== undefined && result.penaltiesAway !== undefined) {
    return `<span class="result-line ${isPlayer ? 'result-player' : ''}">${roundLabel}: ${escapeHtml(match.home.name)} ${result.scoreHome}-${result.scoreAway} (${result.penaltiesHome}-${result.penaltiesAway} pen.) ${escapeHtml(match.away.name)}</span>`;
  }
  return `<span class="result-line ${isPlayer ? 'result-player' : ''}">${roundLabel}: ${escapeHtml(match.home.name)} ${result.scoreHome}–${result.scoreAway} ${escapeHtml(match.away.name)}</span>`;
}

const KNOCKOUT_STAGE_ORDER = ['Oitavas', 'Quartas', 'Semi', 'Final'];

function knockoutTable(state: TournamentState): string {
  const presentStages = KNOCKOUT_STAGE_ORDER.filter(
    (stage) => state.plan.matches.some((m) => m.stage === stage),
  );

  if (presentStages.length === 0) return '';

  return presentStages.map((stage) => {
    const matches = state.plan.matches
      .filter((m) => m.stage === stage)
      .sort((a, b) => a.matchdayOrder - b.matchdayOrder);
    return `
      <div class="tournament-group">
        <h2 class="group-title">${escapeHtml(stage)}</h2>
        <div class="group-results knockout-results">
          ${matches.map((m) => matchResultLine(m, state)).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function eliminatedPanel(state: TournamentState): string {
  const knockoutStages = ['Oitavas', 'Quartas', 'Semi', 'Final'];
  const lastUserMatch = [...state.plan.matches]
    .filter((m) => knockoutStages.includes(m.stage)
      && (m.home.kind === 'player' || m.away.kind === 'player')
      && state.results[m.id])
    .pop();

  const result = lastUserMatch ? state.results[lastUserMatch.id] : null;
  const userIsHome = lastUserMatch?.home.kind === 'player';
  const opponentName = userIsHome ? lastUserMatch?.away.name : lastUserMatch?.home.name;
  const scoreStr = result
    ? `${result.scoreHome}–${result.scoreAway}`
    : '';

  return `
    <div class="next-match-panel">
      <p class="draft-kicker">Eliminado em ${escapeHtml(lastUserMatch?.stage ?? 'knockout')}</p>
      <h2>Voce foi eliminado</h2>
      ${lastUserMatch && result ? `
        <div class="next-match-vs">
          <span class="team-entry">Derrota para ${escapeHtml(opponentName ?? '')}</span>
          <span class="vs-divider">${escapeHtml(scoreStr)}</span>
        </div>
      ` : ''}
      <p style="margin-top:12px;color:var(--text-muted)">O torneio continua sem voce. Acompanhe o bracket ao lado.</p>
    </div>
  `;
}

function championPanel(champion: ReturnType<typeof getTournamentChampion>): string {
  if (!champion) return '<p class="draft-kicker" style="padding:16px">Torneio concluido</p>';
  return `
    <div class="next-match-panel">
      <p class="draft-kicker">Torneio encerrado</p>
      <h2>Campeao</h2>
      <div class="next-match-vs">
        <span class="team-entry ${champion.kind === 'player' ? 'is-player' : ''}">
          ${escapeHtml(champion.name)}
          <small class="ovr-inline">${champion.overall} OVR</small>
        </span>
      </div>
      ${champion.kind === 'player' ? '<p style="margin-top:12px;font-weight:600">Voce é o campeao!</p>' : ''}
    </div>
  `;
}

function nextMatchPanel(match: TournamentMatch): string {
  const userIsHome = match.home.kind === 'player';
  const user = userIsHome ? match.home : match.away;
  const opponent = userIsHome ? match.away : match.home;
  const ovrDiff = user.overall - opponent.overall;
  const diffLabel = ovrDiff > 0 ? `+${ovrDiff}` : `${ovrDiff}`;
  const diffClass = ovrDiff > 0 ? 'ovr-favor' : ovrDiff < 0 ? 'ovr-against' : 'ovr-even';
  return `
    <div class="next-match-panel">
      <p class="draft-kicker">${escapeHtml(match.stage)} · Rodada ${match.round} · Jogo ${match.matchdayOrder} do dia</p>
      <h2>Próxima partida</h2>
      <div class="next-match-vs">
        <span class="team-entry ${userIsHome ? 'is-player' : ''}">
          ${escapeHtml(user.name)}
          <small class="ovr-inline">${user.overall}</small>
        </span>
        <span class="vs-divider">
          vs
          <small class="${diffClass}">${ovrDiff !== 0 ? diffLabel + ' OVR' : 'igual'}</small>
        </span>
        <span class="team-entry ${!userIsHome ? 'is-player' : ''}">
          ${escapeHtml(opponent.name)}
          <small class="ovr-inline">${opponent.overall}</small>
        </span>
      </div>
    </div>
  `;
}

function topScorersPanel(state: TournamentState): string {
  const stats = state.playerStats;
  if (!stats) return '';

  const entries = Object.entries(stats) as [string, PlayerTournamentStats][];
  if (entries.length === 0) return '';

  const scorers = entries
    .filter(([, s]) => s.goals > 0)
    .sort(([, a], [, b]) => b.goals - a.goals || b.assists - a.assists)
    .slice(0, 7);

  const assisters = entries
    .filter(([, s]) => s.assists > 0)
    .sort(([, a], [, b]) => b.assists - a.assists || b.goals - a.goals)
    .slice(0, 5);

  if (scorers.length === 0 && assisters.length === 0) return '';

  const scorerRows = scorers.map(([, s], i) => `
    <tr>
      <td class="col-rank">${i + 1}</td>
      <td class="col-name">${escapeHtml(s.playerName)}<small class="ovr-inline" style="display:block">${escapeHtml(s.teamName)}</small></td>
      <td class="col-pts"><strong>${s.goals}</strong></td>
      <td>${s.assists}</td>
    </tr>
  `).join('');

  const assisterRows = assisters.map(([, s], i) => `
    <tr>
      <td class="col-rank">${i + 1}</td>
      <td class="col-name">${escapeHtml(s.playerName)}<small class="ovr-inline" style="display:block">${escapeHtml(s.teamName)}</small></td>
      <td class="col-pts"><strong>${s.assists}</strong></td>
      <td>${s.goals}</td>
    </tr>
  `).join('');

  return `
    <div class="next-match-panel" style="margin-top:16px">
      <p class="draft-kicker">Estatisticas</p>
      <h2>Artilheiros</h2>
      ${scorers.length > 0 ? `
        <table class="standings-table" style="margin-top:8px">
          <thead><tr><th class="col-rank">#</th><th class="col-name">Jogador</th><th class="col-pts">Gols</th><th>Ast</th></tr></thead>
          <tbody>${scorerRows}</tbody>
        </table>
      ` : '<p class="draft-kicker" style="margin-top:8px">Nenhum gol registrado ainda</p>'}
      ${assisters.length > 0 ? `
        <h2 style="margin-top:16px">Garçons</h2>
        <table class="standings-table" style="margin-top:8px">
          <thead><tr><th class="col-rank">#</th><th class="col-name">Jogador</th><th class="col-pts">Ast</th><th>Gols</th></tr></thead>
          <tbody>${assisterRows}</tbody>
        </table>
      ` : ''}
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

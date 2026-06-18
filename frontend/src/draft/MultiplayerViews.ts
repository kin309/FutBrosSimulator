import {
  LobbyPlayer,
  LobbySettings,
  MultiplayerDraftState,
  MultiplayerDraftTeam,
  MultiplayerMatchState,
  MultiplayerMatchLiveState,
} from './MultiplayerLobby';
import { KitPattern } from '../game/data/TeamFactory';
import { TournamentPlan, TournamentMatch, TOURNAMENT_MODES } from './Tournament';
import { DraftPlayer } from './DraftTypes';
import {
  escapeHtml,
  shortPlayerName,
  posStringRoleClass,
  positionNeedsView,
  squadDraftPanel,
  boosterKindLabel,
  playerCard,
  completeView,
  openingOpponentNameFor,
} from './DraftViews';
import { positionLabel } from './PositionLabels';

// ── Kit helpers ───────────────────────────────────────────────────────────────

export function lobbyHexColor(color: number | undefined): string {
  return `#${(color ?? 0x3b82f6).toString(16).padStart(6, '0')}`;
}

export const KIT_PATTERN_LABELS: Record<KitPattern, string> = {
  solid:       'Sólida',
  'stripes-h': 'Listras H',
  'stripes-v': 'Listras V',
  checkered:   'Xadrez',
  sash:        'Faixa',
};

export function kitPatternBg(pattern: KitPattern, primary: string, secondary: string): string {
  switch (pattern) {
    case 'stripes-h':
      return `repeating-linear-gradient(0deg,${primary} 0px,${primary} 7px,${secondary} 7px,${secondary} 14px)`;
    case 'stripes-v':
      return `repeating-linear-gradient(90deg,${primary} 0px,${primary} 7px,${secondary} 7px,${secondary} 14px)`;
    case 'checkered':
      return `linear-gradient(45deg,${secondary} 25%,transparent 25%,transparent 75%,${secondary} 75%) 0 0/18px 18px,`
           + `linear-gradient(45deg,${secondary} 25%,transparent 25%,transparent 75%,${secondary} 75%) 9px 9px/18px 18px,`
           + primary;
    case 'sash':
      return `linear-gradient(135deg,${primary} 35%,${secondary} 35%,${secondary} 65%,${primary} 65%)`;
    default:
      return primary;
  }
}

// ── Lobby views ───────────────────────────────────────────────────────────────

interface MultiplayerHostSaveSnippet {
  roomCode: string;
}

interface MultiplayerReturnInviteSnippet {
  hostName: string;
}

export function lobbyHomeView(
  playerName: string,
  joinCode: string,
  hasSave = false,
  hostSave: MultiplayerHostSaveSnippet | null = null,
  invite: MultiplayerReturnInviteSnippet | null = null,
): string {
  return `
    <main class="tournament-shell">
      <section class="tournament-main">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">Multiplayer</p>
            <h1>Lobby</h1>
          </div>
        </header>

        <section class="player-count-panel">
          <label>
            Seu nome
            <input data-player-display value="${escapeHtml(playerName)}">
          </label>
          <p>Crie uma sala ou entre com o codigo. Cada dispositivo conectado vira um jogador humano no campeonato.</p>
        </section>

        ${hasSave ? `
        <div class="resume-banner">
          <span>Campeonato em andamento</span>
          <button class="start-button" data-action="resume-save">Continuar campeonato</button>
        </div>
        ` : ''}

        ${hostSave ? `
        <div class="resume-banner">
          <span>Sala multiplayer salva: ${escapeHtml(hostSave.roomCode)}</span>
          <button class="start-button" data-action="resume-multiplayer-host">Reabrir campeonato</button>
        </div>
        ` : ''}

        ${invite && !hostSave ? `
        <div class="resume-banner">
          <span>${escapeHtml(invite.hostName)} reabre esta sala como host</span>
          <button class="start-button" data-action="join-host-resume">Entrar na partida do host</button>
        </div>
        ` : ''}

        <div class="lobby-actions-grid">
          <button class="mode-card lobby-action-card" data-action="create-room">
            <strong>Criar Novo Jogo</strong>
            <span>Cria uma nova sala de jogo como anfitrião.</span>
          </button>
          <div class="join-card">
            <label>
              Entrar por código
              <input data-join-code value="${escapeHtml(joinCode)}" maxlength="8" placeholder="ABC123">
            </label>
            <button class="start-button" data-action="join-room">Entrar</button>
          </div>
        </div>
      </section>

      <aside class="squad-panel">
        <div class="tournament-mini">
          <span>Multiplayer real</span>
          <strong>Compartilhe o codigo da sala e jogue de qualquer dispositivo ou navegador.</strong>
        </div>
      </aside>
    </main>
  `;
}

export function lobbyWaitingView(roomCode: string): string {
  return `
    <main class="tournament-shell">
      <section class="draft-loading">
        <p class="draft-kicker">Sala ${escapeHtml(roomCode)}</p>
        <h1>Conectando...</h1>
        <p>Aguardando resposta do host.</p>
      </section>
    </main>
  `;
}

export function lobbyRoomView(
  roomCode: string,
  localPlayerId: string,
  isHost: boolean,
  players: LobbyPlayer[],
  settings: LobbySettings,
  plan: TournamentPlan,
): string {
  const localPlayer = players.find((player) => player.id === localPlayerId) ?? players[0];
  const onlineCount = players.filter((player) => player.isConnected !== false).length;

  return `
    <main class="tournament-shell">
      <section class="tournament-main">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">Sala ${escapeHtml(roomCode)}</p>
            <h1>Lobby multiplayer</h1>
            <p class="match-context">${onlineCount}/${players.length} humano${players.length === 1 ? '' : 's'} online / ${16 - players.length} bots</p>
          </div>
          <button class="start-button tournament-start" data-action="start-multiplayer-draft" ${isHost ? '' : 'disabled'}>
            Iniciar draft
          </button>
        </header>

        <section class="player-count-panel">
          <div class="lobby-identity-row">
            <label>
              Seu nome
              <input data-local-name value="${escapeHtml(localPlayer?.name ?? 'Jogador')}">
            </label>
          </div>
          <div class="kit-section">
            <div class="kit-section-header">
              <h2>Camisa</h2>
              <div class="kit-preview-circle" style="background: ${kitPatternBg(localPlayer?.kitColors?.pattern ?? 'solid', lobbyHexColor(localPlayer?.kitColors?.primary), lobbyHexColor(localPlayer?.kitColors?.secondary ?? 0x000000))}; border-color: ${lobbyHexColor(localPlayer?.kitColors?.secondary ?? 0x000000)}">
                <span style="color: ${lobbyHexColor(localPlayer?.kitColors?.numberColor ?? 0xffffff)}">10</span>
              </div>
            </div>
            <div class="kit-colors">
              <label class="kit-color-label">
                <span>Primária</span>
                <input type="color" data-kit-color="primary" value="${lobbyHexColor(localPlayer?.kitColors?.primary)}">
              </label>
              <label class="kit-color-label">
                <span>Secundária</span>
                <input type="color" data-kit-color="secondary" value="${lobbyHexColor(localPlayer?.kitColors?.secondary ?? 0x000000)}">
              </label>
              <label class="kit-color-label">
                <span>Número</span>
                <input type="color" data-kit-color="numberColor" value="${lobbyHexColor(localPlayer?.kitColors?.numberColor ?? 0xffffff)}">
              </label>
            </div>
            <div class="kit-symbol-row">
              <span class="kit-symbol-label">Estampa</span>
              <div class="kit-symbol-btns">
                ${(['solid', 'stripes-h', 'stripes-v', 'checkered', 'sash'] as KitPattern[]).map((p) => `
                  <button class="kit-symbol-btn ${(localPlayer?.kitColors?.pattern ?? 'solid') === p ? 'is-active' : ''}"
                    data-kit-pattern="${p}"
                    title="${KIT_PATTERN_LABELS[p]}"
                    style="background: ${kitPatternBg(p, lobbyHexColor(localPlayer?.kitColors?.primary), lobbyHexColor(localPlayer?.kitColors?.secondary ?? 0x000000))}">
                  </button>
                `).join('')}
              </div>
            </div>
          </div>
          <p>${isHost ? 'Voce e o host. Ajuste o modo e comece quando todos entrarem ou voltarem.' : 'Aguardando o host iniciar ou retomar o campeonato.'}</p>
        </section>

        <div class="option-group">
          <p class="option-group-label">Formato</p>
          <div class="mode-grid">
            ${Object.entries(TOURNAMENT_MODES).map(([key, option]) => `
              <button class="mode-card ${key === settings.mode ? 'is-active' : ''}" data-mode="${key}" ${isHost ? '' : 'disabled'}>
                <span class="mode-card-radio"></span>
                <strong>${escapeHtml(option.title)}</strong>
                <span>${escapeHtml(option.subtitle)}</span>
              </button>
            `).join('')}
          </div>
        </div>

        <div class="option-group">
          <p class="option-group-label">Visibilidade do draft</p>
          <div class="visibility-grid">
            <button class="mode-card ${settings.visibility === 'public' ? 'is-active' : ''}" data-visibility="public" ${isHost ? '' : 'disabled'}>
              <span class="mode-card-radio"></span>
              <strong>Picks abertos</strong>
              <span>Todos veem os elencos sendo montados em tempo real.</span>
            </button>
            <button class="mode-card ${settings.visibility === 'hidden' ? 'is-active' : ''}" data-visibility="hidden" ${isHost ? '' : 'disabled'}>
              <span class="mode-card-radio"></span>
              <strong>Hidden picks</strong>
              <span>Durante o draft, cada jogador ve apenas as proprias escolhas.</span>
            </button>
          </div>
        </div>

        <div class="option-group">
          <p class="option-group-label">Posicionamento nos grupos</p>
          <div class="visibility-grid">
            <button class="mode-card ${(settings.groupPlacement ?? 'separated') === 'separated' ? 'is-active' : ''}" data-placement="separated" ${isHost ? '' : 'disabled'}>
              <span class="mode-card-radio"></span>
              <strong>Grupos separados</strong>
              <span>Humanos distribuidos em grupos distintos — so se enfrentam nas quartas ou depois.</span>
            </button>
            <button class="mode-card ${settings.groupPlacement === 'random' ? 'is-active' : ''}" data-placement="random" ${isHost ? '' : 'disabled'}>
              <span class="mode-card-radio"></span>
              <strong>Grupos aleatorios</strong>
              <span>Posicoes totalmente sortadas — humanos podem cair no mesmo grupo.</span>
            </button>
          </div>
        </div>
      </section>

      <aside class="squad-panel">
        <div class="room-code-block">
          <span class="room-code-label">Codigo da sala</span>
          <strong class="room-code-value" id="room-code-display">${escapeHtml(roomCode)}</strong>
          <button class="copy-code-button" data-action="copy-code" data-code="${escapeHtml(roomCode)}">Copiar</button>
        </div>
        <div class="squad-header">
          <h2>Jogadores</h2>
          <span>${onlineCount}</span>
        </div>
        <ol class="picked-list tournament-list">
          ${players.map((player, index) => `
            <li>
              <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${lobbyHexColor(player.kitColors?.primary)};flex-shrink:0"></span>
              <div>
                <strong>${escapeHtml(player.name)}</strong>
                <small>${player.isHost ? 'Host' : 'Jogador'} / ${player.isConnected === false ? 'aguardando retorno' : 'online'} / ${plan.competitors[index]?.name ? 'Humano' : 'Bot'}</small>
              </div>
            </li>
          `).join('')}
        </ol>
      </aside>
    </main>
  `;
}

// ── Multiplayer draft views ───────────────────────────────────────────────────

export function multiplayerLocalRenderKey(
  state: MultiplayerDraftState,
  localTeam: MultiplayerDraftTeam,
): string {
  return JSON.stringify({
    roomCode: state.roomCode,
    mode: state.settings.mode,
    groupPlacement: state.settings.groupPlacement,
    playerName: localTeam.playerName,
    picked: localTeam.picked.map((player) => player.id),
    currentPlayers: localTeam.currentPlayers.map((player) => player.id),
    currentKind: localTeam.currentKind,
    titleRound: localTeam.title,
    rerollsLeft: localTeam.rerollsLeft,
    isComplete: localTeam.isComplete,
    hasPickedThisRound: localTeam.hasPickedThisRound,
  });
}

export function multiplayerBoosterView(team: MultiplayerDraftTeam): string {
  const isSpecial = team.currentKind !== 'normal';
  const specialClass = isSpecial ? 'is-special' : '';
  const { tag, label } = boosterKindLabel(team.currentKind);
  const total = 15;
  const roundNumber = team.picked.length + 1;

  return `
    <div class="round-toolbar ${specialClass}">
      <div>
        <span>${tag}</span>
        <strong>${label}</strong>
      </div>
      <div class="round-progress">
        <span class="round-label">Rodada ${roundNumber}/${total}</span>
        <div class="round-dots">
          ${Array.from({ length: total }, (_, i) => {
            const cls = i < roundNumber - 1 ? 'is-done' : i === roundNumber - 1 ? 'is-current' : '';
            return `<span class="round-dot ${cls}"></span>`;
          }).join('')}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div data-draft-countdown style="
          display:flex;align-items:center;justify-content:center;
          min-width:52px;height:36px;padding:0 10px;
          background:#78350f;border:2px solid #f59e0b;border-radius:8px;
          font-size:18px;font-weight:800;color:#fde68a;letter-spacing:1px;
          font-variant-numeric:tabular-nums;
        ">30s</div>
        <button class="reroll-button" data-action="reroll" ${team.rerollsLeft <= 0 ? 'disabled' : ''}>
          Reroll (${team.rerollsLeft})
        </button>
      </div>
    </div>

    <div class="booster-grid">
      ${team.currentPlayers.map((player, i) => playerCard(player, team.picked, i)).join('')}
    </div>
  `;
}

export function waitingForOthersView(teams: MultiplayerDraftTeam[]): string {
  const pending = teams.filter((t) => !t.isComplete && !t.hasPickedThisRound);
  return `
    <div class="draft-waiting">
      <p class="draft-kicker">Rodada ${teams[0]?.picked.length ?? 0}</p>
      <h2>Escolha feita!</h2>
      <p>Aguardando ${pending.length === 1 ? pending[0].playerName : `${pending.length} jogadores`}...</p>
      <ul class="waiting-list">
        ${teams.map((t) => `
          <li class="${t.isComplete || t.hasPickedThisRound ? 'is-ready' : 'is-pending'}">
            <span class="waiting-dot"></span>
            ${escapeHtml(t.playerName)}
            ${t.isComplete ? '<small>completo</small>' : t.hasPickedThisRound ? '<small>escolheu</small>' : '<small>escolhendo...</small>'}
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

function mpPickedItem(player: DraftPlayer): string {
  const altBadges = (player.alternatePositions ?? [])
    .map((pos) => `<span class="pos-badge pos-badge-sm ${posStringRoleClass(pos)}">${escapeHtml(positionLabel(pos))}</span>`)
    .join('');
  return `
    <li class="mp-pick-item">
      <span>${player.overall}</span>
      <div>
        <strong>${escapeHtml(player.name)}</strong>
        <div class="picked-pos-row">
          <span class="pos-badge pos-badge-sm ${posStringRoleClass(player.position)}">${escapeHtml(positionLabel(player.position))}</span>
          ${altBadges}
        </div>
        <small>${escapeHtml(player.team)}</small>
      </div>
    </li>
  `;
}

function mpProgressBar(picked: number, total = 15): string {
  const pct = Math.round((picked / total) * 100);
  return `<div class="mp-progress"><div class="mp-progress-fill" style="width:${pct}%"></div></div>`;
}

function mpTeamSection(team: MultiplayerDraftTeam, isLocal: boolean): string {
  return `
    <section class="mp-local-team ${isLocal ? 'is-local' : ''}">
      <header class="mp-local-header">
        <div>
          ${isLocal ? '<span class="mp-you-badge">Você</span>' : ''}
          <strong>${escapeHtml(team.playerName)}</strong>
        </div>
        <span class="mp-pick-count">${team.picked.length}/15</span>
      </header>
      ${isLocal ? positionNeedsView(team.picked, 'compact') : ''}
      <ol class="mp-picked-list">
        ${team.picked.length > 0
          ? team.picked.map(mpPickedItem).join('')
          : '<li class="mp-pick-empty">Nenhum jogador ainda</li>'}
      </ol>
    </section>
  `;
}

function publicDraftSummary(teams: MultiplayerDraftTeam[], localPlayerId: string): string {
  const localTeam = teams.find((t) => t.playerId === localPlayerId);
  const others = teams.filter((t) => t.playerId !== localPlayerId);
  return `
    ${localTeam ? mpTeamSection(localTeam, true) : ''}
    ${others.map((t) => mpTeamSection(t, false)).join('')}
  `;
}

function hiddenDraftSummary(teams: MultiplayerDraftTeam[], localPlayerId: string): string {
  const localTeam = teams.find((team) => team.playerId === localPlayerId);
  const others = teams.filter((team) => team.playerId !== localPlayerId);
  return `
    ${others.length > 0 ? `
      <div class="hidden-progress-list">
        ${others.map((team) => `
          <div>
            <strong>${escapeHtml(team.playerName)}</strong>
            <span>${team.picked.length}/15</span>
          </div>
        `).join('')}
      </div>
    ` : ''}
    ${squadDraftPanel(localTeam?.picked ?? [], 'Seu elenco')}
  `;
}

export function multiplayerDraftSidebarView(state: MultiplayerDraftState, localTeam: MultiplayerDraftTeam): string {
  return `
    <div class="tournament-mini">
      <span>${state.settings.visibility === 'public' ? 'Picks abertos' : 'Hidden picks'}</span>
      <strong>${state.players.length} humanos / ${16 - state.players.length} bots</strong>
    </div>
    ${state.settings.visibility === 'public'
      ? publicDraftSummary(state.teams, localTeam.playerId)
      : hiddenDraftSummary(state.teams, localTeam.playerId)}
  `;
}

export function multiplayerDraftView(
  state: MultiplayerDraftState,
  localTeam: MultiplayerDraftTeam,
  tournament: TournamentPlan,
  localIndex: number,
): string {
  const pickedCount = localTeam.picked.length;
  const totalPicks = 15;

  return `
    <main class="draft-shell">
      <section class="draft-board">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">${escapeHtml(tournament.title)} / Sala ${escapeHtml(state.roomCode)}</p>
            <h1>Draft de ${escapeHtml(localTeam.playerName)}</h1>
            <p class="match-context">Estreia contra ${escapeHtml(openingOpponentNameFor(tournament, localIndex))}</p>
          </div>
          <div class="draft-meter">
            <span>${pickedCount}/${totalPicks}</span>
            <div class="draft-progress" aria-hidden="true">
              <div style="width: ${(pickedCount / totalPicks) * 100}%"></div>
            </div>
          </div>
        </header>

        ${localTeam.isComplete
          ? completeView(localTeam.picked)
          : localTeam.hasPickedThisRound
            ? waitingForOthersView(state.teams)
            : multiplayerBoosterView(localTeam)}
      </section>

      <aside class="squad-panel" data-multiplayer-draft-sidebar>
        ${multiplayerDraftSidebarView(state, localTeam)}
      </aside>
    </main>
  `;
}

// ── Multiplayer status views ──────────────────────────────────────────────────

export function multiplayerSyncWaitingView(roomCode: string): string {
  return `
    <main class="draft-shell">
      <section class="draft-board">
        <div class="draft-waiting">
          <p class="draft-kicker">Sala ${escapeHtml(roomCode)}</p>
          <h2>Sincronizando partida...</h2>
          <p>Aguardando o estado do torneio chegar do host.</p>
        </div>
      </section>
    </main>
  `;
}

export function multiplayerSpectatorWaitingView(
  match: TournamentMatch,
  state: MultiplayerDraftState,
  matchState: MultiplayerMatchState,
  opts: { isHost?: boolean; disconnectedPlayerIds?: string[] } = {},
): string {
  const required = playerIdsForMatch(match);
  const playerName = (playerId: string): string => (
    state.players.find((player) => player.id === playerId)?.name ?? 'Jogador'
  );

  const pendingDisconnected = required.filter(
    (pid) => !matchState.readyPlayerIds.includes(pid) && opts.disconnectedPlayerIds?.includes(pid),
  );
  const showForceStart = opts.isHost && pendingDisconnected.length > 0;

  return `
    <main class="draft-shell">
      <section class="draft-board">
        <header class="draft-header">
          <div>
            <p class="draft-kicker">${escapeHtml(match.stage)} / Rodada ${match.round}</p>
            <h1>${escapeHtml(match.home.name)} vs ${escapeHtml(match.away.name)}</h1>
            <p class="match-context">Aguardando formacoes dos jogadores envolvidos.</p>
          </div>
        </header>
        <div class="draft-waiting">
          <h2>Modo espectador</h2>
          <p>Voce vai assistir essa partida assim que todos estiverem prontos.</p>
          <ul class="waiting-list">
            ${required.map((playerId) => {
              const ready = matchState.readyPlayerIds.includes(playerId);
              const disconnected = opts.disconnectedPlayerIds?.includes(playerId);
              const statusText = ready ? 'pronto' : disconnected ? 'desconectado' : 'montando formacao';
              const cls = ready ? 'is-ready' : disconnected ? 'is-disconnected' : 'is-pending';
              return `
                <li class="${cls}">
                  <span class="waiting-dot"></span>
                  ${escapeHtml(playerName(playerId))}
                  <small>${statusText}</small>
                </li>
              `;
            }).join('')}
          </ul>
          ${showForceStart ? `
            <div style="margin-top:1.5rem;padding:12px 16px;background:#1e293b;border:1px solid #ef4444;border-radius:8px">
              <p style="margin:0 0 10px;font-size:13px;color:#fca5a5">
                <strong>${pendingDisconnected.map((pid) => escapeHtml(playerName(pid))).join(', ')}</strong>
                desconectou e ainda não enviou a formação.
              </p>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="draft-btn draft-btn--secondary" data-action="view-table">Ver tabela</button>
                <button class="draft-btn" style="background:#ef4444" data-action="force-start-with-bots" data-match-id="${escapeHtml(match.id)}">
                  Iniciar sem ele${pendingDisconnected.length > 1 ? 's' : ''} (bot)
                </button>
              </div>
            </div>
          ` : `
            <button class="draft-btn draft-btn--secondary" data-action="view-table" style="margin-top:1.5rem">Ver tabela</button>
          `}
        </div>
      </section>
    </main>
  `;
}

export function multiplayerHostRunningView(match: TournamentMatch): string {
  return `
    <main class="draft-shell">
      <section class="draft-board">
        <div class="draft-waiting">
          <p class="draft-kicker">${escapeHtml(match.stage)}</p>
          <h2>${escapeHtml(match.home.name)} vs ${escapeHtml(match.away.name)}</h2>
          <p>Partida oficial rodando no host.</p>
        </div>
      </section>
    </main>
  `;
}

export function multiplayerMatchLiveView(match: TournamentMatch, liveState: MultiplayerMatchLiveState | null): string {
  const scoreHome = liveState?.scoreHome ?? 0;
  const scoreAway = liveState?.scoreAway ?? 0;
  const clock = liveState?.clock ?? '0\'';
  const phase = liveState?.phase ?? 'iniciando';
  const eventText = liveState?.eventText ?? 'Aguardando o primeiro pacote do host...';
  const updatedAgo = liveState ? Math.max(0, Math.round((Date.now() - liveState.updatedAt) / 1000)) : null;

  return `
    <main class="live-spectator-shell">
      <header class="draft-header" style="margin-bottom:12px">
        <div>
          <p class="draft-kicker">${escapeHtml(match.stage)} · Espectador</p>
          <h1 style="font-size:26px;line-height:1">${escapeHtml(match.home.name)} vs ${escapeHtml(match.away.name)}</h1>
        </div>
        <div class="live-scorebar" style="margin:0;width:auto;min-width:220px">
          <strong data-live-home>${escapeHtml(match.home.name)}</strong>
          <span data-live-score>${scoreHome} - ${scoreAway}</span>
          <strong data-live-away>${escapeHtml(match.away.name)}</strong>
        </div>
      </header>
      <p class="draft-kicker" data-live-event style="margin-bottom:6px">${escapeHtml(eventText)}</p>
      <div class="live-replay-stage" data-live-replay>
        <div class="live-host-hud">
          <span class="live-host-score" data-live-score>${scoreHome} - ${scoreAway}</span>
          <span class="live-host-clock" data-live-clock>${escapeHtml(clock)}</span>
        </div>
        <div class="live-host-possession">Ao vivo pelo host</div>
        <div class="live-goal live-goal-left"></div>
        <div class="live-goal live-goal-right"></div>
        <div class="live-field-border"></div>
        <div class="live-pitch-line live-half"></div>
        <div class="live-pitch-box live-penalty-left"></div>
        <div class="live-pitch-box live-penalty-right"></div>
        <div class="live-goal-box live-goal-box-left"></div>
        <div class="live-goal-box live-goal-box-right"></div>
        <div class="live-pitch-circle"></div>
        <div class="live-center-spot"></div>
        <div class="live-penalty-spot live-penalty-spot-left"></div>
        <div class="live-penalty-spot live-penalty-spot-right"></div>
        <div class="live-ball" data-live-ball></div>
      </div>
      <div class="live-meta-row" style="margin-top:8px">
        <span>Tempo <strong data-live-clock-meta>${escapeHtml(clock)}</strong></span>
        <span>Estado <strong data-live-phase>${escapeHtml(phase)}</strong></span>
        <span>Host <strong data-live-host>${updatedAgo === null ? 'conectando...' : `ha ${updatedAgo}s`}</strong></span>
      </div>
    </main>
  `;
}

export function updateMultiplayerLiveReplay(root: HTMLDivElement, liveState: MultiplayerMatchLiveState): void {
  root.querySelectorAll<HTMLElement>('[data-live-score]').forEach((el) => {
    el.textContent = `${liveState.scoreHome} - ${liveState.scoreAway}`;
  });
  root.querySelector<HTMLElement>('[data-live-clock]')!.textContent = liveState.clock;
  root.querySelector<HTMLElement>('[data-live-clock-meta]')!.textContent = liveState.clock;
  root.querySelector<HTMLElement>('[data-live-phase]')!.textContent = liveState.phase;
  root.querySelector<HTMLElement>('[data-live-host]')!.textContent = 'agora';
  if (liveState.eventText) {
    root.querySelector<HTMLElement>('[data-live-event]')!.textContent = liveState.eventText;
  }

  const replay = liveState.replay;
  const pitch = root.querySelector<HTMLElement>('[data-live-replay]');
  if (!replay || !pitch) return;

  const ball = root.querySelector<HTMLElement>('[data-live-ball]');
  if (ball) {
    ball.style.left = `${(replay.ball.x / 1200) * 100}%`;
    ball.style.top = `${(replay.ball.y / 760) * 100}%`;
  }

  const seen = new Set<string>();
  for (const player of replay.players) {
    const markerKey = `${player.teamId}:${player.id}`;
    seen.add(markerKey);
    let marker = pitch.querySelector<HTMLElement>(`[data-live-player="${markerKey}"]`);
    if (!marker) {
      marker = document.createElement('div');
      marker.className = `live-player ${player.teamId === 'teamA' ? 'is-home' : 'is-away'}`;
      marker.dataset.livePlayer = markerKey;
      marker.innerHTML = `<span></span><small></small>`;
      pitch.appendChild(marker);
    }
    marker.classList.toggle('has-ball', player.hasBall);
    marker.style.left = `${(player.x / 1200) * 100}%`;
    marker.style.top = `${(player.y / 760) * 100}%`;
    marker.querySelector('span')!.textContent = String(player.jerseyNumber);
    marker.querySelector('small')!.textContent = shortPlayerName(player.name);
  }

  pitch.querySelectorAll<HTMLElement>('[data-live-player]').forEach((marker) => {
    if (!seen.has(marker.dataset.livePlayer ?? '')) marker.remove();
  });
}

// ── Helper (duplicated from Tournament to avoid circular import) ──────────────

function playerIdsForMatch(match: TournamentMatch): string[] {
  return [match.home.playerId, match.away.playerId].filter((id): id is string => Boolean(id));
}

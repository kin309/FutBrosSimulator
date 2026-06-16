# Football Sim — CLAUDE.md

## Comandos

```bash
# Frontend (rodar do diretório frontend/)
cd frontend && npm run dev          # dev local
cd frontend && npm run dev:lan      # dev LAN (start-lan.js)
cd frontend && npm run build        # tsc + vite build

# Server (rodar do diretório server/)
cd server && npx tsx watch src/index.ts   # dev com hot reload
cd server && node dist/index.js           # produção

# Debug mode (sem alterar código)
http://localhost:5173/?debug        # ativa startDebugMode() via URL param
```

## Stack

- **Frontend**: TypeScript + Phaser 3.87 + Vite (`frontend/`)
- **Server**: Node.js + WebSocket (`ws`) relay puro (`server/src/index.ts`, porta 3001)
- **Sem framework UI** — DOM vanilla (draft/lobby) + Phaser canvas (partida)
- **Sem testes automatizados** — verificação é sempre manual no browser

## Dois mundos de UI — regra de ouro

O HTML tem dois containers que nunca coexistem ativos:

| Container | Quem usa | Como |
|-----------|----------|------|
| `#draft-root` | `DraftApp.ts` | `root.innerHTML = ...` direto (sem framework) |
| `#game-root` | Phaser via `createGame()` | Canvas injetado pelo Phaser |

**Nunca usar Phaser para UI de draft/lobby, nunca usar DOM dentro de MatchScene.**

## Fluxo do jogo

```
main.ts → startDraftApp()
  └─ DraftApp.ts (orquestrador de TODO o fluxo pré-jogo)
       ├─ renderLobbyHome()       → escolha de modo
       ├─ DraftManager            → 15 picks, 2 rerolls
       ├─ renderFormationScreen() → formação, kit, tática
       ├─ Tournament              → bracket, simulate bots
       └─ createGame(MatchSetup)  → entrega ao Phaser
            └─ MatchScene         → loop físico + IA
                 └─ callbacks → DraftApp retoma controle
```

### Como DraftApp se comunica com MatchScene

Via objeto `MatchSetup` passado para `createGame()`. Comunicação é **unidirecional por callbacks**:

```ts
// DraftApp → MatchScene: configuração inicial
createGame({
  teams: [teamA, teamB],
  tacticalProfileA: profile,
  onMatchEnd: (scoreA, scoreB) => { /* DraftApp retoma */ },
  onHalftime: ({ resume, applyTactic }) => { /* mostra HalftimePanel, chama resume() */ },
  onLiveUpdate: (state) => { /* multiplayer: relay para outros via transport */ },
})
```

**Não existe estado compartilhado global** entre DraftApp e MatchScene — tudo via callbacks.

## Estrutura de pastas

```
frontend/src/
  main.ts              → entry point; ativa debug com ?debug
  draft/
    DraftApp.ts        → orquestrador central (fluxo + localStorage)
    DraftManager.ts    → lógica de draft (picks, rerolls, roundKinds)
    DraftTypes.ts      → interfaces: DraftPlayer, DraftRound, DraftRoundKind
    FormationApp.ts    → tela de formação; SavedFormationState
    MultiplayerLobby.ts → tipos multiplayer: LobbyPlayer, LobbySettings, etc.
    Tournament.ts      → bracket, simulate, TournamentState
    HalftimePanel.ts   → UI do intervalo
    CsvPlayerLoader.ts → parse CSV → DraftPlayer[]
    transport/         → WebSocketTransport + BroadcastChannelTransport
  game/
    FootballGame.ts    → createGame(MatchSetup) → Phaser.Game; interface MatchSetup aqui
    types.ts           → GoalBounds, FieldBounds
    scenes/MatchScene.ts → loop principal (física, IA, render)
    entities/          → Player, Ball, Team, Goal
    ai/                → PlayerAI, TeamAI, TacticalAI, DecisionUtils, FieldHeatMap
    data/
      TeamFactory.ts   → FORMATIONS, interfaces: TeamData, PlayerData, FormationDefinition
      TacticalProfile.ts → 5 perfis; interface TacticalProfile
      OutOfPositionPenalty.ts → matriz de penalidades
    physics/BallPhysics.ts
server/src/index.ts    → relay WebSocket; sem lógica de jogo
```

## Entry points por tipo de tarefa

| Tarefa | Arquivo de início |
|--------|------------------|
| Novo perfil tático | `TacticalProfile.ts` — adicionar ao array de perfis |
| Nova formação | `TeamFactory.ts → FORMATIONS` |
| Novo tipo de rodada de draft | `DraftTypes.ts → DraftRoundKind` + `DraftManager.ts` |
| Mudar comportamento de IA | `PlayerAI.ts → decide()` e/ou `DecisionUtils.ts` |
| Mudar física da bola | `BallPhysics.ts` |
| UI de lobby/draft | `DraftApp.ts` (DOM + `innerHTML`) |
| UI de torneio/tabela | `DraftApp.ts` + `Tournament.ts` |
| Novo evento de partida | `MatchScene.ts` + `LiveUpdatePayload` em `FootballGame.ts` |
| Mudar sincronização multiplayer | `DraftApp.ts` (onde `transport.send()` é chamado) |

## Interfaces-chave e onde ficam

| Interface | Arquivo |
|-----------|---------|
| `MatchSetup` | `game/FootballGame.ts` |
| `TeamData`, `PlayerData`, `FormationDefinition` | `game/data/TeamFactory.ts` |
| `TacticalProfile` | `game/data/TacticalProfile.ts` |
| `DraftPlayer`, `DraftRound`, `DraftRoundKind` | `draft/DraftTypes.ts` |
| `TournamentState`, `TournamentMatch` | `draft/Tournament.ts` |
| `LobbyPlayer`, `LobbySettings`, `SpectatorPlayerState` | `draft/MultiplayerLobby.ts` |
| `LiveUpdatePayload` | `game/FootballGame.ts` |
| `SavedFormationState` | `draft/FormationApp.ts` |

## Regras críticas

### Paridade multiplayer/single
**Sempre aplicar mudanças de gameplay/UI em ambos os modos.** Verificar se a função já é compartilhada antes de duplicar.

### Câmera
Sem câmera dinâmica. Canvas fixo 1200×760px. Campo: `x[20..1180] y[76..744]`.

### Persistência — apenas localStorage

| Chave | Conteúdo |
|-------|----------|
| `football-sim-save` | TournamentState (solo) |
| `football-sim-last-formation` | Última formação (solo) |
| `football-sim-multiplayer-host-save` | Estado completo da sala (host) |
| `football-sim-multiplayer-formation:{room}:{matchId}:{playerId}` | Formação por jogador |

Erros de localStorage são silenciados (try/catch sem log) — padrão estabelecido, manter.

### Multiplayer — server é relay puro
Sem lógica. Cache por tipo de mensagem (`lobby-state`, `draft-state`, `tournament-state`, `match-state`, `live-update`). Lógica do próximo match calculada localmente (determinístico). `roundKinds` gerado pelo host, nunca pelo guest.

### Duração da partida
`halfDuration = 75_000ms` por metade. Ao fim do tempo com bola em jogo → modo `advantage` (relógio congela até saída de bola).

### Out-of-position penalty
`OutOfPositionPenalty.ts`. Stats técnicos penalizados 0–60%. **Athletic stats nunca penalizados**: speed, acceleration, sprintSpeed, strength, stamina, agility, ballControl, balance, skillMoves, weakFootAbility, preferredFoot.

### Formações (9 fixas) — `TeamFactory.ts → FORMATIONS`
4-4-2, 3-5-2, 4-3-3, 4-2-3-1, 4-5-1, 3-4-3, 5-3-2, 4-1-4-1. Bots escolhem aleatória.

### Perfis táticos (5 fixos) — `TacticalProfile.ts`
Balanced, Possession, High-Press, Counter, Park-the-Bus.

### Spectator mode
`MatchSetup.spectatorMode = true` desativa física/IA local. Estado aplicado via `onSpectatorFrame` callback.

### Constantes físicas (não alterar sem motivo)
```
Ball radius: 7px | Contact: 17px | Pickup: 22px
Ground friction: 0.989/frame | Wall restitution: 0.74
```

### Loop de jogo não para ao perder foco
`FootballGame.ts` sobrescreve `game.loop.blur()` intencionalmente para o host continuar simulando com browser minimizado. Não remover.

## O que não fazer

- Não adicionar persistência backend — localStorage é intencional
- Não criar câmera dinâmica — layout calculado para campo fixo
- Não sincronizar formação via server — é privada por design
- Não modificar `roundKinds` no guest — host é fonte da verdade
- Não usar Phaser UI no fluxo de draft, nem DOM dentro de MatchScene
- Não adicionar estado global compartilhado entre DraftApp e MatchScene — usar callbacks via MatchSetup

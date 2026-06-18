# Plano de Debug e Testes

## Objetivo

Criar um modo de debug e testes que permita entender por que a IA tomou uma decisão, reproduzir bugs, medir comportamento tático e iniciar uma base de testes automatizados sem reescrever o jogo inteiro.

## Princípio Arquitetural

A primeira versão deve instrumentar a partida atual, não separar toda a engine do Phaser imediatamente.

A separação entre simulação e renderização é importante, mas deve vir de forma gradual. Primeiro, o projeto precisa de telemetria, snapshots e estatísticas melhores. Depois disso, fica mais claro quais partes da simulação merecem ser extraídas para rodar sem renderização.

Também vale manter as regras do projeto descritas em `CLAUDE.md`:

- UI de draft/lobby continua no DOM.
- UI dentro da partida continua no Phaser.
- `MatchScene` não deve depender de estado global compartilhado.
- Comunicação externa deve passar por `MatchSetup` e callbacks quando necessário.
- Mudanças relevantes de gameplay devem considerar singleplayer e multiplayer.

## Fase 1: Debug Visual MVP

Arquivos prováveis:

- `frontend/src/game/scenes/MatchScene.ts`
- `frontend/src/game/ai/PlayerAI.ts`
- `frontend/src/game/ai/DecisionUtils.ts`
- `frontend/src/game/debug/`

Entregas:

- Selecionar jogador com clique durante a partida.
- Exibir painel Phaser com:
  - nome;
  - time;
  - função;
  - estado atual;
  - stamina;
  - alvo atual;
  - fase tática do time;
  - instrução individual, quando existir;
  - decisão mais recente.
- Desenhar no campo:
  - linha até `targetX`/`targetY`;
  - linha de passe planejado;
  - círculo na posição base;
  - marcador atual;
  - seta de direção.

Critério de aceite:

- Ao entrar em `?debug`, é possível clicar em um jogador e entender o que ele está tentando fazer.

## Fase 2: Telemetria de Decisão

Novos arquivos sugeridos:

- `frontend/src/game/debug/DebugCollector.ts`
- `frontend/src/game/debug/DebugTypes.ts`

Entregas:

- Registrar decisões importantes em memória.
- Usar ring buffer para guardar apenas os últimos eventos.
- Registrar eventos iniciais:
  - jogador decidiu passar;
  - jogador decidiu chutar;
  - jogador decidiu conduzir;
  - jogador decidiu driblar;
  - jogador decidiu marcar;
  - jogador saiu da posição;
  - jogador obedeceu ou ignorou instrução individual.
- Cada evento deve conter:
  - tempo da partida;
  - jogador;
  - time;
  - estado anterior;
  - decisão;
  - alvo;
  - motivo resumido;
  - scores disponíveis.

Critério de aceite:

- Ao selecionar um jogador, o painel mostra as últimas decisões dele sem poluir o console.

## Fase 3: Scores Reais de Decisão

Arquivos principais:

- `frontend/src/game/ai/DecisionUtils.ts`
- `frontend/src/game/ai/PlayerAI.ts`

Entregas:

- Expor scores que hoje ficam implícitos na lógica.
- Começar por decisões com bola:
  - passe;
  - chute;
  - condução;
  - drible;
  - clearance;
  - proteção.
- Mostrar no painel algo como:

```text
Passe: 82
Chute: 45
Conduzir: 70
Drible: 61
Escolha: Passe
Motivo: maior score
```

Critério de aceite:

- Quando um jogador toma uma decisão ruim, dá para investigar se o problema foi score, peso tático, posição, stamina, alvo ou instrução individual.

## Fase 4: Pausa, Tick Manual e Snapshot

Arquivos prováveis:

- `frontend/src/game/scenes/MatchScene.ts`
- `frontend/src/game/debug/SnapshotBuffer.ts`

Entregas:

- Manter `Space` para pausar.
- Adicionar avanço manual de 1 tick quando pausado.
- Guardar os últimos 10 segundos de estado.
- Snapshot deve conter:
  - bola;
  - jogadores;
  - placar;
  - relógio;
  - estado de cada jogador;
  - alvo de cada jogador;
  - posse;
  - última decisão debug.

Critério de aceite:

- Quando algo estranho acontece, é possível pausar e inspecionar o momento com contexto suficiente para investigar.

## Fase 5: Estatísticas de Partida Melhoradas

Arquivo principal:

- `frontend/src/game/systems/StatsTracker.ts`

Entregas:

- Expandir estatísticas existentes:
  - posse;
  - passes tentados;
  - passes completos;
  - finalizações;
  - finalizações no alvo;
  - desarmes;
  - interceptações;
  - perdas de bola;
  - passes progressivos;
  - ataques pela esquerda;
  - ataques pelo meio;
  - ataques pela direita;
  - xG simples;
  - tempo em zona por jogador;
  - obediência a instruções individuais.
- Reaproveitar o overlay final em `MatchVisuals.ts` para mostrar um relatório mais útil.
- Considerar exportação futura em JSON ou CSV.

Critério de aceite:

- O fim da partida mostra um relatório que ajuda a avaliar tática e comportamento, não apenas placar e estatísticas básicas.

## Fase 6: Seeds e Reprodutibilidade

Entregas:

- Criar uma abstração simples de RNG, por exemplo `RandomSource`.
- Aceitar seed por URL, como `?debug&seed=123`.
- Trocar gradualmente usos de `Math.random()` por RNG injetado nos pontos relevantes de IA, física e eventos.

Critério de aceite:

- Rodar a mesma seed reproduz comportamento parecido o bastante para investigar bugs recorrentes.

## Fase 7: Testes Automatizados

Ferramenta sugerida:

- `vitest`

Primeiros testes:

- `StatsTracker`;
- `MatchManager`;
- funções puras de `DecisionUtils`;
- regras de posição;
- regras de passe;
- regras de stamina.

Depois, criar cenários pequenos:

- 2 contra 1;
- ponta aberto;
- contra-ataque 3 contra 2;
- goleiro pressionado;
- defensor marcando atacante.

Critério de aceite:

- `npm test` roda testes básicos sem abrir o jogo.

## Fase 8: Simulação em Massa

Esta fase deve vir depois de telemetria, estatísticas e seed.

Entregas:

- Rodar N partidas aceleradas.
- Comparar tática A contra tática B.
- Gerar relatório agregado:
  - vitórias;
  - empates;
  - derrotas;
  - gols médios;
  - posse;
  - finalizações;
  - precisão de passe;
  - xG;
  - comportamento por instrução.

Critério de aceite:

- É possível simular 100 partidas e comparar se uma tática realmente funciona melhor.

## Primeiro Pacote Recomendado

O primeiro pacote deve ser pequeno, mas já útil:

1. Criar `DebugTypes.ts`.
2. Criar `DebugCollector.ts`.
3. Adicionar seleção de jogador no `MatchScene`.
4. Criar painel Phaser simples para o jogador selecionado.
5. Desenhar linha até o alvo atual.
6. Mostrar últimas decisões básicas do jogador.
7. Rodar build para verificar que nada quebrou.

Esse pacote já melhora bastante a capacidade de observar a IA, sem mexer profundamente na arquitetura.

## Backlog Posterior

- Filtros por jogador, time e tipo de evento.
- Exportação de logs.
- Exportação de snapshots.
- Comparador de duas partidas com seeds diferentes.
- Tela de escolha de cenários de treino.
- Runner de partidas aceleradas.
- Runner headless sem renderização.
- Dashboard de comparação tática.


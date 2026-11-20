# Arquitetura

## Visão geral

```
┌──────────────── MacBook ─────────────────────────────────────────────┐
│                                                                      │
│  Claude Code (N sessões)                                             │
│     │  hooks oficiais (HTTP + 1 de comando)                          │
│     │  opcionais: métricas OpenTelemetry e linha de status           │
│     ▼                                                                │
│  ┌────────────────────── Hub local (Node) ───────────────────────┐   │
│  │ porta LOCAL 127.0.0.1:4317        porta IPHONE 127.0.0.1:4318 │   │
│  │  • POST /hooks/claude-code         • PWA (arquivos estáticos) │   │
│  │  • POST /otel/v1/metrics           • API + WebSocket          │   │
│  │  • POST /statusline/claude-code      (token do dispositivo)   │   │
│  │  • API + WebSocket (token local)   • POST /api/pair           │   │
│  │  • administração (/local/*)                                   │   │
│  │  SQLite: sessões, eventos, pedidos, dispositivos, auditoria,  │   │
│  │          consumo                                              │   │
│  └───────────────────────────────────────────────────────────────┘   │
│     ▲ WebSocket                          ▲ https (túnel)             │
│     │                                    │                           │
│  App macOS (ilha, Swift/SwiftUI)         │        Web Push (VAPID)   │
│   • monitor do Mac: leituras locais      │                           │
│   • widgets: relógio, música, clima ─────┼──► Open-Meteo (só o clima)│
└──────────────────────────────────────────┼──────────────┬────────────┘
                                           │              ▼
                                      iPhone (PWA) ◄── Apple Push
```

Três regras estruturais:

1. **Monitorar não é executar.** O hub só recebe eventos e responde a pedidos de permissão que o próprio Claude Code fez. Ele não inicia agentes, não lê transcrições e não executa comandos.
2. **Tudo roda no Mac.** Não há servidor na nuvem nem assinatura. A ilha, o monitor do Mac e o acompanhamento das sessões funcionam sem internet. Só três coisas saem do Mac, todas opcionais: o túnel https até o iPhone (Tailscale), as notificações push (direto para o serviço da Apple) e a previsão do tempo do widget de clima (Open-Meteo).
3. **Falha aberta.** Se o hub estiver fora do ar, os hooks falham sem bloquear e o Claude Code volta a perguntar no terminal, como se o Claude Hub não existisse.

## Componentes

| Pasta | Papel | Tecnologia |
|---|---|---|
| `packages/shared` | Contratos: estados, sessão, pedido, mensagens WebSocket, tokens visuais, redutor do cliente | TypeScript, sem dependências |
| `packages/claude-bridge` | Integração com o Claude Code: leitura dos payloads, máquina de estados, instalador de hooks, hook de comando, preferências (`prefs.ts`), ponte da linha de status (`statusline.ts`), CLI `claude-hub` | TypeScript |
| `services/api` | Hub local: entrada de hooks, pedidos com espera, pareamento, auditoria, push, WebSocket, consumo e limites (`consumption.ts`), serve a PWA | Node 22, Fastify, `node:sqlite`, `web-push` |
| `apps/web` | PWA do iPhone (Sessões, Uso, Histórico, Ajustes) e réplica web da ilha (`/island`) | Next.js (export estático), React |
| `apps/macos` | Ilha nativa, monitor do Mac, widgets, item na barra de menus, presença | Swift, SwiftUI, AppKit |
| `scripts/bundle-runtime.mjs` | Gera o runtime embutido (hub, CLI, hook e ponte da linha de status em arquivo único) | esbuild |
| `apps/macos/scripts` | `build-app.sh`, `fetch-node.sh`, `package-dmg.sh` | bash |
| `tests/e2e` | Testes ponta a ponta no navegador contra um hub real | Playwright |
| `tests/real` | Prova com o Claude Code de verdade | Node |

## Como tudo chega ao Mac: um app só

O `ClaudeHub.app` carrega o sistema inteiro em `Contents/Resources/runtime/`:

| Arquivo | Papel |
|---|---|
| `bin/node` | Node.js oficial para Apple Silicon (versão e SHA-256 fixados em `fetch-node.sh`) |
| `hub.mjs` | Hub local em arquivo único (gerado de `services/api`) |
| `claude-hub.mjs` | CLI: configuração, hooks, serviço, saúde, pareamento |
| `claude-hub-hook.mjs` | Hook de comando chamado pelo Claude Code |
| `claude-hub-statusline.mjs` | Ponte da linha de status (só é chamada se a leitura de limites estiver ligada) |
| `web/` | PWA do iPhone |

O app Swift não reimplementa nada disso: o assistente de configuração chama a CLI embutida (`… --json`) e mostra o resultado. Assim a mesma lógica é testada em Linux, no CI macOS e pelo terminal.

Instalar significa três coisas, todas no usuário atual e sem `sudo`:

1. **Serviço** — `~/Library/LaunchAgents/dev.claudehub.hub.plist` executa `bin/node hub.mjs` desde o login e reinicia se cair.
2. **Hooks** — entradas acrescentadas a `~/.claude/settings.json`, apontando para o hub local e para o hook embutido.
3. **Dados** — `~/.claude-hub/` (configuração, segredos locais, banco, log).

Como serviço e hooks guardam caminhos absolutos, o app precisa ficar em `/Applications`; aberto de outro lugar, o assistente se recusa a configurar. Se o app for movido, a verificação de saúde acusa e o botão **Reparar** regrava os caminhos.

### Abertura automática e instância única

O hook de comando do `SessionStart` (o mesmo que avisa o hub) abre a ilha se ela não estiver rodando: `open -g ClaudeHub.app`, sem tirar o foco do terminal e sem esperar o app subir. A preferência `autoOpenIsland` vem ligada e pode ser desligada na aba Widgets (**Abrir a ilha quando o Claude Code iniciar**). "Abrir no login" continua sendo uma opção separada.

Nunca há duas ilhas: o `Info.plist` declara `LSMultipleInstancesProhibited` e, por garantia, o app confere na partida se já existe outra instância com o mesmo identificador — se existir, ativa a que está aberta e encerra.

## Integração com o Claude Code

Só mecanismos oficiais: **hooks** declarados em `settings.json` (referência: `code.claude.com/docs/en/hooks`). Nada de arquivos internos, transcrições ou APIs privadas.

| Evento | Tipo de hook | Efeito no hub |
|---|---|---|
| `SessionStart` | comando | cria a sessão (IDLE); o hook de comando informa qual terminal hospeda a sessão |
| `UserPromptSubmit` | HTTP | WORKING; define tarefa e título |
| `PreToolUse` | HTTP | WORKING; atualiza a prévia; `TodoWrite` gera progresso |
| `PermissionRequest` | HTTP (resposta retida) | APPROVAL_REQUIRED; cria o pedido e espera a decisão |
| `PostToolUse` / `PostToolUseFailure` | HTTP | volta a WORKING; cancela pedido já resolvido |
| `Notification` | HTTP | `idle_prompt` no meio de um turno → WAITING (depois de "Terminou" é ignorado); `permission_prompt` → APPROVAL_REQUIRED |
| `Stop` | HTTP | COMPLETED + alerta "Terminou" |
| `StopFailure` | HTTP | ERROR + alerta |
| `TaskCreated` / `TaskCompleted` | HTTP | progresso |
| `SubagentStart` / `SubagentStop` | HTTP | contagem de subagentes |
| `SessionEnd` | HTTP | encerra a sessão |

**Identificação e retomada.** Cada sessão é identificada pelo `session_id` que o Claude Code envia em todo evento. Uma sessão encerrada que volta a emitir eventos (`claude --resume <session_id>`) reaparece no hub com o mesmo histórico; o detalhe da sessão na PWA mostra o comando de retomada pronto para copiar.

`SessionStart` usa hook de comando porque o hook HTTP não dispara para esse evento — confirmado no Claude Code 2.1.329. O formato dos payloads foi conferido com capturas reais (`tests/fixtures/`).

### Consumo e limites: só o que o Claude Code informa

Duas fontes oficiais, **opcionais e desligadas por padrão**. Ligam-se na aba **Uso** da ilha, com um passo de confirmação que explica o que será alterado; a CLI (`claude-hub prefs set consumption|limits on|off`) faz a mesma coisa.

| Dado | Fonte oficial | O que a preferência grava em `settings.json` | Rota do hub (porta local, token de hook) |
|---|---|---|---|
| Tokens (entrada, saída, cache lido, cache criado) e custo estimado, por modelo | Métricas OpenTelemetry do Claude Code (`claude_code.token.usage`, `claude_code.cost.usage`) | Variáveis em `env`: telemetria ligada, exportador OTLP em `http/json`, destino `http://127.0.0.1:<porta>/otel/v1/metrics`, cabeçalho com o token de hook | `POST /otel/v1/metrics` |
| Limites do plano (janela de 5 horas, de 7 dias: % usada e horário de reinício) e uso do contexto | JSON que o Claude Code entrega à linha de status (`rate_limits`, `context_window`) | `statusLine` apontando para a ponte embutida | `POST /statusline/claude-code` |

Regras:

- **Nada é estimado.** Percentuais e horários de reinício são exibidos exatamente como chegaram. Sem dado, a tela diz que não há dado. Uma janela cujo horário de reinício já passou é descartada, não "zerada".
- **O `settings.json` é preservado.** Backup datado antes de gravar. Se você já usa telemetria OpenTelemetry própria, nada é alterado e a aba explica por quê. Se você já tem uma linha de status, a ponte a executa com o mesmo JSON e mostra a saída dela, igual. Desligar devolve o arquivo byte a byte.
- **A ponte nunca atrapalha a sessão**: qualquer erro vira silêncio.
- O custo é a estimativa do próprio Claude Code, não a fatura.

O hub guarda o consumo agregado por dia, modelo e tipo de token (tabela `consumption`) e a última leitura de limites informada (em `settings`), para sobreviverem a um reinício do hub. `GET /api/usage` devolve, além das contagens do dia, os blocos `consumption` e `limits` — é o que a aba Uso da ilha e a aba Uso da PWA mostram.

Limite conhecido: a linha de status só existe em sessões interativas, e o Claude Code só informa `rate_limits` em planos com limite por janela, depois da primeira resposta.

### Como a aprovação remota funciona

1. O Claude Code dispara `PermissionRequest` e faz `POST` para o hub.
2. O hub cria o pedido (`pending`) e **mantém a requisição HTTP aberta**.
3. Ilha e iPhone recebem o pedido por WebSocket; o iPhone também por push.
4. Alguém decide → o hub responde `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny"}}}` e o Claude Code segue.
5. Sem decisão em 5 min → resposta vazia → o Claude Code pergunta no terminal.
6. Se o Claude Code fecha a conexão (respondido no terminal, turno interrompido) → o pedido vira `cancelled` e some das telas.

Perguntas do Claude (`AskUserQuestion`, `ExitPlanMode`) **não** viram aprovação remota: a sessão fica "Esperando você" e a resposta é dada no terminal.

## Estados de sessão

`IDLE → WORKING ⇄ APPROVAL_REQUIRED / WAITING → COMPLETED | ERROR`. A máquina de estados é uma função pura (`packages/claude-bridge/src/reducer.ts`): recebe sessão + evento, devolve nova sessão + registro de histórico + alertas. É o ponto de extensão para outros agentes.

## Monitor do Mac (aba Sistema)

Leituras feitas pelo próprio app, por API pública do macOS — sem hub, sem rede, sem processo auxiliar e sem permissão especial.

| Indicador | Fonte | Verde / amarelo / vermelho |
|---|---|---|
| CPU | `host_statistics` (diferença entre duas leituras) | < 60% / < 85% / acima |
| Memória usada e disponível | `host_statistics64` (ativa + fixa + comprimida) sobre a memória física | < 70% / < 88% / acima |
| SSD livre | Capacidade do volume de inicialização (`URLResourceValues`) | > 20% livre / > 10% / abaixo |
| Bateria (só em Macs com bateria) | IOKit (`IOPS…`): carga, tomada, tempo restante, ciclos | Na tomada: verde. Fora: > 30% / > 15% / abaixo |
| Temperatura | `ProcessInfo.thermalState` | Normal / Morno / Quente ou Crítico |

- **Sem graus Celsius.** O macOS não expõe a temperatura por API pública no Apple Silicon; ler sensores exigiria caminhos privados (SMC, IOHID), que o projeto não usa. A aba mostra o estado térmico informado pelo sistema e diz isso na tela.
- **Gráficos.** CPU e memória guardam as últimas 60 amostras (`SampleHistory`, em `ClaudeHubCore`).
- **Amostragem.** Um único temporizador: a cada 2 s com a aba Sistema na tela; a cada 10 s no resto do tempo, se os indicadores da ilha estiverem ligados; **parado com a ilha oculta**. Disco e ciclos de bateria são lidos no máximo uma vez por minuto.
- **Na ilha.** Em repouso a pílula mostra "CPU n% · RAM n%"; nas demais pílulas aparece um ponto só quando o pior indicador está em atenção ou crítico; o topo do painel traz três pontos (CPU, RAM, SSD). Tudo some com **Mostrar desempenho na ilha** desligado.
- Os limiares são funções puras em `SystemHealth.swift`, cobertas por testes.

## Widgets (aba Widgets)

`Sources/ClaudeHub/Widgets/`. O ponto de extensão é o protocolo `HubWidget` (id, título, símbolo, vista, ajustes opcionais, `start()`/`stop()`) mais o `WidgetRegistry`, que cuida do liga/desliga, da persistência (`widget.<id>.enabled`) e do cartão. Acrescentar um widget é criar uma classe e registrá-la em `registerBuiltIns()`; nenhuma outra tela muda.

| Widget | Como obtém o dado | Rede | Permissão do macOS |
|---|---|---|---|
| Relógio e data | Relógio do sistema, atualizado uma vez por minuto | Não | Nenhuma |
| Música | Avisos que o app Música e o Spotify publicam no `DistributedNotificationCenter` a cada troca de faixa ou de estado | Não | Nenhuma para ler. Os botões (voltar, pausar, avançar) enviam um Apple Event por AppleScript; no primeiro clique o macOS pede a permissão de **Automação** |
| Clima | Open-Meteo (`api.open-meteo.com` e a busca de cidades em `geocoding-api.open-meteo.com`), sem chave nem conta | Sim | Nenhuma (não usa a localização do Mac; a cidade é escolhida por você) |

- O clima é a **única chamada de rede externa do app**. Só acontece com o widget ligado, uma cidade definida e a aba na tela; a leitura é refeita no máximo a cada 30 minutos.
- A música só mostra o que tocou **depois** de o Claude Hub abrir: os players não informam a faixa atual a quem chega depois, e perguntar exigiria um Apple Event sem clique seu.
- O comando de música vai apenas ao player que informou a faixa, e só se ele estiver aberto.

## Tema

Preto no topo da ilha, descendo para azul-escuro (`#0B1630`) no painel e nos cartões; azul vivo nos botões de ação, como na referência; verde, amarelo e vermelho ficam reservados aos indicadores.

## Comunicação em tempo real

WebSocket em `/ws`. A primeira mensagem do cliente é `{type:"auth", token}`; nada é enviado antes disso. Depois: `snapshot` e, em seguida, `session`, `session_removed`, `event`, `approval`, `settings`, `alert`. O app macOS envia `presence` (segundos sem uso) para o roteamento do modo automático.

## Persistência

SQLite (`~/.claude-hub/hub.sqlite`) pelo módulo nativo `node:sqlite` — sem binário para compilar. Tabelas: `sessions`, `events` (14 dias), `approvals`, `devices`, `push_subscriptions`, `pairing_codes`, `settings`, `audit`, `consumption`.

As preferências do app que não dependem do hub (widgets, cidade do clima, indicadores na ilha) ficam no `UserDefaults` do macOS. As que mexem no Claude Code ou são lidas pelos hooks (`autoOpenIsland`, `consumption`, `limits`) ficam em `~/.claude-hub/config.json` e passam pela CLI.

## Disponibilidade

| Situação | O que continua funcionando |
|---|---|
| Mac sem internet | Ilha, monitor do Mac, sessões e aprovações locais. Ficam sem dado: clima, push e iPhone |
| iPhone sem rede / túnel fora | Ilha no Mac, com aprovações locais |
| Push indisponível | PWA aberta continua recebendo tudo por WebSocket |
| App macOS fechado | Hub e iPhone; o modo automático passa a considerar você "longe" |
| Hub fora do ar | Claude Code funciona normalmente; a ilha mostra "Hub offline" e reconecta sozinha. O monitor do Mac e os widgets continuam funcionando |

## Codex e OpenCode (0.5.0)

Os dois entram pela mesma rota dos hooks do Claude Code, no mesmo formato de evento, com um campo `hub_agent` (`codex` ou `opencode`). Redutor, banco, WebSocket, ilha e PWA são os mesmos; sessões e pedidos guardam `agentKind`.

| | Codex CLI | OpenCode |
|---|---|---|
| Mecanismo oficial | Hooks de comando (`~/.codex/hooks.json`), mesmo modelo do Claude Code | Plugin em `~/.config/opencode/plugins/` (V1: `server`; V2: `id` + `setup`) |
| Transporte | O hook de comando do Claude Hub com `--agent codex` | `fetch` do próprio plugin para `127.0.0.1` |
| Pedido de permissão | Hook `PermissionRequest` fica aberto até a decisão e devolve `{"behavior":"allow"\|"deny"}` — o mesmo JSON do Claude Code | Evento `permission.asked` → hub; a decisão volta pelo cliente do OpenCode (`once`/`reject`). Resposta dada no terminal (`permission.replied`) cancela o pedido no hub |
| Confiança | O Codex só executa hooks que o usuário aprovou; o hub não grava essa aprovação | Plugins da pasta são carregados sem aprovação |
| Sem hub | Falha aberta: o Codex segue com a aprovação normal | Falha aberta: o pedido fica só no terminal |

Fontes conferidas em 20/11/2026: código do Codex 0.171.0 (`hooks/src/engine/discovery.rs`, `protocol/src/hooks.rs`, schemas em `hooks/schema/generated/`) e tipos/código do OpenCode 1.19.6 (`@opencode-ai/plugin`, `@opencode-ai/sdk`) e 2.3.2 (`@opencode/plugin`, `packages/core/src/plugin/module.ts`, `packages/protocol/openapi.json`). Consumo e limites continuam só para o Claude Code.

## Docker

`docker compose up -d --build` sobe o hub (API + PWA) em Linux. A ilha é nativa do macOS e não roda em contêiner. No Mac, o caminho recomendado é rodar o hub direto com Node (ver `INSTALL_MACOS.md`).

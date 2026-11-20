# Claude Hub — app macOS

> Documento de desenvolvimento. Para **instalar e usar**, o guia é `docs/INSTALL_MACOS.md` (sem Terminal); o app chega pronto no `.dmg` construído pelo GitHub Actions. Os comandos abaixo são para quem mantém o código.

Ilha flutuante no topo da tela (estilo Dynamic Island) + item na barra de menus.
Mostra as sessões do Claude Code em tempo real e deixa você **Negar** ou
**Permitir** cada pedido de permissão. Desde a 0.4.0 traz também o monitor do Mac
(aba Sistema), consumo e limites do Claude (aba Uso) e widgets de relógio, música e
clima (aba Widgets). O app conversa com o hub local (`services/api`) em `127.0.0.1`;
ele não executa nada e não inicia agentes. A única chamada para fora do Mac é a do
widget de clima (Open-Meteo), e só com o widget ligado e uma cidade escolhida.

> **Estado da verificação:** não há toolchain Swift no ambiente em que este código
> foi escrito; compilação, testes do núcleo e um teste de fumaça com o app em execução
> rodam no workflow `.github/workflows/ci-macos.yml` (macOS 15 / Xcode 16.4). Resultados
> em `docs/TEST_REPORT.md`. Notch, vários monitores, cliques, foco, bateria, os
> controles de música (permissão de Automação) e a leitura de limites numa sessão
> interativa só se confirmam num Mac de verdade.

## Instalação pelo .dmg / assistente

O `.dmg` traz o `ClaudeHub.app` com um runtime Node embutido em
`Contents/Resources/runtime/` (`bin/node`, a CLI `claude-hub.mjs`, o hub e a PWA).
Arraste o app para **Aplicativos** e abra de lá: na primeira execução o
**assistente de configuração** aparece sozinho (depois, fica em
*menu da barra → Configuração e saúde…*). São cinco blocos numa página:

1. **Aplicativo** — confere se o app está em Aplicativos. Fora de lá (ou aberto direto
   do `.dmg`) os outros passos ficam bloqueados, porque o serviço e os hooks guardam o
   caminho do app.
2. **Claude Code** — mostra a instalação encontrada e a versão.
3. **Serviço e hooks** — *Configurar agora* instala o serviço do hub (launchd) e os
   hooks oficiais do Claude Code. O `settings.json` existente é preservado e um backup
   é gravado antes; se o arquivo não for um JSON válido, nada é alterado.
4. **Verificação de saúde** — *Verificar agora* roda o autoteste: hub no ar, evento
   recebido por WebSocket e um pedido de permissão **sintético, sempre negado, que não
   executa nenhum comando**. Mostra também quando chegou o último evento real.
5. **iPhone** — detecta o Tailscale, ativa o acesso https só dentro da sua rede
   Tailscale (por clique seu) e gera o **QR de pareamento** (código de uso único, 10 min).

O app é só a interface: toda a lógica de instalação está na CLI embutida, chamada com
`--json` (`setup status`, `setup run`, `selftest`, `tunnel enable`, `uninstall-all`).
O assistente não aprova pedidos, não cria regra de "permitir sempre" e não muda o modo
de permissão do Claude Code. *Desinstalar integração…* (rodapé) remove só os hooks e o
serviço do Claude Hub.

Para desenvolvimento, o runtime pode vir de fora do app: `CLAUDE_HUB_RUNTIME_DIR=<pasta>`.
`CLAUDE_HUB_NO_AUTO_SETUP=1` impede a abertura automática do assistente. Num build sem
runtime (Xcode, `swift run`, `build-app.sh` puro) o assistente avisa "runtime não
embutido" e não abre sozinho.

**Não verificado:** o assistente nunca foi usado num Mac real. Clicar nos botões,
a ativação da janela a partir de um app de barra de menus, o serviço launchd, o
`tailscale serve`, a leitura do QR pelo iPhone e o comportamento do Gatekeeper com um
`.dmg` não notarizado só se confirmam num Mac de verdade. O CI compila o código e
testa a decodificação do contrato JSON; não clica em nada.

## Requisitos

- macOS 14 (Sonoma) ou mais novo
- Xcode 16+ **ou** só as Command Line Tools (`xcode-select --install`)
- O hub rodando (`pnpm build && pnpm start` na raiz do repositório)

## Compilar e rodar

**Com Xcode** — abra `ClaudeHub.xcodeproj`, escolha o esquema `ClaudeHub` e rode (⌘R).
O projeto usa pastas sincronizadas (formato do Xcode 16): todo arquivo em `Sources/`
entra no alvo sozinho. Assinatura: "Sign to Run Locally", sem conta de desenvolvedor.

**Sem Xcode** (só Command Line Tools):

```bash
./scripts/build-app.sh                 # gera build/ClaudeHub.app (assinado ad-hoc)
cp -R build/ClaudeHub.app /Applications/
open /Applications/ClaudeHub.app
```

**Durante o desenvolvimento:**

```bash
swift build        # compila os dois módulos
swift test         # testes do núcleo (ClaudeHubCore)
swift run ClaudeHub
```

## Manter o hub sempre ligado

O serviço de inicialização é instalado pelo assistente do app (bloco 3) ou pela CLI:

```bash
claude-hub service install     # LaunchAgent dev.claudehub.hub, apontando para o runtime
claude-hub service uninstall
```

O serviço executa o Node embutido com o hub desde o login, reinicia se cair e grava o
log em `~/.claude-hub/hub.log`. "Abrir no login" do próprio app fica no rodapé do
assistente (usa `SMAppService`; funciona com o app em `/Applications`).

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `Sources/ClaudeHubCore` | Modelos (espelho de `packages/shared`), contrato JSON da CLI (`SetupModels`), redutor de estado, configuração e cliente do hub; limiares e histórico do monitor (`SystemHealth`), consumo e limites (`UsageModels`), previsão do tempo (`WeatherModels`). Só Foundation. |
| `Sources/ClaudeHub` | App: janela da ilha (`IslandPanel`), estados, painel, abas, pareamento, barra de menus, assistente de configuração (`SetupAssistant*`, `RuntimeCLI`); monitor do Mac (`SystemMonitor`, `SystemStats`, `PerformanceIndicators`, `SystemTabView`); aba Uso (`UsageTabView`). |
| `Sources/ClaudeHub/Widgets` | `HubWidget` (protocolo) e `WidgetRegistry`; `ClockWidget`, `MusicWidget`, `WeatherWidget`; `HubPrefsModel` (preferências que passam pela CLI). |
| `Tests/ClaudeHubCoreTests` | 83 testes: decodificação de todas as mensagens e do contrato da CLI, redutor, prioridade de foco, formatadores, configuração, limiares do monitor, consumo/limites e previsão do tempo. |
| `Support/` | `Info.plist` (instância única, texto do pedido de Automação), `ClaudeHub.entitlements` (Apple Events, só sob Developer ID) e `node.entitlements`. |
| `scripts/` | `build-app.sh` (app), `fetch-node.sh` (Node oficial, SHA-256 fixado), `package-dmg.sh` (instalador). |

No SwiftPM são dois módulos; no projeto Xcode as duas pastas compilam num alvo só
(por isso o `#if canImport(ClaudeHubCore)` no topo dos fontes do app).

## Como a ilha se comporta

- **Compacta:** `Trabalhando` (pontos + anel; a `%` só aparece quando o agente tem
  lista de tarefas), `Esperando você` + **Responder**, `Terminou`, `Erro`, sem sessões,
  `Hub offline` + tentar de novo.
- **Mouse em cima:** detalhe da sessão em foco. **Clique:** painel completo.
  Clique fora (ou Esc, com a ilha em foco) recolhe.
- **Pedido de permissão:** abre sozinho com o comando inteiro, **Responder no Claude**,
  **Negar** e **Permitir**. Não existe "permitir sempre".
- **Em repouso:** a pílula mostra `CPU n% · RAM n%` com um ponto verde, amarelo ou
  vermelho; nas outras pílulas aparece um ponto só quando algum indicador do Mac está
  em atenção ou crítico. Desliga-se em *Sistema → Mostrar desempenho na ilha*.
- **Abas do painel:** `Claude | Sistema | Uso | Widgets`, com três pontos (CPU, RAM,
  SSD) no topo.
- **Abre sozinha** quando uma sessão do Claude Code começa (hook de `SessionStart`,
  `open -g`, sem tirar o foco do terminal). Desliga-se em *Widgets → Abrir a ilha
  quando o Claude Code iniciar*. Nunca há duas instâncias
  (`LSMultipleInstancesProhibited` + conferência na partida).
- **Notch:** em telas com recorte a ilha cola na borda superior e usa as laterais do
  notch; sem notch, flutua logo abaixo da barra de menus.
- **Vários monitores:** tela principal, tela com o cursor ou tela embutida
  (aba Widgets, ou o ícone ⇄ do painel).

## Aba Sistema — monitor do Mac

`SystemMonitor` publica uma fotografia (`SystemSnapshot`) por amostra; as leituras
ficam em `SystemStats.swift` (`SystemProbe`), todas por API pública:

| Indicador | Leitura | Limiar (verde / amarelo / vermelho) |
| --- | --- | --- |
| CPU | `host_statistics`, diferença entre duas leituras | < 60% / < 85% / acima |
| Memória (usada e disponível) | `host_statistics64`: ativa + fixa + comprimida | < 70% / < 88% / acima |
| SSD livre | capacidade do volume de inicialização | > 20% / > 10% / abaixo |
| Bateria, se houver | IOKit (`IOPS…`): carga, tomada, tempo, ciclos | na tomada verde; fora, > 30% / > 15% / abaixo |
| Temperatura | `ProcessInfo.thermalState` | Normal / Morno / Quente, Crítico |

O macOS não expõe a temperatura em graus por API pública no Apple Silicon, e o app
não lê sensores por caminhos privados: a aba mostra o estado térmico e diz isso.
CPU e memória têm gráfico com as últimas 60 amostras. Um único temporizador: 2 s com
a aba na tela, 10 s no resto do tempo (se os indicadores da ilha estiverem ligados),
**parado com a ilha oculta**; disco e ciclos de bateria no máximo uma vez por minuto.
Os limiares são funções puras em `ClaudeHubCore/SystemHealth.swift`, com testes.

## Aba Uso — consumo e limites

Mostra só o que o Claude Code informou ao hub (`GET /api/usage`): limites do plano
(janelas, % usada, horário de reinício), uso do contexto, tokens e custo estimado por
modelo, atividade do dia. Sem dado, a aba diz "O Claude Code não informou…" — nada é
estimado. As duas fontes vêm desligadas; os botões **Ligar medição** e
**Ligar leitura de limites** abrem um cartão que explica a alteração no
`settings.json` do Claude Code e pede **Confirmar**. Por baixo, a aba chama a CLI
embutida: `prefs --json` e `prefs set <consumption|limits> on|off --json`
(`HubPrefsModel`). Enquanto a aba está na tela, os números são relidos a cada 20 s.

## Aba Widgets

| Widget | Dado | Observações |
| --- | --- | --- |
| Relógio e data | relógio do sistema, uma atualização por minuto | 12 h ou 24 h |
| Música | avisos `com.apple.Music.playerInfo` e `com.spotify.client.PlaybackStateChanged` | Ler não pede permissão. Os botões enviam AppleScript (`playpause`, `next track`, `previous track`) só ao clique, só ao player que informou a faixa e só se ele estiver aberto; no primeiro clique o macOS pede **Automação**. Só aparece o que tocou depois de o app abrir |
| Clima | Open-Meteo, sem chave | Cidade por busca (não usa a localização do Mac), °C ou °F, hoje + 3 dias; relê no máximo a cada 30 min e só com a aba na tela |

### Como acrescentar um widget

1. Crie `final class MeuWidget: HubWidget` em `Sources/ClaudeHub/Widgets/`, com `id`
   estável, `title`, `symbol` (SF Symbol) e `makeView()`.
2. Opcional: `makeSettingsView()` (aparece na engrenagem do cartão), `start()`/`stop()`
   para o trabalho que só deve acontecer com o widget ligado e na tela, e
   `enabledChanged(_:)` para escutas baratas que não podem perder eventos.
3. Registre em `WidgetRegistry.registerBuiltIns()` — é o único lugar a tocar.

Liga/desliga, persistência (`widget.<id>.enabled` no `UserDefaults`) e cartão vêm
prontos. No projeto Xcode a pasta é sincronizada: o arquivo novo entra no alvo sozinho.

## Preferências

| Onde ficam | Quais |
| --- | --- |
| `UserDefaults` do app | `system.showPerformance`, `widget.<id>.enabled`, `widget.clock.twelveHour`, `widget.weather.cityName` / `.latitude` / `.longitude` / `.fahrenheit`, e as da ilha (porcentagem, aviso de conclusão, sons, tela) |
| `~/.claude-hub/config.json`, pela CLI `claude-hub prefs` | `autoOpenIsland` (lida pelo hook), `consumption` e `limits` (alteram o `settings.json` do Claude Code) |

```bash
claude-hub prefs                          # mostra as três
claude-hub prefs set autoOpenIsland off   # chaves: autoOpenIsland | consumption | limits
```

## Automação

O painel e o assistente podem ser abertos ou fechados por script, sem permissão de
Acessibilidade, por notificações distribuídas: `dev.claudehub.mac.openPanel`,
`dev.claudehub.mac.collapse`,
`dev.claudehub.mac.openTab.<claude|sistema|uso|widgets>` (abre o painel já na aba),
`dev.claudehub.mac.openSetup`,
`dev.claudehub.mac.closeSetup` e `dev.claudehub.mac.runSelfTest` (abre o assistente e
roda a verificação de saúde, que é somente leitura). Isso só muda o que está visível —
por esse caminho não se instala nada, não se pareia ninguém e nenhuma decisão de
permissão pode ser tomada. É o que o teste de fumaça usa
(`tests/real/macos-smoke.mjs`, que também roda no seu Mac).

## Consumo

Medido no CI (runner macOS, 4 sessões ativas, depois de percorrer as abas Sistema,
Uso e Widgets): 0% de CPU e 82 MB de memória (na 0.3.0, sem monitor nem widgets:
~0,3% e ~72 MB). O estado das sessões chega por WebSocket, sem polling. O monitor do
Mac lê a cada 10 s em repouso (2 s só com a aba Sistema aberta) e para com a ilha
oculta; a aba Uso relê a cada 20 s só enquanto está na tela; o clima, a cada 30 min. O anel giratório é uma animação do Core
Animation (roda fora do processo do app). Relógios de tela (contagem regressiva,
"1 min") só existem enquanto a vista que os mostra está visível.

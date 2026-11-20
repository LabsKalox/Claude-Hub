# Desenvolvimento e pipeline

Este documento é para quem mantém o projeto. **Quem só vai usar o Claude Hub não precisa de nada daqui** — o guia de instalação é [`INSTALL_MACOS.md`](INSTALL_MACOS.md), sem Terminal.

## Onde cada coisa é construída

Tudo é compilado, testado e empacotado no GitHub Actions. Nenhuma etapa roda no Mac de quem usa.

| Workflow | Runner | O que faz |
|---|---|---|
| `CI (Linux)` | `ubuntu-latest` | Build, typecheck, 185 testes unitários/integração (contratos 13, bridge 83, hub 89), 25 testes ponta a ponta (Chromium), imagem Docker |
| `CI macOS` | `macos-15` (Apple Silicon) | Compila o app (SwiftPM e Xcode), testa o núcleo Swift, constrói o `.dmg`, executa a ilha, **instala a partir do `.dmg`**, mede o Gatekeeper e publica o instalador |

### Passos do `CI macOS`

1. `swift build`, `swift test` (85 testes do núcleo), `xcodebuild` — o app compila pelos dois caminhos.
2. `scripts/build-installer.sh` — `pnpm install`, `pnpm build`, `pnpm bundle:runtime`, `apps/macos/scripts/package-dmg.sh`.
   - `bundle-runtime.mjs` gera hub, CLI, hook e ponte da linha de status em arquivo único e copia a PWA.
   - `fetch-node.sh` baixa o Node oficial para arm64 e confere o SHA-256 fixado.
   - `build-app.sh` monta o `.app`, embute o runtime e assina (com `Support/ClaudeHub.entitlements`, que só tem efeito sob Developer ID).
   - `package-dmg.sh` cria o `.dmg`, e assina/notariza se houver segredos.
3. `tests/real/macos-smoke.mjs` — abre o app e fotografa cada estado da ilha e as abas Sistema, Uso (com métricas reais gravadas e limites de teste) e Widgets (clima real, faixa simulada).
4. `tests/real/macos-install-test.mjs` — instalação limpa, aprovação (negar, permitir, duplicar, cancelar, revogar), abertura automática da ilha pelo hook de `SessionStart` (abre, não duplica, respeita a preferência), consumo e limites ligados e desligados sobre um `settings.json` que já tem `env` e `statusLine` do usuário, reinstalação por cima, desinstalação, reinstalação e desinstalação apagando os dados.
5. `tests/real/macos-gatekeeper-check.mjs` — marca uma cópia do `.dmg` como download e registra o veredito do macOS. Só observa.
6. Artefatos: `ClaudeHub-macOS-arm64` (o `.dmg` e o `.sha256`) e `ilha-nativa-capturas`.
7. Opcional, em execução manual com **publicar_release**: cria o pré-lançamento `v<versão>` com o `.dmg` anexado (link direto).

### Publicar um instalador

GitHub → **Actions** → **CI macOS** → **Run workflow** → escolha o branch, marque **publicar_release** → **Run workflow**. Ao terminar, o `.dmg` está em **Releases**.

### Assinatura e notarização

Segredos opcionais do repositório; ver [`SIGNING_NOTARIZATION.md`](SIGNING_NOTARIZATION.md). Sem eles o instalador sai assinado só localmente e **não notarizado**.

## Ambiente local de desenvolvimento (opcional)

```bash
pnpm install && pnpm build      # contratos, bridge, hub e PWA
pnpm test                       # unitários e integração
pnpm test:e2e                   # navegador, contra um hub real
pnpm start                      # hub em primeiro plano
pnpm hub <comando>              # CLI: setup status|run, selftest, diagnostics, prefs, pair, devices, audit…
pnpm hub prefs                  # mostra: abrir a ilha com o Claude Code, medição de consumo, leitura de limites
pnpm hub prefs set consumption on   # chaves: autoOpenIsland | consumption | limits  ·  valores: on | off
pnpm bundle:runtime             # runtime que vai dentro do app
CLAUDE_HUB_RUNTIME_DIR=$PWD/dist-runtime pnpm test:e2e    # mesmos testes contra o runtime empacotado
node tests/real/run-real-claude.mjs allow|deny            # Claude Code de verdade (precisa estar autenticado)
docker compose up -d --build    # hub em Linux
```

No macOS, `apps/macos/README.md` descreve o app Swift. A CLI embutida no app instalado fica em `ClaudeHub.app/Contents/Resources/runtime/bin/claude-hub` e aceita os mesmos comandos; o assistente gráfico é só uma interface sobre ela.

## O que entrou na 0.4.0 e onde está

| Recurso | Arquivos |
|---|---|
| Consumo (OpenTelemetry) e limites (linha de status) no hub | `services/api/src/consumption.ts`; rotas `POST /otel/v1/metrics` e `POST /statusline/claude-code` em `server.ts`; `GET /api/usage` devolve `consumption` e `limits` |
| Preferências que tocam no `settings.json` | `packages/claude-bridge/src/prefs.ts` (`autoOpenIsland`, `consumption`, `limits`) |
| Ponte da linha de status | `packages/claude-bridge/src/statusline.ts` → `claude-hub-statusline.mjs` no runtime |
| Abertura automática da ilha | `packages/claude-bridge/src/hook-command.ts` (`openIslandIfNeeded`) |
| Tipos e formatadores de uso | `packages/shared/src/core.ts` (`ConsumptionStats`, `LimitsStats`, `formatTokens`, `formatUsd`) |
| Aba Uso da PWA | `apps/web/app/page.tsx` (`UsageTab`) |
| Monitor do Mac, widgets e aba Uso da ilha | `apps/macos` — ver `apps/macos/README.md` |
| Fixtures | `tests/fixtures/otel-metrics-claude-code-2.1.329.jsonl` (métricas reais, sem dados pessoais), `tests/fixtures/statusline-input-docs.json` (exemplo da documentação oficial) |

`prefs set consumption on` recusa-se a alterar um `settings.json` que já tenha telemetria OpenTelemetry de outra origem; `prefs set limits on` guarda a linha de status original em `statusLineOriginal` e a devolve ao desligar.

## Versão

O número vive em quatro lugares e um teste garante que os três de código coincidem (`services/api/test/setup.test.ts`); `package-dmg.sh` falha se o do app divergir:

- `package.json` (raiz e pacotes)
- `packages/claude-bridge/src/setup.ts` → `RUNTIME_VERSION`
- `services/api/src/server.ts` → `VERSION`
- `apps/macos/Support/Info.plist` → `CFBundleShortVersionString`

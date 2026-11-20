# Matriz de funcionalidades — Claude Hub 0.5.1

Escopo definido em 20/11/2026. Cada linha diz o que existe, **como foi verificado** e o que ainda falta. Num MacBook físico só o hub, o serviço e os hooks têm evidência; a ilha na tela e o iPhone, não — ver a última seção.

## Como ler

| Situação | Significa |
|---|---|
| **Verificado (CI macOS)** | Rodou no app real, num Mac Apple Silicon virtual do GitHub Actions (macOS 15), com teste automatizado e/ou captura de tela |
| **Verificado (Claude Code real)** | Rodou com o Claude Code 2.1.329 de verdade, neste ambiente de desenvolvimento |
| **Verificado (testes)** | Coberto por testes automatizados (hub, bridge, navegador simulando iPhone) |
| **Implementado, não verificado** | O código existe e compila, mas o comportamento nunca foi exercitado |
| **Parcial** | Funciona com uma limitação descrita na linha |
| **Ausente** | Não existe |

Execução de referência (0.5.1): workflow `CI macOS` [44804497487](https://github.com/LabsKalox/Claude-Hub/actions/runs/44804497487) — compilação, testes do núcleo Swift, fumaça com capturas (inclusive os três agentes), 131 verificações aprovadas na fumaça e na instalação a partir do `.dmg` e medição do Gatekeeper.

## 1. Monitoramento do Mac (aba Sistema)

| Funcionalidade | Situação | Evidência | Limite / o que falta |
|---|---|---|---|
| CPU em tempo real | Verificado (CI macOS, 0.4.2) | `screenshots/macos/10b-aba-sistema-com-cpu-e-memoria.jpg` | **Oculto por padrão desde a 0.4.3**, a pedido. Liga em aba Sistema → *Mostrar CPU e memória* |
| RAM usada e disponível | Verificado (CI macOS, 0.4.2) | Mesma captura | Idem: oculta por padrão |
| Espaço no SSD | Verificado (CI macOS) | Mesma captura (47,5 GB livres de 343 GB, barra de uso) | — |
| Temperatura | **Parcial** | Mesma captura ("Normal") | O macOS **não expõe temperatura em graus** por API pública no Apple Silicon. A ilha mostra o estado térmico oficial do sistema (Normal, Morno, Quente, Crítico) e diz isso na tela. Graus exigiriam API privada ou privilégio de administrador — fora do escopo por decisão de segurança |
| Bateria | **Implementado, não verificado** | Testes dos limiares (`SystemHealthTests`) | O Mac virtual do CI não tem bateria; o cartão só aparece quando há bateria. Precisa do MacBook |
| Gráficos de desempenho | Verificado (CI macOS, 0.4.2) | Mesma captura (histórico de CPU e memória) | Aparecem junto com os cartões de CPU e memória |
| Indicadores verde/amarelo/vermelho | Verificado (CI macOS) + testes | Captura (SSD em "Atenção" com 86% em uso; CPU e RAM em "Bom") e testes dos limiares | Limiares: CPU 60/85%, RAM 70/88%, disco livre 20/10%, bateria 30/15% fora da tomada |
| Atualização eficiente | Verificado (CI macOS) | Fumaça: app com 4 sessões e monitor ligado — CPU 0,2%, memória 82 MB | Leituras a cada 2 s com a aba aberta, mais espaçadas em repouso, nenhuma com a ilha oculta. Medido em VM, não num MacBook em bateria |
| CPU/RAM na ilha em repouso | Verificado (CI macOS, 0.4.2) | Captura `01-sem-sessoes.jpg` da 0.4.2 | Desligado por padrão desde a 0.4.3 (acompanha *Mostrar CPU e memória*) |

## 2. Integração com o Claude Code

| Funcionalidade | Situação | Evidência | Limite / o que falta |
|---|---|---|---|
| Sessões e estados (Trabalhando, Esperando você, Precisa de autorização, Terminou, Erro, Inativa) | Verificado (Claude Code real) + CI macOS | `evidence/real-claude-allow.txt`, capturas `02`–`06` | Sessão **interativa** em terminal nunca exercitada (só `claude -p`) |
| Tarefas (título, progresso, último evento) | Verificado (testes) + CI macOS | `02-trabalhando.jpg` (70%), testes do redutor de estados | Progresso só existe quando o Claude usa a lista de tarefas |
| Notificação de conclusão | **Parcial** | Ilha: `05-terminou.jpg`. Push: testes do hub | No iPhone real o push **ainda não funciona**: a ativação não respondia na 0.4.0 (causa não identificada; `TEST_REPORT.md`, seção 5.7) |
| Pedidos de autorização na ilha | Verificado (CI macOS) | `04-pedido-de-permissao.jpg`; teste de instalação, etapa 6 | O clique em Negar/Permitir na ilha nativa nunca foi feito por uma pessoa |
| Aprovar/negar pelo iPhone | Verificado (Claude Code real) + testes | `evidence/real-claude-allow.txt`, `real-claude-deny.txt`; e2e | Feito por navegador simulando iPhone, pela porta do iPhone. **iPhone real e Tailscale não testados** |
| Histórico de eventos | Verificado (testes) | e2e (aba Histórico do iPhone, detalhe da sessão); aba Uso da ilha | — |
| Consumo (tokens e custo) | Verificado (Claude Code real) + CI macOS | `11-aba-uso.jpg`; `evidence/real-claude-allow.txt` (custo medido pelo hub = custo impresso pelo Claude Code) | Opcional, desligado por padrão. Fonte: telemetria OpenTelemetry do próprio Claude Code, enviada só para o hub local. O custo é estimativa do Claude Code, não a fatura |
| Limites do plano (janelas de 5 h e 7 dias, com horário de reinício) | **Parcial** | `11-aba-uso.jpg`; teste de instalação, etapa 8c; e2e | Opcional, desligado por padrão. Fonte: campo oficial `rate_limits` da linha de status. **Nunca recebido de uma sessão interativa real** — verificado com o exemplo da documentação oficial. O Claude Code só informa limites em planos Pro/Max, depois da primeira resposta |
| Nada inventado | Verificado (testes) | Testes do hub e e2e: sem dado, a tela diz "não informou"; janela vencida some | Percentuais e horários são exibidos exatamente como o Claude Code informou |

## 2b. Codex CLI e OpenCode (0.5.1)

Testados com os **agentes reais**: workflow `Agentes reais` [44801274169](https://github.com/LabsKalox/Claude-Hub/actions/runs/44801274169) — Codex CLI 0.171.0, OpenCode 1.19.6 (`opencode-ai`) e OpenCode 2.3.2 (`@opencode/cli`), cada um em macOS 15 e Ubuntu, 6 de 6 aprovados. O modelo é um servidor local falso (`tests/real/fake-model.mjs`), sem chave de API: o agente, os hooks/plugins, o hub e as decisões são reais; a "inteligência" é um roteiro fixo que pede para rodar um comando.

| Funcionalidade | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| Detectar e identificar sessões (projeto, título, agente) | Verificado (agente real) | **Verificado (agente real)** | **Verificado (agente real, V1 e V2)** |
| Várias sessões ao mesmo tempo | Verificado (testes + CI macOS) | **Verificado (agente real)**: 2 sessões simultâneas, decisões independentes | **Verificado (agente real)**: idem |
| Ferramentas usadas e último evento | Verificado | **Verificado (agente real)** | **Verificado (agente real)** |
| Progresso por lista de tarefas | Verificado | **Ausente**: o Codex não envia o plano por hook | V1: implementado (`todo.updated`), só testes. V2: ausente |
| Fim da tarefa (sai de "Trabalhando") | Verificado | **Verificado (agente real)** (hook `Stop`) | **Verificado (agente real)** (V1 `session.idle`; V2 `session.execution.succeeded`) |
| Erro da tarefa | Verificado (testes) | **Ausente**: o Codex não tem hook de erro; a sessão termina sem marcar "Erro" | Implementado, só testes (V1 `session.error`, V2 `session.execution.failed`) |
| Pedido de autorização na ilha e no iPhone, com o comando completo | Verificado (agente real) | **Verificado (agente real)** | **Verificado (agente real)** |
| Permitir/negar remotamente, e o agente obedece | Verificado (agente real) | **Verificado (agente real)**: permitido executa; negado não executa | **Verificado (agente real)**: idem |
| Responder no terminal cancela o pedido no iPhone | Comportamento do Claude Code | Não verificado | Implementado (`permission.replied`), só testes |
| Notificação push de conclusão/pedido | Mesmo caminho do hub para os três; **no iPhone real o push não está confirmado** (ver seção 2) | Idem | Idem |
| Tokens e custo | Verificado (agente real), opcional | **Ausente** | **Ausente** |
| Limites do plano | Parcial (ver seção 2) | **Ausente** | **Ausente** |
| Ilha (Dynamic Island) | Verificado (CI macOS) | Verificado (CI macOS): captura `13-tres-agentes`, `14-pedido-do-codex` — eventos de teste no formato da integração | Idem |
| Requisito do usuário | Nenhum | O Codex pede para **confiar nos hooks** novos (uma vez, na tela "Review hooks"); o Claude Hub não pula essa etapa | Nenhum: o plugin é carregado na próxima vez que o OpenCode abrir |

Em resumo: para Codex e OpenCode o que está verificado com o agente real é **sessões, várias ao mesmo tempo, fim da tarefa e aprovação remota**. Consumo, limites e (no Codex) erro e progresso **não existem**. Nenhum dos dois foi usado num MacBook físico.

## 3. Widgets

| Funcionalidade | Situação | Evidência | Limite / o que falta |
|---|---|---|---|
| Relógio e data | Verificado (CI macOS) | `12-aba-widgets.jpg` | — |
| Música: título, artista, álbum | Verificado (CI macOS) | Mesma captura (faixa anunciada por uma notificação de teste no formato do app Música) | Só mostra faixas que mudaram depois de o Hub abrir. Com o app Música/Spotify de verdade: **não verificado** |
| Música: controles (voltar, pausar, avançar) | **Implementado, não verificado** | Os botões aparecem na captura | Dependem da permissão de **Automação** que o macOS pede no primeiro clique. Nunca clicados |
| Clima configurável | Verificado (CI macOS) | Mesma captura (São Paulo, dados reais do Open-Meteo, previsão de 3 dias) | Busca de cidade pela interface (digitar no painel) **não verificada**. Precisa de internet |
| Arquitetura extensível | Verificado (CI macOS) | Os três widgets entram pelo mesmo registro (`Widgets/HubWidget.swift`) | Acrescentar um widget exige compilar uma nova versão (na nuvem) |

## 4. Dynamic Island

| Funcionalidade | Situação | Evidência | Limite / o que falta |
|---|---|---|---|
| Pop-up flutuante no topo | Verificado (CI macOS) + captura do MacBook real | Todas as capturas; captura do autor no MacBook dele (não publicada) | Desde a 0.4.3 fica **abaixo das abas do navegador** por padrão (colada no topo ela cobria as abas do Chrome). Posição configurável na barra de menus. A posição nova não foi vista num Mac real |
| Visual minimalista, preto + azul-escuro | Verificado (CI macOS) | Capturas `06`, `10`, `11`, `12` | — |
| Animações suaves | **Implementado, não verificado** | — | Capturas são estáticas; ninguém viu as transições |
| Modo compacto e expandido | Verificado (CI macOS) | `01`–`05` (compacto), `06`, `10`–`12` (expandido) | Expandir por **clique/hover** não verificado: o teste abre o painel por comando |
| Abas Claude, Sistema, Uso, Widgets | Verificado (CI macOS) | `06`, `10`, `11`, `12` | Troca de aba por clique não verificada |
| Indicadores de desempenho | Verificado (CI macOS) | Topo do painel (CPU · RAM · SSD) e ilha em repouso | — |

## 5. Inicialização

| Funcionalidade | Situação | Evidência | Limite / o que falta |
|---|---|---|---|
| Abre sozinho quando o Claude Code inicia | Verificado (CI macOS) | Teste de instalação, etapa 8b: o hook de início de sessão gravado no `settings.json` abre a ilha | Disparado pelo teste, do jeito que o Claude Code dispara. Com uma sessão interativa real: não verificado |
| Fica acessível | Verificado (CI macOS) | Ilha sempre no topo + ícone na barra de menus | — |
| Iniciar com o macOS (opcional) | **Parcial** | Serviço do hub: verificado (volta sozinho se morrer). Ilha no login: chave "Abrir no login" | **Reinício do Mac nunca testado** |
| Sem janelas duplicadas | Verificado (CI macOS) | Etapa 8b: três sessões + novo duplo clique = 1 instância | — |
| Pode ser desligado | Verificado (CI macOS) | Etapa 8b: com a preferência desligada, a ilha não abre | — |

## 6. Operação local

| Funcionalidade | Situação | Evidência | Limite / o que falta |
|---|---|---|---|
| Monitor do Mac e ilha sem servidor externo | Verificado (CI macOS) | Tudo roda no app e no hub local (127.0.0.1) | — |
| iPhone por conexão privada e autenticada | **Parcial** | Pareamento por código de uso único, token por aparelho, revogação: verificados (testes + etapa 6) | No MacBook real, a 0.4.0 **não reconhecia o Tailscale conectado** (defeito de detecção, corrigido na 0.4.1 — `TEST_REPORT.md`, seção 5.6). A correção foi testada com um substituto do Tailscale, não com o de verdade; publicar a porta e parear o iPhone **continuam sem teste real** |
| Rede só onde é inevitável | Verificado (código + CI) | Clima (Open-Meteo) e push (Apple, via Web Push) | — |
| Sem assinatura em nuvem | Verificado | Nenhum serviço pago é usado | Tailscale tem plano gratuito pessoal; a notarização da Apple é paga (ver seção 7) |

## 7. Compilação e entrega

| Funcionalidade | Situação | Evidência | Limite / o que falta |
|---|---|---|---|
| Tudo compilado no GitHub Actions | Verificado | Workflow `CI macOS` | — |
| Nada a instalar no MacBook (Xcode, Node, Git, Terminal) | Verificado (CI macOS) | O app traz o Node dentro; instalação, reparo e desinstalação pelo assistente gráfico | — |
| `.dmg` para Apple Silicon | Verificado (CI macOS) | Binários arm64, assinatura íntegra | — |
| Preserva as configurações do Claude Code | Verificado (CI macOS) | Etapas 4, 8c, 9, 10: modelo, permissões, hooks, variáveis e linha de status do usuário intactos; desinstalar devolve o arquivo exato | — |
| Validação da instalação no macOS do CI | Verificado (CI macOS) | `evidence/macos-install-test.txt` | VM, sem cliques |
| Gatekeeper respeitado | Verificado (CI macOS) | `evidence/macos-gatekeeper-check.txt`, `09-download-nao-notarizado.jpg` | — |
| Instalação convencional (abrir com duplo clique) | **Ausente** | O macOS **bloqueia** o app baixado | **Não há certificado Apple Developer ID.** Sem notarização (US$ 99/ano, não autorizado), o duplo clique não abre o app. Ver `SIGNING_NOTARIZATION.md` |

## O que nenhuma linha acima cobre

Num MacBook de verdade há duas evidências, ambas de 20/11/2026 com a 0.4.0: o diagnóstico (diagnóstico enviado pelo autor, não publicado por conter dados do Mac dele), que mostra hub, serviço, hooks e um evento real do Claude Code funcionando, com os 23 hooks do usuário preservados; e uma captura da ilha compacta no estado Trabalhando (não publicada). Foi nesse Mac que apareceu o defeito de detecção do Tailscale, corrigido na 0.4.1. Nada foi executado num iPhone. Continuam sem verificação: cliques e hover na ilha e no assistente, notch, vários monitores, animações, reinício do Mac, sessão interativa do Claude Code com o app instalado, limites vindos de uma sessão real, controles de música, Tailscale, instalação da PWA, QR Code e notificações no iPhone, assinatura Developer ID e notarização.

**A instalação só estará validada depois de funcionar no seu MacBook.**

# Segurança

O Claude Hub decide se um comando roda na sua máquina. O modelo abaixo parte de uma premissa: **o celular só responde "sim" ou "não" a um pedido que o próprio Claude Code fez** — nunca envia comandos.

## Garantias e onde estão no código

| Requisito | Como é atendido | Teste |
|---|---|---|
| Mostrar o comando completo e o contexto | `describeToolCall` nunca trunca; o cartão mostra comando, ferramenta, projeto, sessão e pasta | `install.test.ts`, e2e "Ver detalhes" |
| Vincular a aprovação à sessão e ao pedido exatos | Cada pedido tem id aleatório de 128 bits e guarda `session_id` + entrada original da ferramenta; a decisão referencia esse id | `approvals.test.ts` |
| Exigir autenticação | Toda rota de API e o WebSocket exigem token; nada é enviado antes da autenticação | `security.test.ts` |
| Expiração | Pedido expira em 5 min (`approvalTimeoutSec`); depois disso a decisão é recusada e o terminal volta a perguntar | `approvals.test.ts` › expiração |
| Impedir aprovação duplicada | A decisão é um único `UPDATE … WHERE status='pending' AND expires_at > agora`; só a primeira vale, as demais recebem 409 | "impede decisão duplicada" |
| Auditoria | Tabela só-acréscimo com cadeia de hashes SHA-256; `claude-hub audit --verify` detecta edição ou remoção | `security.test.ts` › auditoria |
| Nunca aprovar sozinho | Não existe modo de aprovação automática. "Automático" só escolhe **para onde** o pedido vai | "não existe modo que aprove sozinho" |
| Nunca executar comandos vindos de notificações | O push carrega só título, texto e um link interno. A resposta ao Claude Code contém apenas `allow`/`deny` | "a resposta nunca altera o comando" |
| Respeitar as permissões do Claude Code | Usa o hook oficial `PermissionRequest`. Regras `deny`/`ask` do seu `settings.json` continuam valendo; o hub nunca devolve `updatedInput` nem `updatedPermissions` | idem |

## Superfícies e segredos

| Segredo | Onde fica | O que autoriza |
|---|---|---|
| `hookToken` | `~/.claude-hub/config.json` e `settings.json` do Claude Code (nos hooks e, se a medição de consumo estiver ligada, no cabeçalho do exportador de métricas) | Apenas enviar ao hub: eventos de hook, métricas de consumo e a leitura de limites. Não lê nada e não decide pedidos |
| `localToken` | `~/.claude-hub/config.json` (0600) | App macOS e CLI na porta local |
| Token do dispositivo | Só no iPhone; no hub fica o SHA-256 | API na porta do iPhone |
| Chave VAPID privada | `~/.claude-hub/config.json` | Assinar pushes |

- **Duas portas, duas superfícies.** A porta local (4317) recebe hooks, métricas de consumo, leitura de limites e administração; a porta do iPhone (4318) só serve a PWA e a API de dispositivos. A separação é por porta porque, atrás de um túnel, tudo chega de `127.0.0.1` — filtrar por IP não protegeria nada.
- **Ambas escutam só em `127.0.0.1`** por padrão. A porta do iPhone só sai do Mac pelo túnel que você configurar.
- **Pareamento.** Código de 8 caracteres, uso único, vale 10 min; 5 erros invalidam o código; mais de 10 erros por minuto bloqueiam novas tentativas. Gerar um código novo invalida o anterior.
- **Revogação.** `claude-hub revoke <id>` (ou a aba Sistema) corta o acesso na hora e apaga as assinaturas de push do aparelho.
- **WebSocket.** O token vai na primeira mensagem, não na URL (URLs acabam em logs e históricos).
- **Cabeçalhos.** CSP restritiva, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.

## Consumo, limites, monitor do Mac e widgets (0.4.0)

| Superfície | O que entra ou sai | Como é contido |
|---|---|---|
| `POST /otel/v1/metrics` (porta local) | Métricas OpenTelemetry do Claude Code | Exige o token de hook. O hub só aproveita duas métricas (`claude_code.token.usage` e `claude_code.cost.usage`) e guarda **contagens de tokens e custo por dia e por modelo** — nenhum prompt, resposta, nome de arquivo ou atributo de identificação. O resto do payload é descartado |
| `POST /statusline/claude-code` (porta local) | Limites do plano e uso do contexto | Exige o token de hook. A ponte repassa só `session_id`, `rate_limits` e `context_window`; o hub guarda percentual usado, horário de reinício, tamanho do contexto e o id da sessão |
| Variáveis de telemetria em `settings.json` | Ligam o exportador de métricas do Claude Code | O destino é sempre `http://127.0.0.1:<porta>` — nada vai para fora do Mac. Se já existir telemetria OpenTelemetry sua, o hub **não altera nada** |
| Linha de status | O Claude Code passa a chamar a ponte embutida | A ponte executa a sua linha de status original com o mesmo JSON e mostra a saída dela. Qualquer erro vira silêncio; ela nunca bloqueia a sessão |
| Ligar e desligar | Altera `settings.json` | Desligado por padrão. Liga-se na aba Uso, com confirmação e a explicação do que muda; backup datado; desligar (ou desinstalar) devolve o arquivo byte a byte — conferido no teste de instalação |
| Monitor do Mac | CPU, memória, disco, bateria, estado térmico | Só APIs públicas, lidas pelo próprio app. Nada é gravado, enviado ao hub ou à rede. Sem leitura com a ilha oculta |
| Widget de clima | Requisição https ao Open-Meteo | **Única chamada externa do app.** Revela ao Open-Meteo a coordenada da cidade que você escolheu, o texto digitado na busca de cidades e o seu IP. Não usa a localização do Mac. Sem cidade definida ou com o widget desligado, nenhuma requisição é feita |
| Widget de música — leitura | Avisos públicos do Música e do Spotify | Não exige permissão e não envia nada a lugar nenhum |
| Widget de música — controle | Apple Event (`playpause`, `next track`, `previous track`) | Só quando você clica num botão; só para o player que informou a faixa, e só se ele estiver aberto. O macOS pede o seu consentimento (Automação) na primeira vez; negar apenas desativa os botões. O texto do comando é fixo no código |
| Entitlement `com.apple.security.automation.apple-events` | Permite ao app enviar Apple Events sob hardened runtime | É o único entitlement do app (`Support/ClaudeHub.entitlements`); só tem efeito num build assinado com Developer ID. Não dispensa o consentimento do macOS |
| Abertura automática | O hook do `SessionStart` executa `open -g` no próprio `ClaudeHub.app` | O caminho é o do app onde o hook está embutido, não vem do payload. Pode ser desligada. Instância única garantida pelo sistema e pelo app |
| Notificações `dev.claudehub.mac.openTab.*` | Abrem o painel numa aba | Como as demais: só mudam o que está visível |

Os limites e o consumo exibidos **não são calculados pelo Claude Hub**: são os números que o Claude Code informou. Sem dado, a tela diz que não há dado.

## Instalação e serviço

| Ponto | Como é tratado |
|---|---|
| Privilégios | Tudo roda como o usuário atual. Nenhum passo usa `sudo`; o serviço é um LaunchAgent do usuário, não um daemon do sistema |
| O que o serviço executa | Apenas o Node embutido com o hub — sem shell no meio. Conferido no teste de instalação |
| `settings.json` do Claude Code | Na configuração, só os hooks do hub são acrescentados; backup datado antes de gravar; arquivo inválido não é tocado; nenhuma regra de permissão ou modo de permissão é alterado. As variáveis de telemetria e a linha de status só entram se você ligar consumo ou limites (seção acima) |
| Node embutido | Binário oficial, versão e SHA-256 fixados no build; o build falha se o arquivo baixado divergir |
| Verificação de saúde | Usa um pedido sintético, sempre respondido com "negar"; não existe comando por trás dele, não gera push e não conta como evento real |
| Automação do app | As notificações `dev.claudehub.mac.*` só abrem/fecham janelas e disparam a verificação de saúde (somente leitura). Não instalam, não pareiam e não decidem pedidos |
| Tailscale | `tailscale serve` só é executado quando você clica em "Ativar acesso pelo iPhone"; publica a porta dentro da sua rede privada, não na internet |
| QR de pareamento | Carrega um código de uso único (10 min). O manifesto dinâmico só aceita códigos no formato esperado; valores malformados são ignorados |
| Gatekeeper | O projeto não remove quarentena nem altera políticas do sistema. Ver `SIGNING_NOTARIZATION.md` |

## Ameaças consideradas

| Ameaça | Mitigação |
|---|---|
| Alguém na rede tenta aprovar um comando | Sem token de dispositivo, 401. A porta nem escuta fora de `127.0.0.1` |
| Página maliciosa no navegador do Mac faz `fetch` para `127.0.0.1:4317` | Sem token não passa; os tokens vão em cabeçalho `Authorization`, que o navegador não envia sozinho |
| Reenvio de uma decisão antiga | Id único + troca de estado atômica + expiração |
| Aprovar o pedido errado | A decisão referencia um id; o cartão mostra o comando daquele id |
| Push interceptado ou forjado | O push não decide nada. Abrir a PWA exige o token guardado no aparelho |
| Celular perdido | Revogar o dispositivo no Mac. O bloqueio de tela do iPhone é a primeira barreira |
| Hub comprometido tenta trocar o comando | O hub nunca devolve `updatedInput`; o Claude Code executa o que ele mesmo propôs |
| Adulteração do histórico | Cadeia de hashes na auditoria |
| Processo local forja consumo ou limites | Precisa do token de hook, que só quem já lê a sua pasta pessoal tem. O efeito máximo é um número errado na aba Uso; nada disso entra em decisão de permissão |
| Resposta adulterada do serviço de clima | Só alimenta o texto e os ícones do widget (temperaturas, códigos de tempo, nome da cidade); a conexão é https e nada da resposta é executado ou enviado ao hub |

## Limitações que você deve conhecer

1. **Quem tem acesso à sua conta no Mac lê `~/.claude-hub/config.json`.** O modelo protege contra a rede e contra outros dispositivos, não contra malware rodando como você.
2. **O conteúdo do push passa pelos servidores da Apple.** É cifrado de ponta a ponta pelo padrão Web Push, mas o comando (até 180 caracteres) faz parte dele. Se isso for sensível, use o modo "Só avisar" combinado com a ilha, ou mantenha a PWA aberta.
3. **A PWA não pede Face ID a cada aprovação.** A proteção é o bloqueio de tela do iPhone mais o token do dispositivo. Confirmação biométrica por pedido (WebAuthn) está no plano.
4. **Permitir é pontual.** Não há "permitir sempre" pelo celular, de propósito. Regras permanentes continuam sendo criadas no terminal do Claude Code.
5. **Aprovar remotamente um comando que você não entende é o maior risco real.** O cartão mostra o comando inteiro; leia antes de tocar.
6. **O token de hook fica em texto no `settings.json`** (nos hooks e, com a medição ligada, no cabeçalho do exportador). Ele só permite enviar dados ao hub local.
7. **O custo mostrado é a estimativa do Claude Code**, não a sua fatura; e os limites só aparecem quando o Claude Code os informa (sessão interativa, planos com limite por janela).

## Não verificado neste ambiente

- O túnel Tailscale e a entrega de push em um iPhone real (ver `TEST_REPORT.md`).
- **A ponte da linha de status numa sessão interativa real.** Ela foi executada como o Claude Code a executa (comando gravado no `settings.json`, JSON no stdin), mas com o exemplo da documentação oficial e valores de teste — nunca com os limites de uma conta de verdade. Se o formato real divergir do documentado, a aba Uso ficará sem dado (não mostrará número inventado).
- **A medição de consumo no app instalado, com uma sessão real.** O caminho foi provado com o Claude Code 2.1.329 em modo não interativo contra um hub de desenvolvimento, e no CI com métricas reais gravadas; não com o app instalado num Mac de uso.
- **Os controles de música e o pedido de Automação do macOS.** Nenhum botão foi clicado; o aviso de consentimento nunca foi visto. No CI o widget só recebeu um aviso de faixa simulado.
- **O entitlement de Apple Events sob hardened runtime**: só vale num build assinado com Developer ID, que nunca foi produzido.
- **Monitor do Mac e widgets num Mac real**: bateria (o runner do CI não tem), notch, valores ao longo de horas de uso, digitação na busca de cidades.
- **Abertura automática com uma sessão interativa**: no CI o hook gravado foi disparado pelo teste, não pelo Claude Code.
- O comportamento do diálogo de permissão do terminal **enquanto** o hook está em espera, em sessão interativa. O hub trata os dois desfechos possíveis (conexão fechada → pedido cancelado; tempo esgotado → terminal pergunta), mas a convivência em tela não foi observada.

# Conectar o iPhone

Tempo estimado: 10 minutos. Requisitos: iOS 16.4 ou mais novo e o Claude Hub já configurado no Mac (`INSTALL_MACOS.md`). Tudo é feito por telas — sem Terminal.

> **Status:** este roteiro não foi executado em um iPhone real — o ambiente de desenvolvimento não tem um. A PWA, o pareamento por QR e as aprovações foram testados em Chromium simulando um iPhone; o que falta você validar é o que só existe no aparelho: o Tailscale, a instalação na Tela de Início (inclusive se o iOS leva o código do QR para o app instalado) e a entrega de push. Checklist no fim.

## Por que precisa de um túnel https

O iPhone só permite instalar a PWA com notificações em endereço **https**. O hub escuta apenas em `127.0.0.1` do Mac. O **Tailscale** resolve os dois pontos sem servidor pago: cria uma rede privada entre seus aparelhos e entrega um endereço https com certificado válido. Só os seus dispositivos alcançam esse endereço.

## Passo a passo

### 1. Tailscale no Mac e no iPhone
1. Instale o Tailscale pela App Store no Mac e no iPhone.
2. Entre com a **mesma conta** nos dois.
3. No painel `login.tailscale.com` → **DNS**, ative **MagicDNS** e **HTTPS Certificates**.

### 2. Ligar o acesso pelo iPhone
No Mac: ícone do Claude Hub na barra de menus → **Configuração e saúde…** → bloco **5. iPhone** → **Ativar acesso pelo iPhone**.

O botão publica a porta do iPhone **apenas dentro da sua rede Tailscale**, com https, e grava o endereço no hub. Nada fica exposto à internet aberta. Se o Tailscale não estiver instalado ou conectado, ou se **HTTPS Certificates** estiver desativado na sua rede, o próprio bloco avisa e mostra o que fazer. Se ele não conseguir ler o estado do Tailscale, mostra a resposta exata que recebeu.

> Na versão 0.4.0 este bloco dizia "não está conectado" mesmo com o Tailscale conectado. Corrigido na 0.4.1.

### 3. Parear pelo QR Code
1. No mesmo bloco, clique em **Gerar QR de pareamento**. O código vale 10 minutos e só pode ser usado uma vez.
2. No iPhone, com o Tailscale ligado, aponte a câmera para o QR e abra o link no Safari.
3. A página pede para instalar o app: toque em **Compartilhar** → **Adicionar à Tela de Início**.
4. Abra o **Claude Hub** pelo ícone novo. Ele pareia sozinho, usando o código do QR.

Por que instalar antes: no iOS, o app da Tela de Início não compartilha dados com o Safari. O link do QR leva o código para dentro do app instalado, para você não precisar digitar nada. Se o pareamento automático não acontecer, digite o código de 8 caracteres mostrado ao lado do QR.

### 4. Ativar notificações
No app: **Ajustes** → **Ativar notificações** → **Permitir**. Depois toque em **Enviar teste**.

Desde a 0.4.3 o botão nunca fica sem resposta. Ele vira **Ativando…**, mostra a etapa em andamento e, se alguma etapa não responder, diz qual foi em até 15 segundos:

| Mensagem na tela | O que significa | O que fazer |
|---|---|---|
| "O iPhone não respondeu ao pedido de permissão" | O iOS não mostrou (ou você ainda não respondeu) o aviso de permissão | Se o aviso está na tela, responda. Se não apareceu: feche o app (deslize para cima), abra pelo ícone da Tela de Início e tente de novo. Persistindo: remova o ícone, reinstale pela página do QR e me envie o diagnóstico |
| "As notificações estão bloqueadas para este app" | A permissão foi negada antes | Ajustes do iPhone → Notificações → Claude Hub → permitir |
| "O serviço de notificações do app não ativou" | O service worker do app não ficou ativo | Fechar e reabrir o app pelo ícone |
| "A Apple não devolveu a inscrição de push" | O iPhone pediu a inscrição à Apple e não teve resposta | Conferir a internet do iPhone; tentar de novo |
| "O hub não respondeu…" / "não confirmou o registro" | O iPhone não alcançou o Mac | Conferir o Tailscale no iPhone e se o Mac está acordado |
| "o serviço de push (…) recusou o envio: 403 …" (em **Enviar teste**) | A Apple recusou o envio do hub; o motivo vem escrito | Me envie o diagnóstico |

Abaixo do botão ficam quatro linhas de estado — **Permissão do iPhone**, **Serviço de notificações do app**, **Inscrição neste aparelho** e **Aberto pela Tela de Início**. Se algo não funcionar, uma captura dessa tela já diz muito.

O iPhone também conta ao hub em que etapa parou. No Mac, **Configuração e saúde… → Copiar diagnóstico** traz a seção **[Notificações]** com: inscrições por aparelho, o último relato do iPhone e o resultado do último envio (com o código e o motivo da Apple, quando há recusa).

> **Situação honesta:** o pareamento já funcionou num iPhone de verdade, mas na 0.4.0 o toque em "Ativar notificações" não fazia nada visível. A causa no iPhone ainda **não foi identificada** — não tenho um iPhone para reproduzir. A 0.4.3 não promete resolver: ela garante que a tela e o diagnóstico digam em que etapa parou, que é o que falta para corrigir.

### Como a conexão é protegida

| Camada | Proteção |
|---|---|
| Rede | Só aparelhos da sua conta Tailscale alcançam o endereço; o tráfego é cifrado (WireGuard) e servido por https |
| Pareamento | Código de uso único, 10 minutos, 5 erros invalidam, rajadas são bloqueadas |
| Sessão | Token exclusivo do aparelho, guardado no hub apenas como hash; revogável no Mac |
| Decisão | Vinculada ao pedido exato; expira; só a primeira resposta vale; tudo fica na auditoria |

## Como usar

| Situação | No iPhone |
|---|---|
| Claude pede permissão | Chega a notificação "Claude quer usar Bash". Toque nela: o app abre no pedido, com o comando completo e os botões **Negar** / **Permitir** |
| Tarefa termina | Notificação "Terminou · projeto" |
| Claude tem uma pergunta | Notificação "Esperando você" — a resposta é dada no Mac |
| Ver o que está rodando | Aba **Sessões**; toque numa sessão para status, progresso e histórico |
| Ver limites do plano e consumo do Claude | Aba **Uso**. Só mostra o que o Claude Code informou; para ligar a leitura, use a aba Uso da ilha, no Mac |
| Ver o que foi aprovado | Aba **Histórico** |
| Sair de perto do Mac | **Ajustes** → **Estou longe do PC** |

Um pedido vale 5 minutos. Depois disso ele some do app e o Claude Code volta a perguntar no terminal.

## Limites do iPhone

- **Botões na própria notificação.** O iOS não mostra botões de ação em notificações de PWA — só em apps nativos. Aqui são dois toques: notificação → Permitir.
- **Fora de casa.** Funciona em qualquer rede, desde que o Tailscale esteja ligado no iPhone e o Mac esteja acordado. Mac dormindo não recebe nada: em viagens, deixe-o ligado na tomada e ajuste em Ajustes do Sistema → Bateria (ou Tela de Bloqueio) para ele não dormir.

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| "Ativar notificações" não aparece | App aberto pelo Safari, não pelo ícone | Abrir pelo ícone da Tela de Início |
| "Sem conexão com o Mac" | Tailscale desligado no iPhone ou Mac dormindo | Ligar o Tailscale; acordar o Mac |
| Código recusado | Expirou (10 min) ou já foi usado | Gerar outro QR |
| Push não chega, app aberto funciona | Assinatura de push inválida | Ajustes → Desativar → Ativar de novo |
| Voltou para a tela de pareamento | Dispositivo revogado no Mac | Parear de novo |

## Checklist de validação no iPhone real

- [ ] URL do Tailscale abre no Safari
- [ ] App instalado na Tela de Início abre em tela cheia
- [ ] Pareamento pelo QR funciona (o app instalado abre já pareado)
- [ ] Pareamento digitando o código funciona
- [ ] "Enviar teste" gera notificação
- [ ] Pedido real do Claude Code chega com o iPhone bloqueado
- [ ] Tocar na notificação abre o pedido certo
- [ ] **Permitir** libera o comando no Mac; **Negar** bloqueia
- [ ] Notificação de "Terminou" chega

## Caminho para um app iOS nativo

A API e o protocolo WebSocket usados pela PWA são os mesmos que um app nativo usaria (`packages/shared` descreve os contratos; `apps/macos/Sources/ClaudeHubCore` já os implementa em Swift sem dependência de AppKit e pode ser reaproveitado). Um app nativo acrescentaria: botões Negar/Permitir na tela de bloqueio, Face ID por aprovação e Live Activity. Exige conta de desenvolvedor Apple (paga) e envio de push via APNs — por isso ficou fora desta versão.

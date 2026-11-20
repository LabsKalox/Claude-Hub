import AppKit
import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

// MARK: - Peças

enum SetupBlockState {
    case ok
    case pending
    case problem
    case working
}

struct SetupStateIcon: View {
    let state: SetupBlockState
    var size: CGFloat = 17

    var body: some View {
        Group {
            switch state {
            case .ok:
                Image(systemName: "checkmark.circle.fill")
                    .font(Theme.font(size))
                    .foregroundStyle(Theme.green)
            case .pending:
                Image(systemName: "circle.dashed")
                    .font(Theme.font(size))
                    .foregroundStyle(Theme.textFaint)
            case .problem:
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(Theme.font(size))
                    .foregroundStyle(Theme.orange)
            case .working:
                ProgressView()
                    .controlSize(.small)
            }
        }
        .frame(width: 22, height: 22)
    }
}

/// Um dos cinco blocos numerados: ícone de estado, título, uma frase e o conteúdo.
struct SetupBlock<Content: View>: View {
    let number: Int
    let title: String
    let state: SetupBlockState
    let summary: String
    let content: Content

    init(number: Int, title: String, state: SetupBlockState, summary: String, @ViewBuilder content: () -> Content) {
        self.number = number
        self.title = title
        self.state = state
        self.summary = summary
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                SetupStateIcon(state: state)
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(number). \(title)")
                        .font(Theme.font(14, .bold))
                        .foregroundStyle(Color.white)
                    Text(summary)
                        .font(Theme.font(12))
                        .foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 8) {
                content
            }
            .padding(.leading, 32)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(Theme.cardBorder, lineWidth: 1))
    }
}

/// Linha de resultado (etapa da configuração ou checagem de saúde).
struct SetupResultRow: View {
    let ok: Bool
    let title: String
    let detail: String
    var trailing: String?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(Theme.font(12))
                .foregroundStyle(ok ? Theme.green : Theme.red)
                .frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(Theme.font(11.5, .semibold))
                    .foregroundStyle(Color.white)
                    .fixedSize(horizontal: false, vertical: true)
                if !detail.isEmpty {
                    Text(detail)
                        .font(Theme.font(11))
                        .foregroundStyle(ok ? Theme.textDim : Theme.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 6)
            if let trailing = trailing {
                Text(trailing)
                    .font(Theme.font(10.5, .medium))
                    .foregroundStyle(Theme.textFaint)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.field))
    }
}

/// Texto de apoio dentro de um bloco.
struct SetupNote: View {
    let text: String
    var color: Color = Theme.textDim

    init(_ text: String, color: Color = Theme.textDim) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(Theme.font(11.5))
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

/// Caminho ou URL em fonte monoespaçada, selecionável.
struct SetupMonoField: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Theme.mono(11))
            .foregroundStyle(Color.white)
            .lineLimit(2)
            .truncationMode(.middle)
            .textSelection(.enabled)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.field))
    }
}

// MARK: - Assistente

/// Configuração, verificação de saúde e pareamento, numa página só.
///
/// Cada bloco mostra o estado lido da CLI embutida, uma frase e no máximo uma
/// ação principal. O que falha aparece com o texto da própria CLI.
@MainActor
struct SetupAssistantView: View {
    @EnvironmentObject private var model: SetupModel
    @EnvironmentObject private var store: HubStore
    @State private var confirmingUninstall = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    applicationBlock
                        .id(1)
                    configurableBlocks
                    footer
                }
                .padding(18)
            }
            .onReceive(model.$scrollRequest) { target in
                guard let target = target else { return }
                Task { @MainActor in
                    withAnimation(.easeInOut(duration: 0.25)) {
                        proxy.scrollTo(target, anchor: .top)
                    }
                    model.scrollRequest = nil
                }
            }
        }
        .frame(minWidth: 520, idealWidth: 560, minHeight: 460, idealHeight: 640)
        .background(Color(hex: "#090A0D"))
        .preferredColorScheme(.dark)
        .alert("Desinstalar o Claude Hub?", isPresented: $confirmingUninstall) {
            Button("Desinstalar e manter os dados", role: .destructive) {
                model.uninstallAll(purge: false)
            }
            Button("Desinstalar e apagar os dados", role: .destructive) {
                model.uninstallAll(purge: true)
            }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Remove do Claude Code os hooks do Claude Hub, desliga o serviço do hub e tira o app da abertura no login. Seus outros hooks e configurações ficam como estão. \"Apagar os dados\" remove também o histórico, os pareamentos e os segredos locais (pasta ~/.claude-hub).")
        }
    }

    private var configurableBlocks: some View {
        VStack(alignment: .leading, spacing: 12) {
            claudeBlock
                .id(2)
            integrationBlock
                .id(3)
            healthBlock
                .id(4)
            phoneBlock
                .id(5)
            agentsBlock
                .id(6)
        }
        .disabled(!model.canConfigure)
        .opacity(model.canConfigure ? 1 : 0.4)
    }

    // MARK: Cabeçalho

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            AppBadge(size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text("Configuração do Claude Hub")
                    .font(Theme.font(18, .bold))
                    .foregroundStyle(Color.white)
                Text("Cinco passos, do app ao iPhone. Nada é alterado sem o seu clique.")
                    .font(Theme.font(12))
                    .foregroundStyle(Theme.textDim)
            }
            Spacer(minLength: 8)
            if model.isBusy {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.bottom, 2)
    }

    // MARK: Botões

    private func primaryButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(PillButtonStyle(background: Theme.blue, fontSize: 12.5, horizontalPadding: 16, verticalPadding: 7))
            .disabled(model.isBusy)
            .opacity(model.isBusy ? 0.5 : 1)
    }

    private func secondaryButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(PillButtonStyle(background: Theme.buttonNeutral, fontSize: 12, horizontalPadding: 14, verticalPadding: 6))
            .disabled(model.isBusy)
            .opacity(model.isBusy ? 0.5 : 1)
    }

    private func openLink(_ address: String) {
        if let url = URL(string: address) {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: 1. Aplicativo

    private var applicationState: SetupBlockState {
        if model.runtimeMissing { return .problem }
        guard let status = model.status else {
            if model.statusError != nil { return .problem }
            return model.hasLoaded ? .pending : .working
        }
        return status.runtime.locationBlocked ? .problem : .ok
    }

    private var applicationSummary: String {
        if model.runtimeMissing {
            return "Runtime não embutido neste build. Este é um build de desenvolvimento: instale pelo .dmg ou defina CLAUDE_HUB_RUNTIME_DIR com a pasta do runtime."
        }
        guard let status = model.status else {
            if let error = model.statusError { return error }
            return "Lendo o estado da instalação…"
        }
        if status.runtime.locationBlocked {
            return "Arraste o Claude Hub para a pasta Aplicativos e abra de lá."
        }
        let version = status.version.map { "Claude Hub \($0)" } ?? "Claude Hub"
        let node = status.runtime.nodeVersion ?? "versão desconhecida"
        if status.runtime.bundled {
            return "\(version) em Aplicativos, com Node \(node) embutido."
        }
        return "\(version), usando o Node \(node) de fora do app."
    }

    private var applicationBlock: some View {
        SetupBlock(number: 1, title: "Aplicativo", state: applicationState, summary: applicationSummary) {
            applicationDetail
        }
    }

    @ViewBuilder
    private var applicationDetail: some View {
        if let status = model.status, status.runtime.locationBlocked {
            SetupNote("O serviço do hub e os hooks do Claude Code guardam o caminho do app. Fora de Aplicativos — ou aberto direto do .dmg — esse caminho muda e a integração para de funcionar. Por isso os próximos passos ficam bloqueados.")
            if let path = status.runtime.appPath {
                SetupMonoField(text: path)
            }
            primaryButton("Abrir a pasta Aplicativos") {
                NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications", isDirectory: true))
            }
        } else if model.status == nil, model.statusError != nil, !model.runtimeMissing {
            primaryButton("Tentar de novo") {
                model.refresh()
            }
        }
    }

    // MARK: 2. Claude Code

    private var claudeState: SetupBlockState {
        guard let status = model.status else { return .pending }
        return status.claude.found ? .ok : .problem
    }

    private var claudeSummary: String {
        guard let status = model.status else {
            return "O assistente procura o Claude Code instalado neste Mac."
        }
        if status.claude.found {
            let version = status.claude.version.map { "Claude Code \($0)" } ?? "Claude Code"
            if let path = status.claude.path {
                return "\(version) encontrado em \(path)."
            }
            return "\(version) encontrado."
        }
        return "Claude Code não encontrado neste Mac. Sem ele não há sessões para acompanhar — você pode continuar e instalá-lo depois."
    }

    private var claudeBlock: some View {
        SetupBlock(number: 2, title: "Claude Code", state: claudeState, summary: claudeSummary) {
            claudeDetail
        }
    }

    @ViewBuilder
    private var claudeDetail: some View {
        if let status = model.status, !status.claude.found {
            secondaryButton("Como instalar o Claude Code") {
                openLink("https://code.claude.com/docs")
            }
        }
    }

    // MARK: 3. Serviço e hooks

    private var integrationState: SetupBlockState {
        guard let status = model.status else { return .pending }
        if !status.claude.settingsValid { return .problem }
        if model.busy == .setup { return .working }
        if status.integrationConfigured { return .ok }
        return model.setupError == nil ? .pending : .problem
    }

    private var integrationSummary: String {
        guard let status = model.status else {
            return "Liga o hub como serviço deste Mac e instala os hooks oficiais do Claude Code."
        }
        if !status.claude.settingsValid {
            return "O arquivo de configurações do Claude Code não é um JSON válido. Para não arriscar o que já está lá, nada será alterado até ele ser corrigido."
        }
        if model.busy == .setup {
            return "Configurando o serviço do hub e os hooks…"
        }
        if status.integrationConfigured {
            return "Tudo configurado: serviço do hub ativo e \(status.hooks.events) eventos de hook instalados."
        }
        let missing = status.missingParts
        if missing.isEmpty {
            return "A integração ainda não está completa."
        }
        return "Falta configurar: \(missing.joined(separator: "; "))."
    }

    private var integrationBlock: some View {
        SetupBlock(number: 3, title: "Serviço e hooks", state: integrationState, summary: integrationSummary) {
            integrationDetail
        }
    }

    @ViewBuilder
    private var integrationDetail: some View {
        if let status = model.status {
            SetupNote("Suas configurações existentes são preservadas e um backup é gravado antes de qualquer alteração em:")
            SetupMonoField(text: status.claude.settingsPath)
            if status.claude.otherHooks > 0 {
                SetupNote(status.claude.otherHooks == 1
                    ? "1 hook seu foi encontrado e continua como está."
                    : "\(status.claude.otherHooks) hooks seus foram encontrados e continuam como estão.")
            }
            if !status.service.supported {
                SetupNote("Este sistema não oferece o serviço de inicialização (launchd); o hub precisará ser iniciado à mão.", color: Theme.orange)
            }
            ForEach(Array(model.setupSteps.enumerated()), id: \.offset) { item in
                SetupResultRow(ok: item.element.ok, title: item.element.title, detail: item.element.detail)
            }
            if let error = model.setupError {
                SetupNote(error, color: Theme.red)
            }
            if status.claude.settingsValid {
                if status.integrationConfigured {
                    secondaryButton("Reparar") {
                        model.runSetup()
                    }
                } else {
                    primaryButton("Configurar agora") {
                        model.runSetup()
                    }
                }
            }
        }
    }

    // MARK: 4. Verificação de saúde

    private var healthState: SetupBlockState {
        if model.busy == .selfTest { return .working }
        guard let result = model.selfTest else {
            return model.selfTestError == nil ? .pending : .problem
        }
        return result.ok ? .ok : .problem
    }

    private var healthSummary: String {
        if model.busy == .selfTest {
            return "Verificando… leva alguns segundos."
        }
        guard let result = model.selfTest else {
            return "Confirma de ponta a ponta que o hub responde, que os eventos chegam e que um pedido de permissão recebe resposta."
        }
        let total = result.checks.count
        if result.ok {
            // Itens opcionais (evento real, notificações do iPhone) podem estar pendentes sem reprovar o conjunto.
            let passed = result.checks.filter { $0.ok }.count
            if passed < total {
                return "O essencial funciona: \(passed) de \(total) checagens passaram. Veja abaixo o que falta."
            }
            return total == 1 ? "Tudo funcionando: 1 checagem passou." : "Tudo funcionando: \(total) checagens passaram."
        }
        return "\(result.failedCount) de \(total) checagens falharam."
    }

    private var healthBlock: some View {
        SetupBlock(number: 4, title: "Verificação de saúde", state: healthState, summary: healthSummary) {
            healthDetail
        }
    }

    private var lastHookLine: String {
        let now = HubFormat.nowMs() + store.state.clockSkew
        if let text = SetupJSON.lastHookText(lastHookAt: model.status?.hub.lastHookAt, now: now) {
            return "Último evento real do Claude Code: \(text)."
        }
        return "Último evento real do Claude Code: ainda nenhum — abra uma sessão do Claude Code para confirmar."
    }

    @ViewBuilder
    private var healthDetail: some View {
        SetupNote("O autoteste usa um pedido de permissão sintético, que é sempre negado e não executa nenhum comando.")
        SetupNote(lastHookLine)
        if let result = model.selfTest {
            ForEach(Array(result.checks.enumerated()), id: \.offset) { item in
                SetupResultRow(
                    ok: item.element.ok,
                    title: item.element.title,
                    detail: item.element.detail,
                    trailing: item.element.ms.map { "\(Int($0.rounded())) ms" }
                )
            }
        }
        if let error = model.selfTestError {
            SetupNote(error, color: Theme.red)
        }
        if let message = model.diagnosticsMessage {
            SetupNote(message, color: model.diagnosticsFailed ? Theme.red : Theme.textDim)
        }
        HStack(spacing: 8) {
            primaryButton("Verificar agora") {
                model.runSelfTest()
            }
            secondaryButton("Copiar diagnóstico") {
                model.copyDiagnostics()
            }
            secondaryButton("Abrir log do hub") {
                model.openHubLog()
            }
        }
    }

    // MARK: 6. Outros agentes

    private var agentsState: SetupBlockState {
        if model.busy == .agent { return .working }
        if model.agentError != nil { return .problem }
        guard let agents = model.status?.agents else { return .pending }
        let on = [agents.codex, agents.opencode].filter { $0.installed }
        if on.contains(where: { !$0.current }) { return .problem }
        return on.isEmpty ? .pending : .ok
    }

    private var agentsSummary: String {
        guard let agents = model.status?.agents else {
            return "Acompanhe também sessões do Codex CLI e do OpenCode, com os mesmos pedidos de permissão na ilha e no iPhone."
        }
        let names = [("Codex", agents.codex), ("OpenCode", agents.opencode)].filter { $0.1.installed }.map { $0.0 }
        if names.isEmpty {
            return "Opcional. Acompanhe também o Codex CLI e o OpenCode, com os mesmos pedidos de permissão na ilha e no iPhone."
        }
        return "Ligado para: \(names.joined(separator: " e "))."
    }

    private var agentsBlock: some View {
        SetupBlock(number: 6, title: "Codex e OpenCode", state: agentsState, summary: agentsSummary) {
            if let agents = model.status?.agents {
                agentRow(
                    name: "Codex",
                    id: "codex",
                    agent: agents.codex,
                    note: "Grava hooks em ~/.codex/hooks.json (os seus ficam). Na próxima sessão, o Codex pede para você revisar e confiar nos hooks novos: aprove para funcionar."
                )
                agentRow(
                    name: "OpenCode",
                    id: "opencode",
                    agent: agents.opencode,
                    note: "Copia um plugin para ~/.config/opencode/plugins. O opencode.json não é alterado."
                )
            }
            if let message = model.agentMessage {
                SetupNote(message)
            }
            if let error = model.agentError {
                SetupNote(error, color: Theme.red)
            }
        }
    }

    @ViewBuilder
    private func agentRow(name: String, id: String, agent: SetupAgent, note: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SwitchRow(
                title: name,
                subtitle: agent.found
                    ? "Encontrado\(agent.version.map { " (\($0))" } ?? "")\(agent.installed && !agent.current ? " · desatualizado: use Reparar no bloco 3" : "")"
                    : "Não encontrado neste Mac\(agent.installed ? " · integração ligada" : "")",
                isOn: Binding(
                    get: { agent.installed },
                    set: { model.setAgent(id, on: $0) }
                )
            )
            .disabled(model.busy != nil || !agent.configValid)
            if !agent.configValid {
                SetupNote("O arquivo \(agent.configPath ?? "") não é um JSON válido; nada será alterado até ele ser corrigido.", color: Theme.red)
            } else if !agent.installed {
                SetupNote(note)
            }
        }
    }

    // MARK: 5. iPhone

    private var phoneState: SetupBlockState {
        if model.busy == .tunnel || model.busy == .pairing { return .working }
        if !store.devices.isEmpty { return .ok }
        if let status = model.status, status.devices > 0 { return .ok }
        if model.tunnelError != nil || model.pairingError != nil { return .problem }
        return .pending
    }

    private var phoneSummary: String {
        guard let status = model.status else {
            return "Pareie o iPhone por QR para acompanhar e responder pedidos de longe."
        }
        if status.tunnel.publicUrl != nil {
            let count = max(status.devices, store.devices.count)
            if count == 0 {
                return "Acesso pelo iPhone ativo. Falta parear o aparelho."
            }
            return count == 1 ? "1 iPhone pareado." : "\(count) iPhones pareados."
        }
        switch status.tunnel.tailscale {
        case .missing:
            return "O iPhone precisa de um endereço https seguro para chegar a este Mac. O Tailscale fornece isso sem expor nada à internet."
        case .unknown:
            return "O Tailscale está instalado, mas não consegui ler o estado dele."
        case .stopped:
            return "O Tailscale está instalado, mas não está conectado. Abra-o, entre na sua conta e toque em Atualizar."
        case .running:
            if status.tunnel.httpsDisabled {
                return "O Tailscale está conectado, mas o HTTPS está desativado na sua rede."
            }
            return "O Tailscale está conectado. Falta ativar o acesso pelo iPhone."
        }
    }

    private var phoneBlock: some View {
        SetupBlock(number: 5, title: "iPhone", state: phoneState, summary: phoneSummary) {
            phoneDetail
        }
    }

    @ViewBuilder
    private var phoneDetail: some View {
        if let status = model.status {
            if let url = status.tunnel.publicUrl {
                SetupMonoField(text: url)
                pairingArea
                devicesArea
            } else {
                tunnelArea(status.tunnel)
            }
            if let message = model.tunnelMessage {
                SetupNote(message)
            }
            if let error = model.tunnelError {
                SetupNote(error, color: Theme.red)
            }
        }
    }

    @ViewBuilder
    private func tunnelArea(_ tunnel: SetupTunnel) -> some View {
        switch tunnel.tailscale {
        case .missing:
            SetupNote("Instale o Tailscale neste Mac e no iPhone, com a mesma conta, e volte aqui.")
            secondaryButton("Baixar o Tailscale") {
                openLink("https://tailscale.com/download")
            }
        case .unknown:
            // Não dá para afirmar que está desconectado: mostra o que o Tailscale respondeu.
            SetupNote("Resposta do Tailscale:")
            // Texto inteiro, sem cortar: é ele que diz o que está errado.
            Text(tunnel.detail ?? "(sem resposta)")
                .font(Theme.mono(11))
                .foregroundStyle(Color.white)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.field))
            SetupNote("Abra o Tailscale, confira se está conectado e toque em Atualizar. Se continuar, use Copiar diagnóstico no bloco 4.")
            secondaryButton("Abrir o Tailscale") {
                openTailscale()
            }
        case .stopped:
            secondaryButton("Abrir o Tailscale") {
                openTailscale()
            }
        case .running:
            if let name = tunnel.dnsName {
                SetupMonoField(text: name)
            }
            if tunnel.httpsDisabled {
                SetupNote("Ative HTTPS Certificates em https://login.tailscale.com/admin/dns e toque em Atualizar. Sem isso o Tailscale não publica um endereço https para o iPhone.")
                secondaryButton("Abrir o painel do Tailscale") {
                    openLink("https://login.tailscale.com/admin/dns")
                }
            } else {
                SetupNote("Publica a porta do iPhone apenas dentro da sua rede Tailscale, com https. Nada fica acessível pela internet aberta.")
                primaryButton("Ativar acesso pelo iPhone") {
                    model.enableTunnel()
                }
            }
        }
    }

    private func openTailscale() {
        let workspace = NSWorkspace.shared
        for identifier in ["io.tailscale.ipn.macsys", "io.tailscale.ipn.macos"] {
            if let url = workspace.urlForApplication(withBundleIdentifier: identifier) {
                workspace.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
                return
            }
        }
        openLink("https://tailscale.com/download")
    }

    @ViewBuilder
    private var pairingArea: some View {
        if let pairing = model.pairing {
            HStack(alignment: .top, spacing: 14) {
                pairingQR(pairing)
                    .frame(width: 168, height: 168)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Código de uso único")
                        .font(Theme.font(10.5))
                        .foregroundStyle(Theme.textDim)
                    Text(pairing.code)
                        .font(Font.system(size: 22, weight: .bold, design: .monospaced))
                        .foregroundStyle(Color.white)
                        .textSelection(.enabled)
                    Ticking(every: 1) { now in
                        Text(PairingView.expiryText(expiresAt: pairing.expiresAt, now: now + store.state.clockSkew))
                            .font(Theme.font(10.5, .medium))
                            .foregroundStyle(Theme.textFaint)
                            .monospacedDigit()
                    }
                    SetupNote("No iPhone: aponte a câmera, toque em Compartilhar → Adicionar à Tela de Início e abra o app — ele pareia sozinho.")
                    if pairing.url == nil {
                        SetupNote("O hub não devolveu o link do QR. Abra o endereço acima no iPhone e digite o código.", color: Theme.orange)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        if let message = model.pairedMessage {
            SetupNote(message, color: Theme.green)
        }
        if let error = model.pairingError {
            SetupNote(error, color: Theme.red)
        }
        primaryButton(model.pairing == nil ? "Gerar QR de pareamento" : "Gerar novo QR") {
            model.generatePairing()
        }
    }

    @ViewBuilder
    private func pairingQR(_ pairing: PairingInfo) -> some View {
        if let link = pairing.url, let image = QRCode.image(for: link) {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(9)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white))
        } else {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Theme.field)
                .overlay(
                    Image(systemName: "qrcode")
                        .font(Theme.font(40))
                        .foregroundStyle(Theme.textFaint)
                )
        }
    }

    @ViewBuilder
    private var devicesArea: some View {
        if !store.devices.isEmpty {
            SectionTitle("IPHONES PAREADOS")
                .padding(.top, 2)
            ForEach(store.devices) { device in
                HStack(spacing: 8) {
                    Image(systemName: "iphone")
                        .font(Theme.font(12))
                        .foregroundStyle(Theme.textDim)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(device.name)
                            .font(Theme.font(11.5, .semibold))
                            .foregroundStyle(Color.white)
                            .lineLimit(1)
                        Text(device.pushEnabled ? "notificações ativas" : "sem notificações")
                            .font(Theme.font(10.5))
                            .foregroundStyle(Theme.textFaint)
                    }
                    Spacer(minLength: 6)
                    Button("Revogar") {
                        model.revoke(device)
                    }
                    .buttonStyle(PillButtonStyle(background: Theme.buttonNeutral, fontSize: 10.5, horizontalPadding: 10, verticalPadding: 4))
                    .disabled(model.isBusy)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.field))
            }
        }
    }

    // MARK: Rodapé

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                SwitchRow(
                    title: "Abrir no login",
                    subtitle: model.launchFailed ? "O macOS recusou. Mova o app para Aplicativos e tente de novo." : nil,
                    isOn: Binding(
                        get: { model.launchAtLogin },
                        set: { model.setLaunchAtLogin($0) }
                    )
                )
                Spacer(minLength: 8)
                secondaryButton("Atualizar") {
                    store.refreshSystem()
                    model.refresh()
                }
            }
            ForEach(Array(model.uninstallSteps.enumerated()), id: \.offset) { item in
                SetupResultRow(ok: item.element.ok, title: item.element.title, detail: item.element.detail)
            }
            if let message = model.uninstallMessage {
                SetupNote(message, color: model.uninstallFailed ? Theme.red : Theme.textDim)
            }
            if model.uninstalled {
                SetupNote("Para terminar, mande o aplicativo para o Lixo. Para voltar a usar, clique em \"Configurar agora\" no bloco 3.")
                if model.trashFailed {
                    SetupNote("Não consegui mover o app. Arraste o Claude Hub da pasta Aplicativos para o Lixo.", color: Theme.red)
                }
                secondaryButton("Mover o app para o Lixo e sair") {
                    model.moveAppToTrashAndQuit()
                }
            }
            Button("Desinstalar…") {
                confirmingUninstall = true
            }
            .buttonStyle(TextLinkButtonStyle())
            .disabled(model.isBusy || model.runtimeMissing)
            .opacity(model.isBusy || model.runtimeMissing ? 0.5 : 1)
        }
        .padding(.top, 4)
        .padding(.horizontal, 2)
    }
}

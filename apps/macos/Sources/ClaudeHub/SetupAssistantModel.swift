import AppKit
import Combine
import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Comando da CLI em andamento (um por vez).
enum SetupAction: Equatable {
    case status
    case setup
    case selfTest
    case tunnel
    case agent
    case pairing
    case uninstall
    case diagnostics
}

/// Estado do assistente de configuração.
///
/// O app não decide nada aqui: cada ação roda um comando da CLI embutida e
/// mostra o que ela devolveu, com o texto de erro da própria CLI. Nenhum
/// comando deste arquivo aprova pedidos nem muda o modo de permissão do
/// Claude Code.
@MainActor
final class SetupModel: ObservableObject {
    @Published private(set) var status: SetupStatus?
    @Published private(set) var statusError: String?
    @Published private(set) var runtimeMissing = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var busy: SetupAction?

    // Bloco 3 — serviço e hooks
    @Published private(set) var setupSteps: [SetupStep] = []
    @Published private(set) var setupError: String?

    // Bloco 4 — saúde
    @Published private(set) var selfTest: SelfTestResult?
    @Published private(set) var selfTestError: String?

    @Published private(set) var diagnosticsMessage: String?
    @Published private(set) var diagnosticsFailed = false

    // Bloco 5 — iPhone
    @Published private(set) var agentMessage: String?
    @Published private(set) var agentError: String?
    @Published private(set) var tunnelMessage: String?
    @Published private(set) var tunnelError: String?
    @Published private(set) var pairing: PairingInfo?
    @Published private(set) var pairingError: String?
    @Published private(set) var pairedMessage: String?

    // Rodapé
    @Published private(set) var uninstallSteps: [SetupStep] = []
    @Published private(set) var uninstallMessage: String?
    @Published private(set) var uninstallFailed = false
    /// A integração acabou de ser removida com sucesso: oferece mandar o app para o Lixo.
    @Published private(set) var uninstalled = false
    @Published private(set) var trashFailed = false
    @Published private(set) var launchAtLogin = LaunchAtLogin.isEnabled
    @Published private(set) var launchFailed = false

    /// Bloco para o qual a janela deve rolar (5 = iPhone); a vista zera depois.
    @Published var scrollRequest: Int?

    let store: HubStore
    private var autoOpened = false
    private var pairingWatch: Task<Void, Never>?

    init(store: HubStore) {
        self.store = store
    }

    var isBusy: Bool {
        return busy != nil
    }

    /// App fora de Aplicativos (ou aberto direto do .dmg): nada mais pode ser configurado.
    var locationBlocked: Bool {
        return status?.runtime.locationBlocked ?? false
    }

    /// Blocos 2 a 5 só fazem sentido com runtime embutido, estado lido e app no lugar certo.
    var canConfigure: Bool {
        return !runtimeMissing && status != nil && !locationBlocked
    }

    // MARK: - Estado

    /// Relê `setup status`. Chamado ao abrir a janela e depois de cada ação.
    func refresh() {
        guard busy == nil else { return }
        busy = .status
        Task { [weak self] in
            guard let model = self else { return }
            await model.loadStatus()
            model.busy = nil
        }
    }

    private func loadStatus() async {
        guard RuntimeCLI.isAvailable else {
            runtimeMissing = true
            status = nil
            statusError = nil
            hasLoaded = true
            return
        }
        runtimeMissing = false
        do {
            let fresh = try await RuntimeCLI.run(SetupStatus.self, ["setup", "status"])
            if let failure = fresh.failure {
                status = nil
                statusError = failure
            } else {
                status = fresh
                statusError = nil
            }
        } catch {
            status = nil
            statusError = RuntimeCLIError.describe(error)
        }
        hasLoaded = true
        launchAtLogin = LaunchAtLogin.isEnabled
    }

    /// Na abertura do app: se a integração não está pronta, mostra o assistente
    /// (uma vez por execução). Builds sem runtime embutido não abrem nada.
    func checkOnLaunch() {
        guard RuntimeCLI.isAvailable else { return }
        if ProcessInfo.processInfo.environment["CLAUDE_HUB_NO_AUTO_SETUP"] == "1" { return }
        guard !autoOpened, busy == nil else { return }
        busy = .status
        Task { [weak self] in
            guard let model = self else { return }
            await model.loadStatus()
            model.busy = nil
            let ready = model.status?.ready ?? false
            if !ready && !model.autoOpened {
                model.autoOpened = true
                SetupWindowController.shared.show()
            }
        }
    }

    // MARK: - Bloco 3: serviço e hooks

    /// Instala o serviço do hub e os hooks do Claude Code (`setup run`).
    /// A CLI preserva o settings.json existente e grava um backup antes.
    func runSetup() {
        uninstalled = false
        guard busy == nil, canConfigure else { return }
        if status?.claude.settingsValid == false { return }
        busy = .setup
        setupError = nil
        setupSteps = []
        Task { [weak self] in
            guard let model = self else { return }
            do {
                let result = try await RuntimeCLI.run(SetupRunResult.self, ["setup", "run"], timeout: 120)
                model.setupSteps = result.steps
                if let fresh = result.status, fresh.failure == nil {
                    model.status = fresh
                }
                if !result.ok {
                    model.setupError = result.detail ?? model.firstFailure(in: result.steps)
                        ?? "A configuração não foi concluída."
                }
            } catch {
                model.setupError = RuntimeCLIError.describe(error)
            }
            // O hub pode ter acabado de subir: o app tenta conectar já.
            model.store.retryConnection()
            await model.loadStatus()
            model.busy = nil
        }
    }

    private func firstFailure(in steps: [SetupStep]) -> String? {
        guard let failed = steps.first(where: { !$0.ok }) else { return nil }
        return failed.detail.isEmpty ? failed.title : failed.detail
    }

    // MARK: - Bloco 4: verificação de saúde

    /// Roda `selftest`: usa um pedido sintético, sempre negado, que não executa nada.
    func runSelfTest() {
        guard busy == nil, canConfigure else { return }
        busy = .selfTest
        selfTestError = nil
        Task { [weak self] in
            guard let model = self else { return }
            do {
                let result = try await RuntimeCLI.run(SelfTestResult.self, ["selftest"], timeout: 60)
                model.selfTest = result
                if !result.ok, result.checks.isEmpty {
                    model.selfTestError = result.detail ?? "A verificação não devolveu nenhuma checagem."
                } else if !result.ok, let detail = result.detail {
                    model.selfTestError = detail
                }
            } catch {
                model.selfTest = nil
                model.selfTestError = RuntimeCLIError.describe(error)
            }
            await model.loadStatus()
            model.busy = nil
        }
    }

    /// Gera o relatório de diagnóstico (`diagnostics`) e o copia para a área de
    /// transferência. O relatório não contém tokens nem chaves.
    func copyDiagnostics() {
        guard busy == nil, !runtimeMissing else { return }
        busy = .diagnostics
        diagnosticsMessage = nil
        diagnosticsFailed = false
        Task { [weak self] in
            guard let model = self else { return }
            do {
                let result = try await RuntimeCLI.run(DiagnosticsResult.self, ["diagnostics"], timeout: 90)
                if result.report.isEmpty {
                    model.diagnosticsFailed = true
                    model.diagnosticsMessage = result.detail ?? "O diagnóstico veio vazio."
                } else {
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setString(result.report, forType: .string)
                    model.diagnosticsMessage = "Diagnóstico copiado. Cole numa mensagem para enviar — ele não contém senhas nem tokens."
                }
            } catch {
                model.diagnosticsFailed = true
                model.diagnosticsMessage = RuntimeCLIError.describe(error)
            }
            model.busy = nil
        }
    }

    /// Abre o log do hub no aplicativo padrão (Console ou Editor de Texto).
    func openHubLog() {
        let log = HubConfig.homeDirectory().appendingPathComponent("hub.log", isDirectory: false)
        if FileManager.default.fileExists(atPath: log.path) {
            NSWorkspace.shared.open(log)
        } else {
            diagnosticsFailed = true
            diagnosticsMessage = "Ainda não existe log: o serviço do hub nunca foi iniciado neste Mac."
        }
    }

    /// Usado pela automação: a janela acabou de abrir e pode estar relendo o
    /// estado; espera esse comando terminar (até ~20 s) e então verifica.
    func runSelfTestWhenIdle() {
        Task { [weak self] in
            var attempts = 0
            while attempts < 100 {
                guard let model = self else { return }
                if model.busy == nil { break }
                attempts += 1
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            self?.runSelfTest()
        }
    }

    // MARK: - Bloco 6: outros agentes

    /// Liga ou desliga a integração com o Codex ou o OpenCode (`agents set`). Só por clique.
    func setAgent(_ agent: String, on: Bool) {
        guard busy == nil, canConfigure, agent == "codex" || agent == "opencode" else { return }
        busy = .agent
        agentError = nil
        agentMessage = nil
        Task { [weak self] in
            guard let model = self else { return }
            do {
                let result = try await RuntimeCLI.run(CommandResult.self, ["agents", "set", agent, on ? "on" : "off"], timeout: 30)
                if result.ok {
                    model.agentMessage = result.detail
                } else {
                    model.agentError = result.detail.isEmpty ? "Não foi possível alterar a integração." : result.detail
                }
            } catch {
                model.agentError = RuntimeCLIError.describe(error)
            }
            await model.loadStatus()
            model.busy = nil
        }
    }

    // MARK: - Bloco 5: iPhone

    /// Publica a porta do iPhone na rede Tailscale do usuário (`tunnel enable`).
    /// Só roda por clique explícito.
    func enableTunnel() {
        guard busy == nil, canConfigure else { return }
        busy = .tunnel
        tunnelError = nil
        tunnelMessage = nil
        Task { [weak self] in
            guard let model = self else { return }
            do {
                let result = try await RuntimeCLI.run(CommandResult.self, ["tunnel", "enable"], timeout: 90)
                if result.ok {
                    model.tunnelMessage = result.detail.isEmpty ? "Acesso pelo iPhone ativado." : result.detail
                } else {
                    model.tunnelError = result.detail.isEmpty ? "Não foi possível ativar o acesso pelo iPhone." : result.detail
                }
            } catch {
                model.tunnelError = RuntimeCLIError.describe(error)
            }
            // A CLI reinicia o hub para aplicar a URL.
            model.store.retryConnection()
            await model.loadStatus()
            model.busy = nil
        }
    }

    /// Pede ao hub um código de pareamento de uso único (POST /local/pairing).
    func generatePairing() {
        guard busy == nil, canConfigure else { return }
        busy = .pairing
        pairingError = nil
        pairedMessage = nil
        pairing = nil
        pairingWatch?.cancel()
        let baseURL = status?.tunnel.publicUrl
        let knownDevices = Set(store.devices.map { $0.id })
        Task { [weak self] in
            guard let model = self else { return }
            do {
                let info = try await model.store.createPairing(baseURL: baseURL)
                model.pairing = info
                model.watchForNewDevice(known: knownDevices, expiresAt: info.expiresAt)
            } catch {
                model.pairingError = "Não foi possível gerar o código de pareamento. O hub está no ar?"
            }
            model.busy = nil
        }
    }

    /// Enquanto o QR está na tela, confere de tempos em tempos se o iPhone pareou.
    private func watchForNewDevice(known: Set<String>, expiresAt: Double) {
        pairingWatch?.cancel()
        pairingWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard let model = self, !Task.isCancelled, model.pairing != nil else { return }
                let devices = await model.store.loadDevices()
                if let added = devices.first(where: { !known.contains($0.id) }) {
                    model.pairing = nil
                    model.pairedMessage = "iPhone pareado: \(added.name)."
                    await model.loadStatus()
                    return
                }
                if HubFormat.nowMs() + model.store.state.clockSkew > expiresAt {
                    return
                }
            }
        }
    }

    func dismissPairing() {
        pairingWatch?.cancel()
        pairingWatch = nil
        pairing = nil
    }

    func revoke(_ device: DeviceInfo) {
        store.revokeDevice(device)
    }

    // MARK: - Rodapé

    func setLaunchAtLogin(_ enabled: Bool) {
        launchFailed = !LaunchAtLogin.set(enabled)
        launchAtLogin = LaunchAtLogin.isEnabled
    }

    /// Remove os hooks do Claude Hub e o serviço (`uninstall-all`). Os hooks e
    /// as configurações do usuário não são tocados pela CLI.
    ///
    /// `purge` apaga também a pasta de dados do hub (histórico, pareamentos e
    /// segredos locais). Em caso de sucesso, o app também deixa de abrir no login.
    func uninstallAll(purge: Bool = false) {
        guard busy == nil, !runtimeMissing else { return }
        busy = .uninstall
        uninstallSteps = []
        uninstallMessage = nil
        uninstallFailed = false
        uninstalled = false
        trashFailed = false
        Task { [weak self] in
            guard let model = self else { return }
            do {
                let arguments = purge ? ["uninstall-all", "--purge"] : ["uninstall-all"]
                let result = try await RuntimeCLI.run(UninstallResult.self, arguments, timeout: 90)
                model.uninstallSteps = result.steps
                model.uninstallFailed = !result.ok
                if result.ok {
                    model.uninstalled = true
                    if LaunchAtLogin.isEnabled {
                        LaunchAtLogin.set(false)
                    }
                    model.launchAtLogin = LaunchAtLogin.isEnabled
                    model.uninstallMessage = result.detail ?? "Integração removida. Os seus hooks e configurações foram preservados."
                } else {
                    model.uninstallMessage = result.detail ?? model.firstFailure(in: result.steps)
                        ?? "A desinstalação não foi concluída."
                }
            } catch {
                model.uninstallFailed = true
                model.uninstallMessage = RuntimeCLIError.describe(error)
            }
            model.setupSteps = []
            model.selfTest = nil
            model.dismissPairing()
            await model.loadStatus()
            model.busy = nil
        }
    }

    /// Último passo da desinstalação pela interface: manda o app para o Lixo e encerra.
    func moveAppToTrashAndQuit() {
        let bundle = Bundle.main.bundleURL
        NSWorkspace.shared.recycle([bundle]) { [weak self] _, error in
            Task { @MainActor [weak self] in
                if error != nil {
                    self?.trashFailed = true
                } else {
                    NSApp.terminate(nil)
                }
            }
        }
    }

    // MARK: - Janela

    func windowOpened() {
        store.refreshSystem()
        refresh()
    }

    func windowClosed() {
        dismissPairing()
    }
}

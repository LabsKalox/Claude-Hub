import AppKit
import Combine
import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

enum PanelTab: String, CaseIterable, Identifiable {
    case claude = "Claude"
    case sistema = "Sistema"
    case uso = "Uso"
    case widgets = "Widgets"

    var id: String {
        return rawValue
    }
}

/// Estado do app: o que veio do hub + o que a ilha está mostrando.
/// Todo dado de sessão vem do WebSocket do hub; nada é simulado aqui.
@MainActor
final class HubStore: ObservableObject {
    // Vindo do hub
    @Published private(set) var state = HubState()
    @Published private(set) var connection: HubConnectionState = .disconnected
    @Published private(set) var info: HubInfo?
    @Published private(set) var devices: [DeviceInfo] = []
    @Published private(set) var usage: UsageStats?
    /// Últimos eventos guardados pelo hub (GET /api/events), para o histórico da aba Uso.
    @Published private(set) var recentEvents: [HubEvent] = []

    // Interface
    @Published private(set) var panelOpen = false
    @Published private(set) var hovering = false
    @Published private(set) var flash: HubAlert?
    @Published private(set) var selectedTab: PanelTab = .claude
    @Published private(set) var pairingVisible = false
    @Published private(set) var pairing: PairingInfo?
    @Published private(set) var pairingError: String?
    @Published private(set) var decidingID: String?
    @Published private(set) var decisionError: String?

    let prefs: Preferences
    private let client: HubClient
    private var flashTask: Task<Void, Never>?
    private var hoverTask: Task<Void, Never>?
    private var errorTask: Task<Void, Never>?

    init(prefs: Preferences) {
        self.prefs = prefs
        self.client = HubClient()
        client.onMessage = { [weak self] message in
            self?.handle(message)
        }
        client.onStateChange = { [weak self] newState in
            self?.connectionChanged(newState)
        }
        client.idleSecondsProvider = {
            return Presence.idleSeconds()
        }
    }

    // MARK: - Ciclo de vida

    func start() {
        client.start()
        // Os widgets são registrados aqui (uma única vez) para que a música em
        // reprodução seja acompanhada mesmo com o painel fechado.
        WidgetRegistry.shared.registerBuiltIns()
    }

    func stop() {
        client.stop()
    }

    func retryConnection() {
        client.retryNow()
    }

    var isConnected: Bool {
        return connection == .connected
    }

    var config: HubConfig? {
        return client.config
    }

    // MARK: - O que a ilha mostra

    var content: IslandContent {
        if panelOpen { return .panel }
        if connection != .connected { return .offline(connection) }
        if let first = state.approvals.first {
            return .approval(first, more: state.approvals.count - 1)
        }
        if let flash = flash { return .flash(flash) }
        guard let session = state.focus else { return .idle }
        if hovering { return .detail(session) }
        switch session.status {
        case .working: return .working(session)
        case .waiting, .approvalRequired: return .waiting(session)
        case .completed: return .completed(session)
        case .error: return .failed(session)
        case .idle: return .idle
        }
    }

    /// Resumo de uma linha para a barra de menus.
    var statusSummary: String {
        if connection != .connected { return "Hub offline" }
        let sessions = state.sessions
        if sessions.isEmpty { return "Nenhuma sessão ativa" }
        let pending = state.approvals.count
        let working = sessions.filter { $0.status == .working }.count
        var parts = ["\(sessions.count) " + (sessions.count == 1 ? "sessão" : "sessões")]
        if working > 0 { parts.append("\(working) trabalhando") }
        if pending > 0 { parts.append("\(pending) " + (pending == 1 ? "pedido" : "pedidos")) }
        return parts.joined(separator: " · ")
    }

    // MARK: - Mensagens do hub

    private func handle(_ message: ServerMessage) {
        let alert = state.apply(message, localNow: HubFormat.nowMs())
        if case .approval(let approval) = message, approval.status != .pending, decidingID == approval.id {
            decidingID = nil
        }
        if let alert = alert {
            present(alert)
        }
    }

    private func connectionChanged(_ newState: HubConnectionState) {
        connection = newState
        if newState == .connected {
            refreshSystem()
        } else {
            state.connectionLost()
            decidingID = nil
        }
    }

    private func present(_ alert: HubAlert) {
        switch alert.kind {
        case .completed:
            guard prefs.completionAlerts else { return }
            showFlash(alert)
            playSound("Glass")
        case .error:
            showFlash(alert)
            playSound("Basso")
        case .approval:
            playSound("Ping")
        case .waiting:
            playSound("Tink")
        case .other:
            break
        }
    }

    private func showFlash(_ alert: HubAlert) {
        flash = alert
        flashTask?.cancel()
        flashTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if Task.isCancelled { return }
            self?.flash = nil
        }
    }

    func dismissFlash() {
        flashTask?.cancel()
        flash = nil
    }

    private func playSound(_ name: String) {
        guard prefs.sounds else { return }
        _ = NSSound(named: NSSound.Name(name))?.play()
    }

    // MARK: - Interação com a ilha

    func setHovering(_ value: Bool) {
        hoverTask?.cancel()
        if value {
            if !hovering { hovering = true }
            return
        }
        // Pequena espera para o mouse poder sair e voltar sem a ilha piscar.
        hoverTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            if Task.isCancelled { return }
            if self?.hovering == true { self?.hovering = false }
        }
    }

    func togglePanel() {
        if panelOpen {
            collapse()
        } else {
            openPanel(tab: nil)
        }
    }

    func openPanel(tab: PanelTab?) {
        if let tab = tab { selectedTab = tab }
        dismissFlash()
        if !panelOpen { panelOpen = true }
    }

    func collapse() {
        if pairingVisible { pairingVisible = false }
        if panelOpen { panelOpen = false }
    }

    func selectTab(_ tab: PanelTab) {
        if pairingVisible { pairingVisible = false }
        if selectedTab != tab { selectedTab = tab }
    }

    /// Traz para a frente o terminal da sessão. Não responde nada por você.
    func answerInClaude(sessionID: String?) {
        let hostApp = sessionID.flatMap { state.session(id: $0) }?.hostApp ?? state.focus?.hostApp
        HostAppActivator.activate(bundleID: hostApp)
    }

    // MARK: - Aprovações

    /// Permite ou nega exatamente o pedido mostrado. Não existe "permitir sempre".
    func decide(_ approval: Approval, _ decision: ApprovalDecision) {
        guard decidingID == nil else { return }
        decidingID = approval.id
        decisionError = nil
        Task { [weak self] in
            guard let store = self else { return }
            do {
                let outcome = try await store.client.decide(approvalID: approval.id, decision: decision)
                switch outcome {
                case .accepted:
                    break
                case .conflict(let reason):
                    store.state.removeApproval(id: approval.id)
                    store.showFlash(HubAlert(
                        kind: .error,
                        sessionId: approval.sessionId,
                        title: reason == "expired" ? "Pedido expirou" : "Pedido já respondido",
                        body: "Responda no Claude Code.",
                        at: HubFormat.nowMs()
                    ))
                case .notFound:
                    store.state.removeApproval(id: approval.id)
                    store.showFlash(HubAlert(
                        kind: .error,
                        sessionId: approval.sessionId,
                        title: "Pedido não existe mais",
                        body: "Responda no Claude Code.",
                        at: HubFormat.nowMs()
                    ))
                }
            } catch {
                store.showDecisionError("O hub não respondeu. Tente de novo.")
            }
            if store.decidingID == approval.id {
                store.decidingID = nil
            }
        }
    }

    private func showDecisionError(_ text: String) {
        decisionError = text
        errorTask?.cancel()
        errorTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if Task.isCancelled { return }
            self?.decisionError = nil
        }
    }

    // MARK: - Configurações do hub

    func setApprovalMode(_ mode: ApprovalMode) {
        var next = state.settings
        guard next.approvalMode != mode else { return }
        next.approvalMode = mode
        state.setSettings(next)
        Task { [weak self] in
            guard let store = self else { return }
            let confirmed = try? await store.client.updateSettings(approvalMode: mode)
            if let confirmed = confirmed {
                store.state.setSettings(confirmed)
            }
        }
    }

    func setAway(_ away: Bool) {
        var next = state.settings
        guard next.away != away else { return }
        next.away = away
        state.setSettings(next)
        Task { [weak self] in
            guard let store = self else { return }
            let confirmed = try? await store.client.updateSettings(away: away)
            if let confirmed = confirmed {
                store.state.setSettings(confirmed)
            }
        }
    }

    func dismissSession(_ session: Session) {
        Task { [weak self] in
            try? await self?.client.dismissSession(id: session.id)
        }
    }

    // MARK: - Abas Sistema / Uso

    func refreshSystem() {
        Task { [weak self] in
            guard let store = self else { return }
            store.info = try? await store.client.info()
            let list = try? await store.client.devices()
            if let list = list {
                store.devices = list
            }
        }
    }

    func refreshUsage() {
        Task { [weak self] in
            guard let store = self else { return }
            let stats = try? await store.client.usage()
            if let stats = stats {
                store.usage = stats
            }
        }
    }

    /// Relê do hub os eventos mais recentes de todas as sessões.
    func refreshEvents() {
        Task { [weak self] in
            guard let store = self else { return }
            let list = try? await store.client.recentEvents(limit: HubStore.historyLimit)
            if let list = list {
                store.recentEvents = list
            }
        }
    }

    static let historyLimit = 40

    /// Histórico da aba Uso: o que o hub guardou mais o que chegou ao vivo pelo
    /// WebSocket, sem repetição, do mais novo para o mais antigo.
    var history: [HubEvent] {
        var seen = Set<Int>()
        var merged: [HubEvent] = []
        for event in state.events + recentEvents {
            if seen.insert(event.id).inserted {
                merged.append(event)
            }
        }
        merged.sort { a, b in
            if a.at != b.at { return a.at > b.at }
            return a.id > b.id
        }
        return Array(merged.prefix(HubStore.historyLimit))
    }

    func revokeDevice(_ device: DeviceInfo) {
        Task { [weak self] in
            guard let store = self else { return }
            try? await store.client.revokeDevice(id: device.id)
            store.refreshSystem()
        }
    }

    // MARK: - Pareamento do iPhone

    func startPairing() {
        openPanel(tab: nil)
        pairingVisible = true
        requestPairingCode()
    }

    func requestPairingCode() {
        pairing = nil
        pairingError = nil
        Task { [weak self] in
            guard let store = self else { return }
            do {
                store.pairing = try await store.client.createPairing()
            } catch {
                store.pairingError = "Não foi possível gerar o código. O hub está no ar?"
            }
        }
    }

    func closePairing() {
        pairingVisible = false
        pairing = nil
        refreshSystem()
    }

    // MARK: - Usado pelo assistente de configuração

    /// Código de pareamento de uso único. `baseURL` é a URL https do iPhone
    /// quando o assistente já a conhece (o QR depende dela).
    func createPairing(baseURL: String?) async throws -> PairingInfo {
        return try await client.createPairing(baseURL: baseURL)
    }

    /// Relê a lista de iPhones pareados e a devolve (vazia se o hub não responder).
    func loadDevices() async -> [DeviceInfo] {
        let list = try? await client.devices()
        if let list = list {
            devices = list
        }
        return devices
    }
}

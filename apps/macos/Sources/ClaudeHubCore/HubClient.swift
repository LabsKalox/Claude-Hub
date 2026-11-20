import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum HubConnectionState: Equatable, Sendable {
    /// Sem conexão (hub fora do ar ou ainda tentando).
    case disconnected
    case connecting
    /// Autenticado e com snapshot recebido.
    case connected
    /// ~/.claude-hub/config.json ainda não existe.
    case notConfigured
    /// O hub recusou o token local.
    case unauthorized
}

public enum HubClientError: Error, Equatable {
    case notConfigured
    case transport(String)
    case http(status: Int, message: String)
    case decoding
}

public enum DecisionOutcome: Equatable, Sendable {
    case accepted
    /// 409: "expired" ou "already_decided".
    case conflict(reason: String)
    case notFound
}

/// Cliente do hub local: WebSocket para estado em tempo real (sem polling) e
/// REST para ações. Tudo roda no ator principal; as respostas de rede voltam
/// para ele antes de tocar em qualquer estado.
@MainActor
public final class HubClient {
    public var onMessage: (@MainActor (ServerMessage) -> Void)?
    public var onStateChange: (@MainActor (HubConnectionState) -> Void)?
    /// Segundos sem uso do teclado/mouse, para o modo "Automático" do hub.
    public var idleSecondsProvider: (@MainActor () -> Double)?

    public private(set) var state: HubConnectionState = .disconnected
    public private(set) var config: HubConfig?

    private let session: URLSession
    private let configLoader: () -> HubConfig?
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    private var socket: URLSessionWebSocketTask?
    private var generation = 0
    private var attempt = 0
    private var running = false
    private var reconnectTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?

    public init(configLoader: @escaping () -> HubConfig? = { HubConfig.load() }) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        self.session = URLSession(configuration: configuration)
        self.configLoader = configLoader
    }

    // MARK: - Ciclo de vida

    public func start() {
        guard !running else { return }
        running = true
        attempt = 0
        connectNow()
    }

    public func stop() {
        running = false
        reconnectTask?.cancel()
        reconnectTask = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
        generation += 1
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        setState(.disconnected)
    }

    /// Tenta reconectar agora, sem esperar o próximo intervalo.
    public func retryNow() {
        guard running else {
            start()
            return
        }
        attempt = 0
        connectNow()
    }

    /// Espera entre tentativas: 0,5 s, 1 s, 2 s, 4 s, 8 s e daí em diante 10 s.
    public nonisolated static func backoffDelay(attempt: Int) -> Double {
        let exponent = Double(max(0, min(attempt, 12) - 1))
        return min(10, 0.5 * pow(2, exponent))
    }

    private func setState(_ newState: HubConnectionState) {
        guard newState != state else { return }
        state = newState
        onStateChange?(newState)
    }

    private func connectNow() {
        guard running else { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        generation += 1
        let current = generation

        // Relê a configuração a cada tentativa: o hub pode ter acabado de criá-la.
        guard let loaded = configLoader(), let url = loaded.webSocketURL else {
            config = nil
            setState(.notConfigured)
            scheduleReconnect()
            return
        }
        config = loaded
        if attempt == 0 && state != .connected {
            setState(.connecting)
        }

        let task = session.webSocketTask(with: url)
        socket = task
        task.resume()
        // O token vai na primeira mensagem, nunca na URL.
        send(.auth(token: loaded.localToken, client: "macos"), on: task) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor [weak self] in
                self?.connectionLost(generation: current)
            }
        }
        receiveNext(on: task, generation: current)
    }

    private func scheduleReconnect() {
        guard running else { return }
        attempt += 1
        let delay = HubClient.backoffDelay(attempt: attempt)
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            self?.connectNow()
        }
    }

    private func connectionLost(generation lost: Int) {
        guard lost == generation, running else { return }
        heartbeatTask?.cancel()
        heartbeatTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        if state != .unauthorized && state != .notConfigured {
            setState(.disconnected)
        }
        scheduleReconnect()
    }

    // MARK: - WebSocket

    private func send(
        _ message: ClientMessage,
        on task: URLSessionWebSocketTask,
        completion: (@Sendable (Error?) -> Void)? = nil
    ) {
        guard let data = try? encoder.encode(message), let text = String(data: data, encoding: .utf8) else {
            return
        }
        task.send(.string(text)) { error in
            completion?(error)
        }
    }

    private func receiveNext(on task: URLSessionWebSocketTask, generation current: Int) {
        task.receive { [weak self] result in
            var payload: Data?
            var failed = false
            switch result {
            case .failure:
                failed = true
            case .success(let message):
                switch message {
                case .string(let text):
                    payload = text.data(using: .utf8)
                case .data(let data):
                    payload = data
                @unknown default:
                    payload = nil
                }
            }
            let received = payload
            let didFail = failed
            Task { @MainActor [weak self] in
                self?.handleReceive(payload: received, failed: didFail, generation: current)
            }
        }
    }

    private func handleReceive(payload: Data?, failed: Bool, generation current: Int) {
        guard current == generation else { return }
        if failed {
            connectionLost(generation: current)
            return
        }
        if let payload = payload, let message = try? decoder.decode(ServerMessage.self, from: payload) {
            process(message)
        }
        // `process` pode ter derrubado a conexão (auth_error).
        if current == generation, let task = socket {
            receiveNext(on: task, generation: current)
        }
    }

    private func process(_ message: ServerMessage) {
        switch message {
        case .snapshot:
            attempt = 0
            setState(.connected)
            startHeartbeat()
        case .authError:
            setState(.unauthorized)
            onMessage?(message)
            connectionLost(generation: generation)
            return
        default:
            break
        }
        onMessage?(message)
    }

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        sendPresence()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if Task.isCancelled { return }
                guard let client = self else { return }
                client.sendPresence()
            }
        }
    }

    private func sendPresence() {
        guard state == .connected, let task = socket else { return }
        if let provider = idleSecondsProvider {
            send(.presence(idleSeconds: provider()), on: task)
        } else {
            send(.ping, on: task)
        }
    }

    // MARK: - REST

    private struct HTTPResult {
        let data: Data
        let status: Int
    }

    private func perform(_ method: String, _ path: String, json: [String: Any]? = nil) async throws -> HTTPResult {
        let loaded: HubConfig
        if let existing = config {
            loaded = existing
        } else if let fresh = configLoader() {
            config = fresh
            loaded = fresh
        } else {
            throw HubClientError.notConfigured
        }
        guard let url = URL(string: loaded.baseURLString + path) else {
            throw HubClientError.transport("URL inválida")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 8
        request.setValue("Bearer \(loaded.localToken)", forHTTPHeaderField: "Authorization")
        if let json = json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        let urlSession = session
        let finalRequest = request
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<HTTPResult, Error>) in
            let task = urlSession.dataTask(with: finalRequest) { data, response, error in
                if let error = error {
                    continuation.resume(throwing: HubClientError.transport(error.localizedDescription))
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                continuation.resume(returning: HTTPResult(data: data ?? Data(), status: status))
            }
            task.resume()
        }
    }

    private func errorMessage(_ data: Data) -> String {
        if let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let message = object["error"] as? String {
            return message
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func expectOK(_ result: HTTPResult) throws {
        guard (200..<300).contains(result.status) else {
            throw HubClientError.http(status: result.status, message: errorMessage(result.data))
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from result: HTTPResult) throws -> T {
        try expectOK(result)
        guard let value = try? decoder.decode(type, from: result.data) else {
            throw HubClientError.decoding
        }
        return value
    }

    private func pathComponent(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private struct SettingsEnvelope: Decodable { let settings: HubSettings }
    private struct UsageEnvelope: Decodable { let usage: UsageStats }
    private struct EventsEnvelope: Decodable { let events: [HubEvent] }
    private struct DevicesEnvelope: Decodable { let devices: [DeviceInfo] }

    /// Responde a um pedido de permissão. A única escolha possível é permitir
    /// ou negar aquela chamada exata — nunca "permitir sempre".
    public func decide(approvalID: String, decision: ApprovalDecision) async throws -> DecisionOutcome {
        let result = try await perform(
            "POST",
            "/api/approvals/\(pathComponent(approvalID))/decision",
            json: ["decision": decision.rawValue]
        )
        if result.status == 409 {
            return .conflict(reason: errorMessage(result.data))
        }
        if result.status == 404 {
            return .notFound
        }
        try expectOK(result)
        return .accepted
    }

    public func updateSettings(approvalMode: ApprovalMode? = nil, away: Bool? = nil) async throws -> HubSettings {
        var body: [String: Any] = [:]
        if let approvalMode = approvalMode { body["approvalMode"] = approvalMode.rawValue }
        if let away = away { body["away"] = away }
        let result = try await perform("PUT", "/api/settings", json: body)
        return try decode(SettingsEnvelope.self, from: result).settings
    }

    public func usage() async throws -> UsageStats {
        let result = try await perform("GET", "/api/usage")
        return try decode(UsageEnvelope.self, from: result).usage
    }

    public func events(sessionID: String, limit: Int = 30) async throws -> [HubEvent] {
        let result = try await perform("GET", "/api/events?sessionId=\(pathComponent(sessionID))&limit=\(limit)")
        return try decode(EventsEnvelope.self, from: result).events
    }

    /// Eventos mais recentes de todas as sessões, do mais novo para o mais antigo.
    public func recentEvents(limit: Int = 40) async throws -> [HubEvent] {
        let result = try await perform("GET", "/api/events?limit=\(max(1, min(200, limit)))")
        return try decode(EventsEnvelope.self, from: result).events
    }

    public func dismissSession(id: String) async throws {
        let result = try await perform("DELETE", "/api/sessions/\(pathComponent(id))")
        if result.status == 404 { return }
        try expectOK(result)
    }

    public func createPairing(baseURL: String? = nil) async throws -> PairingInfo {
        var body: [String: Any] = [:]
        if let baseURL = baseURL { body["baseUrl"] = baseURL }
        let result = try await perform("POST", "/local/pairing", json: body)
        return try decode(PairingInfo.self, from: result)
    }

    public func devices() async throws -> [DeviceInfo] {
        let result = try await perform("GET", "/local/devices")
        return try decode(DevicesEnvelope.self, from: result).devices
    }

    public func revokeDevice(id: String) async throws {
        let result = try await perform("DELETE", "/local/devices/\(pathComponent(id))")
        try expectOK(result)
    }

    public func info() async throws -> HubInfo {
        let result = try await perform("GET", "/local/info")
        return try decode(HubInfo.self, from: result)
    }
}

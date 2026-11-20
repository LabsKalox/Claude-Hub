import Foundation

// Espelho de packages/shared/src/index.ts.
//
// Regras de decodificação: campos desconhecidos são ignorados e valores de
// enum desconhecidos caem num padrão seguro. Um hub mais novo nunca deve
// derrubar o app.

public let hubProtocolVersion = 1

// MARK: - Decodificação tolerante

extension KeyedDecodingContainer {
    /// Lê um campo opcional; devolve nil se faltar, for null ou tiver outro tipo.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        guard let value = try? decodeIfPresent(type, forKey: key) else { return nil }
        return value
    }
}

// MARK: - JSON arbitrário (tool_input)

public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .null
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

// MARK: - Sessões

public enum SessionStatus: String, Codable, CaseIterable, Sendable {
    case working = "WORKING"
    case waiting = "WAITING"
    case approvalRequired = "APPROVAL_REQUIRED"
    case completed = "COMPLETED"
    case error = "ERROR"
    case idle = "IDLE"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionStatus(rawValue: raw) ?? .idle
    }
}

public struct SessionProgress: Codable, Equatable, Sendable {
    public var done: Int
    public var total: Int

    public init(done: Int, total: Int) {
        self.done = done
        self.total = total
    }
}

public struct SessionLastEvent: Codable, Equatable, Sendable {
    public var type: String
    public var summary: String
    public var at: Double

    public init(type: String, summary: String, at: Double) {
        self.type = type
        self.summary = summary
        self.at = at
    }
}

public struct Session: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var agentKind: String
    public var projectName: String
    public var cwd: String
    public var title: String
    public var agent: String?
    public var status: SessionStatus
    public var task: String?
    public var preview: String?
    /// Milissegundos desde 1970, como no JavaScript.
    public var startedAt: Double
    public var updatedAt: Double
    public var activeSince: Double?
    public var activeMs: Double
    public var progress: SessionProgress?
    public var lastEvent: SessionLastEvent?
    public var pendingApprovals: Int
    public var permissionMode: String?
    public var subagents: Int
    public var hostApp: String?
    public var endedAt: Double?

    public init(
        id: String,
        agentKind: String = "claude-code",
        projectName: String = "sessão",
        cwd: String = "",
        title: String = "sessão",
        agent: String? = nil,
        status: SessionStatus = .idle,
        task: String? = nil,
        preview: String? = nil,
        startedAt: Double = 0,
        updatedAt: Double = 0,
        activeSince: Double? = nil,
        activeMs: Double = 0,
        progress: SessionProgress? = nil,
        lastEvent: SessionLastEvent? = nil,
        pendingApprovals: Int = 0,
        permissionMode: String? = nil,
        subagents: Int = 0,
        hostApp: String? = nil,
        endedAt: Double? = nil
    ) {
        self.id = id
        self.agentKind = agentKind
        self.projectName = projectName
        self.cwd = cwd
        self.title = title
        self.agent = agent
        self.status = status
        self.task = task
        self.preview = preview
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.activeSince = activeSince
        self.activeMs = activeMs
        self.progress = progress
        self.lastEvent = lastEvent
        self.pendingApprovals = pendingApprovals
        self.permissionMode = permissionMode
        self.subagents = subagents
        self.hostApp = hostApp
        self.endedAt = endedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let project = c.lenient(String.self, .projectName) ?? "sessão"
        id = try c.decode(String.self, forKey: .id)
        agentKind = c.lenient(String.self, .agentKind) ?? "claude-code"
        projectName = project
        cwd = c.lenient(String.self, .cwd) ?? ""
        title = c.lenient(String.self, .title) ?? project
        agent = c.lenient(String.self, .agent)
        status = c.lenient(SessionStatus.self, .status) ?? .idle
        task = c.lenient(String.self, .task)
        preview = c.lenient(String.self, .preview)
        startedAt = c.lenient(Double.self, .startedAt) ?? 0
        updatedAt = c.lenient(Double.self, .updatedAt) ?? 0
        activeSince = c.lenient(Double.self, .activeSince)
        activeMs = c.lenient(Double.self, .activeMs) ?? 0
        progress = c.lenient(SessionProgress.self, .progress)
        lastEvent = c.lenient(SessionLastEvent.self, .lastEvent)
        pendingApprovals = c.lenient(Int.self, .pendingApprovals) ?? 0
        permissionMode = c.lenient(String.self, .permissionMode)
        subagents = c.lenient(Int.self, .subagents) ?? 0
        hostApp = c.lenient(String.self, .hostApp)
        endedAt = c.lenient(Double.self, .endedAt)
    }
}

public struct HubEvent: Codable, Equatable, Identifiable, Sendable {
    public var id: Int
    public var sessionId: String
    public var at: Double
    public var type: String
    public var summary: String
    public var toolName: String?

    public init(id: Int, sessionId: String, at: Double, type: String, summary: String, toolName: String? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.at = at
        self.type = type
        self.summary = summary
        self.toolName = toolName
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        sessionId = c.lenient(String.self, .sessionId) ?? ""
        at = c.lenient(Double.self, .at) ?? 0
        type = c.lenient(String.self, .type) ?? ""
        summary = c.lenient(String.self, .summary) ?? ""
        toolName = c.lenient(String.self, .toolName)
    }
}

// MARK: - Aprovações

public enum ApprovalStatus: String, Codable, CaseIterable, Sendable {
    case pending
    case allowed
    case denied
    case expired
    case cancelled

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        // Estado desconhecido nunca é tratado como "pendente".
        self = ApprovalStatus(rawValue: raw) ?? .cancelled
    }
}

public enum ApprovalDecision: String, Codable, Sendable {
    case allow
    case deny
}

public struct Approval: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var sessionId: String
    public var projectName: String
    public var sessionTitle: String
    public var toolName: String
    /// Texto completo do que será executado.
    public var command: String
    public var toolInput: JSONValue?
    public var cwd: String
    public var createdAt: Double
    public var expiresAt: Double
    public var status: ApprovalStatus
    public var decidedBy: String?
    public var decidedAt: Double?
    /// "claude-code", "codex" ou "opencode". Hubs anteriores à 0.5.0 não mandam: Claude Code.
    public var agentKind: String = "claude-code"

    /// Como o agente aparece nos títulos: "Claude quer usar…", "Codex quer usar…".
    public var agentShortName: String {
        switch agentKind {
        case "codex": return "Codex"
        case "opencode": return "OpenCode"
        default: return "Claude"
        }
    }

    public init(
        id: String,
        sessionId: String,
        projectName: String = "",
        sessionTitle: String = "",
        toolName: String = "",
        command: String = "",
        toolInput: JSONValue? = nil,
        cwd: String = "",
        createdAt: Double = 0,
        expiresAt: Double = 0,
        status: ApprovalStatus = .pending,
        decidedBy: String? = nil,
        decidedAt: Double? = nil
    ) {
        self.id = id
        self.sessionId = sessionId
        self.projectName = projectName
        self.sessionTitle = sessionTitle
        self.toolName = toolName
        self.command = command
        self.toolInput = toolInput
        self.cwd = cwd
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.status = status
        self.decidedBy = decidedBy
        self.decidedAt = decidedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = c.lenient(String.self, .sessionId) ?? ""
        projectName = c.lenient(String.self, .projectName) ?? ""
        sessionTitle = c.lenient(String.self, .sessionTitle) ?? ""
        toolName = c.lenient(String.self, .toolName) ?? ""
        command = c.lenient(String.self, .command) ?? ""
        toolInput = c.lenient(JSONValue.self, .toolInput)
        cwd = c.lenient(String.self, .cwd) ?? ""
        createdAt = c.lenient(Double.self, .createdAt) ?? 0
        expiresAt = c.lenient(Double.self, .expiresAt) ?? 0
        status = c.lenient(ApprovalStatus.self, .status) ?? .cancelled
        decidedBy = c.lenient(String.self, .decidedBy)
        decidedAt = c.lenient(Double.self, .decidedAt)
        agentKind = c.lenient(String.self, .agentKind) ?? "claude-code"
    }
}

/// Modos do seletor "APROVAÇÕES". Nenhum deles aprova nada sozinho.
public enum ApprovalMode: String, Codable, CaseIterable, Sendable {
    case auto
    case always
    case notify

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ApprovalMode(rawValue: raw) ?? .always
    }
}

public struct HubSettings: Codable, Equatable, Sendable {
    public var approvalMode: ApprovalMode
    /// Chave "Estou longe do PC".
    public var away: Bool

    public static let standard = HubSettings(approvalMode: .always, away: false)

    public init(approvalMode: ApprovalMode, away: Bool) {
        self.approvalMode = approvalMode
        self.away = away
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approvalMode = c.lenient(ApprovalMode.self, .approvalMode) ?? .always
        away = c.lenient(Bool.self, .away) ?? false
    }
}

// MARK: - Alertas

public enum AlertKind: String, Codable, Sendable {
    case completed
    case waiting
    case approval
    case error
    case other

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AlertKind(rawValue: raw) ?? .other
    }
}

public struct HubAlert: Codable, Equatable, Sendable {
    public var kind: AlertKind
    public var sessionId: String
    public var title: String
    public var body: String
    public var approvalId: String?
    public var at: Double

    public init(kind: AlertKind, sessionId: String, title: String, body: String, approvalId: String? = nil, at: Double) {
        self.kind = kind
        self.sessionId = sessionId
        self.title = title
        self.body = body
        self.approvalId = approvalId
        self.at = at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.lenient(AlertKind.self, .kind) ?? .other
        sessionId = c.lenient(String.self, .sessionId) ?? ""
        title = c.lenient(String.self, .title) ?? ""
        body = c.lenient(String.self, .body) ?? ""
        approvalId = c.lenient(String.self, .approvalId)
        at = c.lenient(Double.self, .at) ?? 0
    }
}

// MARK: - REST

public struct ToolCount: Codable, Equatable, Sendable {
    public var tool: String
    public var count: Int
}

public struct UsageStats: Codable, Equatable, Sendable {
    public var since: Double
    public var sessions: Int
    public var prompts: Int
    public var toolCalls: Int
    public var approvalsAllowed: Int
    public var approvalsDenied: Int
    public var activeMs: Double
    public var byTool: [ToolCount]
    /// Tokens e custo informados pelo Claude Code (UsageModels.swift); nil se o hub não mandou.
    public var consumption: ClaudeConsumption?
    /// Limites do plano informados pelo Claude Code; nil se o hub não mandou.
    public var limits: ClaudeLimits?
    /// Codex e OpenCode; vazio em hubs antigos.
    public var agents: [AgentUsage]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        since = c.lenient(Double.self, .since) ?? 0
        sessions = c.lenient(Int.self, .sessions) ?? 0
        prompts = c.lenient(Int.self, .prompts) ?? 0
        toolCalls = c.lenient(Int.self, .toolCalls) ?? 0
        approvalsAllowed = c.lenient(Int.self, .approvalsAllowed) ?? 0
        approvalsDenied = c.lenient(Int.self, .approvalsDenied) ?? 0
        activeMs = c.lenient(Double.self, .activeMs) ?? 0
        byTool = c.lenient([ToolCount].self, .byTool) ?? []
        consumption = c.lenient(ClaudeConsumption.self, .consumption)
        limits = c.lenient(ClaudeLimits.self, .limits)
        agents = c.lenient([AgentUsage].self, .agents) ?? []
    }
}

public struct DeviceInfo: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var createdAt: Double
    public var lastSeenAt: Double?
    public var pushEnabled: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, .name) ?? "iPhone"
        createdAt = c.lenient(Double.self, .createdAt) ?? 0
        lastSeenAt = c.lenient(Double.self, .lastSeenAt)
        pushEnabled = c.lenient(Bool.self, .pushEnabled) ?? false
    }
}

/// Resposta de GET /local/info.
public struct HubInfo: Codable, Equatable, Sendable {
    public var version: String
    public var localPort: Int
    public var publicPort: Int
    public var publicUrl: String?
    public var pushConfigured: Bool
    public var away: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.lenient(String.self, .version) ?? "?"
        localPort = c.lenient(Int.self, .localPort) ?? 0
        publicPort = c.lenient(Int.self, .publicPort) ?? 0
        publicUrl = c.lenient(String.self, .publicUrl)
        pushConfigured = c.lenient(Bool.self, .pushConfigured) ?? false
        away = c.lenient(Bool.self, .away) ?? false
    }
}

/// Resposta de POST /local/pairing.
public struct PairingInfo: Codable, Equatable, Sendable {
    public var code: String
    public var expiresAt: Double
    public var url: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        expiresAt = c.lenient(Double.self, .expiresAt) ?? 0
        url = c.lenient(String.self, .url)
    }
}

// MARK: - WebSocket

public struct SnapshotPayload: Equatable, Sendable {
    public var protocolVersion: Int
    public var sessions: [Session]
    public var approvals: [Approval]
    public var settings: HubSettings
    public var serverTime: Double

    public init(protocolVersion: Int = 1, sessions: [Session], approvals: [Approval], settings: HubSettings, serverTime: Double) {
        self.protocolVersion = protocolVersion
        self.sessions = sessions
        self.approvals = approvals
        self.settings = settings
        self.serverTime = serverTime
    }
}

public enum ServerMessage: Decodable, Equatable, Sendable {
    case snapshot(SnapshotPayload)
    case session(Session)
    case sessionRemoved(String)
    case event(HubEvent)
    case approval(Approval)
    case settings(HubSettings)
    case alert(HubAlert)
    case authError(String)
    case pong
    /// Tipo de mensagem que esta versão do app não conhece.
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
        case sessions
        case approvals
        case settings
        case serverTime
        case session
        case sessionId
        case event
        case approval
        case alert
        case reason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "snapshot":
            let payload = SnapshotPayload(
                protocolVersion: c.lenient(Int.self, .protocolVersion) ?? 1,
                sessions: c.lenient([Session].self, .sessions) ?? [],
                approvals: c.lenient([Approval].self, .approvals) ?? [],
                settings: c.lenient(HubSettings.self, .settings) ?? HubSettings.standard,
                serverTime: c.lenient(Double.self, .serverTime) ?? 0
            )
            self = .snapshot(payload)
        case "session":
            self = .session(try c.decode(Session.self, forKey: .session))
        case "session_removed":
            self = .sessionRemoved(try c.decode(String.self, forKey: .sessionId))
        case "event":
            self = .event(try c.decode(HubEvent.self, forKey: .event))
        case "approval":
            self = .approval(try c.decode(Approval.self, forKey: .approval))
        case "settings":
            self = .settings(try c.decode(HubSettings.self, forKey: .settings))
        case "alert":
            self = .alert(try c.decode(HubAlert.self, forKey: .alert))
        case "auth_error":
            self = .authError(c.lenient(String.self, .reason) ?? "invalid")
        case "pong":
            self = .pong
        default:
            self = .unknown(type)
        }
    }
}

public enum ClientMessage: Encodable, Equatable, Sendable {
    case auth(token: String, client: String)
    case presence(idleSeconds: Double)
    case ping

    private enum CodingKeys: String, CodingKey {
        case type
        case token
        case client
        case idleSeconds
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .auth(let token, let client):
            try c.encode("auth", forKey: .type)
            try c.encode(token, forKey: .token)
            try c.encode(client, forKey: .client)
        case .presence(let idleSeconds):
            try c.encode("presence", forKey: .type)
            try c.encode(idleSeconds, forKey: .idleSeconds)
        case .ping:
            try c.encode("ping", forKey: .type)
        }
    }
}

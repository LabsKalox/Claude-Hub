import Foundation

/// Estado do cliente e o redutor que aplica as mensagens do hub.
/// Equivalente em Swift de packages/shared/src/state.ts — função pura, sem I/O.
public struct HubState: Equatable, Sendable {
    /// Sessões vivas, na ordem de chegada (a mais recente primeiro).
    public private(set) var sessions: [Session] = []
    /// Pedidos pendentes, do mais antigo para o mais novo.
    public private(set) var approvals: [Approval] = []
    public private(set) var settings: HubSettings = HubSettings.standard
    /// Eventos recebidos ao vivo, do mais novo para o mais antigo (limitado).
    public private(set) var events: [HubEvent] = []
    /// Diferença entre o relógio do servidor e o local, em ms.
    public private(set) var clockSkew: Double = 0
    public private(set) var ready: Bool = false

    public static let maxLiveEvents = 200

    public init() {}

    /// Sessões ordenadas para exibição.
    public var sortedSessions: [Session] {
        return HubFormat.sortSessions(sessions)
    }

    /// Sessão que a ilha compacta mostra.
    public var focus: Session? {
        return HubFormat.focusSession(sessions)
    }

    public func session(id: String) -> Session? {
        return sessions.first { $0.id == id }
    }

    /// Aplica uma mensagem do hub. Devolve o alerta, quando a mensagem é um.
    @discardableResult
    public mutating func apply(_ message: ServerMessage, localNow: Double) -> HubAlert? {
        switch message {
        case .snapshot(let payload):
            sessions = payload.sessions.filter { $0.endedAt == nil }
            approvals = HubState.sortedPending(payload.approvals)
            settings = payload.settings
            clockSkew = payload.serverTime > 0 ? payload.serverTime - localNow : 0
            ready = true
            return nil

        case .session(let session):
            sessions.removeAll { $0.id == session.id }
            if session.endedAt == nil {
                sessions.insert(session, at: 0)
            }
            return nil

        case .sessionRemoved(let sessionId):
            sessions.removeAll { $0.id == sessionId }
            approvals.removeAll { $0.sessionId == sessionId }
            return nil

        case .event(let event):
            events.insert(event, at: 0)
            if events.count > HubState.maxLiveEvents {
                events.removeLast(events.count - HubState.maxLiveEvents)
            }
            return nil

        case .approval(let approval):
            // Só pedidos pendentes ficam na fila; decididos/expirados saem.
            var rest = approvals.filter { $0.id != approval.id }
            if approval.status == .pending {
                rest.append(approval)
            }
            approvals = HubState.sortedPending(rest)
            return nil

        case .settings(let newSettings):
            settings = newSettings
            return nil

        case .alert(let alert):
            return alert

        case .authError, .pong, .unknown:
            return nil
        }
    }

    /// Conexão caiu: o que está na tela pode estar velho. Pedidos pendentes
    /// somem (não dá para responder sem o hub); as sessões ficam até o próximo snapshot.
    public mutating func connectionLost() {
        approvals = []
        ready = false
    }

    /// Remove localmente um pedido que o hub recusou (expirado/já respondido).
    public mutating func removeApproval(id: String) {
        approvals.removeAll { $0.id == id }
    }

    /// Atualização otimista das configurações; o hub confirma em seguida.
    public mutating func setSettings(_ newSettings: HubSettings) {
        settings = newSettings
    }

    private static func sortedPending(_ list: [Approval]) -> [Approval] {
        return list
            .filter { $0.status == .pending }
            .sorted { a, b in
                if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
                return a.id < b.id
            }
    }
}

import Foundation

// Espelho dos tokens visuais e das funções utilitárias de packages/shared.

/// Tokens visuais extraídos dos frames de referência (hex).
public enum HubTokens {
    public static let island = "#000000"
    public static let card = "#111214"
    public static let cardBorder = "#1E2024"
    public static let field = "#16181C"
    public static let text = "#FFFFFF"
    public static let textDim = "#9BA1AC"
    public static let textFaint = "#5E6470"
    public static let blue = "#2F6BFF"
    public static let green = "#2FBF71"
    public static let orange = "#F5A524"
    public static let red = "#FF453A"
    public static let grey = "#6B7280"
    public static let link = "#7C8CFF"
    public static let buttonNeutral = "#2A2C31"
    public static let coral = "#E8704F"

    public static let radiusIsland: Double = 28
    public static let radiusCard: Double = 14
    public static let radiusField: Double = 10
}

extension SessionStatus {
    /// Rótulo exibido na interface (pt-BR), igual ao do vídeo de referência.
    public var label: String {
        switch self {
        case .working: return "Trabalhando"
        case .waiting: return "Esperando você"
        case .approvalRequired: return "Precisa de autorização"
        case .completed: return "Terminou"
        case .error: return "Erro"
        case .idle: return "Inativa"
        }
    }

    public var colorHex: String {
        switch self {
        case .working: return HubTokens.blue
        case .waiting: return HubTokens.orange
        case .approvalRequired: return HubTokens.orange
        case .completed: return HubTokens.green
        case .error: return HubTokens.red
        case .idle: return HubTokens.grey
        }
    }

    /// Quem precisa de você vem primeiro.
    public var priority: Int {
        switch self {
        case .approvalRequired: return 0
        case .waiting: return 1
        case .error: return 2
        case .working: return 3
        case .completed: return 4
        case .idle: return 5
        }
    }
}

extension ApprovalMode {
    public var label: String {
        switch self {
        case .auto: return "Automático"
        case .always: return "Sempre aqui"
        case .notify: return "Só avisar"
        }
    }

    public var hint: String {
        switch self {
        case .auto:
            return "O pedido vai para a ilha quando você está no computador e para o celular quando está longe."
        case .always:
            return "Todo pedido de permissão vem para a ilha e para o celular."
        case .notify:
            return "Só avisa. A resposta é dada no próprio Claude Code."
        }
    }
}

public enum HubFormat {
    /// Agora, em milissegundos desde 1970 (mesma base do hub).
    public static func nowMs() -> Double {
        return Date().timeIntervalSince1970 * 1000
    }

    /// "agora", "1 min", "2 h", "3 d" — canto direito dos cartões.
    public static func ago(from: Double, now: Double) -> String {
        let seconds = max(0, ((now - from) / 1000).rounded(.down))
        if seconds < 45 { return "agora" }
        let minutes = max(1, (seconds / 60).rounded())
        if minutes < 60 { return "\(Int(minutes)) min" }
        let hours = (minutes / 60).rounded()
        if hours < 24 { return "\(Int(hours)) h" }
        return "\(Int((hours / 24).rounded())) d"
    }

    /// Duração de atividade: "42s", "3min 05s", "1h 12min".
    public static func duration(ms: Double) -> String {
        let seconds = Int(max(0, (ms / 1000).rounded(.down)))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)min \(twoDigits(seconds % 60))s" }
        return "\(minutes / 60)h \(twoDigits(minutes % 60))min"
    }

    private static func twoDigits(_ value: Int) -> String {
        return value < 10 ? "0\(value)" : "\(value)"
    }

    public static func progressPercent(_ progress: SessionProgress?) -> Int? {
        guard let progress = progress, progress.total > 0 else { return nil }
        let raw = (Double(progress.done) / Double(progress.total) * 100).rounded()
        return Int(max(0, min(100, raw)))
    }

    /// Tempo total de atividade da sessão, incluindo o turno em andamento.
    public static func sessionActiveMs(_ session: Session, now: Double) -> Double {
        var total = session.activeMs
        if let since = session.activeSince {
            total += max(0, now - since)
        }
        return total
    }

    /// Ordena para exibição: quem precisa de atenção primeiro, depois o mais recente.
    public static func sortSessions(_ sessions: [Session]) -> [Session] {
        return sessions.sorted { a, b in
            if a.status.priority != b.status.priority { return a.status.priority < b.status.priority }
            if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
            return a.id < b.id
        }
    }

    /// Sessão que a ilha compacta deve mostrar; nil se não houver nenhuma viva.
    public static func focusSession(_ sessions: [Session]) -> Session? {
        return sortSessions(sessions.filter { $0.endedAt == nil }).first
    }

    public static func truncate(_ text: String, max: Int) -> String {
        let collapsed = text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if collapsed.count <= max { return collapsed }
        let head = String(collapsed.prefix(Swift.max(0, max - 1)))
        return trimTrailingSpaces(head) + "…"
    }

    private static func trimTrailingSpaces(_ text: String) -> String {
        var result = text
        while let last = result.last, last == " " {
            result.removeLast()
        }
        return result
    }

    /// Nome curto da ferramenta para títulos ("Bash", "memory · create_entities").
    public static func toolLabel(_ toolName: String) -> String {
        let prefix = "mcp__"
        guard toolName.hasPrefix(prefix) else { return toolName }
        let rest = String(toolName.dropFirst(prefix.count))
        guard let range = rest.range(of: "__") else { return toolName }
        let server = String(rest[rest.startIndex..<range.lowerBound])
        let tool = String(rest[range.upperBound...])
        if server.isEmpty || tool.isEmpty { return toolName }
        return "\(server) · \(tool)"
    }
}

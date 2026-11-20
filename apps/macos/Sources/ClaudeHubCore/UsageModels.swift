import Foundation

// Consumo e limites do Claude, como o hub os devolve dentro de GET /api/usage.
//
// Regra da aba "Uso": só aparece o que o próprio Claude Code informou. Nada
// aqui calcula, extrapola ou estima — quando um campo não veio, ele fica nil
// e a interface diz que o dado não foi informado.

// MARK: - Consumo (telemetria local do Claude Code)

public struct ModelConsumption: Codable, Equatable, Identifiable, Sendable {
    public var model: String
    public var inputTokens: Double
    public var outputTokens: Double
    public var cacheReadTokens: Double
    public var cacheCreationTokens: Double
    /// Custo estimado pelo próprio Claude Code; nil quando ele não informou.
    public var costUsd: Double?

    public var id: String {
        return model
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = c.lenient(String.self, .model) ?? "modelo desconhecido"
        inputTokens = c.lenient(Double.self, .inputTokens) ?? 0
        outputTokens = c.lenient(Double.self, .outputTokens) ?? 0
        cacheReadTokens = c.lenient(Double.self, .cacheReadTokens) ?? 0
        cacheCreationTokens = c.lenient(Double.self, .cacheCreationTokens) ?? 0
        costUsd = c.lenient(Double.self, .costUsd)
    }
}

public struct ClaudeConsumption: Codable, Equatable, Sendable {
    /// A medição está ligada nas configurações do Claude Code.
    public var enabled: Bool
    /// De onde vieram os números ("otel"); nil enquanto nada chegou.
    public var source: String?
    public var since: Double
    public var inputTokens: Double
    public var outputTokens: Double
    public var cacheReadTokens: Double
    public var cacheCreationTokens: Double
    public var costUsd: Double?
    public var byModel: [ModelConsumption]
    /// Quando o hub recebeu o último dado; nil = ainda não chegou nada.
    public var updatedAt: Double?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.lenient(Bool.self, .enabled) ?? false
        source = c.lenient(String.self, .source)
        since = c.lenient(Double.self, .since) ?? 0
        inputTokens = c.lenient(Double.self, .inputTokens) ?? 0
        outputTokens = c.lenient(Double.self, .outputTokens) ?? 0
        cacheReadTokens = c.lenient(Double.self, .cacheReadTokens) ?? 0
        cacheCreationTokens = c.lenient(Double.self, .cacheCreationTokens) ?? 0
        costUsd = c.lenient(Double.self, .costUsd)
        byModel = c.lenient([ModelConsumption].self, .byModel) ?? []
        updatedAt = c.lenient(Double.self, .updatedAt)
    }

    /// Há números para mostrar (medição ligada e pelo menos um dado recebido).
    public var hasData: Bool {
        return enabled && updatedAt != nil
    }
}

// MARK: - Limites (linha de status do Claude Code)

public struct LimitWindow: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var label: String
    /// 0...100, exatamente como o Claude Code informou.
    public var usedPercent: Double
    /// Instante da renovação em ms; nil quando o Claude Code não informou.
    public var resetsAt: Double?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rawID = c.lenient(String.self, .id)
        let rawLabel = c.lenient(String.self, .label)
        id = rawID ?? rawLabel ?? "limite"
        label = rawLabel ?? rawID ?? "Limite"
        usedPercent = c.lenient(Double.self, .usedPercent) ?? 0
        resetsAt = c.lenient(Double.self, .resetsAt)
    }

    /// Fração 0...1 para a barra.
    public var fraction: Double {
        return max(0, min(1, usedPercent / 100))
    }
}

public struct ContextUsage: Codable, Equatable, Sendable {
    public var usedPercent: Double
    public var windowSize: Double?
    public var sessionId: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        usedPercent = c.lenient(Double.self, .usedPercent) ?? 0
        windowSize = c.lenient(Double.self, .windowSize)
        sessionId = c.lenient(String.self, .sessionId)
    }

    public var fraction: Double {
        return max(0, min(1, usedPercent / 100))
    }
}

public struct ClaudeLimits: Codable, Equatable, Sendable {
    /// A leitura de limites está ligada nas configurações do Claude Code.
    public var enabled: Bool
    public var source: String?
    public var updatedAt: Double?
    public var windows: [LimitWindow]
    public var context: ContextUsage?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.lenient(Bool.self, .enabled) ?? false
        source = c.lenient(String.self, .source)
        updatedAt = c.lenient(Double.self, .updatedAt)
        windows = c.lenient([LimitWindow].self, .windows) ?? []
        context = c.lenient(ContextUsage.self, .context)
    }
}

// MARK: - Preferências guardadas pela CLI (`prefs`)

public struct HubPrefs: Codable, Equatable, Sendable {
    /// Abrir a ilha quando o Claude Code iniciar (padrão: ligado).
    public var autoOpenIsland: Bool
    public var consumption: Bool
    public var limits: Bool

    public init(autoOpenIsland: Bool = true, consumption: Bool = false, limits: Bool = false) {
        self.autoOpenIsland = autoOpenIsland
        self.consumption = consumption
        self.limits = limits
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        autoOpenIsland = c.lenient(Bool.self, .autoOpenIsland) ?? true
        consumption = c.lenient(Bool.self, .consumption) ?? false
        limits = c.lenient(Bool.self, .limits) ?? false
    }
}

/// Resposta de `prefs` e de `prefs set <chave> on|off`.
public struct PrefsResult: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var detail: String?
    public var prefs: HubPrefs?

    private enum CodingKeys: String, CodingKey {
        case ok, detail, prefs, error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(Bool.self, .ok) ?? false
        detail = c.lenient(String.self, .detail) ?? c.lenient(String.self, .error)
        prefs = c.lenient(HubPrefs.self, .prefs)
    }
}

// MARK: - Formatação

public enum UsageFormat {
    /// "950", "12,3 mil", "1,24 mi" — só reescreve o número recebido.
    public static func tokens(_ value: Double) -> String {
        let n = max(0, value)
        if n < 1000 {
            return String(Int(n.rounded()))
        }
        if n < 1_000_000 {
            return decimal(n / 1000, digits: n < 100_000 ? 1 : 0) + " mil"
        }
        return decimal(n / 1_000_000, digits: 2) + " mi"
    }

    /// "US$ 0,42"; valores abaixo de um centavo ganham mais casas ("US$ 0,0031").
    public static func cost(_ usd: Double) -> String {
        let value = max(0, usd)
        let digits = value > 0 && value < 0.01 ? 4 : 2
        return "US$ " + decimal(value, digits: digits)
    }

    /// "42%" ou "42,5%" — sem arredondar para cima o que o Claude Code informou.
    public static func percent(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        if rounded == rounded.rounded() {
            return "\(Int(rounded))%"
        }
        return decimal(rounded, digits: 1) + "%"
    }

    /// Número com vírgula decimal (pt-BR), sem depender do locale da máquina.
    static func decimal(_ value: Double, digits: Int) -> String {
        let text = String(format: "%.\(max(0, digits))f", value)
        return text.replacingOccurrences(of: ".", with: ",")
    }
}

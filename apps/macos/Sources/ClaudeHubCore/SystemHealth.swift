import Foundation

/// Semáforo dos indicadores de desempenho do Mac: verde, amarelo, vermelho.
public enum HealthLevel: Int, Comparable, CaseIterable, Sendable {
    case good = 0
    case warning = 1
    case critical = 2

    public static func < (lhs: HealthLevel, rhs: HealthLevel) -> Bool {
        return lhs.rawValue < rhs.rawValue
    }

    /// Rótulo em pt-BR.
    public var label: String {
        switch self {
        case .good: return "Bom"
        case .warning: return "Atenção"
        case .critical: return "Crítico"
        }
    }
}

/// Limiares dos indicadores. Funções puras: recebem a medida, devolvem o nível.
public enum SystemHealth {
    /// Uso de CPU (0…1): abaixo de 60% bom, abaixo de 85% atenção, senão crítico.
    public static func cpu(usage: Double) -> HealthLevel {
        if usage < 0.60 { return .good }
        if usage < 0.85 { return .warning }
        return .critical
    }

    /// Fração de memória em uso (0…1): abaixo de 70% bom, abaixo de 88% atenção.
    public static func memory(usedFraction: Double) -> HealthLevel {
        if usedFraction < 0.70 { return .good }
        if usedFraction < 0.88 { return .warning }
        return .critical
    }

    /// Fração LIVRE do disco (0…1): acima de 20% bom, acima de 10% atenção.
    public static func disk(freeFraction: Double) -> HealthLevel {
        if freeFraction > 0.20 { return .good }
        if freeFraction > 0.10 { return .warning }
        return .critical
    }

    /// Bateria: na tomada (ou sem bateria) é sempre bom; fora dela,
    /// acima de 30% bom, acima de 15% atenção, senão crítico.
    public static func battery(percent: Int?, pluggedIn: Bool) -> HealthLevel {
        guard let percent = percent, !pluggedIn else { return .good }
        if percent > 30 { return .good }
        if percent > 15 { return .warning }
        return .critical
    }

    /// Estado térmico do macOS (`ProcessInfo.ThermalState.rawValue`):
    /// 0 nominal, 1 fair, 2 serious, 3 critical.
    public static func thermal(state: Int) -> HealthLevel {
        if state <= 0 { return .good }
        if state == 1 { return .warning }
        return .critical
    }

    /// Nome do estado térmico em pt-BR.
    public static func thermalLabel(state: Int) -> String {
        switch state {
        case 1: return "Morno"
        case 2: return "Quente"
        case 3: return "Crítico"
        default: return state <= 0 ? "Normal" : "Crítico"
        }
    }

    /// O pior dos níveis informados (sem nenhum, é bom).
    public static func overall(_ levels: [HealthLevel]) -> HealthLevel {
        return levels.max() ?? .good
    }
}

/// Histórico de tamanho fixo para os gráficos: guarda as últimas `capacity`
/// amostras; ao encher, a mais antiga sai.
public struct SampleHistory: Equatable, Sendable {
    public let capacity: Int
    private var storage: [Double]
    /// Posição onde a próxima amostra será gravada quando o histórico estiver cheio.
    private var next: Int

    public init(capacity: Int) {
        self.capacity = max(1, capacity)
        self.storage = []
        self.next = 0
    }

    public var count: Int {
        return storage.count
    }

    public var isEmpty: Bool {
        return storage.isEmpty
    }

    public mutating func append(_ value: Double) {
        if storage.count < capacity {
            storage.append(value)
        } else {
            storage[next] = value
            next = (next + 1) % capacity
        }
    }

    /// Amostras da mais antiga para a mais nova.
    public var values: [Double] {
        if storage.count < capacity { return storage }
        return Array(storage[next...]) + Array(storage[..<next])
    }

    public var last: Double? {
        if storage.isEmpty { return nil }
        if storage.count < capacity { return storage[storage.count - 1] }
        return storage[(next + capacity - 1) % capacity]
    }

    public var maximum: Double? {
        return storage.max()
    }
}

/// Formatação pt-BR das medidas do sistema.
public enum SystemFormat {
    /// "37%" a partir de uma fração 0…1 (arredondada e limitada a 0–100).
    public static func percent(fraction: Double) -> String {
        guard fraction.isFinite else { return "0%" }
        let clamped = max(0, min(1, fraction))
        return "\(Int((clamped * 100).rounded()))%"
    }

    /// "12,4 GB", "182 GB", "512 MB". `binary` usa 1024 (memória); o padrão é
    /// 1000, como o Finder mostra discos.
    public static func bytes(_ bytes: Double, binary: Bool = false) -> String {
        guard bytes.isFinite, bytes > 0 else { return "0 MB" }
        let unit: Double = binary ? 1024 : 1000
        let megabyte = unit * unit
        let gigabyte = megabyte * unit
        let terabyte = gigabyte * unit
        if bytes >= terabyte {
            return "\(decimal(bytes / terabyte)) TB"
        }
        if bytes >= gigabyte {
            return "\(decimal(bytes / gigabyte)) GB"
        }
        return "\(Int((bytes / megabyte).rounded())) MB"
    }

    /// Uma casa decimal com vírgula abaixo de 100 ("12,4"), sem ",0" ("16");
    /// de 100 para cima, inteiro ("182").
    static func decimal(_ value: Double) -> String {
        if value >= 99.95 {
            return "\(Int(value.rounded()))"
        }
        let tenths = Int((value * 10).rounded())
        let whole = tenths / 10
        let fraction = tenths % 10
        return fraction == 0 ? "\(whole)" : "\(whole),\(fraction)"
    }

    /// "3h 20min", "45min" — tempo restante de bateria.
    public static func minutes(_ minutes: Int) -> String {
        let safe = max(0, minutes)
        if safe < 60 { return "\(safe)min" }
        let rest = safe % 60
        return rest == 0 ? "\(safe / 60)h" : "\(safe / 60)h \(rest < 10 ? "0" : "")\(rest)min"
    }
}

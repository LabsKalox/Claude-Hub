import AppKit
import Combine
import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

// MARK: - Preferência

/// Leitura direta da preferência, sem depender do ator principal — usada por
/// `IslandMetrics`, que calcula o tamanho da ilha fora de uma vista.
enum SystemPreferenceStore {
    static let showPerformanceKey = "system.showPerformance"

    static let showCpuMemoryKey = "system.showCpuMemory"

    static var showPerformance: Bool {
        return (UserDefaults.standard.object(forKey: showPerformanceKey) as? Bool) ?? true
    }

    /// CPU e memória aparecem (cartões da aba Sistema e leituras na ilha). Desligado de fábrica.
    static var showCpuMemory: Bool {
        return (UserDefaults.standard.object(forKey: showCpuMemoryKey) as? Bool) ?? false
    }

    /// A ilha em repouso mostra "CPU · RAM": só com as duas preferências ligadas.
    static var idleReadout: Bool {
        return showPerformance && showCpuMemory
    }
}

/// Preferências do monitor do sistema (prefixo `system.` no UserDefaults).
@MainActor
final class SystemPreferences: ObservableObject {
    static let shared = SystemPreferences()

    /// Mostra CPU/RAM/SSD na ilha (pílula ociosa, alerta nas demais e cabeçalho do painel).
    @Published var showPerformance: Bool {
        didSet {
            guard showPerformance != oldValue else { return }
            UserDefaults.standard.set(showPerformance, forKey: SystemPreferenceStore.showPerformanceKey)
            SystemMonitor.shared.policyChanged()
        }
    }

    /// Mostra CPU e memória: cartões da aba Sistema, leituras na ilha em repouso e no topo do painel.
    @Published var showCpuMemory: Bool {
        didSet {
            guard showCpuMemory != oldValue else { return }
            UserDefaults.standard.set(showCpuMemory, forKey: SystemPreferenceStore.showCpuMemoryKey)
            SystemMonitor.shared.policyChanged()
        }
    }

    private init() {
        // Inicializa o armazenamento direto: assim o didSet não roda durante a criação.
        _showPerformance = Published(initialValue: SystemPreferenceStore.showPerformance)
        _showCpuMemory = Published(initialValue: SystemPreferenceStore.showCpuMemory)
    }
}

/// Constantes do monitor, fora do ator principal para poderem ser usadas em qualquer contexto.
enum SystemMonitorConstants {
    /// Pontos guardados por gráfico.
    static let historyCapacity = 60
}

// MARK: - Fotografia do sistema

/// Tudo o que o monitor sabe num instante. Publicada de uma vez só, para a
/// interface redesenhar uma única vez por amostra.
struct SystemSnapshot: Equatable {
    /// Uso de CPU (0…1); nil até existir a segunda leitura.
    var cpu: Double?
    var memoryUsed: Double?
    var memoryTotal: Double = 0
    var diskTotal: Double?
    var diskAvailable: Double?
    var battery: SystemProbe.Battery?
    var batteryCycles: Int?
    /// 0 nominal, 1 morno, 2 quente, 3 crítico (`ProcessInfo.thermalState`).
    var thermalState: Int = 0
    var cpuHistory = SampleHistory(capacity: SystemMonitorConstants.historyCapacity)
    var memoryHistory = SampleHistory(capacity: SystemMonitorConstants.historyCapacity)

    var memoryAvailable: Double? {
        guard let used = memoryUsed, memoryTotal > 0 else { return nil }
        return max(0, memoryTotal - used)
    }

    var memoryFraction: Double? {
        guard let used = memoryUsed, memoryTotal > 0 else { return nil }
        return max(0, min(1, used / memoryTotal))
    }

    var diskFreeFraction: Double? {
        guard let total = diskTotal, let available = diskAvailable, total > 0 else { return nil }
        return max(0, min(1, available / total))
    }

    var cpuLevel: HealthLevel? {
        guard let cpu = cpu else { return nil }
        return SystemHealth.cpu(usage: cpu)
    }

    var memoryLevel: HealthLevel? {
        guard let fraction = memoryFraction else { return nil }
        return SystemHealth.memory(usedFraction: fraction)
    }

    var diskLevel: HealthLevel? {
        guard let free = diskFreeFraction else { return nil }
        return SystemHealth.disk(freeFraction: free)
    }

    var batteryLevel: HealthLevel? {
        guard let battery = battery else { return nil }
        return SystemHealth.battery(percent: battery.percent, pluggedIn: battery.onAC || battery.charging)
    }

    var thermalLevel: HealthLevel {
        return SystemHealth.thermal(state: thermalState)
    }

    /// O pior indicador do momento.
    var overallLevel: HealthLevel {
        var levels: [HealthLevel] = [thermalLevel]
        // Indicador oculto não gera alerta.
        if SystemPreferenceStore.showCpuMemory {
            if let level = cpuLevel { levels.append(level) }
            if let level = memoryLevel { levels.append(level) }
        }
        if let level = diskLevel { levels.append(level) }
        if let level = batteryLevel { levels.append(level) }
        return SystemHealth.overall(levels)
    }
}

// MARK: - Monitor

/// Monitor do Mac: CPU, memória, SSD, bateria e estado térmico.
///
/// Um único temporizador para tudo:
///   - a cada 2 s enquanto a aba Sistema está na tela;
///   - a cada 10 s no resto do tempo (para os gráficos terem histórico e os
///     indicadores da ilha ficarem atuais), se os indicadores estiverem ligados;
///   - parado quando a ilha está oculta.
/// O disco e os ciclos da bateria são lidos no máximo uma vez por minuto.
@MainActor
final class SystemMonitor: ObservableObject {
    static let shared = SystemMonitor()

    private static let detailedInterval: TimeInterval = 2
    private static let backgroundInterval: TimeInterval = 10
    private static let slowReadInterval: TimeInterval = 60

    @Published private(set) var snapshot = SystemSnapshot()

    private var timer: Timer?
    private var currentInterval: TimeInterval = 0
    private var warmUp: Task<Void, Never>?
    private var lastTicks: SystemProbe.CPUTicks?
    private var lastSlowRead: Date?
    private var islandVisible = true
    private var detailed = false
    private var cancellables = Set<AnyCancellable>()
    private var thermalObserver: NSObjectProtocol?

    private init() {
        snapshot.memoryTotal = SystemProbe.memoryTotalBytes()
        snapshot.thermalState = SystemProbe.thermalState()
    }

    /// Liga o monitor ao estado do app: ilha oculta para tudo; a aba Sistema
    /// aberta acelera as leituras.
    func bind(store: HubStore, prefs: Preferences) {
        islandVisible = prefs.islandVisible
        prefs.objectWillChange
            .sink { [weak self, weak prefs] _ in
                Task { @MainActor [weak self, weak prefs] in
                    guard let monitor = self, let prefs = prefs else { return }
                    monitor.setActive(prefs.islandVisible)
                }
            }
            .store(in: &cancellables)
        store.objectWillChange
            .sink { [weak self, weak store] _ in
                Task { @MainActor [weak self, weak store] in
                    guard let monitor = self, let store = store else { return }
                    monitor.setDetailed(store.panelOpen && store.selectedTab == .sistema && !store.pairingVisible)
                }
            }
            .store(in: &cancellables)
        if thermalObserver == nil {
            thermalObserver = NotificationCenter.default.addObserver(
                forName: ProcessInfo.thermalStateDidChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.refreshThermal()
                }
            }
        }
        applyPolicy()
    }

    /// Ilha visível ou oculta. Oculta: nenhuma leitura é feita.
    func setActive(_ active: Bool) {
        guard islandVisible != active else { return }
        islandVisible = active
        applyPolicy()
    }

    /// A aba Sistema está na tela: leituras a cada 2 s.
    func setDetailed(_ value: Bool) {
        guard detailed != value else { return }
        detailed = value
        applyPolicy()
    }

    func policyChanged() {
        applyPolicy()
    }

    // MARK: Temporizador

    private var wantedInterval: TimeInterval? {
        guard islandVisible else { return nil }
        if detailed { return SystemMonitor.detailedInterval }
        return SystemPreferences.shared.showPerformance ? SystemMonitor.backgroundInterval : nil
    }

    private func applyPolicy() {
        guard let interval = wantedInterval else {
            stopTimer()
            return
        }
        if timer != nil, interval == currentInterval { return }
        let wasStopped = timer == nil
        stopTimer(keepTicks: !wasStopped)
        currentInterval = interval
        sample()
        let newTimer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.sample()
            }
        }
        newTimer.tolerance = interval * 0.2
        RunLoop.main.add(newTimer, forMode: .common)
        timer = newTimer
        if snapshot.cpu == nil {
            // O uso de CPU precisa de duas leituras: faz a segunda logo, em vez
            // de esperar o intervalo inteiro com "—" na tela.
            warmUp = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                self?.sample()
            }
        }
    }

    private func stopTimer(keepTicks: Bool = false) {
        timer?.invalidate()
        timer = nil
        warmUp?.cancel()
        warmUp = nil
        currentInterval = 0
        if !keepTicks {
            lastTicks = nil
        }
    }

    // MARK: Leituras

    private func sample() {
        var next = snapshot
        if let ticks = SystemProbe.cpuTicks() {
            if let previous = lastTicks, let usage = SystemProbe.cpuUsage(from: previous, to: ticks) {
                next.cpu = usage
                next.cpuHistory.append(usage)
            }
            lastTicks = ticks
        }
        if let used = SystemProbe.memoryUsedBytes() {
            next.memoryUsed = used
            if next.memoryTotal > 0 {
                next.memoryHistory.append(max(0, min(1, used / next.memoryTotal)))
            }
        }
        let now = Date()
        var slowReadDue = true
        if let last = lastSlowRead, now.timeIntervalSince(last) < SystemMonitor.slowReadInterval {
            slowReadDue = false
        }
        if slowReadDue {
            lastSlowRead = now
            if let disk = SystemProbe.disk() {
                next.diskTotal = disk.total
                next.diskAvailable = disk.available
            }
            next.batteryCycles = SystemProbe.batteryCycleCount()
        }
        next.battery = SystemProbe.battery()
        next.thermalState = SystemProbe.thermalState()
        if next != snapshot {
            snapshot = next
        }
    }

    private func refreshThermal() {
        let state = SystemProbe.thermalState()
        if snapshot.thermalState != state {
            snapshot.thermalState = state
        }
    }
}

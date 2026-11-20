import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Aba "Sistema": painel de desempenho deste Mac (CPU, memória, SSD, bateria
/// e estado térmico) e, abaixo, a situação do hub e dos iPhones pareados.
///
/// Todas as leituras vêm do `SystemMonitor`, por API pública do macOS, e
/// ficam mais frequentes (2 s) só enquanto esta aba está na tela.
@MainActor
struct SystemTabView: View {
    @EnvironmentObject private var store: HubStore
    @ObservedObject private var monitor: SystemMonitor
    @ObservedObject private var systemPrefs: SystemPreferences

    init() {
        _monitor = ObservedObject(wrappedValue: SystemMonitor.shared)
        _systemPrefs = ObservedObject(wrappedValue: SystemPreferences.shared)
    }

    var body: some View {
        let snapshot = monitor.snapshot
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    SectionTitle("ESTE MAC")
                    Spacer(minLength: 8)
                    HealthBadge(level: snapshot.overallLevel)
                }
                if systemPrefs.showCpuMemory {
                    HStack(alignment: .top, spacing: 8) {
                        cpuCard(snapshot)
                        memoryCard(snapshot)
                    }
                }
                HStack(alignment: .top, spacing: 8) {
                    diskCard(snapshot)
                    if let battery = snapshot.battery {
                        batteryCard(battery, snapshot: snapshot)
                    }
                }
                thermalCard(snapshot)
                SwitchRow(
                    title: "Mostrar CPU e memória",
                    subtitle: "Cartões com gráfico nesta aba e as leituras de CPU e RAM na ilha.",
                    isOn: Binding(
                        get: { systemPrefs.showCpuMemory },
                        set: { systemPrefs.showCpuMemory = $0 }
                    )
                )
                .padding(.top, 2)
                SwitchRow(
                    title: "Mostrar desempenho na ilha",
                    subtitle: "Um ponto de alerta nas pílulas e os indicadores no topo do painel; com CPU e memória ligadas, também as leituras na ilha em repouso.",
                    isOn: Binding(
                        get: { systemPrefs.showPerformance },
                        set: { systemPrefs.showPerformance = $0 }
                    )
                )
                .padding(.top, 2)
                hubSection
                    .padding(.top, 6)
            }
            .padding(.bottom, 4)
        }
        .scrollIndicators(.never)
        .onAppear {
            monitor.setDetailed(true)
            store.refreshSystem()
            AppEnvironment.shared.setup.refresh()
        }
        .onDisappear {
            monitor.setDetailed(false)
        }
    }

    // MARK: Cartões de desempenho

    private func cpuCard(_ snapshot: SystemSnapshot) -> some View {
        let cores = ProcessInfo.processInfo.activeProcessorCount
        var detail = "\(cores) núcleos"
        if let peak = snapshot.cpuHistory.maximum {
            detail += " · pico recente \(SystemFormat.percent(fraction: peak))"
        }
        return SystemMetricCard(
            title: "CPU",
            value: snapshot.cpu.map { SystemFormat.percent(fraction: $0) } ?? "—",
            detail: detail,
            level: snapshot.cpuLevel,
            history: snapshot.cpuHistory.values,
            fraction: nil
        )
    }

    private func memoryCard(_ snapshot: SystemSnapshot) -> some View {
        var detail = "lendo…"
        if let used = snapshot.memoryUsed, let available = snapshot.memoryAvailable {
            detail = "\(SystemFormat.bytes(used, binary: true)) usados · \(SystemFormat.bytes(available, binary: true)) disponíveis"
        }
        return SystemMetricCard(
            title: "MEMÓRIA · \(SystemFormat.bytes(snapshot.memoryTotal, binary: true))",
            value: snapshot.memoryFraction.map { SystemFormat.percent(fraction: $0) } ?? "—",
            detail: detail,
            level: snapshot.memoryLevel,
            history: snapshot.memoryHistory.values,
            fraction: nil
        )
    }

    private func diskCard(_ snapshot: SystemSnapshot) -> some View {
        var value = "—"
        var detail = "lendo…"
        var used: Double?
        if let total = snapshot.diskTotal, let available = snapshot.diskAvailable, let free = snapshot.diskFreeFraction {
            value = "\(SystemFormat.bytes(available)) livres"
            detail = "de \(SystemFormat.bytes(total)) · \(SystemFormat.percent(fraction: 1 - free)) em uso"
            used = 1 - free
        }
        return SystemMetricCard(
            title: "SSD",
            value: value,
            detail: detail,
            level: snapshot.diskLevel,
            history: nil,
            fraction: used
        )
    }

    private func batteryCard(_ battery: SystemProbe.Battery, snapshot: SystemSnapshot) -> some View {
        var detail: String
        if battery.charging {
            detail = "Na tomada · carregando"
            if let minutes = battery.minutesToFull {
                detail += " · \(SystemFormat.minutes(minutes)) para completar"
            }
        } else if battery.onAC {
            detail = "Na tomada · sem carregar"
        } else {
            detail = "Na bateria"
            if let minutes = battery.minutesToEmpty {
                detail += " · \(SystemFormat.minutes(minutes)) restantes"
            }
        }
        if let cycles = snapshot.batteryCycles {
            detail += " · \(cycles) ciclos"
        }
        return SystemMetricCard(
            title: "BATERIA",
            value: "\(battery.percent)%",
            detail: detail,
            level: snapshot.batteryLevel,
            history: nil,
            fraction: Double(battery.percent) / 100
        )
    }

    private func thermalCard(_ snapshot: SystemSnapshot) -> some View {
        let level = snapshot.thermalLevel
        return HStack(alignment: .center, spacing: 12) {
            Image(systemName: "thermometer")
                .font(Theme.font(15, .medium))
                .foregroundStyle(Theme.healthColor(level))
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text("TEMPERATURA")
                        .kerning(0.8)
                        .font(Theme.font(9.5, .semibold))
                        .foregroundStyle(Theme.textFaint)
                    Text(SystemHealth.thermalLabel(state: snapshot.thermalState))
                        .font(Theme.font(12.5, .bold))
                        .foregroundStyle(Color.white)
                    HealthBadge(level: level)
                }
                Text("O macOS não expõe a temperatura em graus por API pública no Apple Silicon. Este é o estado térmico informado pelo próprio sistema.")
                    .font(Theme.font(10))
                    .foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .navyCard()
    }

    // MARK: Hub e iPhones

    private var hubSection: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                SectionTitle("HUB")
                InfoRow(title: "Estado", value: hubStatus, dot: store.isConnected ? Theme.green : Theme.red)
                InfoRow(title: "Porta local", value: localAddress)
                InfoRow(title: "Porta do iPhone", value: publicAddress)
                InfoRow(title: "URL do iPhone", value: publicURL)
                IntegrationStatusRow(setup: AppEnvironment.shared.setup)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

            VStack(alignment: .leading, spacing: 6) {
                SectionTitle("IPHONES PAREADOS")
                devicesList
                Button("Parear iPhone") {
                    store.startPairing()
                }
                .buttonStyle(PillButtonStyle(background: Theme.blue, fontSize: 11, horizontalPadding: 12, verticalPadding: 5))
                .disabled(!store.isConnected)
                .padding(.top, 4)
            }
            .frame(width: 270, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private var devicesList: some View {
        if store.devices.isEmpty {
            Text("Nenhum iPhone pareado ainda.")
                .font(Theme.font(11))
                .foregroundStyle(Theme.textDim)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.card))
        } else {
            // Sem rolagem própria: a aba inteira já rola.
            VStack(spacing: 6) {
                ForEach(store.devices) { device in
                    deviceRow(device)
                }
            }
        }
    }

    private func deviceRow(_ device: DeviceInfo) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "iphone")
                .font(Theme.font(12))
                .foregroundStyle(Theme.textDim)
            VStack(alignment: .leading, spacing: 1) {
                Text(device.name)
                    .font(Theme.font(11, .semibold))
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                Text(device.pushEnabled ? "notificações ativas" : "sem notificações")
                    .font(Theme.font(10))
                    .foregroundStyle(Theme.textFaint)
            }
            Spacer(minLength: 6)
            Button("Revogar") {
                store.revokeDevice(device)
            }
            .buttonStyle(PillButtonStyle(background: Theme.buttonNeutral, fontSize: 10, horizontalPadding: 9, verticalPadding: 3))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.card))
    }

    // MARK: Textos

    private var hubStatus: String {
        switch store.connection {
        case .connected:
            if let version = store.info?.version {
                return "No ar · v\(version)"
            }
            return "No ar"
        case .connecting: return "Conectando…"
        case .notConfigured: return "Não iniciado"
        case .unauthorized: return "Token recusado"
        case .disconnected: return "Fora do ar"
        }
    }

    private var localAddress: String {
        if let port = store.info?.localPort ?? store.config?.localPort {
            return "127.0.0.1:\(port)"
        }
        return "—"
    }

    private var publicAddress: String {
        if let port = store.info?.publicPort ?? store.config?.publicPort {
            return "porta \(port)"
        }
        return "—"
    }

    private var publicURL: String {
        return store.info?.publicUrl ?? store.config?.publicUrl ?? "não definida"
    }
}

/// Cartão de um indicador: título, semáforo, valor grande, linha de detalhe e,
/// conforme o caso, o gráfico do histórico ou uma barra de ocupação.
struct SystemMetricCard: View {
    let title: String
    let value: String
    let detail: String
    let level: HealthLevel?
    let history: [Double]?
    let fraction: Double?

    private var color: Color {
        guard let level = level else { return Theme.blueDeep }
        return Theme.healthColor(level)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(title)
                    .kerning(0.8)
                    .font(Theme.font(9.5, .semibold))
                    .foregroundStyle(Theme.textFaint)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if let level = level {
                    HealthBadge(level: level)
                }
            }
            Text(value)
                .font(Theme.font(21, .bold))
                .foregroundStyle(Color.white)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(detail)
                .font(Theme.font(10.5))
                .foregroundStyle(Theme.textDim)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if let history = history {
                PerformanceSparkline(values: history, capacity: SystemMonitorConstants.historyCapacity, color: color)
                    .frame(height: 30)
                    .padding(.top, 2)
            }
            if let fraction = fraction {
                ProgressBar(fraction: fraction, color: color, height: 4)
                    .padding(.top, 4)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .navyCard()
    }
}

/// Linha "Integração" da aba Sistema: serviço do hub e hooks do Claude Code,
/// conforme a CLI embutida, com atalho para o assistente de configuração.
@MainActor
struct IntegrationStatusRow: View {
    @ObservedObject var setup: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            InfoRow(title: "Integração", value: text, dot: dot)
            Button("Abrir configuração") {
                SetupWindowController.shared.show()
            }
            .buttonStyle(PillButtonStyle(background: Theme.buttonNeutral, fontSize: 11, horizontalPadding: 12, verticalPadding: 5))
        }
    }

    private var text: String {
        if setup.runtimeMissing { return "runtime não embutido" }
        guard let status = setup.status else {
            return setup.statusError == nil ? "verificando…" : "estado indisponível"
        }
        if status.runtime.locationBlocked { return "mova o app para Aplicativos" }
        if status.integrationConfigured { return "serviço ativo · \(status.hooks.events) hooks" }
        let service = status.service.installed && status.service.loaded ? "serviço ativo" : "serviço parado"
        let hooks = status.hooks.installed ? "hooks instalados" : "sem hooks"
        return "\(service) · \(hooks)"
    }

    private var dot: Color {
        if setup.runtimeMissing { return Theme.grey }
        guard let status = setup.status else { return Theme.grey }
        return status.integrationConfigured && !status.runtime.locationBlocked ? Theme.green : Theme.orange
    }
}

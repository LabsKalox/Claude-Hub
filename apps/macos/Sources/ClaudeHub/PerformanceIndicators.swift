import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Indicadores de desempenho do Mac que aparecem na própria ilha. Todos somem
/// quando a preferência "Mostrar desempenho na ilha" está desligada.

/// Um indicador curto: ponto do semáforo + "CPU 12%".
struct PerformanceReadout: View {
    let title: String
    let fraction: Double?
    let level: HealthLevel?
    var fontSize: CGFloat = 10.5

    private var dotColor: Color {
        guard let level = level else { return Theme.grey }
        return Theme.healthColor(level)
    }

    private var valueText: String {
        guard let fraction = fraction else { return "—" }
        return SystemFormat.percent(fraction: fraction)
    }

    var body: some View {
        HStack(spacing: 4) {
            StatusDot(color: dotColor, size: 5)
            Text("\(title) \(valueText)")
                .font(Theme.font(fontSize, .medium))
                .foregroundStyle(Theme.textDim)
                .monospacedDigit()
                .lineLimit(1)
                .fixedSize()
        }
    }
}

/// Conteúdo da pílula ociosa com os indicadores: "CPU 12% · RAM 61%".
/// Em tela com notch, CPU fica na asa esquerda e RAM na direita.
@MainActor
struct IdlePerformanceContent: View {
    let geometry: IslandGeometry
    @ObservedObject var monitor: SystemMonitor

    var body: some View {
        let snapshot = monitor.snapshot
        if geometry.hasNotch {
            HStack(spacing: 0) {
                PerformanceReadout(title: "CPU", fraction: snapshot.cpu, level: snapshot.cpuLevel, fontSize: 10)
                Spacer(minLength: geometry.notchWidth)
                PerformanceReadout(title: "RAM", fraction: snapshot.memoryFraction, level: snapshot.memoryLevel, fontSize: 10)
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            HStack(spacing: 7) {
                StarburstIcon(size: 11)
                PerformanceReadout(title: "CPU", fraction: snapshot.cpu, level: snapshot.cpuLevel)
                Text("·")
                    .font(Theme.font(10.5, .medium))
                    .foregroundStyle(Theme.textFaint)
                PerformanceReadout(title: "RAM", fraction: snapshot.memoryFraction, level: snapshot.memoryLevel)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Ponto único de alerta das pílulas compactas: só aparece quando o pior
/// indicador do Mac está em atenção ou crítico.
@MainActor
struct PerformanceAlertDot: View {
    @ObservedObject var monitor: SystemMonitor
    @ObservedObject var prefs: SystemPreferences

    var body: some View {
        let level = monitor.snapshot.overallLevel
        if prefs.showPerformance && level >= HealthLevel.warning {
            StatusDot(color: Theme.healthColor(level), size: 5)
                .help("Desempenho do Mac: \(level.label)")
        }
    }
}

/// Três pontos rotulados no topo do painel: "CPU · RAM · SSD".
@MainActor
struct PerformanceHeaderDots: View {
    @ObservedObject var monitor: SystemMonitor
    @ObservedObject var prefs: SystemPreferences

    var body: some View {
        let snapshot = monitor.snapshot
        if prefs.showPerformance {
            HStack(spacing: 9) {
                if prefs.showCpuMemory {
                    item("CPU", level: snapshot.cpuLevel)
                    item("RAM", level: snapshot.memoryLevel)
                }
                item("SSD", level: snapshot.diskLevel)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Capsule().fill(Theme.navySoft))
            .overlay(Capsule().stroke(Theme.navyBorder, lineWidth: 1))
            .help(summary(snapshot))
        }
    }

    private func item(_ title: String, level: HealthLevel?) -> some View {
        var color = Theme.grey
        if let level = level {
            color = Theme.healthColor(level)
        }
        return HStack(spacing: 4) {
            StatusDot(color: color, size: 5)
            Text(title)
                .font(Theme.font(9.5, .semibold))
                .foregroundStyle(Theme.textDim)
                .lineLimit(1)
        }
    }

    private func summary(_ snapshot: SystemSnapshot) -> String {
        var parts: [String] = []
        if prefs.showCpuMemory, let cpu = snapshot.cpu {
            parts.append("CPU \(SystemFormat.percent(fraction: cpu))")
        }
        if prefs.showCpuMemory, let memory = snapshot.memoryFraction {
            parts.append("RAM \(SystemFormat.percent(fraction: memory))")
        }
        if let free = snapshot.diskFreeFraction {
            parts.append("SSD \(SystemFormat.percent(fraction: 1 - free)) em uso")
        }
        return parts.isEmpty ? "Lendo o desempenho do Mac…" : parts.joined(separator: " · ")
    }
}

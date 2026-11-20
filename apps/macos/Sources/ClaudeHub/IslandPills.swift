import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Disposição das pílulas compactas: conteúdo à esquerda e à direita. Em tela
/// com notch, as duas metades ficam nas "asas" ao lado do recorte.
struct PillLayout<Leading: View, Trailing: View>: View {
    let geometry: IslandGeometry
    let leading: Leading
    let trailing: Trailing

    init(geometry: IslandGeometry, @ViewBuilder leading: () -> Leading, @ViewBuilder trailing: () -> Trailing) {
        self.geometry = geometry
        self.leading = leading()
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 10) {
            leading
                .layoutPriority(1)
            Spacer(minLength: geometry.hasNotch ? geometry.notchWidth : 8)
            trailing
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Alerta de desempenho do Mac: cabe na margem direita, então nenhuma
        // pílula muda de tamanho; só aparece em atenção ou crítico.
        .overlay(alignment: .trailing) {
            PerformanceAlertDot(monitor: SystemMonitor.shared, prefs: SystemPreferences.shared)
                .padding(.trailing, 5)
        }
    }
}

private struct PillLabel: View {
    let text: String
    var size: CGFloat = 12.5

    var body: some View {
        Text(text)
            .font(Theme.font(size, .semibold))
            .foregroundStyle(Color.white)
            .lineLimit(1)
    }
}

private struct PillDetail: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Theme.font(11, .medium))
            .foregroundStyle(Theme.textDim)
            .lineLimit(1)
            .truncationMode(.tail)
    }
}

/// Frame 00:08 — ícone, "Trabalhando", pontos, anel laranja e a porcentagem
/// (só quando o progresso é mensurável).
struct WorkingPill: View {
    let session: Session
    let geometry: IslandGeometry
    let showPercent: Bool

    var body: some View {
        let percent = HubFormat.progressPercent(session.progress)
        PillLayout(geometry: geometry) {
            HStack(spacing: 8) {
                StarburstIcon(size: 14)
                PillLabel(text: session.status.label)
            }
        } trailing: {
            HStack(spacing: 8) {
                AnimatedDots()
                if let percent = percent {
                    ProgressRing(fraction: Double(percent) / 100)
                    if showPercent {
                        Text("\(percent)%")
                            .font(Theme.font(11, .semibold))
                            .foregroundStyle(Color.white.opacity(0.9))
                            .monospacedDigit()
                    }
                } else {
                    SpinnerRing()
                        .frame(width: 14, height: 14)
                }
            }
        }
    }
}

/// Frame 00:10 — ponto laranja, "Esperando você" e o botão azul "Responder".
@MainActor
struct WaitingPill: View {
    let session: Session
    let geometry: IslandGeometry
    @EnvironmentObject private var store: HubStore

    var body: some View {
        PillLayout(geometry: geometry) {
            HStack(spacing: 9) {
                StatusDot(color: Theme.orange, size: 9)
                PillLabel(text: session.status.label, size: geometry.hasNotch ? 12.5 : 14)
            }
        } trailing: {
            Button("Responder") {
                store.answerInClaude(sessionID: session.id)
            }
            .buttonStyle(PillButtonStyle(
                background: Theme.blue,
                fontSize: geometry.hasNotch ? 11 : 12.5,
                horizontalPadding: geometry.hasNotch ? 10 : 14,
                verticalPadding: geometry.hasNotch ? 4 : 6
            ))
        }
    }
}

struct CompletedPill: View {
    let session: Session
    let geometry: IslandGeometry

    var body: some View {
        PillLayout(geometry: geometry) {
            HStack(spacing: 8) {
                StatusDot(color: Theme.green)
                PillLabel(text: session.status.label)
            }
        } trailing: {
            PillDetail(text: session.projectName)
        }
    }
}

struct FailedPill: View {
    let session: Session
    let geometry: IslandGeometry

    var body: some View {
        PillLayout(geometry: geometry) {
            HStack(spacing: 8) {
                StatusDot(color: Theme.red)
                PillLabel(text: session.status.label)
            }
        } trailing: {
            PillDetail(text: session.projectName)
        }
    }
}

/// Aviso passageiro de conclusão ou erro (some sozinho em ~6 s).
struct FlashPill: View {
    let alert: HubAlert
    let geometry: IslandGeometry

    var body: some View {
        PillLayout(geometry: geometry) {
            HStack(spacing: 8) {
                StatusDot(color: alert.kind == .error ? Theme.red : Theme.green)
                PillLabel(text: alert.title)
            }
        } trailing: {
            PillDetail(text: alert.body)
        }
    }
}

@MainActor
struct OfflinePill: View {
    let state: HubConnectionState
    let geometry: IslandGeometry
    @EnvironmentObject private var store: HubStore

    private var label: String {
        switch state {
        case .notConfigured: return "Hub não iniciado"
        case .unauthorized: return "Token recusado"
        case .connecting: return "Conectando…"
        default: return "Hub offline"
        }
    }

    var body: some View {
        PillLayout(geometry: geometry) {
            HStack(spacing: 8) {
                StatusDot(color: Theme.grey)
                PillLabel(text: label)
            }
        } trailing: {
            Button {
                store.retryConnection()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(IconButtonStyle())
            .help("Tentar de novo")
        }
    }
}

/// Sem sessões: pílula pequena e discreta com o desempenho do Mac
/// ("CPU 12% · RAM 61%"). Com os indicadores desligados ela volta a ser só o
/// nome do app — e, em tela com notch, some dentro do próprio recorte.
@MainActor
struct IdlePill: View {
    let geometry: IslandGeometry
    @ObservedObject private var systemPrefs: SystemPreferences

    init(geometry: IslandGeometry) {
        self.geometry = geometry
        _systemPrefs = ObservedObject(wrappedValue: SystemPreferences.shared)
    }

    var body: some View {
        if systemPrefs.showPerformance && systemPrefs.showCpuMemory {
            IdlePerformanceContent(geometry: geometry, monitor: SystemMonitor.shared)
        } else if geometry.hasNotch {
            Color.clear
        } else {
            HStack(spacing: 6) {
                StarburstIcon(size: 11)
                Text("Claude Hub")
                    .font(Theme.font(10.5, .medium))
                    .foregroundStyle(Theme.textFaint)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Detalhe da sessão em foco, ao passar o mouse sobre a pílula.
struct DetailCard: View {
    let session: Session

    var body: some View {
        let percent = HubFormat.progressPercent(session.progress)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                StatusDot(color: Theme.statusColor(session.status))
                Text(session.status.label)
                    .font(Theme.font(12, .semibold))
                    .foregroundStyle(Color.white)
                Text("· \(session.projectName)")
                    .font(Theme.font(11.5, .medium))
                    .foregroundStyle(Theme.textDim)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Ticking(every: 1) { now in
                    Text(HubFormat.duration(ms: HubFormat.sessionActiveMs(session, now: now)))
                        .font(Theme.font(11, .medium))
                        .foregroundStyle(Theme.textFaint)
                        .monospacedDigit()
                }
            }
            Text(session.title)
                .font(Theme.font(13, .semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
            Text(session.lastEvent?.summary ?? session.preview ?? session.task ?? "Sem atividade ainda")
                .font(Theme.font(11))
                .foregroundStyle(Theme.textDim)
                .lineLimit(1)
            if let percent = percent {
                HStack(spacing: 8) {
                    ProgressBar(fraction: Double(percent) / 100, color: Theme.statusColor(session.status))
                    Text("\(percent)%")
                        .font(Theme.font(10, .semibold))
                        .foregroundStyle(Theme.textDim)
                        .monospacedDigit()
                }
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

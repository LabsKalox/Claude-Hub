import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Frame 00:05 — painel completo: as abas (na ordem de `PanelTab.allCases`),
/// os indicadores de desempenho, os dois ícones à direita e o conteúdo da aba.
@MainActor
struct PanelView: View {
    @EnvironmentObject private var store: HubStore
    @EnvironmentObject private var prefs: Preferences

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            topBar
            Group {
                if store.pairingVisible {
                    PairingView()
                } else {
                    switch store.selectedTab {
                    case .sistema: SystemTabView()
                    case .claude: ClaudeTabView()
                    case .uso: UsageTabView()
                    case .widgets: WidgetsTabView()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // Preto no topo (encosta no recorte da tela) descendo para azul-escuro.
        .background(Theme.panelGradient)
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 2) {
                ForEach(PanelTab.allCases) { tab in
                    tabButton(tab)
                }
            }
            .padding(3)
            .background(Capsule().fill(Theme.field))

            Spacer(minLength: 8)

            PerformanceHeaderDots(monitor: SystemMonitor.shared, prefs: SystemPreferences.shared)

            Button {
                store.startPairing()
            } label: {
                Image(systemName: "iphone")
            }
            .buttonStyle(IconButtonStyle())
            .help("Parear iPhone")

            Button {
                prefs.screenChoice = prefs.screenChoice.next
            } label: {
                Image(systemName: "arrow.left.arrow.right")
            }
            .buttonStyle(IconButtonStyle())
            .help("Trocar a ilha de tela (\(prefs.screenChoice.label))")
        }
    }

    private func tabButton(_ tab: PanelTab) -> some View {
        let selected = store.selectedTab == tab && !store.pairingVisible
        return Button {
            store.selectTab(tab)
        } label: {
            Text(tab.rawValue)
                .font(Theme.font(11.5, selected ? .bold : .medium))
                .foregroundStyle(selected ? Color.white : Theme.textDim)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(Capsule().fill(selected ? Theme.navySoft : Color.clear))
                .overlay(Capsule().stroke(selected ? Theme.blueDeep.opacity(0.8) : Color.clear, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Peças reutilizadas pelas abas

struct SectionTitle: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .kerning(0.8)
            .font(Theme.font(9.5, .semibold))
            .foregroundStyle(Theme.textFaint)
    }
}

/// Seletor segmentado no estilo do painel ("Automático | Sempre aqui | Só avisar").
struct SegmentedPills<Option: Hashable>: View {
    let options: [Option]
    let selection: Option
    let label: (Option) -> String
    let onSelect: (Option) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.self) { option in
                segment(option)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.field))
    }

    private func segment(_ option: Option) -> some View {
        let selected = option == selection
        return Button {
            onSelect(option)
        } label: {
            Text(label(option))
                .font(Theme.font(10, selected ? .bold : .medium))
                .foregroundStyle(selected ? Color.white : Theme.textDim)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(selected ? Theme.blue : Color.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Chave pequena com o rótulo à direita ("Estou longe do PC").
struct SwitchRow: View {
    let title: String
    var subtitle: String?
    let isOn: Binding<Bool>

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Toggle("", isOn: isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.mini)
                .tint(Theme.blue)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(Theme.font(11, .medium))
                    .foregroundStyle(Theme.textDim)
                if let subtitle = subtitle {
                    Text(subtitle)
                        .font(Theme.font(10))
                        .foregroundStyle(Theme.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct InfoRow: View {
    let title: String
    let value: String
    var dot: Color?

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(Theme.font(11))
                .foregroundStyle(Theme.textDim)
            Spacer(minLength: 8)
            if let dot = dot {
                StatusDot(color: dot, size: 6)
            }
            Text(value)
                .font(Theme.font(11, .medium))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.card))
    }
}

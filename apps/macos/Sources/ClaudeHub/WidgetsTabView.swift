import SwiftUI

/// Aba "Widgets": os widgets ligados (relógio, música, clima…) em cartões e,
/// abaixo, as preferências da ilha neste Mac.
@MainActor
struct WidgetsTabView: View {
    @EnvironmentObject private var prefs: Preferences
    @ObservedObject private var registry = WidgetRegistry.shared
    @ObservedObject private var hubPrefs = HubPrefsModel.shared
    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var launchFailed = false

    private let columns = [
        GridItem(.flexible(), spacing: 10, alignment: .top),
        GridItem(.flexible(), spacing: 10, alignment: .top),
    ]

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                widgetGrid
                if !registry.disabledWidgets.isEmpty {
                    disabledList
                }
                SectionTitle("PREFERÊNCIAS")
                    .padding(.top, 4)
                preferences
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollIndicators(.never)
        .onAppear {
            registry.registerBuiltIns()
            registry.setVisible(true)
            hubPrefs.load()
        }
        .onDisappear {
            registry.setVisible(false)
        }
    }

    // MARK: - Widgets

    @ViewBuilder
    private var widgetGrid: some View {
        let enabled = registry.enabledWidgets
        if enabled.isEmpty {
            Text("Nenhum widget ligado.")
                .font(Theme.font(11))
                .foregroundStyle(Theme.textDim)
        } else {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
                ForEach(Array(enabled.enumerated()), id: \.offset) { item in
                    WidgetCard(widget: item.element, registry: registry)
                        .id(item.element.id)
                }
            }
        }
    }

    /// Widgets desligados: uma linha para cada, com a chave para religar.
    private var disabledList: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle("DESLIGADOS")
            ForEach(Array(registry.disabledWidgets.enumerated()), id: \.offset) { item in
                disabledRow(item.element)
            }
        }
    }

    private func disabledRow(_ widget: any HubWidget) -> some View {
        let id = widget.id
        return SwitchRow(
            title: widget.title,
            subtitle: nil,
            isOn: Binding(
                get: { registry.isEnabled(id) },
                set: { registry.setEnabled(id, $0) }
            )
        )
    }

    // MARK: - Preferências

    private var preferences: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 10) {
                SwitchRow(
                    title: "Mostrar porcentagem",
                    subtitle: "Aparece só quando o agente tem uma lista de tarefas.",
                    isOn: $prefs.showPercent
                )
                SwitchRow(
                    title: "Avisar quando terminar",
                    subtitle: "A ilha mostra \"Terminou\" por alguns segundos.",
                    isOn: $prefs.completionAlerts
                )
                SwitchRow(
                    title: "Sons",
                    subtitle: "Um toque curto em pedidos, esperas e conclusões.",
                    isOn: $prefs.sounds
                )
                autoOpenRow
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

            VStack(alignment: .leading, spacing: 10) {
                SectionTitle("TELA DA ILHA")
                SegmentedPills(
                    options: ScreenChoice.allCases,
                    selection: prefs.screenChoice,
                    label: { $0.label },
                    onSelect: { prefs.screenChoice = $0 }
                )
                SectionTitle("ESTE MAC")
                    .padding(.top, 4)
                SwitchRow(
                    title: "Abrir no login",
                    subtitle: launchFailed ? "O macOS recusou. Mova o app para Aplicativos e tente de novo." : nil,
                    isOn: Binding(
                        get: { launchAtLogin },
                        set: { value in
                            launchFailed = !LaunchAtLogin.set(value)
                            launchAtLogin = LaunchAtLogin.isEnabled
                        }
                    )
                )
            }
            .frame(width: 300, alignment: .topLeading)
        }
    }

    /// Guardada pela CLI embutida (é o hook de início de sessão que a lê).
    private var autoOpenRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            SwitchRow(
                title: "Abrir a ilha quando o Claude Code iniciar",
                subtitle: autoOpenSubtitle,
                isOn: Binding(
                    get: { hubPrefs.prefs.autoOpenIsland },
                    set: { value in
                        Task {
                            await hubPrefs.set(.autoOpenIsland, value)
                        }
                    }
                )
            )
            .disabled(!hubPrefs.available || hubPrefs.isBusy(.autoOpenIsland))
            PrefDetailText(text: hubPrefs.detail(.autoOpenIsland))
                .padding(.leading, 40)
        }
    }

    private var autoOpenSubtitle: String {
        if !hubPrefs.available {
            return "Indisponível neste build: o runtime do Claude Hub não está embutido."
        }
        return "O painel abre sozinho ao começar uma sessão."
    }
}

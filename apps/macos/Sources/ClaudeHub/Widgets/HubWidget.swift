import SwiftUI

// COMO ACRESCENTAR UM WIDGET
//
// 1. Crie uma classe `final class MeuWidget: HubWidget` (num arquivo desta pasta)
//    com `id` estável, `title`, `symbol` (SF Symbol) e `makeView()`.
// 2. Opcional: `makeSettingsView()` para os ajustes que aparecem no botão da
//    engrenagem, e `start()`/`stop()` para trabalho que só deve acontecer com o
//    widget ligado e na tela (timers, rede).
// 3. Registre-o em `WidgetRegistry.registerBuiltIns()` — é o único lugar a tocar.
// O liga/desliga, a persistência (`widget.<id>.enabled`) e o cartão na aba
// Widgets vêm prontos; nenhuma outra tela precisa conhecer o widget novo.

/// Um widget da aba "Widgets" da ilha.
@MainActor
protocol HubWidget: AnyObject {
    /// Identificador estável (usado na chave de preferências). Ex.: "clock".
    var id: String { get }
    /// Nome em português mostrado no cartão.
    var title: String { get }
    /// Nome do SF Symbol do cabeçalho.
    var symbol: String { get }

    /// Conteúdo do cartão.
    func makeView() -> AnyView
    /// Ajustes do widget; nil se não houver nenhum.
    func makeSettingsView() -> AnyView?

    /// O widget passou a estar ligado E visível: pode buscar dados e atualizar a tela.
    func start()
    /// O widget foi desligado ou saiu da tela: para timers e rede.
    func stop()
    /// O widget foi ligado/desligado (mesmo fora da tela). Para escutas baratas
    /// que não podem perder eventos, como a música em reprodução.
    func enabledChanged(_ enabled: Bool)
}

extension HubWidget {
    func makeSettingsView() -> AnyView? {
        return nil
    }

    func start() {}

    func stop() {}

    func enabledChanged(_ enabled: Bool) {}
}

/// Lista ordenada dos widgets e o estado ligado/desligado de cada um.
@MainActor
final class WidgetRegistry: ObservableObject {
    static let shared = WidgetRegistry()

    @Published private(set) var widgets: [any HubWidget] = []
    /// Ids dos widgets desligados (o padrão é ligado).
    @Published private(set) var disabledIDs: Set<String> = []

    private let defaults: UserDefaults
    /// A aba Widgets está na tela.
    private var visible = false
    private var started: Set<String> = []
    private var builtInsRegistered = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private static func key(_ id: String) -> String {
        return "widget.\(id).enabled"
    }

    // MARK: - Registro

    /// Widgets que vêm com o app. Chamado uma vez, na abertura.
    func registerBuiltIns() {
        guard !builtInsRegistered else { return }
        builtInsRegistered = true
        register(ClockWidget())
        register(MusicWidget())
        register(WeatherWidget())
    }

    /// Acrescenta um widget ao fim da lista. Ids repetidos são ignorados.
    func register(_ widget: any HubWidget) {
        guard !widgets.contains(where: { $0.id == widget.id }) else { return }
        widgets.append(widget)
        let stored = defaults.object(forKey: WidgetRegistry.key(widget.id)) as? Bool
        let enabled = stored ?? true
        if !enabled {
            disabledIDs.insert(widget.id)
        }
        widget.enabledChanged(enabled)
        if enabled, visible {
            startIfNeeded(widget)
        }
    }

    // MARK: - Ligado / desligado

    func isEnabled(_ id: String) -> Bool {
        return !disabledIDs.contains(id)
    }

    var enabledWidgets: [any HubWidget] {
        return widgets.filter { !disabledIDs.contains($0.id) }
    }

    var disabledWidgets: [any HubWidget] {
        return widgets.filter { disabledIDs.contains($0.id) }
    }

    func setEnabled(_ id: String, _ enabled: Bool) {
        guard let widget = widgets.first(where: { $0.id == id }) else { return }
        guard isEnabled(id) != enabled else { return }
        defaults.set(enabled, forKey: WidgetRegistry.key(id))
        if enabled {
            disabledIDs.remove(id)
        } else {
            disabledIDs.insert(id)
        }
        widget.enabledChanged(enabled)
        if enabled, visible {
            startIfNeeded(widget)
        } else if !enabled {
            stopIfNeeded(widget)
        }
    }

    // MARK: - Visibilidade

    /// A aba Widgets apareceu ou sumiu: liga/desliga o trabalho de cada widget.
    func setVisible(_ value: Bool) {
        guard visible != value else { return }
        visible = value
        for widget in widgets {
            if value, isEnabled(widget.id) {
                startIfNeeded(widget)
            } else {
                stopIfNeeded(widget)
            }
        }
    }

    private func startIfNeeded(_ widget: any HubWidget) {
        guard !started.contains(widget.id) else { return }
        started.insert(widget.id)
        widget.start()
    }

    private func stopIfNeeded(_ widget: any HubWidget) {
        guard started.contains(widget.id) else { return }
        started.remove(widget.id)
        widget.stop()
    }
}

// MARK: - Cartão

/// Moldura comum: cabeçalho (ícone, nome, engrenagem), conteúdo e, quando a
/// engrenagem está aberta, o liga/desliga e os ajustes do widget.
@MainActor
struct WidgetCard: View {
    let widget: any HubWidget
    @ObservedObject var registry: WidgetRegistry
    @State private var adjusting = false

    init(widget: any HubWidget, registry: WidgetRegistry) {
        self.widget = widget
        self._registry = ObservedObject(wrappedValue: registry)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: widget.symbol)
                    .font(Theme.font(10.5, .semibold))
                    .foregroundStyle(Theme.textDim)
                    .frame(width: 14)
                Text(widget.title.uppercased())
                    .kerning(0.8)
                    .font(Theme.font(9.5, .semibold))
                    .foregroundStyle(Theme.textFaint)
                Spacer(minLength: 4)
                Button {
                    adjusting.toggle()
                } label: {
                    Image(systemName: adjusting ? "xmark" : "gearshape")
                        .font(Theme.font(10.5, .medium))
                        .foregroundStyle(Theme.textDim)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(adjusting ? "Fechar ajustes" : "Ajustar")
            }

            widget.makeView()
                .frame(maxWidth: .infinity, alignment: .leading)

            if adjusting {
                Rectangle()
                    .fill(Theme.cardBorder)
                    .frame(height: 1)
                SwitchRow(
                    title: "Mostrar este widget",
                    subtitle: nil,
                    isOn: Binding(
                        get: { registry.isEnabled(widget.id) },
                        set: { registry.setEnabled(widget.id, $0) }
                    )
                )
                if let settings = widget.makeSettingsView() {
                    settings
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.card))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .stroke(Theme.cardBorder, lineWidth: 1)
        )
    }
}

/// Texto pequeno de apoio usado dentro dos widgets.
struct WidgetCaption: View {
    let text: String
    var color: Color = Theme.textFaint

    init(_ text: String, color: Color = Theme.textFaint) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(Theme.font(10))
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }
}

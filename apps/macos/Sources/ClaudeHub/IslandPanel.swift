import AppKit
import Combine
import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Janela da ilha: painel sem moldura, acima da barra de menus, em todos os
/// Spaces (inclusive apps em tela cheia), que não ativa o app nem rouba o foco
/// do terminal.
final class IslandPanel: NSPanel {
    override init(
        contentRect: NSRect,
        styleMask style: NSWindow.StyleMask,
        backing backingStoreType: NSWindow.BackingStoreType,
        defer flag: Bool
    ) {
        super.init(contentRect: contentRect, styleMask: style, backing: backingStoreType, defer: flag)
        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = true
        level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        isMovable = false
        isMovableByWindowBackground = false
        isReleasedWhenClosed = false
        animationBehavior = .none
        appearance = NSAppearance(named: .darkAqua)
    }

    static func make() -> IslandPanel {
        return IslandPanel(
            contentRect: NSRect(x: 0, y: 0, width: 260, height: 60),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
    }

    override var canBecomeKey: Bool {
        return true
    }

    override var canBecomeMain: Bool {
        return false
    }
}

/// Aceita o primeiro clique mesmo com outro app em primeiro plano.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }
}

/// Publica as medidas do notch para o SwiftUI.
@MainActor
final class IslandGeometryModel: ObservableObject {
    @Published var geometry = IslandGeometry()
}

/// Posiciona e dimensiona a janela da ilha.
///
/// A janela acompanha o tamanho do estado atual: cresce antes da animação de
/// expansão e encolhe depois da de contração. Assim ela nunca cobre (nem
/// intercepta cliques de) uma área maior que a própria ilha.
@MainActor
final class IslandController {
    private let store: HubStore
    private let prefs: Preferences
    private let geometryModel: IslandGeometryModel
    private let panel: IslandPanel
    private var cancellables = Set<AnyCancellable>()
    private var observers: [NSObjectProtocol] = []
    private var monitors: [Any] = []
    private var shrinkTask: Task<Void, Never>?
    private var targetFrame: NSRect = .zero

    init(store: HubStore, prefs: Preferences) {
        self.store = store
        self.prefs = prefs
        self.geometryModel = IslandGeometryModel()
        self.panel = IslandPanel.make()

        let root = IslandRootView()
            .environmentObject(store)
            .environmentObject(prefs)
            .environmentObject(geometryModel)
        let hosting = FirstMouseHostingView(rootView: root)
        hosting.sizingOptions = []
        panel.contentView = hosting

        store.objectWillChange
            .sink { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.sync(force: false)
                }
            }
            .store(in: &cancellables)

        prefs.objectWillChange
            .sink { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.sync(force: true)
                }
            }
            .store(in: &cancellables)

        let screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.sync(force: true)
            }
        }
        observers.append(screenObserver)

        // Clique fora da ilha (em qualquer outro app) recolhe o painel.
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.store.collapse()
            }
        }) {
            monitors.append(monitor)
        }

        // Esc recolhe quando a ilha está com o foco do teclado.
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] event in
            if event.keyCode == 53 {
                Task { @MainActor [weak self] in
                    self?.store.collapse()
                }
            }
            return event
        }) {
            monitors.append(monitor)
        }

        sync(force: true)
    }

    // MARK: - Tela

    private func chooseScreen() -> NSScreen? {
        let screens = NSScreen.screens
        switch prefs.screenChoice {
        case .main:
            return screens.first
        case .cursor:
            let point = NSEvent.mouseLocation
            return screens.first(where: { NSMouseInRect(point, $0.frame, false) }) ?? screens.first
        case .builtin:
            return screens.first(where: { IslandController.isBuiltIn($0) }) ?? screens.first
        }
    }

    private static func isBuiltIn(_ screen: NSScreen) -> Bool {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        guard let number = screen.deviceDescription[key] as? NSNumber else { return false }
        return CGDisplayIsBuiltin(CGDirectDisplayID(number.uint32Value)) != 0
    }

    /// Medidas do notch: altura da área segura e largura do recorte.
    private static func geometry(for screen: NSScreen) -> IslandGeometry {
        let top = screen.safeAreaInsets.top
        guard top > 0 else { return IslandGeometry() }
        var notchWidth: CGFloat = 200
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            notchWidth = max(120, screen.frame.width - left.width - right.width)
        }
        return IslandGeometry(notchHeight: top, notchWidth: notchWidth)
    }

    private static func frame(for size: CGSize, on screen: NSScreen, geometry: IslandGeometry, offset: CGFloat) -> NSRect {
        let margin = IslandMetrics.windowMargin
        let width = (size.width + margin * 2).rounded()
        let height = (size.height + margin).rounded()
        // Com notch (e colada no topo): na borda superior, como extensão do recorte.
        // Nos demais casos: flutuando abaixo da barra de menus, 6 pt + a distância escolhida.
        let top = geometry.hasNotch ? screen.frame.maxY : screen.visibleFrame.maxY - 6 - offset
        return NSRect(
            x: (screen.frame.midX - width / 2).rounded(),
            y: (top - height).rounded(),
            width: width,
            height: height
        )
    }

    // MARK: - Sincronização

    private func sync(force: Bool) {
        guard prefs.islandVisible else {
            shrinkTask?.cancel()
            if panel.isVisible { panel.orderOut(nil) }
            targetFrame = .zero
            return
        }
        guard let screen = chooseScreen() else { return }

        // Fora do topo a ilha deixa de ser extensão do notch: vira uma cápsula solta.
        let offset = prefs.islandOffset
        let geometry = offset > 0 ? IslandGeometry() : IslandController.geometry(for: screen)
        if geometryModel.geometry != geometry {
            geometryModel.geometry = geometry
        }
        let size = IslandMetrics.size(for: store.content, geometry: geometry, showPercent: prefs.showPercent)
        let frame = IslandController.frame(for: size, on: screen, geometry: geometry, offset: offset)

        if !force && frame == targetFrame && panel.isVisible {
            return
        }
        let previous = targetFrame
        targetFrame = frame
        shrinkTask?.cancel()

        let sameAnchor = panel.isVisible && previous != .zero
            && abs(previous.midX - frame.midX) < 1 && abs(previous.maxY - frame.maxY) < 1
        if sameAnchor {
            // Cresce já para caber os dois estados; encolhe quando a animação acabar.
            let union = panel.frame.union(frame)
            panel.setFrame(union, display: true)
            if union != frame {
                shrinkTask = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 600_000_000)
                    if Task.isCancelled { return }
                    guard let controller = self else { return }
                    controller.panel.setFrame(controller.targetFrame, display: true)
                }
            }
        } else {
            panel.setFrame(frame, display: true)
        }
        if !panel.isVisible {
            panel.orderFrontRegardless()
        }
    }
}

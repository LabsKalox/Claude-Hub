import AppKit
import SwiftUI

/// Janela do assistente de configuração.
///
/// A ilha é um painel que não ativa o app; o assistente precisa de foco e de
/// teclado, então é uma janela comum, criada sob demanda.
@MainActor
final class SetupWindowController: NSObject, NSWindowDelegate {
    static let shared = SetupWindowController()

    private var window: NSWindow?

    private override init() {
        super.init()
    }

    var isVisible: Bool {
        return window?.isVisible ?? false
    }

    /// Mostra a janela (criando-a na primeira vez) e traz o app para a frente.
    /// `block` rola até um dos cinco blocos (5 = iPhone).
    func show(scrollTo block: Int? = nil) {
        let model = AppEnvironment.shared.setup
        let target: NSWindow
        if let existing = window {
            target = existing
        } else {
            target = makeWindow()
            window = target
        }
        let wasVisible = target.isVisible
        // App de barra de menus (LSUIElement): sem isto a janela abre atrás das outras.
        NSApp.activate(ignoringOtherApps: true)
        target.makeKeyAndOrderFront(nil)
        if !wasVisible {
            model.windowOpened()
        }
        if let block = block {
            model.scrollRequest = block
        }
    }

    func close() {
        window?.close()
    }

    private func makeWindow() -> NSWindow {
        let environment = AppEnvironment.shared
        let root = SetupAssistantView()
            .environmentObject(environment.setup)
            .environmentObject(environment.store)
        let hosting = NSHostingController(rootView: root)
        // O tamanho da janela é nosso, não o tamanho ideal do conteúdo.
        hosting.sizingOptions = []

        let created = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        created.title = "Claude Hub — Configuração"
        created.isReleasedWhenClosed = false
        created.appearance = NSAppearance(named: .darkAqua)
        created.backgroundColor = NSColor(srgbRed: 0.035, green: 0.039, blue: 0.051, alpha: 1)
        created.contentViewController = hosting
        created.contentMinSize = NSSize(width: 520, height: 460)
        created.setContentSize(NSSize(width: 560, height: 640))
        created.center()
        SetupWindowController.keepClearOfIsland(created)
        created.delegate = self
        return created
    }

    /// A ilha ocupa o topo da tela. Em telas baixas a janela centralizada ficaria
    /// por baixo dela: desce (e, se preciso, encolhe) para deixar a faixa livre.
    private static func keepClearOfIsland(_ window: NSWindow) {
        guard let screen = window.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        let reserved: CGFloat = 76 + IslandPlacement.currentOffset
        let bottomMargin: CGFloat = 12
        var frame = window.frame
        let maxHeight = visible.height - reserved - bottomMargin
        if frame.height > maxHeight {
            frame.size.height = max(window.minSize.height, maxHeight)
        }
        let highestTop = visible.maxY - reserved
        if frame.maxY > highestTop {
            frame.origin.y = max(visible.minY + bottomMargin, highestTop - frame.height)
        }
        if frame != window.frame {
            window.setFrame(frame, display: false)
        }
    }

    // MARK: - NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        AppEnvironment.shared.setup.windowClosed()
    }
}

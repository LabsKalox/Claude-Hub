// Fundo em degradê de fim de tarde (como o monitor dos frames de referência),
// usado só pelo teste de fumaça: sobre o papel de parede preto do runner do CI
// a silhueta preta da ilha ficaria invisível nas capturas.
//
//   swift tests/real/backdrop.swift &
import AppKit

final class GradientView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let colors = [
            NSColor(srgbRed: 0.29, green: 0.35, blue: 0.49, alpha: 1),
            NSColor(srgbRed: 0.42, green: 0.45, blue: 0.57, alpha: 1),
            NSColor(srgbRed: 0.60, green: 0.55, blue: 0.60, alpha: 1),
            NSColor(srgbRed: 0.85, green: 0.71, blue: 0.60, alpha: 1),
        ]
        // Ângulo -90: a primeira cor fica no topo.
        NSGradient(colors: colors)?.draw(in: bounds, angle: -90)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

var windows: [NSWindow] = []
for screen in NSScreen.screens {
    let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
    // Logo acima dos ícones da mesa, abaixo de qualquer janela normal.
    window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
    window.ignoresMouseEvents = true
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    window.isReleasedWhenClosed = false
    window.contentView = GradientView(frame: NSRect(origin: .zero, size: screen.frame.size))
    window.setFrame(screen.frame, display: true)
    window.orderFrontRegardless()
    windows.append(window)
}
app.run()

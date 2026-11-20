import AppKit
import SwiftUI

/// Janela pequena para ajustar a altura da ilha ao vivo: cada navegador e cada
/// tela têm uma barra de altura diferente, então o encaixe certo é visual.
@MainActor
final class IslandPositionWindowController: NSObject, NSWindowDelegate {
    static let shared = IslandPositionWindowController()

    private var window: NSWindow?

    func show() {
        let target = window ?? makeWindow()
        window = target
        NSApp.activate(ignoringOtherApps: true)
        target.makeKeyAndOrderFront(nil)
    }

    private func makeWindow() -> NSWindow {
        let root = IslandPositionView().environmentObject(AppEnvironment.shared.prefs)
        let hosting = NSHostingController(rootView: root)
        let created = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 230),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        created.title = "Altura da ilha"
        created.isReleasedWhenClosed = false
        created.appearance = NSAppearance(named: .darkAqua)
        created.contentViewController = hosting
        created.center()
        created.delegate = self
        return created
    }
}

struct IslandPositionView: View {
    @EnvironmentObject private var prefs: Preferences

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Mova até a ilha encaixar na linha da barra do seu navegador. Ela se move enquanto você ajusta.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Picker("Posição", selection: $prefs.islandPlacement) {
                ForEach(IslandPlacement.allCases) { placement in
                    Text(placement.label).tag(placement)
                }
            }

            HStack(spacing: 8) {
                Text("Ajuste fino")
                Slider(value: $prefs.islandNudge, in: IslandPlacement.nudgeRange, step: 1)
                Text("\(Int(prefs.islandNudge)) pt")
                    .monospacedDigit()
                    .frame(width: 48, alignment: .trailing)
            }

            HStack(spacing: 8) {
                Button {
                    prefs.islandNudge -= 1
                } label: {
                    Label("Subir 1 pt", systemImage: "arrow.up")
                }
                Button {
                    prefs.islandNudge += 1
                } label: {
                    Label("Descer 1 pt", systemImage: "arrow.down")
                }
                Spacer()
                Button("Redefinir") {
                    prefs.islandNudge = 0
                }
            }
        }
        .padding(18)
        .frame(width: 380)
    }
}

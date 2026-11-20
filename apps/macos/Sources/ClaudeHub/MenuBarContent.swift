import AppKit
import SwiftUI

/// Menu do ícone na barra de menus.
@MainActor
struct MenuBarContent: View {
    @EnvironmentObject private var store: HubStore
    @EnvironmentObject private var prefs: Preferences
    @State private var launchAtLogin = LaunchAtLogin.isEnabled

    var body: some View {
        Text(store.statusSummary)
        Divider()
        Button(prefs.islandVisible ? "Ocultar ilha" : "Mostrar ilha") {
            prefs.islandVisible.toggle()
        }
        Button("Abrir painel") {
            prefs.islandVisible = true
            store.openPanel(tab: .claude)
        }
        Button("Configuração e saúde…") {
            SetupWindowController.shared.show()
        }
        Button("Parear iPhone") {
            if RuntimeCLI.isAvailable {
                // Bloco 5 do assistente: túnel https, QR e aparelhos pareados.
                SetupWindowController.shared.show(scrollTo: 5)
            } else {
                // Build sem runtime embutido: pareamento simples no painel da ilha.
                prefs.islandVisible = true
                store.startPairing()
            }
        }
        Picker("Posição da ilha", selection: $prefs.islandPlacement) {
            ForEach(IslandPlacement.allCases) { placement in
                Text(placement.label).tag(placement)
            }
        }
        Button("Ajustar altura da ilha…") {
            prefs.islandVisible = true
            IslandPositionWindowController.shared.show()
        }
        Divider()
        Toggle("Abrir no login", isOn: Binding(
            get: { launchAtLogin },
            set: { value in
                LaunchAtLogin.set(value)
                launchAtLogin = LaunchAtLogin.isEnabled
            }
        ))
        Divider()
        Button("Sair do Claude Hub") {
            NSApplication.shared.terminate(nil)
        }
        .keyboardShortcut("q")
    }
}

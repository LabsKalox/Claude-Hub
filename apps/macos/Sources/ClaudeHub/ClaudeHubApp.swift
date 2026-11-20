import AppKit
import SwiftUI

/// Objetos que vivem durante toda a execução do app.
@MainActor
final class AppEnvironment {
    static let shared = AppEnvironment()

    let prefs: Preferences
    let store: HubStore
    /// Estado do assistente de configuração (CLI embutida).
    let setup: SetupModel

    private init() {
        let preferences = Preferences()
        let hubStore = HubStore(prefs: preferences)
        self.prefs = preferences
        self.store = hubStore
        self.setup = SetupModel(store: hubStore)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var island: IslandController?
    private var automationObservers: [NSObjectProtocol] = []
    /// Esta cópia do app só existiu para acordar a que já estava aberta.
    private var isDuplicateInstance = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Uma instância só: se o Claude Hub já está aberto (por exemplo, aberto
        // de novo pelo início de uma sessão do Claude Code), traz a que existe
        // para a frente e encerra esta antes de criar qualquer janela.
        if AppDelegate.activateExistingInstance() {
            isDuplicateInstance = true
            NSApp.terminate(nil)
            return
        }
        // App de barra de menus: sem ícone no Dock (também vale ao rodar via `swift run`).
        NSApplication.shared.setActivationPolicy(.accessory)
        let environment = AppEnvironment.shared
        island = IslandController(store: environment.store, prefs: environment.prefs)
        // Monitor do Mac: lê só enquanto a ilha está visível; acelera na aba Sistema.
        SystemMonitor.shared.bind(store: environment.store, prefs: environment.prefs)
        environment.store.start()
        observeAutomation()
        // Primeira execução (ou integração quebrada): abre o assistente sozinho.
        environment.setup.checkOnLaunch()
    }

    /// Procura outro processo do app com o mesmo identificador; se achar,
    /// ativa-o e devolve true.
    private static func activateExistingInstance() -> Bool {
        guard let bundleID = Bundle.main.bundleIdentifier else { return false }
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .filter { $0.processIdentifier != ownPID && !$0.isTerminated }
        guard let existing = others.first else { return false }
        existing.activate(options: [])
        return true
    }

    /// Permite abrir ou recolher o painel por script (atalhos, automações e o
    /// teste de fumaça do CI), sem exigir permissão de Acessibilidade:
    ///   dev.claudehub.mac.openPanel / dev.claudehub.mac.collapse
    ///   dev.claudehub.mac.openTab.claude | .sistema | .uso | .widgets
    ///   dev.claudehub.mac.openSetup / dev.claudehub.mac.closeSetup
    ///   dev.claudehub.mac.runSelfTest  (abre o assistente e roda a verificação
    ///                                   de saúde, que é somente leitura)
    /// Só muda o que está visível; por aqui não se instala nada, não se pareia
    /// ninguém e nenhuma decisão de permissão pode ser tomada.
    private func observeAutomation() {
        let center = DistributedNotificationCenter.default()
        let open = center.addObserver(
            forName: Notification.Name("dev.claudehub.mac.openPanel"),
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in
                AppEnvironment.shared.store.openPanel(tab: nil)
            }
        }
        let collapse = center.addObserver(
            forName: Notification.Name("dev.claudehub.mac.collapse"),
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in
                AppEnvironment.shared.store.collapse()
            }
        }
        let openSetup = center.addObserver(
            forName: Notification.Name("dev.claudehub.mac.openSetup"),
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in
                SetupWindowController.shared.show()
            }
        }
        let runSelfTest = center.addObserver(
            forName: Notification.Name("dev.claudehub.mac.runSelfTest"),
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in
                SetupWindowController.shared.show(scrollTo: 4)
                AppEnvironment.shared.setup.runSelfTestWhenIdle()
            }
        }
        let closeSetup = center.addObserver(
            forName: Notification.Name("dev.claudehub.mac.closeSetup"),
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in
                SetupWindowController.shared.close()
            }
        }
        automationObservers = [open, collapse, openSetup, runSelfTest, closeSetup]
        observeOpenTab("claude", tab: .claude)
        observeOpenTab("sistema", tab: .sistema)
        observeOpenTab("uso", tab: .uso)
        observeOpenTab("widgets", tab: .widgets)
    }

    /// dev.claudehub.mac.openTab.<nome>: abre o painel já na aba pedida.
    private func observeOpenTab(_ suffix: String, tab: PanelTab) {
        let observer = DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("dev.claudehub.mac.openTab.\(suffix)"),
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in
                AppEnvironment.shared.store.openPanel(tab: tab)
            }
        }
        automationObservers.append(observer)
    }

    func applicationWillTerminate(_ notification: Notification) {
        // A cópia duplicada nunca iniciou o store: não há o que parar.
        if isDuplicateInstance { return }
        AppEnvironment.shared.store.stop()
    }
}

@main
@MainActor
struct ClaudeHubApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = AppEnvironment.shared.store
    @StateObject private var prefs = AppEnvironment.shared.prefs

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent()
                .environmentObject(store)
                .environmentObject(prefs)
        } label: {
            Image(systemName: "sparkle")
        }
        .menuBarExtraStyle(.menu)
    }
}

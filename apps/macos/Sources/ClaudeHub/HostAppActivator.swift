import AppKit

/// Traz para a frente o terminal que hospeda a sessão ("Responder no Claude").
/// Só ativa um aplicativo — nunca digita nem executa nada nele.
enum HostAppActivator {
    private static let fallbacks = [
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "dev.warp.Warp-Stable",
        "com.mitchellh.ghostty",
        "com.microsoft.VSCode",
    ]

    @MainActor
    static func activate(bundleID: String?) {
        var candidates: [String] = []
        if let bundleID = bundleID, !bundleID.isEmpty {
            candidates.append(bundleID)
        }
        // Sem bundle id conhecido: o primeiro terminal que já estiver aberto.
        for fallback in fallbacks where !candidates.contains(fallback) {
            if !NSRunningApplication.runningApplications(withBundleIdentifier: fallback).isEmpty {
                candidates.append(fallback)
            }
        }
        candidates.append("com.apple.Terminal")

        for candidate in candidates {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: candidate) else { continue }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: url, configuration: configuration, completionHandler: nil)
            return
        }
    }
}

/// Tempo sem uso de teclado/mouse, informado ao hub para o modo "Automático".
enum Presence {
    static func idleSeconds() -> Double {
        guard let anyInput = CGEventType(rawValue: ~0) else { return 0 }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
    }
}

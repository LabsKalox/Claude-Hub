import Foundation
import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Preferências que vivem na CLI embutida (`prefs`), não em UserDefaults,
/// porque mexem nas configurações do Claude Code ou são lidas pelos hooks.
enum HubPrefKey: String {
    case autoOpenIsland
    case consumption
    case limits
}

/// Lê e grava as preferências da CLI. Compartilhado pelas abas Uso e Widgets.
@MainActor
final class HubPrefsModel: ObservableObject {
    static let shared = HubPrefsModel()

    /// Valores em uso. Antes da primeira leitura valem os padrões da CLI.
    @Published private(set) var prefs = HubPrefs()
    /// A CLI já respondeu pelo menos uma vez.
    @Published private(set) var loaded = false
    /// Chave que está sendo gravada agora (nil = nenhuma).
    @Published private(set) var busyKey: HubPrefKey?
    /// Texto devolvido pela CLI na última gravação de cada chave, sem alterações.
    @Published private(set) var details: [String: String] = [:]

    /// O app tem o runtime embutido (falso num build de desenvolvimento).
    let available: Bool
    private var loading = false

    init() {
        available = RuntimeCLI.isAvailable
    }

    func detail(_ key: HubPrefKey) -> String? {
        return details[key.rawValue]
    }

    func isBusy(_ key: HubPrefKey) -> Bool {
        return busyKey == key
    }

    /// Relê as preferências (`prefs`). Não altera nada.
    func load() {
        guard available, !loading else { return }
        loading = true
        Task { [weak self] in
            let result = try? await RuntimeCLI.run(PrefsResult.self, ["prefs"], timeout: 20)
            guard let model = self else { return }
            model.loading = false
            if let prefs = result?.prefs {
                model.prefs = prefs
                model.loaded = true
            }
        }
    }

    /// Grava uma preferência (`prefs set <chave> on|off`) e guarda o texto que a
    /// CLI devolveu. Devolve true quando a CLI confirmou a gravação.
    @discardableResult
    func set(_ key: HubPrefKey, _ on: Bool) async -> Bool {
        guard busyKey == nil else { return false }
        guard available else {
            details[key.rawValue] = RuntimeCLIError.runtimeMissing.message
            return false
        }
        busyKey = key
        details[key.rawValue] = nil
        var ok = false
        do {
            let result = try await RuntimeCLI.run(
                PrefsResult.self,
                ["prefs", "set", key.rawValue, on ? "on" : "off"],
                timeout: 30
            )
            ok = result.ok
            if let detail = result.detail, !detail.isEmpty {
                details[key.rawValue] = detail
            }
            if let prefs = result.prefs {
                self.prefs = prefs
                loaded = true
            }
        } catch {
            details[key.rawValue] = RuntimeCLIError.describe(error)
        }
        busyKey = nil
        return ok
    }
}

/// Texto devolvido pela CLI, mostrado exatamente como veio.
struct PrefDetailText: View {
    let text: String?

    var body: some View {
        if let text = text, !text.isEmpty {
            Text(text)
                .font(Theme.font(10))
                .foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}

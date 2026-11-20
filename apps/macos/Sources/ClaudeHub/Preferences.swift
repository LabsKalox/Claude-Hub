import Foundation
import ServiceManagement
import SwiftUI

/// Em qual tela a ilha aparece quando há mais de um monitor.
enum ScreenChoice: String, CaseIterable, Identifiable {
    case main
    case cursor
    case builtin

    var id: String {
        return rawValue
    }

    var label: String {
        switch self {
        case .main: return "Tela principal"
        case .cursor: return "Tela com o cursor"
        case .builtin: return "Tela embutida"
        }
    }

    var next: ScreenChoice {
        switch self {
        case .main: return .cursor
        case .cursor: return .builtin
        case .builtin: return .main
        }
    }
}

/// A que altura a ilha fica. Colada no topo ela cobre a barra de abas de um
/// navegador maximizado; por isso o padrão é logo abaixo dessa faixa.
enum IslandPlacement: String, CaseIterable, Identifiable {
    case top
    case belowTabs
    case lower

    static let defaultsKey = "islandPlacement"

    var id: String {
        return rawValue
    }

    var label: String {
        switch self {
        case .top: return "Colada no topo"
        case .belowTabs: return "Abaixo das abas do navegador"
        case .lower: return "Mais abaixo"
        }
    }

    /// Distância, em pontos, abaixo da barra de menus.
    var offset: CGFloat {
        switch self {
        case .top: return 0
        case .belowTabs: return 48
        case .lower: return 96
        }
    }

    /// Valor salvo, para quem não tem acesso ao objeto de preferências.
    static var current: IslandPlacement {
        return IslandPlacement(rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? "") ?? .belowTabs
    }
}

/// Preferências do app, guardadas em UserDefaults.
@MainActor
final class Preferences: ObservableObject {
    private enum Key {
        static let showPercent = "showPercent"
        static let sounds = "sounds"
        static let completionAlerts = "completionAlerts"
        static let islandVisible = "islandVisible"
        static let screenChoice = "screenChoice"
        static let islandPlacement = IslandPlacement.defaultsKey
    }

    private let defaults: UserDefaults

    @Published var showPercent: Bool = true {
        didSet { defaults.set(showPercent, forKey: Key.showPercent) }
    }

    @Published var sounds: Bool = true {
        didSet { defaults.set(sounds, forKey: Key.sounds) }
    }

    @Published var completionAlerts: Bool = true {
        didSet { defaults.set(completionAlerts, forKey: Key.completionAlerts) }
    }

    @Published var islandVisible: Bool = true {
        didSet { defaults.set(islandVisible, forKey: Key.islandVisible) }
    }

    @Published var screenChoice: ScreenChoice = .main {
        didSet { defaults.set(screenChoice.rawValue, forKey: Key.screenChoice) }
    }

    @Published var islandPlacement: IslandPlacement = .belowTabs {
        didSet { defaults.set(islandPlacement.rawValue, forKey: Key.islandPlacement) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            Key.showPercent: true,
            Key.sounds: true,
            Key.completionAlerts: true,
            Key.islandVisible: true,
            Key.screenChoice: ScreenChoice.main.rawValue,
            Key.islandPlacement: IslandPlacement.belowTabs.rawValue,
        ])
        // Todas as propriedades já têm valor inicial; aqui só carregamos o que
        // está salvo (o didSet regrava o mesmo valor, sem efeito colateral).
        showPercent = defaults.bool(forKey: Key.showPercent)
        sounds = defaults.bool(forKey: Key.sounds)
        completionAlerts = defaults.bool(forKey: Key.completionAlerts)
        islandVisible = defaults.bool(forKey: Key.islandVisible)
        screenChoice = ScreenChoice(rawValue: defaults.string(forKey: Key.screenChoice) ?? "") ?? .main
        islandPlacement = IslandPlacement(rawValue: defaults.string(forKey: Key.islandPlacement) ?? "") ?? .belowTabs
    }
}

/// "Abrir no login" pelo mecanismo oficial do macOS 13+ (SMAppService).
enum LaunchAtLogin {
    static var isEnabled: Bool {
        return SMAppService.mainApp.status == .enabled
    }

    /// Devolve false se o macOS recusar (por exemplo, app fora de /Applications).
    @discardableResult
    static func set(_ enabled: Bool) -> Bool {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            return true
        } catch {
            return false
        }
    }
}

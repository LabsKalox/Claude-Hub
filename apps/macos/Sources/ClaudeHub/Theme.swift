import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

extension Color {
    /// Cor a partir de "#RRGGBB".
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var value: UInt64 = 0
        _ = Scanner(string: cleaned).scanHexInt64(&value)
        let red = Double((value >> 16) & 0xFF) / 255
        let green = Double((value >> 8) & 0xFF) / 255
        let blue = Double(value & 0xFF) / 255
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: 1)
    }
}

/// Cores e medidas da ilha — os mesmos tokens da PWA (packages/shared).
enum Theme {
    static let island = Color.black
    static let card = Color(hex: HubTokens.card)
    static let cardBorder = Color(hex: HubTokens.cardBorder)
    static let field = Color(hex: HubTokens.field)
    static let text = Color.white
    static let textDim = Color(hex: HubTokens.textDim)
    static let textFaint = Color(hex: HubTokens.textFaint)
    static let blue = Color(hex: HubTokens.blue)
    static let green = Color(hex: HubTokens.green)
    static let orange = Color(hex: HubTokens.orange)
    static let red = Color(hex: HubTokens.red)
    static let grey = Color(hex: HubTokens.grey)
    static let link = Color(hex: HubTokens.link)
    static let buttonNeutral = Color(hex: HubTokens.buttonNeutral)
    static let coral = Color(hex: HubTokens.coral)
    /// Cor da estrela do Claude Hub.
    static let starburst = Color(hex: HubTokens.coral)

    // Azul-escuro: a cor principal das superfícies. O azul vivo (`blue`)
    // continua nos botões de ação, como no vídeo de referência.
    static let navy = Color(hex: "#0B1630")
    static let navySoft = Color(hex: "#121E3D")
    static let navyDeep = Color(hex: "#070D1E")
    static let navyBorder = Color(hex: "#1F2E57")
    static let blueDeep = Color(hex: "#1D4ED8")
    /// Amarelo do semáforo de desempenho.
    static let yellow = Color(hex: "#F2C94C")

    static let islandRadius: CGFloat = 28
    static let cardRadius: CGFloat = 14
    static let fieldRadius: CGFloat = 10

    static let spring = Animation.spring(response: 0.38, dampingFraction: 0.86)

    static func statusColor(_ status: SessionStatus) -> Color {
        return Color(hex: status.colorHex)
    }

    /// Verde, amarelo ou vermelho conforme o nível do indicador.
    static func healthColor(_ level: HealthLevel) -> Color {
        switch level {
        case .good: return green
        case .warning: return yellow
        case .critical: return red
        }
    }

    /// Fundo dos cartões e do painel: preto descendo para azul-escuro.
    static var panelGradient: LinearGradient {
        return LinearGradient(colors: [Color.black, navyDeep, navy], startPoint: .top, endPoint: .bottom)
    }

    static var cardGradient: LinearGradient {
        return LinearGradient(colors: [navySoft, navy], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    static func font(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        return Font.system(size: size, weight: weight)
    }

    static func mono(_ size: CGFloat) -> Font {
        return Font.system(size: size, weight: .regular, design: .monospaced)
    }
}

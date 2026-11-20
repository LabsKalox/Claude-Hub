import Foundation

/// Configuração local do hub, lida de ~/.claude-hub/config.json
/// (o mesmo arquivo que o hub e a CLI usam). O app só lê; nunca grava.
public struct HubConfig: Equatable, Sendable {
    public var localPort: Int
    public var publicPort: Int
    public var localToken: String
    public var publicUrl: String?

    public init(localPort: Int = 4317, publicPort: Int = 4318, localToken: String, publicUrl: String? = nil) {
        self.localPort = localPort
        self.publicPort = publicPort
        self.localToken = localToken
        self.publicUrl = publicUrl
    }

    public enum ParseError: Error, Equatable {
        case notAnObject
        case missingToken
    }

    /// Pasta de dados do hub; respeita CLAUDE_HUB_HOME.
    public static func homeDirectory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let custom = environment["CLAUDE_HUB_HOME"], !custom.isEmpty {
            return URL(fileURLWithPath: custom, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude-hub", isDirectory: true)
    }

    public static func configURL(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        return homeDirectory(environment: environment).appendingPathComponent("config.json", isDirectory: false)
    }

    public static func parse(_ data: Data) throws -> HubConfig {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ParseError.notAnObject
        }
        guard let token = object["localToken"] as? String, !token.isEmpty else {
            throw ParseError.missingToken
        }
        let publicUrl = (object["publicUrl"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return HubConfig(
            localPort: validPort(object["localPort"]) ?? 4317,
            publicPort: validPort(object["publicPort"]) ?? 4318,
            localToken: token,
            publicUrl: publicUrl
        )
    }

    /// Lê a configuração do disco; nil se o hub ainda não criou o arquivo.
    public static func load(environment: [String: String] = ProcessInfo.processInfo.environment) -> HubConfig? {
        guard let data = try? Data(contentsOf: configURL(environment: environment)),
              var config = try? parse(data) else {
            return nil
        }
        // Mesmas variáveis de ambiente que o hub aceita.
        if let port = validPort(environment["CLAUDE_HUB_LOCAL_PORT"]) { config.localPort = port }
        if let port = validPort(environment["CLAUDE_HUB_PUBLIC_PORT"]) { config.publicPort = port }
        if let url = environment["CLAUDE_HUB_PUBLIC_URL"], !url.isEmpty { config.publicUrl = url }
        return config
    }

    private static func validPort(_ value: Any?) -> Int? {
        var number: Int?
        if let int = value as? Int {
            number = int
        } else if let double = value as? Double, double == double.rounded() {
            number = Int(double)
        } else if let text = value as? String {
            number = Int(text)
        }
        guard let port = number, port > 0, port < 65536 else { return nil }
        return port
    }

    public var baseURLString: String {
        return "http://127.0.0.1:\(localPort)"
    }

    public var webSocketURL: URL? {
        return URL(string: "ws://127.0.0.1:\(localPort)/ws")
    }
}

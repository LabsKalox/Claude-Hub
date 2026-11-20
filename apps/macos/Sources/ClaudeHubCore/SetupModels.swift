import Foundation

// Contrato JSON da CLI embutida no app (`claude-hub.mjs … --json`).
//
// Toda a lógica de instalação vive na CLI; o app só mostra o que ela devolve.
// Decodificação tolerante, como nos demais modelos: campo ausente, nulo ou de
// outro tipo cai num padrão seguro, e chaves desconhecidas são ignoradas.

// MARK: - setup status

public struct SetupRuntime: Decodable, Equatable, Sendable {
    public var dir: String?
    public var node: String?
    public var nodeVersion: String?
    public var bundled: Bool
    public var appPath: String?
    public var inApplications: Bool
    public var translocated: Bool

    private enum CodingKeys: String, CodingKey {
        case dir, node, nodeVersion, bundled, appPath, inApplications, translocated
    }

    public init() {
        dir = nil
        node = nil
        nodeVersion = nil
        bundled = false
        appPath = nil
        // Sem informação, não bloqueia: só a CLI sabe dizer que o lugar está errado.
        inApplications = true
        translocated = false
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dir = c.lenient(String.self, .dir)
        node = c.lenient(String.self, .node)
        nodeVersion = c.lenient(String.self, .nodeVersion)
        bundled = c.lenient(Bool.self, .bundled) ?? false
        appPath = c.lenient(String.self, .appPath)
        inApplications = c.lenient(Bool.self, .inApplications) ?? true
        translocated = c.lenient(Bool.self, .translocated) ?? false
    }

    /// O app precisa estar em Aplicativos: o serviço e os hooks guardam o caminho dele.
    public var locationBlocked: Bool {
        return translocated || !inApplications
    }
}

public struct SetupClaude: Decodable, Equatable, Sendable {
    public var found: Bool
    public var path: String?
    public var version: String?
    public var settingsPath: String
    public var settingsExists: Bool
    public var settingsValid: Bool
    public var otherHooks: Int

    private enum CodingKeys: String, CodingKey {
        case found, path, version, settingsPath, settingsExists, settingsValid, otherHooks
    }

    public init() {
        found = false
        path = nil
        version = nil
        settingsPath = "~/.claude/settings.json"
        settingsExists = false
        settingsValid = true
        otherHooks = 0
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        found = c.lenient(Bool.self, .found) ?? false
        path = c.lenient(String.self, .path)
        version = c.lenient(String.self, .version)
        settingsPath = c.lenient(String.self, .settingsPath) ?? "~/.claude/settings.json"
        settingsExists = c.lenient(Bool.self, .settingsExists) ?? false
        // Só a CLI pode declarar o arquivo inválido; ausência não é invalidez.
        settingsValid = c.lenient(Bool.self, .settingsValid) ?? true
        otherHooks = c.lenient(Int.self, .otherHooks) ?? 0
    }
}

public struct SetupService: Decodable, Equatable, Sendable {
    public var supported: Bool
    public var installed: Bool
    public var loaded: Bool
    public var current: Bool
    public var plistPath: String?
    public var label: String?

    private enum CodingKeys: String, CodingKey {
        case supported, installed, loaded, current, plistPath, label
    }

    public init() {
        supported = true
        installed = false
        loaded = false
        current = false
        plistPath = nil
        label = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        supported = c.lenient(Bool.self, .supported) ?? true
        installed = c.lenient(Bool.self, .installed) ?? false
        loaded = c.lenient(Bool.self, .loaded) ?? false
        current = c.lenient(Bool.self, .current) ?? false
        plistPath = c.lenient(String.self, .plistPath)
        label = c.lenient(String.self, .label)
    }
}

public struct SetupHub: Decodable, Equatable, Sendable {
    public var running: Bool
    public var version: String?
    public var localPort: Int
    public var publicPort: Int
    /// Último evento real do Claude Code (ms desde 1970); nil se ainda não houve.
    public var lastHookAt: Double?

    private enum CodingKeys: String, CodingKey {
        case running, version, localPort, publicPort, lastHookAt
    }

    public init() {
        running = false
        version = nil
        localPort = 4317
        publicPort = 4318
        lastHookAt = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = c.lenient(Bool.self, .running) ?? false
        version = c.lenient(String.self, .version)
        localPort = c.lenient(Int.self, .localPort) ?? 4317
        publicPort = c.lenient(Int.self, .publicPort) ?? 4318
        lastHookAt = c.lenient(Double.self, .lastHookAt)
    }
}

public struct SetupHooks: Decodable, Equatable, Sendable {
    public var installed: Bool
    public var events: Int
    public var current: Bool

    private enum CodingKeys: String, CodingKey {
        case installed, events, current
    }

    public init() {
        installed = false
        events = 0
        current = false
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        installed = c.lenient(Bool.self, .installed) ?? false
        events = c.lenient(Int.self, .events) ?? 0
        current = c.lenient(Bool.self, .current) ?? false
    }
}

public enum TailscaleState: String, Equatable, Sendable {
    case missing
    case stopped
    case running
    /// O Tailscale respondeu algo que não é o estado dele (o texto vem em `detail`),
    /// ou a CLI mandou um valor que esta versão do app não conhece.
    case unknown
}

public struct SetupTunnel: Decodable, Equatable, Sendable {
    public var tailscale: TailscaleState
    public var dnsName: String?
    public var serving: Bool
    public var publicUrl: String?
    /// HTTPS Certificates da rede Tailscale: nil quando o Tailscale não informou.
    public var httpsEnabled: Bool?
    /// Texto do próprio Tailscale quando o estado não pôde ser lido.
    public var detail: String?

    private enum CodingKeys: String, CodingKey {
        case tailscale, dnsName, serving, publicUrl, httpsEnabled, detail
    }

    public init() {
        tailscale = .missing
        dnsName = nil
        serving = false
        publicUrl = nil
        httpsEnabled = nil
        detail = nil
    }

    /// Conectado, mas a rede não emite certificados: publicar a porta falharia.
    public var httpsDisabled: Bool {
        return tailscale == .running && httpsEnabled == false && !serving
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let raw = c.lenient(String.self, .tailscale) {
            tailscale = TailscaleState(rawValue: raw) ?? .unknown
        } else {
            tailscale = .missing
        }
        dnsName = c.lenient(String.self, .dnsName)
        serving = c.lenient(Bool.self, .serving) ?? false
        let url = c.lenient(String.self, .publicUrl)
        publicUrl = (url ?? "").isEmpty ? nil : url
        httpsEnabled = c.lenient(Bool.self, .httpsEnabled)
        let text = c.lenient(String.self, .detail)
        detail = (text ?? "").isEmpty ? nil : text
    }
}

/// Integração com outro agente (Codex CLI, OpenCode).
public struct SetupAgent: Decodable, Equatable, Sendable {
    public var found: Bool
    public var path: String?
    public var version: String?
    public var installed: Bool
    public var current: Bool
    public var configPath: String?
    public var configValid: Bool

    private enum CodingKeys: String, CodingKey {
        case found, path, version, installed, current, configPath, configValid
    }

    public init() {
        found = false
        path = nil
        version = nil
        installed = false
        current = false
        configPath = nil
        configValid = true
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        found = c.lenient(Bool.self, .found) ?? false
        path = c.lenient(String.self, .path)
        version = c.lenient(String.self, .version)
        installed = c.lenient(Bool.self, .installed) ?? false
        current = c.lenient(Bool.self, .current) ?? false
        configPath = c.lenient(String.self, .configPath)
        configValid = c.lenient(Bool.self, .configValid) ?? true
    }
}

public struct SetupAgents: Decodable, Equatable, Sendable {
    public var codex: SetupAgent
    public var opencode: SetupAgent

    private enum CodingKeys: String, CodingKey {
        case codex, opencode
    }

    public init() {
        codex = SetupAgent()
        opencode = SetupAgent()
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        codex = c.lenient(SetupAgent.self, .codex) ?? SetupAgent()
        opencode = c.lenient(SetupAgent.self, .opencode) ?? SetupAgent()
    }
}

/// Resposta de `setup status`.
public struct SetupStatus: Decodable, Equatable, Sendable {
    public var version: String?
    public var runtime: SetupRuntime
    public var claude: SetupClaude
    public var service: SetupService
    public var hub: SetupHub
    public var hooks: SetupHooks
    public var tunnel: SetupTunnel
    public var devices: Int
    /// Codex e OpenCode. Ausente em CLIs anteriores à 0.5.0.
    public var agents: SetupAgents
    public var ready: Bool
    /// Preenchido quando a CLI respondeu com erro (`ok: false`) em vez do estado.
    public var failure: String?

    private enum CodingKeys: String, CodingKey {
        case version, runtime, claude, service, hub, hooks, tunnel, devices, agents, ready
        case ok, detail, error
    }

    public init() {
        version = nil
        runtime = SetupRuntime()
        claude = SetupClaude()
        service = SetupService()
        hub = SetupHub()
        hooks = SetupHooks()
        tunnel = SetupTunnel()
        devices = 0
        agents = SetupAgents()
        ready = false
        failure = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.lenient(String.self, .version)
        runtime = c.lenient(SetupRuntime.self, .runtime) ?? SetupRuntime()
        claude = c.lenient(SetupClaude.self, .claude) ?? SetupClaude()
        service = c.lenient(SetupService.self, .service) ?? SetupService()
        hub = c.lenient(SetupHub.self, .hub) ?? SetupHub()
        hooks = c.lenient(SetupHooks.self, .hooks) ?? SetupHooks()
        tunnel = c.lenient(SetupTunnel.self, .tunnel) ?? SetupTunnel()
        devices = c.lenient(Int.self, .devices) ?? 0
        agents = c.lenient(SetupAgents.self, .agents) ?? SetupAgents()
        ready = c.lenient(Bool.self, .ready) ?? false
        if c.lenient(Bool.self, .ok) == false {
            failure = c.lenient(String.self, .detail) ?? c.lenient(String.self, .error) ?? "A CLI não conseguiu ler o estado."
        } else {
            failure = nil
        }
    }

    /// Serviço no ar, hub respondendo e hooks apontando para este app.
    public var integrationConfigured: Bool {
        return service.installed && service.loaded && service.current
            && hub.running && hooks.installed && hooks.current
    }

    /// O que ainda falta, em palavras, para a frase do bloco "Serviço e hooks".
    public var missingParts: [String] {
        var parts: [String] = []
        if !service.installed {
            parts.append("o serviço do hub não está instalado")
        } else if !service.current {
            parts.append("o serviço aponta para outra cópia do app")
        } else if !service.loaded {
            parts.append("o serviço não está carregado")
        }
        if !hub.running {
            parts.append("o hub não está respondendo")
        }
        if !hooks.installed {
            parts.append("os hooks do Claude Code não estão instalados")
        } else if !hooks.current {
            parts.append("os hooks apontam para outra instalação")
        }
        return parts
    }
}

// MARK: - setup run / uninstall-all

public struct SetupStep: Decodable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var ok: Bool
    public var detail: String

    private enum CodingKeys: String, CodingKey {
        case id, title, ok, detail
    }

    public init(id: String, title: String, ok: Bool, detail: String = "") {
        self.id = id
        self.title = title
        self.ok = ok
        self.detail = detail
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rawTitle = c.lenient(String.self, .title)
        let rawID = c.lenient(String.self, .id)
        id = rawID ?? rawTitle ?? "etapa"
        title = rawTitle ?? rawID ?? "Etapa"
        ok = c.lenient(Bool.self, .ok) ?? false
        detail = c.lenient(String.self, .detail) ?? ""
    }
}

/// Resposta de `setup run`.
public struct SetupRunResult: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var steps: [SetupStep]
    public var status: SetupStatus?
    public var detail: String?

    private enum CodingKeys: String, CodingKey {
        case ok, steps, status, detail, error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(Bool.self, .ok) ?? false
        steps = c.lenient([SetupStep].self, .steps) ?? []
        status = c.lenient(SetupStatus.self, .status)
        detail = c.lenient(String.self, .detail) ?? c.lenient(String.self, .error)
    }
}

/// Resposta de `uninstall-all`.
public struct UninstallResult: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var steps: [SetupStep]
    public var detail: String?

    private enum CodingKeys: String, CodingKey {
        case ok, steps, detail, error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(Bool.self, .ok) ?? false
        steps = c.lenient([SetupStep].self, .steps) ?? []
        detail = c.lenient(String.self, .detail) ?? c.lenient(String.self, .error)
    }
}

/// Resposta de `diagnostics`: relatório em texto, sem segredos.
public struct DiagnosticsResult: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var report: String
    public var logPath: String?
    public var detail: String?

    private enum CodingKeys: String, CodingKey {
        case ok, report, logPath, detail, error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(Bool.self, .ok) ?? false
        report = c.lenient(String.self, .report) ?? ""
        logPath = c.lenient(String.self, .logPath)
        detail = c.lenient(String.self, .detail) ?? c.lenient(String.self, .error)
    }
}

// MARK: - selftest

public struct SelfTestCheck: Decodable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var ok: Bool
    public var detail: String
    /// Duração da checagem em milissegundos, quando a CLI informa.
    public var ms: Double?

    private enum CodingKeys: String, CodingKey {
        case id, title, ok, detail, ms
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rawTitle = c.lenient(String.self, .title)
        let rawID = c.lenient(String.self, .id)
        id = rawID ?? rawTitle ?? "checagem"
        title = rawTitle ?? rawID ?? "Checagem"
        ok = c.lenient(Bool.self, .ok) ?? false
        detail = c.lenient(String.self, .detail) ?? ""
        ms = c.lenient(Double.self, .ms)
    }
}

/// Resposta de `selftest`.
public struct SelfTestResult: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var checks: [SelfTestCheck]
    public var detail: String?

    private enum CodingKeys: String, CodingKey {
        case ok, checks, detail, error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(Bool.self, .ok) ?? false
        checks = c.lenient([SelfTestCheck].self, .checks) ?? []
        detail = c.lenient(String.self, .detail) ?? c.lenient(String.self, .error)
    }

    public var failedCount: Int {
        return checks.filter { !$0.ok }.count
    }
}

// MARK: - service restart / service uninstall / tunnel enable

/// Resposta dos comandos de uma ação só.
public struct CommandResult: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var detail: String
    public var publicUrl: String?

    private enum CodingKeys: String, CodingKey {
        case ok, detail, error, publicUrl
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(Bool.self, .ok) ?? false
        detail = c.lenient(String.self, .detail) ?? c.lenient(String.self, .error) ?? ""
        let url = c.lenient(String.self, .publicUrl)
        publicUrl = (url ?? "").isEmpty ? nil : url
    }
}

// MARK: - Saída da CLI

public enum SetupJSON {
    public enum ParseError: Error, Equatable {
        /// A saída não contém um objeto JSON.
        case noObject
    }

    /// Recorta o objeto JSON da saída da CLI. O contrato é "um único objeto",
    /// mas um aviso do Node antes ou depois não deve derrubar a leitura.
    public static func extractObject(from data: Data) -> Data? {
        let open = UInt8(ascii: "{")
        let close = UInt8(ascii: "}")
        guard let first = data.firstIndex(of: open), let last = data.lastIndex(of: close), first < last else {
            return nil
        }
        return data.subdata(in: first..<(last + 1))
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        if let value = try? decoder.decode(type, from: data) {
            return value
        }
        guard let object = extractObject(from: data) else {
            throw ParseError.noObject
        }
        return try decoder.decode(type, from: object)
    }

    /// "há 2 min" para o último evento real; nil quando ainda não houve nenhum.
    public static func lastHookText(lastHookAt: Double?, now: Double) -> String? {
        guard let at = lastHookAt, at > 0 else { return nil }
        let ago = HubFormat.ago(from: at, now: now)
        return ago == "agora" ? "agora mesmo" : "há \(ago)"
    }
}

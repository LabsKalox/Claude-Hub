import XCTest
@testable import ClaudeHubCore

/// Contrato JSON da CLI embutida (`claude-hub.mjs … --json`).
final class SetupModelsTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        return try SetupJSON.decode(type, from: Data(json.utf8))
    }

    private let fullStatus = """
    {"version":"0.2.0",
     "runtime":{"dir":"/Applications/ClaudeHub.app/Contents/Resources/runtime",
                "node":"/Applications/ClaudeHub.app/Contents/Resources/runtime/bin/node",
                "nodeVersion":"v22.23.5","bundled":true,"appPath":"/Applications/ClaudeHub.app",
                "inApplications":true,"translocated":false},
     "claude":{"found":true,"path":"/Users/dev/.local/bin/claude","version":"2.1.329",
               "settingsPath":"/Users/dev/.claude/settings.json","settingsExists":true,
               "settingsValid":true,"otherHooks":2},
     "service":{"supported":true,"installed":true,"loaded":true,"current":true,
                "plistPath":"/Users/dev/Library/LaunchAgents/dev.claudehub.hub.plist","label":"dev.claudehub.hub"},
     "hub":{"running":true,"version":"0.2.0","localPort":4317,"publicPort":4318,"lastHookAt":1795147000000},
     "hooks":{"installed":true,"events":19,"current":true},
     "tunnel":{"tailscale":"running","dnsName":"macbook.exemplo.ts.net","serving":true,
               "publicUrl":"https://macbook.exemplo.ts.net"},
     "devices":1,"ready":true}
    """

    // MARK: setup status

    func testStatusFull() throws {
        let status = try decode(SetupStatus.self, fullStatus)
        XCTAssertEqual(status.version, "0.2.0")
        XCTAssertEqual(status.runtime.nodeVersion, "v22.23.5")
        XCTAssertTrue(status.runtime.bundled)
        XCTAssertFalse(status.runtime.locationBlocked)
        XCTAssertTrue(status.claude.found)
        XCTAssertEqual(status.claude.version, "2.1.329")
        XCTAssertEqual(status.claude.otherHooks, 2)
        XCTAssertEqual(status.service.label, "dev.claudehub.hub")
        XCTAssertEqual(status.hub.lastHookAt, 1_795_147_000_000)
        XCTAssertEqual(status.hooks.events, 19)
        XCTAssertEqual(status.tunnel.tailscale, .running)
        XCTAssertEqual(status.tunnel.publicUrl, "https://macbook.exemplo.ts.net")
        XCTAssertEqual(status.devices, 1)
        XCTAssertTrue(status.ready)
        XCTAssertNil(status.failure)
        XCTAssertTrue(status.integrationConfigured)
        XCTAssertTrue(status.missingParts.isEmpty)
    }

    func testStatusPartialUsesSafeDefaults() throws {
        let status = try decode(SetupStatus.self, """
        {"runtime":{"bundled":true},"claude":{"found":false},"hub":{"running":false}}
        """)
        XCTAssertFalse(status.ready)
        XCTAssertNil(status.version)
        XCTAssertFalse(status.runtime.locationBlocked, "sem informação, não bloqueia")
        XCTAssertFalse(status.claude.found)
        XCTAssertTrue(status.claude.settingsValid, "ausência não é invalidez")
        XCTAssertEqual(status.claude.settingsPath, "~/.claude/settings.json")
        XCTAssertTrue(status.service.supported)
        XCTAssertFalse(status.service.installed)
        XCTAssertEqual(status.hub.localPort, 4317)
        XCTAssertNil(status.hub.lastHookAt)
        XCTAssertEqual(status.tunnel.tailscale, .missing)
        XCTAssertNil(status.tunnel.publicUrl)
        XCTAssertFalse(status.integrationConfigured)
        XCTAssertEqual(status.missingParts.count, 3)
    }

    func testStatusEmptyObjectAndNulls() throws {
        let empty = try decode(SetupStatus.self, "{}")
        XCTAssertEqual(empty, SetupStatus())
        let nulls = try decode(SetupStatus.self, """
        {"version":null,"runtime":null,"claude":{"path":null,"version":null},"tunnel":{"dnsName":null,"publicUrl":null},
         "hub":{"lastHookAt":null},"devices":null,"ready":null}
        """)
        XCTAssertEqual(nulls, SetupStatus())
    }

    func testTunnelUnknownCarriesTailscaleText() throws {
        let tunnel = try decode(SetupTunnel.self, """
        {"tailscale":"unknown","dnsName":null,"serving":false,"publicUrl":null,"httpsEnabled":null,
         "detail":"The Tailscale GUI failed to start: (Tailscale.CLIError error 3.)"}
        """)
        XCTAssertEqual(tunnel.tailscale, .unknown)
        XCTAssertEqual(tunnel.detail, "The Tailscale GUI failed to start: (Tailscale.CLIError error 3.)")
        XCTAssertNil(tunnel.httpsEnabled)
        XCTAssertFalse(tunnel.httpsDisabled, "sem estado lido, não se afirma nada sobre o HTTPS")
    }

    func testTunnelHttpsDisabledOnlyWhenTailscaleSaidSo() throws {
        let off = try decode(SetupTunnel.self, """
        {"tailscale":"running","dnsName":"macbook.exemplo.ts.net","serving":false,"publicUrl":null,"httpsEnabled":false,"detail":null}
        """)
        XCTAssertTrue(off.httpsDisabled)
        XCTAssertNil(off.detail)

        let on = try decode(SetupTunnel.self, """
        {"tailscale":"running","dnsName":"macbook.exemplo.ts.net","serving":false,"httpsEnabled":true}
        """)
        XCTAssertFalse(on.httpsDisabled)

        let notInformed = try decode(SetupTunnel.self, """
        {"tailscale":"running","dnsName":"macbook.exemplo.ts.net","serving":false}
        """)
        XCTAssertNil(notInformed.httpsEnabled)
        XCTAssertFalse(notInformed.httpsDisabled, "CLI antiga ou Tailscale que não informa: não bloqueia o botão")

        let alreadyServing = try decode(SetupTunnel.self, """
        {"tailscale":"running","serving":true,"httpsEnabled":false,"publicUrl":"https://macbook.exemplo.ts.net"}
        """)
        XCTAssertFalse(alreadyServing.httpsDisabled, "se já publica, não há o que cobrar")

        let stopped = try decode(SetupTunnel.self, """
        {"tailscale":"stopped","httpsEnabled":false,"detail":"NeedsLogin"}
        """)
        XCTAssertEqual(stopped.tailscale, .stopped)
        XCTAssertFalse(stopped.httpsDisabled)
    }

    func testStatusIgnoresUnknownKeysAndWrongTypes() throws {
        let status = try decode(SetupStatus.self, """
        {"futuro":{"x":1},"devices":"muitos","ready":"sim",
         "runtime":{"inApplications":false,"translocated":true,"novo":[1,2]},
         "tunnel":{"tailscale":"hibernando","publicUrl":""},
         "service":{"installed":true,"loaded":true,"current":false},
         "hooks":{"installed":true,"current":false,"events":"dezenove"}}
        """)
        XCTAssertEqual(status.devices, 0)
        XCTAssertFalse(status.ready)
        XCTAssertTrue(status.runtime.locationBlocked)
        XCTAssertEqual(status.tunnel.tailscale, .unknown)
        XCTAssertNil(status.tunnel.publicUrl, "URL vazia conta como ausente")
        XCTAssertEqual(status.hooks.events, 0)
        XCTAssertEqual(status.missingParts, [
            "o serviço aponta para outra cópia do app",
            "o hub não está respondendo",
            "os hooks apontam para outra instalação",
        ])
    }

    func testLocationBlocked() throws {
        let outside = try decode(SetupStatus.self, """
        {"runtime":{"inApplications":false}}
        """)
        XCTAssertTrue(outside.runtime.locationBlocked)
        let translocated = try decode(SetupStatus.self, """
        {"runtime":{"inApplications":true,"translocated":true}}
        """)
        XCTAssertTrue(translocated.runtime.locationBlocked)
    }

    func testStatusFailureFromCLI() throws {
        let status = try decode(SetupStatus.self, """
        {"ok":false,"detail":"Não consegui ler ~/.claude-hub/config.json"}
        """)
        XCTAssertEqual(status.failure, "Não consegui ler ~/.claude-hub/config.json")
        XCTAssertFalse(status.ready)
        let viaError = try decode(SetupStatus.self, """
        {"ok":false,"error":"boom"}
        """)
        XCTAssertEqual(viaError.failure, "boom")
    }

    // MARK: setup run

    func testSetupRunFull() throws {
        let result = try decode(SetupRunResult.self, """
        {"ok":true,"steps":[
           {"id":"service","title":"Serviço do hub","ok":true,"detail":"dev.claudehub.hub carregado"},
           {"id":"hub","title":"Hub no ar","ok":true,"detail":"v0.2.0 em 127.0.0.1:4317"},
           {"id":"hooks","title":"Hooks do Claude Code","ok":true,"detail":"19 eventos; backup em settings.json.claude-hub.bak"}],
         "status":\(fullStatus)}
        """)
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.steps.map { $0.id }, ["service", "hub", "hooks"])
        XCTAssertEqual(result.steps.last?.detail, "19 eventos; backup em settings.json.claude-hub.bak")
        XCTAssertEqual(result.status?.ready, true)
        XCTAssertNil(result.detail)
    }

    func testSetupRunPartialAndUnknownKeys() throws {
        let result = try decode(SetupRunResult.self, """
        {"ok":false,"extra":1,"steps":[{"title":"Hooks do Claude Code","ok":false,"novo":true},{"id":"x"}],
         "error":"settings.json não é um JSON válido"}
        """)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.steps.count, 2)
        XCTAssertEqual(result.steps[0].id, "Hooks do Claude Code", "sem id, usa o título")
        XCTAssertEqual(result.steps[0].detail, "")
        XCTAssertEqual(result.steps[1].title, "x", "sem título, usa o id")
        XCTAssertFalse(result.steps[1].ok)
        XCTAssertNil(result.status)
        XCTAssertEqual(result.detail, "settings.json não é um JSON válido")
        let empty = try decode(SetupRunResult.self, "{}")
        XCTAssertFalse(empty.ok)
        XCTAssertTrue(empty.steps.isEmpty)
    }

    // MARK: selftest

    func testSelfTestFull() throws {
        let result = try decode(SelfTestResult.self, """
        {"ok":false,"checks":[
           {"id":"hub","title":"Hub responde","ok":true,"detail":"v0.2.0","ms":12},
           {"id":"event","title":"Evento recebido por WebSocket","ok":true,"detail":"em 41 ms","ms":41.5},
           {"id":"approval","title":"Pedido de permissão negado de ponta a ponta","ok":false,"detail":"sem resposta em 5 s","ms":5003}]}
        """)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.checks.count, 3)
        XCTAssertEqual(result.checks[1].ms, 41.5)
        XCTAssertEqual(result.failedCount, 1)
        XCTAssertEqual(result.checks[2].detail, "sem resposta em 5 s")
    }

    func testSelfTestPartialAndUnknownKeys() throws {
        let result = try decode(SelfTestResult.self, """
        {"ok":true,"futuro":"x","checks":[{"title":"Hooks presentes","ok":true,"ms":"rápido"},{"ok":true}]}
        """)
        XCTAssertTrue(result.ok)
        XCTAssertNil(result.checks[0].ms)
        XCTAssertEqual(result.checks[0].id, "Hooks presentes")
        XCTAssertEqual(result.checks[1].title, "Checagem")
        XCTAssertEqual(result.failedCount, 0)
        let empty = try decode(SelfTestResult.self, """
        {"detail":"hub fora do ar"}
        """)
        XCTAssertFalse(empty.ok)
        XCTAssertTrue(empty.checks.isEmpty)
        XCTAssertEqual(empty.detail, "hub fora do ar")
    }

    // MARK: service / tunnel / uninstall

    func testCommandResult() throws {
        let restart = try decode(CommandResult.self, """
        {"ok":true,"detail":"Serviço reiniciado."}
        """)
        XCTAssertTrue(restart.ok)
        XCTAssertEqual(restart.detail, "Serviço reiniciado.")
        XCTAssertNil(restart.publicUrl)

        let tunnel = try decode(CommandResult.self, """
        {"ok":true,"detail":"Porta 4318 publicada na sua rede Tailscale.","publicUrl":"https://macbook.exemplo.ts.net","x":1}
        """)
        XCTAssertEqual(tunnel.publicUrl, "https://macbook.exemplo.ts.net")

        let failed = try decode(CommandResult.self, """
        {"ok":false,"error":"tailscale serve falhou: HTTPS não habilitado","publicUrl":null}
        """)
        XCTAssertFalse(failed.ok)
        XCTAssertEqual(failed.detail, "tailscale serve falhou: HTTPS não habilitado")
        XCTAssertNil(failed.publicUrl)

        let empty = try decode(CommandResult.self, "{}")
        XCTAssertFalse(empty.ok)
        XCTAssertEqual(empty.detail, "")
    }

    func testUninstallResult() throws {
        let result = try decode(UninstallResult.self, """
        {"ok":true,"steps":[{"id":"hooks","title":"Hooks removidos","ok":true,"detail":"os seus foram preservados"},
                            {"id":"service","title":"Serviço removido","ok":true,"detail":""}],"novo":null}
        """)
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.steps.count, 2)
        XCTAssertEqual(result.steps[0].detail, "os seus foram preservados")
        let partial = try decode(UninstallResult.self, """
        {"ok":false,"detail":"launchctl recusou"}
        """)
        XCTAssertFalse(partial.ok)
        XCTAssertTrue(partial.steps.isEmpty)
        XCTAssertEqual(partial.detail, "launchctl recusou")
    }

    // MARK: saída da CLI

    func testDecodeToleratesNoiseAroundTheObject() throws {
        let noisy = """
        (node:1) ExperimentalWarning: SQLite is an experimental feature
        {"ok":true,"detail":"feito"}

        """
        let result = try decode(CommandResult.self, noisy)
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.detail, "feito")
    }

    func testDecodeFailsWithoutAnObject() {
        XCTAssertThrowsError(try SetupJSON.decode(CommandResult.self, from: Data("Error: Cannot find module".utf8))) { error in
            XCTAssertEqual(error as? SetupJSON.ParseError, .noObject)
        }
        XCTAssertNil(SetupJSON.extractObject(from: Data()))
        XCTAssertNil(SetupJSON.extractObject(from: Data("} {".utf8)))
    }

    func testLastHookText() {
        let now: Double = 100_000_000
        XCTAssertNil(SetupJSON.lastHookText(lastHookAt: nil, now: now))
        XCTAssertNil(SetupJSON.lastHookText(lastHookAt: 0, now: now))
        XCTAssertEqual(SetupJSON.lastHookText(lastHookAt: now - 10_000, now: now), "agora mesmo")
        XCTAssertEqual(SetupJSON.lastHookText(lastHookAt: now - 2 * 60_000, now: now), "há 2 min")
        XCTAssertEqual(SetupJSON.lastHookText(lastHookAt: now - 3 * 3_600_000, now: now), "há 3 h")
    }

    func testDiagnosticsResult() throws {
        let full = Data("""
        {"ok":true,"report":"Diagnóstico do Claude Hub 0.3.0\\n[Aplicativo]","logPath":"/Users/x/.claude-hub/hub.log","dataDir":"/Users/x/.claude-hub","novo":1}
        """.utf8)
        let decoded = try SetupJSON.decode(DiagnosticsResult.self, from: full)
        XCTAssertTrue(decoded.ok)
        XCTAssertTrue(decoded.report.contains("[Aplicativo]"))
        XCTAssertEqual(decoded.logPath, "/Users/x/.claude-hub/hub.log")

        let failure = try SetupJSON.decode(DiagnosticsResult.self, from: Data("{\"ok\":false,\"detail\":\"falhou\"}".utf8))
        XCTAssertFalse(failure.ok)
        XCTAssertEqual(failure.report, "")
        XCTAssertEqual(failure.detail, "falhou")
    }
}

import XCTest
@testable import ClaudeHubCore

final class UsageModelsTests: XCTestCase {
    private func decodeUsage(_ json: String) throws -> UsageStats {
        return try JSONDecoder().decode(UsageStats.self, from: Data(json.utf8))
    }

    // MARK: - Codex e OpenCode

    func testAgentsUsageDecodes() throws {
        let usage = try decodeUsage("""
        {"since":0,"sessions":0,"prompts":0,"toolCalls":0,"approvalsAllowed":0,"approvalsDenied":0,"activeMs":0,"byTool":[],
         "agents":[
          {"agent":"codex","inputTokens":900,"outputTokens":200,"cacheReadTokens":600,"cacheCreationTokens":0,"reasoningTokens":60,
           "costUsd":null,"byModel":[{"model":"gpt-5-codex","inputTokens":900,"outputTokens":200,"costUsd":null}],"updatedAt":1700000000000,
           "limits":{"windows":[{"id":"primary","label":"Janela de 5 horas","usedPercent":12.5,"resetsAt":1700000360000}],"updatedAt":1700000000000}},
          {"agent":"opencode","inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0,"reasoningTokens":0,
           "costUsd":null,"byModel":[],"updatedAt":null,"limits":null}
         ]}
        """)
        XCTAssertEqual(usage.agents.count, 2)
        XCTAssertEqual(usage.agents[0].displayName, "Codex")
        XCTAssertNil(usage.agents[0].costUsd)
        XCTAssertEqual(usage.agents[0].limits?.windows.first?.usedPercent, 12.5)
        XCTAssertNil(usage.agents[1].limits)
        XCTAssertNil(usage.agents[1].updatedAt)

        let old = try decodeUsage("{\"since\":0,\"sessions\":0,\"prompts\":0,\"toolCalls\":0,\"approvalsAllowed\":0,\"approvalsDenied\":0,\"activeMs\":0,\"byTool\":[]}")
        XCTAssertTrue(old.agents.isEmpty)
    }

    // MARK: - Resposta completa

    func testFullUsageWithConsumptionAndLimits() throws {
        let usage = try decodeUsage("""
        {
          "since": 1700000000000, "sessions": 3, "prompts": 12, "toolCalls": 40,
          "approvalsAllowed": 5, "approvalsDenied": 1, "activeMs": 3600000,
          "byTool": [{"tool": "Bash", "count": 20}],
          "consumption": {
            "enabled": true, "source": "otel", "since": 1700000000000,
            "inputTokens": 12000, "outputTokens": 3400, "cacheReadTokens": 90000, "cacheCreationTokens": 1500,
            "costUsd": 0.4213,
            "byModel": [
              {"model": "claude-sonnet-5-5", "inputTokens": 10000, "outputTokens": 3000, "cacheReadTokens": 80000, "cacheCreationTokens": 1500, "costUsd": 0.4},
              {"model": "claude-haiku-5-5", "inputTokens": 2000, "outputTokens": 400, "cacheReadTokens": 10000, "cacheCreationTokens": 0, "costUsd": null}
            ],
            "updatedAt": 1700000500000, "campoNovo": 1
          },
          "limits": {
            "enabled": true, "source": "statusline", "updatedAt": 1700000600000,
            "windows": [
              {"id": "five_hour", "label": "Janela de 5 horas", "usedPercent": 42.5, "resetsAt": 1700003600000},
              {"id": "seven_day", "label": "Semana", "usedPercent": 12, "resetsAt": null}
            ],
            "context": {"usedPercent": 31, "windowSize": 200000, "sessionId": "abc"}
          },
          "outroCampo": "ignorado"
        }
        """)
        XCTAssertEqual(usage.sessions, 3)
        XCTAssertEqual(usage.byTool.first?.tool, "Bash")

        let consumption = try XCTUnwrap(usage.consumption)
        XCTAssertTrue(consumption.enabled)
        XCTAssertTrue(consumption.hasData)
        XCTAssertEqual(consumption.source, "otel")
        XCTAssertEqual(consumption.inputTokens, 12000)
        XCTAssertEqual(consumption.cacheReadTokens, 90000)
        XCTAssertEqual(consumption.costUsd ?? 0, 0.4213, accuracy: 0.00001)
        XCTAssertEqual(consumption.byModel.count, 2)
        XCTAssertEqual(consumption.byModel[0].id, "claude-sonnet-5-5")
        XCTAssertNil(consumption.byModel[1].costUsd)

        let limits = try XCTUnwrap(usage.limits)
        XCTAssertTrue(limits.enabled)
        XCTAssertEqual(limits.windows.count, 2)
        XCTAssertEqual(limits.windows[0].usedPercent, 42.5)
        XCTAssertEqual(limits.windows[0].fraction, 0.425, accuracy: 0.0001)
        XCTAssertEqual(limits.windows[0].resetsAt, 1700003600000)
        XCTAssertNil(limits.windows[1].resetsAt)
        XCTAssertEqual(limits.context?.usedPercent, 31)
        XCTAssertEqual(limits.context?.windowSize, 200000)
        XCTAssertEqual(limits.context?.sessionId, "abc")
    }

    // MARK: - Resposta parcial

    func testEnabledButNoDataYet() throws {
        let usage = try decodeUsage("""
        {"sessions": 1, "consumption": {"enabled": true, "source": null, "updatedAt": null},
         "limits": {"enabled": false, "windows": []}}
        """)
        let consumption = try XCTUnwrap(usage.consumption)
        XCTAssertTrue(consumption.enabled)
        XCTAssertFalse(consumption.hasData)
        XCTAssertNil(consumption.source)
        XCTAssertNil(consumption.costUsd)
        XCTAssertEqual(consumption.inputTokens, 0)
        XCTAssertTrue(consumption.byModel.isEmpty)

        let limits = try XCTUnwrap(usage.limits)
        XCTAssertFalse(limits.enabled)
        XCTAssertTrue(limits.windows.isEmpty)
        XCTAssertNil(limits.context)
        XCTAssertNil(limits.updatedAt)
    }

    func testDisabledConsumptionNeverHasData() throws {
        let usage = try decodeUsage("""
        {"consumption": {"enabled": false, "updatedAt": 1700000000000, "inputTokens": 10}}
        """)
        XCTAssertEqual(usage.consumption?.hasData, false)
    }

    func testWrongTypesDoNotBreakTheRest() throws {
        let usage = try decodeUsage("""
        {"sessions": 2, "consumption": "inesperado", "limits": {"windows": "x", "context": 5}}
        """)
        XCTAssertEqual(usage.sessions, 2)
        XCTAssertNil(usage.consumption)
        let limits = try XCTUnwrap(usage.limits)
        XCTAssertTrue(limits.windows.isEmpty)
        XCTAssertNil(limits.context)
    }

    func testWindowWithoutIdOrLabelStillDecodes() throws {
        let usage = try decodeUsage("""
        {"limits": {"enabled": true, "windows": [{"usedPercent": 250}, {"id": "x", "usedPercent": -3}]}}
        """)
        let windows = try XCTUnwrap(usage.limits?.windows)
        XCTAssertEqual(windows.count, 2)
        XCTAssertEqual(windows[0].id, "limite")
        XCTAssertEqual(windows[0].label, "Limite")
        // A barra é limitada a 0...1, mas o número informado não é alterado.
        XCTAssertEqual(windows[0].usedPercent, 250)
        XCTAssertEqual(windows[0].fraction, 1)
        XCTAssertEqual(windows[1].label, "x")
        XCTAssertEqual(windows[1].fraction, 0)
    }

    // MARK: - Resposta antiga (sem os campos novos)

    func testAbsentConsumptionAndLimits() throws {
        let usage = try decodeUsage("""
        {"since": 1, "sessions": 4, "prompts": 2, "toolCalls": 9, "approvalsAllowed": 0, "approvalsDenied": 0, "activeMs": 10, "byTool": []}
        """)
        XCTAssertEqual(usage.sessions, 4)
        XCTAssertNil(usage.consumption)
        XCTAssertNil(usage.limits)
    }

    // MARK: - prefs

    func testPrefsResult() throws {
        let full = try JSONDecoder().decode(PrefsResult.self, from: Data("""
        {"ok": true, "detail": "Medição ligada.", "prefs": {"autoOpenIsland": false, "consumption": true, "limits": false, "novo": 1}}
        """.utf8))
        XCTAssertTrue(full.ok)
        XCTAssertEqual(full.detail, "Medição ligada.")
        XCTAssertEqual(full.prefs, HubPrefs(autoOpenIsland: false, consumption: true, limits: false))

        let readOnly = try JSONDecoder().decode(PrefsResult.self, from: Data("{\"ok\": true, \"prefs\": {}}".utf8))
        XCTAssertNil(readOnly.detail)
        // Padrões: abrir a ilha ligado; medições desligadas.
        XCTAssertEqual(readOnly.prefs, HubPrefs(autoOpenIsland: true, consumption: false, limits: false))

        let failure = try JSONDecoder().decode(PrefsResult.self, from: Data("{\"ok\": false, \"error\": \"settings.json inválido\"}".utf8))
        XCTAssertFalse(failure.ok)
        XCTAssertEqual(failure.detail, "settings.json inválido")
        XCTAssertNil(failure.prefs)
    }

    // MARK: - Formatação

    func testTokenFormatting() {
        XCTAssertEqual(UsageFormat.tokens(0), "0")
        XCTAssertEqual(UsageFormat.tokens(950), "950")
        XCTAssertEqual(UsageFormat.tokens(12_300), "12,3 mil")
        XCTAssertEqual(UsageFormat.tokens(250_000), "250 mil")
        XCTAssertEqual(UsageFormat.tokens(1_240_000), "1,24 mi")
        XCTAssertEqual(UsageFormat.tokens(-5), "0")
    }

    func testCostAndPercentFormatting() {
        XCTAssertEqual(UsageFormat.cost(0.4213), "US$ 0,42")
        XCTAssertEqual(UsageFormat.cost(12), "US$ 12,00")
        XCTAssertEqual(UsageFormat.cost(0.0031), "US$ 0,0031")
        XCTAssertEqual(UsageFormat.cost(0), "US$ 0,00")
        XCTAssertEqual(UsageFormat.percent(42), "42%")
        XCTAssertEqual(UsageFormat.percent(42.5), "42,5%")
        XCTAssertEqual(UsageFormat.percent(99.96), "100%")
    }
}

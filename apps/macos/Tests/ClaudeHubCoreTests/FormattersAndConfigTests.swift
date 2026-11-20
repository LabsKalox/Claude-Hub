import XCTest
@testable import ClaudeHubCore

final class FormattersAndConfigTests: XCTestCase {
    func testAgo() {
        XCTAssertEqual(HubFormat.ago(from: 0, now: 10_000), "agora")
        XCTAssertEqual(HubFormat.ago(from: 0, now: 44_000), "agora")
        XCTAssertEqual(HubFormat.ago(from: 0, now: 45_000), "1 min")
        XCTAssertEqual(HubFormat.ago(from: 0, now: 7 * 60_000), "7 min")
        XCTAssertEqual(HubFormat.ago(from: 0, now: 2 * 3_600_000), "2 h")
        XCTAssertEqual(HubFormat.ago(from: 0, now: 3 * 86_400_000), "3 d")
        XCTAssertEqual(HubFormat.ago(from: 5_000, now: 0), "agora", "relógio adiantado não vira negativo")
    }

    func testDuration() {
        XCTAssertEqual(HubFormat.duration(ms: 42_000), "42s")
        XCTAssertEqual(HubFormat.duration(ms: 185_000), "3min 05s")
        XCTAssertEqual(HubFormat.duration(ms: 4_320_000), "1h 12min")
        XCTAssertEqual(HubFormat.duration(ms: -5), "0s")
    }

    func testProgressPercent() {
        XCTAssertNil(HubFormat.progressPercent(nil))
        XCTAssertNil(HubFormat.progressPercent(SessionProgress(done: 0, total: 0)))
        XCTAssertEqual(HubFormat.progressPercent(SessionProgress(done: 7, total: 10)), 70)
        XCTAssertEqual(HubFormat.progressPercent(SessionProgress(done: 1, total: 3)), 33)
        XCTAssertEqual(HubFormat.progressPercent(SessionProgress(done: 9, total: 4)), 100)
    }

    func testSessionActiveMs() {
        let running = Session(id: "s", activeSince: 1_000, activeMs: 500)
        XCTAssertEqual(HubFormat.sessionActiveMs(running, now: 3_000), 2_500)
        let stopped = Session(id: "s", activeSince: nil, activeMs: 500)
        XCTAssertEqual(HubFormat.sessionActiveMs(stopped, now: 3_000), 500)
    }

    func testTruncate() {
        XCTAssertEqual(HubFormat.truncate("  um   dois\ntrês ", max: 40), "um dois três")
        XCTAssertEqual(HubFormat.truncate("abcdefghij", max: 5), "abcd…")
        XCTAssertEqual(HubFormat.truncate("abc defgh", max: 5), "abc…")
    }

    func testLabelsMatchTheReference() {
        XCTAssertEqual(SessionStatus.working.label, "Trabalhando")
        XCTAssertEqual(SessionStatus.completed.label, "Terminou")
        XCTAssertEqual(SessionStatus.waiting.label, "Esperando você")
        XCTAssertEqual(ApprovalMode.auto.label, "Automático")
        XCTAssertEqual(ApprovalMode.always.label, "Sempre aqui")
        XCTAssertEqual(ApprovalMode.notify.label, "Só avisar")
        XCTAssertEqual(ApprovalMode.always.hint, "Todo pedido de permissão vem para a ilha e para o celular.")
        XCTAssertEqual(SessionStatus.working.colorHex, "#2F6BFF")
        XCTAssertEqual(SessionStatus.completed.colorHex, "#2FBF71")
        XCTAssertEqual(SessionStatus.waiting.colorHex, "#F5A524")
    }

    func testToolLabel() {
        XCTAssertEqual(HubFormat.toolLabel("Bash"), "Bash")
        XCTAssertEqual(HubFormat.toolLabel("mcp__memory__create_entities"), "memory · create_entities")
        XCTAssertEqual(HubFormat.toolLabel("mcp__quebrado"), "mcp__quebrado")
    }

    func testBackoffIsCappedAtTenSeconds() {
        XCTAssertEqual(HubClient.backoffDelay(attempt: 1), 0.5)
        XCTAssertEqual(HubClient.backoffDelay(attempt: 2), 1)
        XCTAssertEqual(HubClient.backoffDelay(attempt: 5), 8)
        XCTAssertEqual(HubClient.backoffDelay(attempt: 6), 10)
        XCTAssertEqual(HubClient.backoffDelay(attempt: 500), 10)
    }

    func testConfigParsing() throws {
        let config = try HubConfig.parse(Data("""
        {"localPort":5001,"publicPort":5002,"publicHost":"127.0.0.1","publicUrl":"https://mac.tailnet.ts.net",
         "localToken":"segredo","hookToken":"outro","approvalTimeoutSec":300,"vapid":null}
        """.utf8))
        XCTAssertEqual(config.localPort, 5001)
        XCTAssertEqual(config.publicPort, 5002)
        XCTAssertEqual(config.localToken, "segredo")
        XCTAssertEqual(config.publicUrl, "https://mac.tailnet.ts.net")
        XCTAssertEqual(config.webSocketURL?.absoluteString, "ws://127.0.0.1:5001/ws")
        XCTAssertEqual(config.baseURLString, "http://127.0.0.1:5001")
    }

    func testConfigDefaultsAndErrors() throws {
        let config = try HubConfig.parse(Data("{\"localToken\":\"t\",\"publicUrl\":null}".utf8))
        XCTAssertEqual(config.localPort, 4317)
        XCTAssertEqual(config.publicPort, 4318)
        XCTAssertNil(config.publicUrl)
        XCTAssertThrowsError(try HubConfig.parse(Data("{\"localPort\":1}".utf8)))
        XCTAssertThrowsError(try HubConfig.parse(Data("[1,2]".utf8)))
        XCTAssertThrowsError(try HubConfig.parse(Data("não é json".utf8)))
    }

    func testConfigHonoursClaudeHubHome() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claude-hub-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let environment = ["CLAUDE_HUB_HOME": directory.path]
        XCTAssertNil(HubConfig.load(environment: environment), "sem arquivo, sem configuração")

        try Data("{\"localToken\":\"abc\",\"localPort\":4400}".utf8)
            .write(to: HubConfig.configURL(environment: environment))
        let loaded = HubConfig.load(environment: environment)
        XCTAssertEqual(loaded?.localToken, "abc")
        XCTAssertEqual(loaded?.localPort, 4400)

        var overridden = environment
        overridden["CLAUDE_HUB_LOCAL_PORT"] = "4500"
        XCTAssertEqual(HubConfig.load(environment: overridden)?.localPort, 4500)
    }
}

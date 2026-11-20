import XCTest
@testable import ClaudeHubCore

/// Os literais JSON abaixo seguem os formatos de packages/shared/src/core.ts.
final class ModelsDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> ServerMessage {
        return try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
    }

    private let sessionJSON = """
    {"id":"s1","agentKind":"claude-code","projectName":"site","cwd":"/Users/dev/projetos/site",
     "title":"Publicar o site","agent":"claude-sonnet-5","status":"WORKING","task":"Publicar o site",
     "preview":"npm run build","startedAt":1000,"updatedAt":2000,"activeSince":1500,"activeMs":250,
     "progress":{"done":2,"total":4},"lastEvent":{"type":"PreToolUse","summary":"npm run build","at":2000},
     "pendingApprovals":0,"permissionMode":"default","subagents":1,"hostApp":"com.apple.Terminal","endedAt":null}
    """

    private let approvalJSON = """
    {"id":"apr_1","sessionId":"s1","projectName":"site","sessionTitle":"Publicar o site","toolName":"Bash",
     "command":"npm install && npm run build -- --prod",
     "toolInput":{"command":"npm install && npm run build -- --prod","timeout":120000,"flags":["a",1,true,null]},
     "cwd":"/Users/dev/projetos/site","createdAt":1000,"expiresAt":301000,"status":"pending",
     "decidedBy":null,"decidedAt":null}
    """

    func testSnapshot() throws {
        let message = try decode("""
        {"type":"snapshot","protocol":1,"sessions":[\(sessionJSON)],"approvals":[\(approvalJSON)],
         "settings":{"approvalMode":"always","away":false},"serverTime":5000}
        """)
        guard case .snapshot(let payload) = message else { return XCTFail("esperava snapshot") }
        XCTAssertEqual(payload.protocolVersion, 1)
        XCTAssertEqual(payload.sessions.count, 1)
        XCTAssertEqual(payload.approvals.first?.command, "npm install && npm run build -- --prod")
        XCTAssertEqual(payload.settings, HubSettings(approvalMode: .always, away: false))
        XCTAssertEqual(payload.serverTime, 5000)
    }

    func testSession() throws {
        let message = try decode("{\"type\":\"session\",\"session\":\(sessionJSON)}")
        guard case .session(let session) = message else { return XCTFail("esperava session") }
        XCTAssertEqual(session.id, "s1")
        XCTAssertEqual(session.status, .working)
        XCTAssertEqual(session.progress, SessionProgress(done: 2, total: 4))
        XCTAssertEqual(session.lastEvent?.summary, "npm run build")
        XCTAssertEqual(session.hostApp, "com.apple.Terminal")
        XCTAssertNil(session.endedAt)
        XCTAssertEqual(session.activeSince, 1500)
    }

    func testSessionRemoved() throws {
        XCTAssertEqual(try decode("{\"type\":\"session_removed\",\"sessionId\":\"s1\"}"), .sessionRemoved("s1"))
    }

    func testEvent() throws {
        let message = try decode("""
        {"type":"event","event":{"id":7,"sessionId":"s1","at":2000,"type":"PreToolUse","summary":"ls","toolName":"Bash"}}
        """)
        XCTAssertEqual(message, .event(HubEvent(id: 7, sessionId: "s1", at: 2000, type: "PreToolUse", summary: "ls", toolName: "Bash")))
    }

    func testApproval() throws {
        let message = try decode("{\"type\":\"approval\",\"approval\":\(approvalJSON)}")
        guard case .approval(let approval) = message else { return XCTFail("esperava approval") }
        XCTAssertEqual(approval.status, .pending)
        XCTAssertEqual(approval.toolName, "Bash")
        XCTAssertEqual(approval.expiresAt, 301000)
        guard case .object(let input)? = approval.toolInput else { return XCTFail("toolInput deveria ser objeto") }
        XCTAssertEqual(input["timeout"], .number(120000))
        XCTAssertEqual(input["flags"], .array([.string("a"), .number(1), .bool(true), .null]))
    }

    func testSettings() throws {
        XCTAssertEqual(
            try decode("{\"type\":\"settings\",\"settings\":{\"approvalMode\":\"notify\",\"away\":true}}"),
            .settings(HubSettings(approvalMode: .notify, away: true))
        )
    }

    func testAlert() throws {
        let message = try decode("""
        {"type":"alert","alert":{"kind":"approval","sessionId":"s1","title":"Claude quer usar Bash",
         "body":"npm run build","approvalId":"apr_1","at":3000}}
        """)
        XCTAssertEqual(
            message,
            .alert(HubAlert(kind: .approval, sessionId: "s1", title: "Claude quer usar Bash", body: "npm run build", approvalId: "apr_1", at: 3000))
        )
    }

    func testAuthErrorAndPong() throws {
        XCTAssertEqual(try decode("{\"type\":\"auth_error\",\"reason\":\"invalid\"}"), .authError("invalid"))
        XCTAssertEqual(try decode("{\"type\":\"pong\"}"), .pong)
    }

    func testUnknownMessageTypeDoesNotThrow() throws {
        XCTAssertEqual(try decode("{\"type\":\"algo_do_futuro\",\"x\":1}"), .unknown("algo_do_futuro"))
    }

    func testUnknownFieldsAndEnumValuesFallBack() throws {
        let message = try decode("""
        {"type":"session","session":{"id":"s9","status":"ESTADO_NOVO","campoNovo":{"a":1},"projectName":"reels"}}
        """)
        guard case .session(let session) = message else { return XCTFail("esperava session") }
        XCTAssertEqual(session.status, .idle)
        XCTAssertEqual(session.title, "reels")
        XCTAssertEqual(session.agentKind, "claude-code")
        XCTAssertEqual(session.pendingApprovals, 0)
    }

    func testUnknownApprovalStatusIsNeverPending() throws {
        let message = try decode("{\"type\":\"approval\",\"approval\":{\"id\":\"a\",\"sessionId\":\"s\",\"status\":\"novo\"}}")
        guard case .approval(let approval) = message else { return XCTFail("esperava approval") }
        XCTAssertEqual(approval.status, .cancelled)
    }

    func testUnknownApprovalModeFallsBackToAlways() throws {
        XCTAssertEqual(
            try decode("{\"type\":\"settings\",\"settings\":{\"approvalMode\":\"yolo\"}}"),
            .settings(HubSettings(approvalMode: .always, away: false))
        )
    }

    func testClientMessagesEncodeAsTheHubExpects() throws {
        func object(_ message: ClientMessage) throws -> [String: Any] {
            let data = try JSONEncoder().encode(message)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        let auth = try object(.auth(token: "tok", client: "macos"))
        XCTAssertEqual(auth["type"] as? String, "auth")
        XCTAssertEqual(auth["token"] as? String, "tok")
        XCTAssertEqual(auth["client"] as? String, "macos")
        let presence = try object(.presence(idleSeconds: 12))
        XCTAssertEqual(presence["type"] as? String, "presence")
        XCTAssertEqual(presence["idleSeconds"] as? Double, 12)
        XCTAssertEqual(try object(.ping)["type"] as? String, "ping")
    }

    func testRestPayloads() throws {
        let decoder = JSONDecoder()
        let usage = try decoder.decode(UsageStats.self, from: Data("""
        {"since":0,"sessions":4,"prompts":9,"toolCalls":31,"approvalsAllowed":3,"approvalsDenied":1,
         "activeMs":125000,"byTool":[{"tool":"Bash","count":12},{"tool":"Edit","count":8}]}
        """.utf8))
        XCTAssertEqual(usage.toolCalls, 31)
        XCTAssertEqual(usage.byTool.first?.tool, "Bash")

        let pairing = try decoder.decode(PairingInfo.self, from: Data("""
        {"code":"ABCD-EFGH","expiresAt":300000,"url":"https://mac.tailnet.ts.net/pair/?code=ABCD-EFGH"}
        """.utf8))
        XCTAssertEqual(pairing.code, "ABCD-EFGH")

        let noUrl = try decoder.decode(PairingInfo.self, from: Data("{\"code\":\"ABCD-EFGH\",\"expiresAt\":1,\"url\":null}".utf8))
        XCTAssertNil(noUrl.url)

        let device = try decoder.decode(DeviceInfo.self, from: Data("""
        {"id":"dev_1","name":"iPhone","createdAt":1,"lastSeenAt":null,"pushEnabled":true}
        """.utf8))
        XCTAssertTrue(device.pushEnabled)
        XCTAssertNil(device.lastSeenAt)

        let info = try decoder.decode(HubInfo.self, from: Data("""
        {"version":"0.1.0","localPort":4317,"publicPort":4318,"publicUrl":null,"pushConfigured":true,"away":false}
        """.utf8))
        XCTAssertEqual(info.version, "0.1.0")
        XCTAssertEqual(info.localPort, 4317)
    }
}

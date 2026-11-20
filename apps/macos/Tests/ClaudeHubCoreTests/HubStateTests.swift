import XCTest
@testable import ClaudeHubCore

final class HubStateTests: XCTestCase {
    private func session(_ id: String, _ status: SessionStatus, updatedAt: Double = 0, endedAt: Double? = nil) -> Session {
        return Session(id: id, projectName: id, title: id, status: status, updatedAt: updatedAt, endedAt: endedAt)
    }

    private func approval(_ id: String, session: String = "s1", createdAt: Double, status: ApprovalStatus = .pending) -> Approval {
        return Approval(id: id, sessionId: session, toolName: "Bash", command: "ls", createdAt: createdAt, expiresAt: createdAt + 300_000, status: status)
    }

    func testSnapshotReplacesEverythingAndComputesClockSkew() {
        var state = HubState()
        XCTAssertFalse(state.ready)
        state.apply(.session(session("velha", .working)), localNow: 0)
        let payload = SnapshotPayload(
            sessions: [session("a", .working), session("b", .completed)],
            approvals: [approval("apr_2", createdAt: 20), approval("apr_1", createdAt: 10)],
            settings: HubSettings(approvalMode: .auto, away: true),
            serverTime: 10_500
        )
        state.apply(.snapshot(payload), localNow: 10_000)
        XCTAssertTrue(state.ready)
        XCTAssertEqual(state.sessions.map { $0.id }, ["a", "b"])
        XCTAssertEqual(state.approvals.map { $0.id }, ["apr_1", "apr_2"], "do mais antigo para o mais novo")
        XCTAssertEqual(state.settings.approvalMode, .auto)
        XCTAssertEqual(state.clockSkew, 500)
    }

    func testSessionUpsertAndRemoval() {
        var state = HubState()
        state.apply(.session(session("a", .working)), localNow: 0)
        state.apply(.session(session("b", .working)), localNow: 0)
        state.apply(.session(session("a", .completed)), localNow: 0)
        XCTAssertEqual(state.sessions.count, 2)
        XCTAssertEqual(state.session(id: "a")?.status, .completed)

        state.apply(.approval(approval("apr_1", session: "a", createdAt: 1)), localNow: 0)
        state.apply(.sessionRemoved("a"), localNow: 0)
        XCTAssertEqual(state.sessions.map { $0.id }, ["b"])
        XCTAssertTrue(state.approvals.isEmpty, "pedidos da sessão removida saem junto")
    }

    func testEndedSessionIsNotKept() {
        var state = HubState()
        state.apply(.session(session("a", .working)), localNow: 0)
        state.apply(.session(session("a", .idle, endedAt: 99)), localNow: 0)
        XCTAssertTrue(state.sessions.isEmpty)
    }

    func testOnlyPendingApprovalsStayInTheQueue() {
        var state = HubState()
        state.apply(.approval(approval("apr_1", createdAt: 1)), localNow: 0)
        state.apply(.approval(approval("apr_2", createdAt: 2)), localNow: 0)
        XCTAssertEqual(state.approvals.count, 2)
        state.apply(.approval(approval("apr_1", createdAt: 1, status: .allowed)), localNow: 0)
        XCTAssertEqual(state.approvals.map { $0.id }, ["apr_2"])
        state.apply(.approval(approval("apr_2", createdAt: 2, status: .expired)), localNow: 0)
        XCTAssertTrue(state.approvals.isEmpty)
        state.apply(.approval(approval("apr_3", createdAt: 3, status: .cancelled)), localNow: 0)
        XCTAssertTrue(state.approvals.isEmpty)
    }

    func testEventsAreNewestFirstAndCapped() {
        var state = HubState()
        for index in 0..<(HubState.maxLiveEvents + 25) {
            state.apply(.event(HubEvent(id: index, sessionId: "s", at: Double(index), type: "PreToolUse", summary: "x")), localNow: 0)
        }
        XCTAssertEqual(state.events.count, HubState.maxLiveEvents)
        XCTAssertEqual(state.events.first?.id, HubState.maxLiveEvents + 24)
    }

    func testAlertIsReturnedAndSettingsApplied() {
        var state = HubState()
        let alert = HubAlert(kind: .completed, sessionId: "s", title: "Terminou · site", body: "Pronto", at: 1)
        XCTAssertEqual(state.apply(.alert(alert), localNow: 0), alert)
        XCTAssertNil(state.apply(.settings(HubSettings(approvalMode: .notify, away: true)), localNow: 0))
        XCTAssertEqual(state.settings, HubSettings(approvalMode: .notify, away: true))
        XCTAssertNil(state.apply(.unknown("x"), localNow: 0))
        XCTAssertNil(state.apply(.pong, localNow: 0))
    }

    func testConnectionLostDropsPendingApprovals() {
        var state = HubState()
        state.apply(.snapshot(SnapshotPayload(sessions: [session("a", .working)], approvals: [approval("apr_1", createdAt: 1)], settings: .standard, serverTime: 1)), localNow: 1)
        state.connectionLost()
        XCTAssertFalse(state.ready)
        XCTAssertTrue(state.approvals.isEmpty)
        XCTAssertEqual(state.sessions.count, 1)
    }

    func testFocusPriority() {
        var state = HubState()
        state.apply(.session(session("trabalhando", .working, updatedAt: 50)), localNow: 0)
        state.apply(.session(session("terminou", .completed, updatedAt: 90)), localNow: 0)
        XCTAssertEqual(state.focus?.id, "trabalhando")
        state.apply(.session(session("erro", .error, updatedAt: 10)), localNow: 0)
        XCTAssertEqual(state.focus?.id, "erro")
        state.apply(.session(session("esperando", .waiting, updatedAt: 5)), localNow: 0)
        XCTAssertEqual(state.focus?.id, "esperando")
        state.apply(.session(session("aprovar", .approvalRequired, updatedAt: 1)), localNow: 0)
        XCTAssertEqual(state.focus?.id, "aprovar")
    }

    func testFocusBreaksTiesByMostRecentAndIgnoresEnded() {
        let sessions = [
            session("antiga", .working, updatedAt: 10),
            session("nova", .working, updatedAt: 20),
            session("encerrada", .approvalRequired, updatedAt: 30, endedAt: 31),
        ]
        XCTAssertEqual(HubFormat.focusSession(sessions)?.id, "nova")
        XCTAssertNil(HubFormat.focusSession([]))
        XCTAssertEqual(HubFormat.sortSessions(sessions).map { $0.id }, ["encerrada", "nova", "antiga"])
    }
}

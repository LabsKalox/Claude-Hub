import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Aba "Claude" (frame 00:05): sessões à esquerda, "APROVAÇÕES" à direita.
@MainActor
struct ClaudeTabView: View {
    @EnvironmentObject private var store: HubStore

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            sessionsColumn
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            approvalsColumn
                .frame(width: 236, alignment: .topLeading)
        }
    }

    private var sessionsColumn: some View {
        let sessions = store.state.sortedSessions
        return Group {
            if sessions.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(store.isConnected ? "Nenhuma sessão do Claude Code ativa" : "Hub offline")
                        .font(Theme.font(12, .semibold))
                        .foregroundStyle(Color.white)
                    Text(store.isConnected
                        ? "Abra o Claude Code em um projeto: a sessão aparece aqui sozinha."
                        : "Inicie o hub (pnpm start) para acompanhar as sessões.")
                        .font(Theme.font(11))
                        .foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.card))
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(spacing: 8) {
                        ForEach(sessions) { session in
                            SessionCard(session: session)
                        }
                    }
                }
                .scrollIndicators(.never)
            }
        }
    }

    private var approvalsColumn: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle("APROVAÇÕES")
            SegmentedPills(
                options: ApprovalMode.allCases,
                selection: store.state.settings.approvalMode,
                label: { $0.label },
                onSelect: { store.setApprovalMode($0) }
            )
            Text(store.state.settings.approvalMode.hint)
                .font(Theme.font(10))
                .foregroundStyle(Theme.textFaint)
                .fixedSize(horizontal: false, vertical: true)
            SwitchRow(
                title: "Estou longe do PC",
                isOn: Binding(
                    get: { store.state.settings.away },
                    set: { store.setAway($0) }
                )
            )
            if !store.state.approvals.isEmpty {
                SectionTitle("PENDENTES")
                    .padding(.top, 4)
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 8) {
                        ForEach(store.state.approvals) { approval in
                            PendingApprovalRow(approval: approval)
                        }
                    }
                }
                .scrollIndicators(.never)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Cartão de sessão: ponto de estado, título, tempo relativo, prévia de duas
/// linhas, barra de progresso (quando mensurável) e tempo de atividade.
@MainActor
struct SessionCard: View {
    let session: Session
    @EnvironmentObject private var store: HubStore

    var body: some View {
        let percent = HubFormat.progressPercent(session.progress)
        HStack(alignment: .top, spacing: 9) {
            StatusDot(color: Theme.statusColor(session.status), size: 7)
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(session.title)
                        .font(Theme.font(12, .bold))
                        .foregroundStyle(Color.white)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Ticking(every: 30) { now in
                        Text(HubFormat.ago(from: session.updatedAt, now: now + store.state.clockSkew))
                            .font(Theme.font(10))
                            .foregroundStyle(Theme.textFaint)
                    }
                }
                Text(session.preview ?? session.task ?? session.lastEvent?.summary ?? "Sem atividade ainda")
                    .font(Theme.font(11))
                    .foregroundStyle(Theme.textDim)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if let percent = percent {
                    HStack(spacing: 8) {
                        ProgressBar(fraction: Double(percent) / 100, color: Theme.statusColor(session.status))
                        Text("\(percent)%")
                            .font(Theme.font(10, .semibold))
                            .foregroundStyle(Theme.textDim)
                            .monospacedDigit()
                    }
                }
                Ticking(every: session.activeSince == nil ? 60 : 1) { now in
                    Text(footer(now: now + store.state.clockSkew))
                        .font(Theme.font(10))
                        .foregroundStyle(Theme.textFaint)
                        .lineLimit(1)
                        .monospacedDigit()
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.cardBorder, lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture {
            store.answerInClaude(sessionID: session.id)
        }
        .contextMenu {
            Button("Abrir no terminal") {
                store.answerInClaude(sessionID: session.id)
            }
            Button("Dispensar sessão") {
                store.dismissSession(session)
            }
        }
        .help(session.cwd)
    }

    private func footer(now: Double) -> String {
        var parts = [session.status.label, session.projectName]
        if session.agentKind == "codex" {
            parts.append("Codex")
        } else if session.agentKind == "opencode" {
            parts.append("OpenCode")
        }
        if let agent = session.agent, !agent.isEmpty {
            parts.append(agent)
        }
        parts.append(HubFormat.duration(ms: HubFormat.sessionActiveMs(session, now: now)))
        if session.pendingApprovals > 0 {
            parts.append(session.pendingApprovals == 1 ? "1 pedido pendente" : "\(session.pendingApprovals) pedidos pendentes")
        }
        if session.subagents > 0 {
            parts.append(session.subagents == 1 ? "1 subagente" : "\(session.subagents) subagentes")
        }
        return parts.joined(separator: " · ")
    }
}

/// Pedido pendente dentro do painel, com as mesmas duas decisões do cartão.
@MainActor
struct PendingApprovalRow: View {
    let approval: Approval
    @EnvironmentObject private var store: HubStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(HubFormat.toolLabel(approval.toolName)) · \(approval.projectName)")
                .font(Theme.font(10.5, .semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
            Text(approval.command)
                .font(Theme.mono(10))
                .foregroundStyle(Theme.textDim)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(approval.command)
            HStack(spacing: 6) {
                Spacer(minLength: 0)
                Button("Negar") {
                    store.decide(approval, .deny)
                }
                .buttonStyle(PillButtonStyle(background: Theme.buttonNeutral, fontSize: 10.5, horizontalPadding: 10, verticalPadding: 4))
                Button("Permitir") {
                    store.decide(approval, .allow)
                }
                .buttonStyle(PillButtonStyle(background: Theme.blue, fontSize: 10.5, horizontalPadding: 10, verticalPadding: 4))
            }
            .disabled(store.decidingID != nil)
        }
        .padding(9)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.orange.opacity(0.35), lineWidth: 1))
    }
}

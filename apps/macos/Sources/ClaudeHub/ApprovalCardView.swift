import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Frame 00:13 — pedido de permissão na ilha.
///
/// Mostra o comando INTEIRO (a caixa rola se for longo) e oferece só duas
/// decisões para aquela chamada exata: Negar ou Permitir. Não há "permitir
/// sempre". "Responder no Claude" apenas traz o terminal para a frente.
@MainActor
struct ApprovalCardView: View {
    let approval: Approval
    let more: Int
    @EnvironmentObject private var store: HubStore

    private var title: String {
        let tool = HubFormat.toolLabel(approval.toolName)
        if approval.projectName.isEmpty {
            return "\(approval.agentShortName) quer usar \(tool)"
        }
        return "\(approval.agentShortName) quer usar \(tool) · \(approval.projectName)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: IslandMetrics.approvalSpacing) {
            header
                .frame(height: IslandMetrics.approvalHeaderHeight)
            codeBox
                .frame(height: IslandMetrics.codeBoxHeight(for: approval.command))
            actions
                .frame(height: IslandMetrics.approvalButtonsHeight)
        }
        .padding(IslandMetrics.approvalPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var header: some View {
        HStack(spacing: 8) {
            StatusDot(color: Theme.orange, size: 7)
            Text(title)
                .font(Theme.font(13, .semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            if more > 0 {
                Text("+\(more)")
                    .font(Theme.font(10, .bold))
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Theme.buttonNeutral))
                    .help("Outros pedidos na fila")
            }
            Ticking(every: 1) { now in
                Text(ApprovalCardView.countdown(expiresAt: approval.expiresAt, now: now + store.state.clockSkew))
                    .font(Theme.font(10.5, .medium))
                    .foregroundStyle(Theme.textFaint)
                    .monospacedDigit()
                    .help("Tempo até o pedido voltar para o terminal")
            }
        }
    }

    private var codeBox: some View {
        ScrollView(.vertical) {
            Text(approval.command)
                .font(Theme.mono(12))
                .foregroundStyle(Color.white.opacity(0.92))
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
        }
        .background(Theme.field)
        .clipShape(RoundedRectangle(cornerRadius: Theme.fieldRadius, style: .continuous))
    }

    private var actions: some View {
        HStack(spacing: 8) {
            if let error = store.decisionError {
                Text(error)
                    .font(Theme.font(11, .medium))
                    .foregroundStyle(Theme.red)
                    .lineLimit(1)
            } else {
                Button("Responder no \(approval.agentShortName)") {
                    store.answerInClaude(sessionID: approval.sessionId)
                }
                .buttonStyle(TextLinkButtonStyle())
            }
            Spacer(minLength: 8)
            Button("Negar") {
                store.decide(approval, .deny)
            }
            .buttonStyle(PillButtonStyle(background: Theme.buttonNeutral))
            .disabled(store.decidingID != nil)

            Button("Permitir") {
                store.decide(approval, .allow)
            }
            .buttonStyle(PillButtonStyle(background: Theme.blue))
            .disabled(store.decidingID != nil)
        }
    }

    /// "4:59" até a expiração.
    static func countdown(expiresAt: Double, now: Double) -> String {
        let seconds = Int(max(0, ((expiresAt - now) / 1000).rounded(.up)))
        let rest = seconds % 60
        return "\(seconds / 60):\(rest < 10 ? "0" : "")\(rest)"
    }
}

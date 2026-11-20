import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Medidas do recorte (notch) da tela onde a ilha está. Tudo zero = sem notch.
struct IslandGeometry: Equatable {
    var notchHeight: CGFloat = 0
    var notchWidth: CGFloat = 0

    var hasNotch: Bool {
        return notchHeight > 0
    }
}

/// O que a ilha está mostrando agora.
enum IslandContent: Equatable {
    /// Hub fora do ar, sem configuração ou token recusado.
    case offline(HubConnectionState)
    /// Pedido de permissão (frame 00:13) e quantos mais estão na fila.
    case approval(Approval, more: Int)
    /// Painel completo (frame 00:05).
    case panel
    /// Aviso passageiro: tarefa concluída ou erro.
    case flash(HubAlert)
    /// Detalhe da sessão em foco (ao passar o mouse).
    case detail(Session)
    case working(Session)
    /// "Esperando você" — ou precisa de autorização respondida no Claude Code.
    case waiting(Session)
    case completed(Session)
    case failed(Session)
    /// Nenhuma sessão viva.
    case idle

    /// Identidade para transições: muda só quando troca o tipo de conteúdo.
    var kind: String {
        switch self {
        case .offline: return "offline"
        case .approval: return "approval"
        case .panel: return "panel"
        case .flash: return "flash"
        case .detail: return "detail"
        case .working: return "working"
        case .waiting: return "waiting"
        case .completed: return "completed"
        case .failed: return "failed"
        case .idle: return "idle"
        }
    }

    /// Estados em que um clique abre o painel.
    var opensPanelOnTap: Bool {
        switch self {
        case .panel, .approval: return false
        default: return true
        }
    }

    var isExpanded: Bool {
        switch self {
        case .panel, .approval, .detail: return true
        default: return false
        }
    }
}

/// Tamanho de cada estado da ilha. A janela (IslandController) e o SwiftUI
/// (IslandRootView) usam a mesma função, então sempre concordam.
enum IslandMetrics {
    static let panelSize = CGSize(width: 700, height: 456)
    static let approvalWidth: CGFloat = 540
    static let detailWidth: CGFloat = 440

    /// Margem transparente em volta da ilha dentro da janela.
    static let windowMargin: CGFloat = 8

    static func size(for content: IslandContent, geometry: IslandGeometry, showPercent: Bool) -> CGSize {
        switch content {
        case .panel:
            return expanded(panelSize, geometry)
        case .approval(let approval, _):
            return expanded(CGSize(width: approvalWidth, height: approvalHeight(for: approval.command)), geometry)
        case .detail(let session):
            let hasProgress = HubFormat.progressPercent(session.progress) != nil
            return expanded(CGSize(width: detailWidth, height: hasProgress ? 116 : 98), geometry)
        default:
            if geometry.hasNotch {
                return CGSize(
                    width: geometry.notchWidth + 2 * notchWing(for: content),
                    height: max(geometry.notchHeight, 30)
                )
            }
            return CGSize(width: compactWidth(for: content, showPercent: showPercent), height: compactHeight(for: content))
        }
    }

    /// Estados expandidos em tela com notch: o conteúdo começa abaixo do recorte.
    private static func expanded(_ size: CGSize, _ geometry: IslandGeometry) -> CGSize {
        guard geometry.hasNotch else { return size }
        return CGSize(width: max(size.width, geometry.notchWidth + 120), height: size.height + geometry.notchHeight)
    }

    private static func compactWidth(for content: IslandContent, showPercent: Bool) -> CGFloat {
        switch content {
        case .working(let session):
            let hasPercent = showPercent && HubFormat.progressPercent(session.progress) != nil
            return hasPercent ? 262 : 228
        case .waiting(let session):
            return session.status == .approvalRequired ? 368 : 318
        case .completed:
            return 290
        case .failed:
            return 300
        case .flash:
            return 340
        case .offline:
            return 250
        case .idle:
            // Com os indicadores ligados cabe "CPU 100% · RAM 100%".
            return SystemPreferenceStore.idleReadout ? 204 : 132
        default:
            return 240
        }
    }

    private static func compactHeight(for content: IslandContent) -> CGFloat {
        switch content {
        case .waiting: return 44
        case .idle: return 28
        default: return 36
        }
    }

    /// Largura de cada "asa" ao lado do notch.
    private static func notchWing(for content: IslandContent) -> CGFloat {
        switch content {
        case .working: return 132
        case .waiting(let session): return session.status == .approvalRequired ? 184 : 150
        case .completed, .failed: return 136
        case .flash: return 156
        case .offline: return 124
        case .idle:
            // Sem indicadores a pílula ociosa some dentro do recorte.
            return SystemPreferenceStore.idleReadout ? 84 : 0
        default: return 120
        }
    }

    // MARK: Cartão de aprovação

    static let approvalPadding: CGFloat = 16
    static let approvalHeaderHeight: CGFloat = 20
    static let approvalButtonsHeight: CGFloat = 30
    static let approvalSpacing: CGFloat = 12

    /// Altura da caixa de código: cresce com o comando até um teto; acima
    /// disso a caixa rola. O comando inteiro está sempre disponível.
    static func codeBoxHeight(for command: String) -> CGFloat {
        let charsPerLine = 62
        var lines = 0
        for part in command.components(separatedBy: "\n") {
            lines += max(1, Int((Double(part.count) / Double(charsPerLine)).rounded(.up)))
        }
        let height = CGFloat(lines) * 17 + 22
        return min(126, max(40, height))
    }

    static func approvalHeight(for command: String) -> CGFloat {
        return approvalPadding * 2
            + approvalHeaderHeight
            + approvalSpacing
            + codeBoxHeight(for: command)
            + approvalSpacing
            + approvalButtonsHeight
    }
}

import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Raiz da ilha. A forma preta muda de tamanho com mola entre os estados;
/// o conteúdo de cada estado entra e sai com um fade curto.
@MainActor
struct IslandRootView: View {
    @EnvironmentObject private var store: HubStore
    @EnvironmentObject private var prefs: Preferences
    @EnvironmentObject private var geometryModel: IslandGeometryModel

    var body: some View {
        let content = store.content
        let geometry = geometryModel.geometry
        let size = IslandMetrics.size(for: content, geometry: geometry, showPercent: prefs.showPercent)
        let shape = islandShape(height: size.height, expanded: content.isExpanded, geometry: geometry)

        ZStack(alignment: .top) {
            Color.clear
            IslandBody(content: content, geometry: geometry)
                .frame(width: size.width, height: size.height, alignment: .top)
                .background(Theme.island)
                .clipShape(shape)
                .contentShape(shape)
                .onHover { inside in
                    store.setHovering(inside)
                }
                .onTapGesture {
                    if content.opensPanelOnTap {
                        store.togglePanel()
                    }
                }
                .animation(Theme.spring, value: size)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .environment(\.colorScheme, .dark)
    }

    /// Pílula inteira quando compacta; raio 28 quando expandida. Em tela com
    /// notch o topo é reto, para a ilha parecer continuação do recorte.
    private func islandShape(height: CGFloat, expanded: Bool, geometry: IslandGeometry) -> UnevenRoundedRectangle {
        let radius = expanded ? Theme.islandRadius : min(Theme.islandRadius, height / 2)
        let top: CGFloat = geometry.hasNotch ? 0 : radius
        return UnevenRoundedRectangle(
            topLeadingRadius: top,
            bottomLeadingRadius: radius,
            bottomTrailingRadius: radius,
            topTrailingRadius: top,
            style: .continuous
        )
    }
}

@MainActor
struct IslandBody: View {
    let content: IslandContent
    let geometry: IslandGeometry
    @EnvironmentObject private var prefs: Preferences

    var body: some View {
        Group {
            switch content {
            case .offline(let state):
                OfflinePill(state: state, geometry: geometry)
            case .approval(let approval, let more):
                ApprovalCardView(approval: approval, more: more)
                    .padding(.top, geometry.notchHeight)
            case .panel:
                PanelView()
                    .padding(.top, geometry.notchHeight)
            case .flash(let alert):
                FlashPill(alert: alert, geometry: geometry)
            case .detail(let session):
                DetailCard(session: session)
                    .padding(.top, geometry.notchHeight)
            case .working(let session):
                WorkingPill(session: session, geometry: geometry, showPercent: prefs.showPercent)
            case .waiting(let session):
                WaitingPill(session: session, geometry: geometry)
            case .completed(let session):
                CompletedPill(session: session, geometry: geometry)
            case .failed(let session):
                FailedPill(session: session, geometry: geometry)
            case .idle:
                IdlePill(geometry: geometry)
            }
        }
        .transition(.opacity)
        .animation(.easeInOut(duration: 0.18), value: content.kind)
    }
}

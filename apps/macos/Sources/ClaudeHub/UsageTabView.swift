import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Aba "Uso". Tudo aqui é dado verificável:
///  - HOJE: números calculados pelo hub a partir dos eventos reais do Claude Code;
///  - CONSUMO e LIMITES: só o que o próprio Claude Code informou (GET /api/usage).
///    Quando ele não informa, a aba diz isso — nada é estimado nem extrapolado;
///  - HISTÓRICO: os últimos eventos guardados pelo hub.
@MainActor
struct UsageTabView: View {
    @EnvironmentObject private var store: HubStore
    @ObservedObject private var hubPrefs = HubPrefsModel.shared
    /// Preferência aguardando o "Confirmar" (nil = nenhuma).
    @State private var confirming: HubPrefKey?

    private let columns = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
    ]

    private let tokenColumns = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
    ]

    private static let consumptionExplanation =
        "Acrescenta variáveis de telemetria local às configurações do Claude Code (com backup). Os dados ficam só neste Mac."
    private static let limitsExplanation =
        "Define a linha de status do Claude Code para repassar os limites ao hub. Se você já tem uma linha de status, ela continua aparecendo."

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                limitsSection
                consumptionSection
                today
                historySection
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollIndicators(.never)
        .onAppear {
            store.refreshEvents()
            hubPrefs.load()
        }
        .task {
            // Enquanto a aba está na tela, os números acompanham o hub.
            while !Task.isCancelled {
                store.refreshUsage()
                try? await Task.sleep(nanoseconds: 20_000_000_000)
            }
        }
    }

    // MARK: - Hoje

    @ViewBuilder
    private var today: some View {
        SectionTitle("HOJE")
        if let usage = store.usage {
            LazyVGrid(columns: columns, spacing: 8) {
                StatTile(title: "Sessões", value: "\(usage.sessions)")
                StatTile(title: "Pedidos", value: "\(usage.prompts)")
                StatTile(title: "Ferramentas", value: "\(usage.toolCalls)")
                StatTile(title: "Permitidos", value: "\(usage.approvalsAllowed)")
                StatTile(title: "Negados", value: "\(usage.approvalsDenied)")
                StatTile(title: "Tempo ativo", value: HubFormat.duration(ms: usage.activeMs))
            }
            if !usage.byTool.isEmpty {
                SectionTitle("FERRAMENTAS MAIS USADAS")
                    .padding(.top, 4)
                toolBars(usage.byTool)
            }
        } else {
            note(store.isConnected ? "Carregando…" : "Hub offline — sem dados de uso.")
        }
    }

    private func toolBars(_ tools: [ToolCount]) -> some View {
        let top = Array(tools.prefix(5))
        let maximum = max(1, top.map { $0.count }.max() ?? 1)
        return VStack(spacing: 5) {
            ForEach(top, id: \.tool) { item in
                HStack(spacing: 8) {
                    Text(HubFormat.toolLabel(item.tool))
                        .font(Theme.font(10.5, .medium))
                        .foregroundStyle(Theme.textDim)
                        .lineLimit(1)
                        .frame(width: 130, alignment: .leading)
                    ProgressBar(fraction: Double(item.count) / Double(maximum), color: Theme.blue, height: 5)
                    Text("\(item.count)")
                        .font(Theme.font(10.5, .semibold))
                        .foregroundStyle(Color.white)
                        .monospacedDigit()
                        .frame(width: 34, alignment: .trailing)
                }
            }
        }
    }

    // MARK: - Consumo do Claude

    @ViewBuilder
    private var consumptionSection: some View {
        SectionTitle("CONSUMO DO CLAUDE")
            .padding(.top, 6)
        if let usage = store.usage {
            if let data = usage.consumption, data.hasData {
                consumptionData(data)
                turnOffLink(.consumption, "Desligar medição")
            } else if consumptionEnabled(usage) {
                note("Medição ligada. Os números aparecem depois da próxima resposta do Claude.")
                turnOffLink(.consumption, "Desligar medição")
            } else {
                note("Medição desligada.")
                enableControl(.consumption, title: "Ligar medição", explanation: UsageTabView.consumptionExplanation)
            }
            PrefDetailText(text: hubPrefs.detail(.consumption))
        } else {
            note(store.isConnected ? "Carregando…" : "Hub offline — sem dados de consumo.")
        }
    }

    private func consumptionEnabled(_ usage: UsageStats) -> Bool {
        if usage.consumption?.enabled == true { return true }
        return hubPrefs.loaded && hubPrefs.prefs.consumption
    }

    private func consumptionData(_ data: ClaudeConsumption) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            LazyVGrid(columns: tokenColumns, spacing: 8) {
                StatTile(title: "Tokens de entrada", value: UsageFormat.tokens(data.inputTokens))
                StatTile(title: "Tokens de saída", value: UsageFormat.tokens(data.outputTokens))
                StatTile(title: "Cache lido", value: UsageFormat.tokens(data.cacheReadTokens))
                StatTile(title: "Cache criado", value: UsageFormat.tokens(data.cacheCreationTokens))
            }
            costRow(data.costUsd)
            if !data.byModel.isEmpty {
                modelTable(data.byModel)
            }
            note(consumptionCaption(data))
        }
    }

    private func costRow(_ cost: Double?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let cost = cost {
                Text(UsageFormat.cost(cost))
                    .font(Theme.font(14, .bold))
                    .foregroundStyle(Color.white)
                    .monospacedDigit()
                Text("Custo estimado pelo próprio Claude Code")
                    .font(Theme.font(10))
                    .foregroundStyle(Theme.textDim)
            } else {
                Text("O Claude Code não informou custo.")
                    .font(Theme.font(10))
                    .foregroundStyle(Theme.textDim)
            }
            Spacer(minLength: 0)
        }
    }

    private func consumptionCaption(_ data: ClaudeConsumption) -> String {
        var parts = ["Telemetria local do Claude Code"]
        if data.since > 0 {
            parts.append("contado desde " + UsageTime.dateTime(data.since))
        }
        if let updated = data.updatedAt {
            parts.append("último dado às " + UsageTime.clock(updated))
        }
        return parts.joined(separator: " · ")
    }

    private func modelTable(_ models: [ModelConsumption]) -> some View {
        VStack(spacing: 3) {
            modelRow(
                name: "Modelo",
                input: "Entrada",
                output: "Saída",
                cacheRead: "Cache lido",
                cacheCreation: "Cache criado",
                cost: "Custo",
                header: true
            )
            ForEach(models) { item in
                modelRow(
                    name: item.model,
                    input: UsageFormat.tokens(item.inputTokens),
                    output: UsageFormat.tokens(item.outputTokens),
                    cacheRead: UsageFormat.tokens(item.cacheReadTokens),
                    cacheCreation: UsageFormat.tokens(item.cacheCreationTokens),
                    cost: item.costUsd.map { UsageFormat.cost($0) } ?? "não informado",
                    header: false
                )
            }
        }
    }

    private func modelRow(
        name: String,
        input: String,
        output: String,
        cacheRead: String,
        cacheCreation: String,
        cost: String,
        header: Bool
    ) -> some View {
        let font = header ? Theme.font(9.5, .semibold) : Theme.font(10.5, .medium)
        let color = header ? Theme.textFaint : Color.white
        return HStack(spacing: 8) {
            Text(name)
                .foregroundStyle(header ? Theme.textFaint : Theme.textDim)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(input).frame(width: 74, alignment: .trailing)
            Text(output).frame(width: 74, alignment: .trailing)
            Text(cacheRead).frame(width: 74, alignment: .trailing)
            Text(cacheCreation).frame(width: 78, alignment: .trailing)
            Text(cost).frame(width: 92, alignment: .trailing)
        }
        .font(font)
        .foregroundStyle(color)
        .monospacedDigit()
        .lineLimit(1)
        .padding(.horizontal, 10)
        .padding(.vertical, header ? 2 : 6)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(header ? Color.clear : Theme.card))
    }

    // MARK: - Limites do plano

    @ViewBuilder
    private var limitsSection: some View {
        SectionTitle("LIMITES DO PLANO")
            .padding(.top, 6)
        if let usage = store.usage {
            let windows = usage.limits?.windows ?? []
            if windows.isEmpty {
                note("O Claude Code não informou limites. Nada é estimado.")
            } else {
                limitWindows(windows, updatedAt: usage.limits?.updatedAt)
            }
            if let context = usage.limits?.context {
                contextRow(context, updatedAt: usage.limits?.updatedAt)
            }
            if limitsEnabled(usage) {
                turnOffLink(.limits, "Desligar leitura de limites")
            } else if windows.isEmpty {
                enableControl(.limits, title: "Ligar leitura de limites", explanation: UsageTabView.limitsExplanation)
            }
            PrefDetailText(text: hubPrefs.detail(.limits))
        } else {
            note(store.isConnected ? "Carregando…" : "Hub offline — sem dados de limites.")
        }
    }

    private func limitsEnabled(_ usage: UsageStats) -> Bool {
        if usage.limits?.enabled == true { return true }
        return hubPrefs.loaded && hubPrefs.prefs.limits
    }

    private func limitWindows(_ windows: [LimitWindow], updatedAt: Double?) -> some View {
        VStack(spacing: 6) {
            ForEach(Array(windows.enumerated()), id: \.offset) { item in
                limitRow(item.element, updatedAt: updatedAt)
            }
        }
    }

    private func limitRow(_ window: LimitWindow, updatedAt: Double?) -> some View {
        var parts: [String] = []
        if let resets = window.resetsAt {
            parts.append("renova " + UsageTime.dateTime(resets))
        }
        parts.append(informedCaption(updatedAt))
        return usageBar(
            label: window.label,
            percent: window.usedPercent,
            fraction: window.fraction,
            caption: parts.joined(separator: " · ")
        )
    }

    private func contextRow(_ context: ContextUsage, updatedAt: Double?) -> some View {
        var label = "Contexto da sessão"
        if let id = context.sessionId, let session = store.state.session(id: id) {
            label += " · " + session.projectName
        }
        var parts: [String] = []
        if let size = context.windowSize, size > 0 {
            parts.append("janela de " + UsageFormat.tokens(size) + " tokens")
        }
        parts.append(informedCaption(updatedAt))
        return usageBar(
            label: label,
            percent: context.usedPercent,
            fraction: context.fraction,
            caption: parts.joined(separator: " · ")
        )
    }

    private func informedCaption(_ updatedAt: Double?) -> String {
        if let updated = updatedAt {
            return "informado pelo Claude Code às " + UsageTime.clock(updated)
        }
        return "informado pelo Claude Code"
    }

    private func usageBar(label: String, percent: Double, fraction: Double, caption: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(label)
                    .font(Theme.font(11, .medium))
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(UsageFormat.percent(percent))
                    .font(Theme.font(11, .bold))
                    .foregroundStyle(Color.white)
                    .monospacedDigit()
            }
            ProgressBar(fraction: fraction, color: barColor(percent), height: 5)
            Text(caption)
                .font(Theme.font(10))
                .foregroundStyle(Theme.textDim)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.card))
    }

    private func barColor(_ percent: Double) -> Color {
        if percent >= 90 { return Theme.red }
        if percent >= 70 { return Theme.orange }
        return Theme.blue
    }

    // MARK: - Ligar / desligar (CLI embutida)

    /// Botão "Ligar…" que, antes de mexer em qualquer coisa, mostra o que será
    /// alterado e espera o "Confirmar".
    @ViewBuilder
    private func enableControl(_ key: HubPrefKey, title: String, explanation: String) -> some View {
        if !hubPrefs.available {
            note("Indisponível neste build: o runtime do Claude Hub não está embutido.")
        } else if confirming == key {
            VStack(alignment: .leading, spacing: 8) {
                Text(explanation)
                    .font(Theme.font(11))
                    .foregroundStyle(Color.white)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button {
                        apply(key, true)
                    } label: {
                        Text("Confirmar")
                    }
                    .buttonStyle(PillButtonStyle(background: Theme.blue, fontSize: 11, horizontalPadding: 12, verticalPadding: 5))
                    Button {
                        confirming = nil
                    } label: {
                        Text("Cancelar")
                    }
                    .buttonStyle(PillButtonStyle(background: Theme.buttonNeutral, fontSize: 11, horizontalPadding: 12, verticalPadding: 5))
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.card))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )
        } else {
            Button {
                confirming = key
            } label: {
                Text(hubPrefs.isBusy(key) ? "Ligando…" : title)
            }
            .buttonStyle(PillButtonStyle(background: Theme.blue, fontSize: 11, horizontalPadding: 12, verticalPadding: 5))
            .disabled(hubPrefs.busyKey != nil)
        }
    }

    @ViewBuilder
    private func turnOffLink(_ key: HubPrefKey, _ title: String) -> some View {
        if hubPrefs.available {
            Button {
                apply(key, false)
            } label: {
                Text(hubPrefs.isBusy(key) ? "Desligando…" : title)
            }
            .buttonStyle(TextLinkButtonStyle())
            .disabled(hubPrefs.busyKey != nil)
        }
    }

    private func apply(_ key: HubPrefKey, _ on: Bool) {
        confirming = nil
        Task {
            await hubPrefs.set(key, on)
            store.refreshUsage()
        }
    }

    // MARK: - Histórico

    @ViewBuilder
    private var historySection: some View {
        SectionTitle("HISTÓRICO")
            .padding(.top, 6)
        let events = store.history
        if events.isEmpty {
            note(store.isConnected ? "Nenhum evento registrado ainda." : "Hub offline — sem histórico.")
        } else {
            VStack(spacing: 3) {
                ForEach(events) { event in
                    historyRow(event)
                }
            }
        }
    }

    private func historyRow(_ event: HubEvent) -> some View {
        let session = store.state.session(id: event.sessionId)
        let summary = event.summary.isEmpty ? event.type : event.summary
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(UsageTime.short(event.at))
                .font(Theme.font(10))
                .foregroundStyle(Theme.textFaint)
                .monospacedDigit()
                .lineLimit(1)
                .frame(width: 68, alignment: .leading)
            if let session = session {
                Text(session.projectName)
                    .font(Theme.font(10.5, .semibold))
                    .foregroundStyle(Theme.textDim)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(width: 120, alignment: .leading)
                    .help(session.title)
            }
            Text(summary)
                .font(Theme.font(10.5))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.card))
    }

    // MARK: - Apoio

    private func note(_ text: String) -> some View {
        Text(text)
            .font(Theme.font(11))
            .foregroundStyle(Theme.textDim)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Datas e horas dos dados do hub (milissegundos desde 1970), no fuso do Mac.
enum UsageTime {
    private static func makeFormatter(_ format: String) -> DateFormatter {
        let result = DateFormatter()
        result.locale = Locale(identifier: "pt_BR")
        result.dateFormat = format
        return result
    }

    private static let clockFormatter: DateFormatter = UsageTime.makeFormatter("HH:mm")
    private static let dayFormatter: DateFormatter = UsageTime.makeFormatter("dd/MM")

    private static func date(_ ms: Double) -> Date {
        return Date(timeIntervalSince1970: ms / 1000)
    }

    /// "14:32"
    static func clock(_ ms: Double) -> String {
        return clockFormatter.string(from: date(ms))
    }

    /// "hoje às 14:32" ou "21/11 às 09:00"
    static func dateTime(_ ms: Double) -> String {
        let value = date(ms)
        let time = clockFormatter.string(from: value)
        if Calendar.current.isDateInToday(value) {
            return "hoje às " + time
        }
        return dayFormatter.string(from: value) + " às " + time
    }

    /// "14:32" para hoje; "19/11 14:32" para outros dias.
    static func short(_ ms: Double) -> String {
        let value = date(ms)
        let time = clockFormatter.string(from: value)
        if Calendar.current.isDateInToday(value) {
            return time
        }
        return dayFormatter.string(from: value) + " " + time
    }
}

struct StatTile: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value)
                .font(Theme.font(18, .bold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .monospacedDigit()
            Text(title)
                .font(Theme.font(10))
                .foregroundStyle(Theme.textDim)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.card))
    }
}

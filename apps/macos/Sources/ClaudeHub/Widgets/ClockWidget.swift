import SwiftUI

enum ClockKeys {
    /// Bool: true = relógio de 12 horas.
    static let twelveHour = "widget.clock.twelveHour"
}

/// Relógio e data. Atualiza uma vez por minuto (TimelineView), sem timers próprios.
@MainActor
final class ClockWidget: HubWidget {
    let id = "clock"
    let title = "Relógio e data"
    let symbol = "clock"

    func makeView() -> AnyView {
        return AnyView(ClockWidgetView())
    }

    func makeSettingsView() -> AnyView? {
        return AnyView(ClockWidgetSettings())
    }
}

enum ClockFormat {
    private static let locale = Locale(identifier: "pt_BR")

    /// "sexta-feira, 20 de novembro"
    static func date(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateFormat = "EEEE, d 'de' MMMM"
        return formatter.string(from: date)
    }

    /// "14:32" ou "2:32".
    static func time(_ date: Date, twelveHour: Bool) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = twelveHour ? "h:mm" : "HH:mm"
        return formatter.string(from: date)
    }

    /// "AM"/"PM" no formato de 12 horas.
    static func period(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "a"
        return formatter.string(from: date)
    }

    /// "2026"
    static func year(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateFormat = "yyyy"
        return formatter.string(from: date)
    }
}

@MainActor
struct ClockWidgetView: View {
    @AppStorage(ClockKeys.twelveHour) private var twelveHour = false

    var body: some View {
        TimelineView(.everyMinute) { context in
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(ClockFormat.time(context.date, twelveHour: twelveHour))
                        .font(Theme.font(40, .bold))
                        .foregroundStyle(Color.white)
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    if twelveHour {
                        Text(ClockFormat.period(context.date))
                            .font(Theme.font(12, .semibold))
                            .foregroundStyle(Theme.textDim)
                    }
                }
                Text(ClockFormat.date(context.date))
                    .font(Theme.font(12, .medium))
                    .foregroundStyle(Theme.textDim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(ClockFormat.year(context.date))
                    .font(Theme.font(10))
                    .foregroundStyle(Theme.textFaint)
            }
        }
    }
}

@MainActor
struct ClockWidgetSettings: View {
    @AppStorage(ClockKeys.twelveHour) private var twelveHour = false

    var body: some View {
        SegmentedPills(
            options: [false, true],
            selection: twelveHour,
            label: { $0 ? "12 horas" : "24 horas" },
            onSelect: { twelveHour = $0 }
        )
    }
}

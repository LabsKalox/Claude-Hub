import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

// Clima pelo Open-Meteo: sem chave de API e sem permissão de localização.
// A cidade é escolhida à mão nos ajustes; só o nome buscado e a coordenada da
// cidade escolhida saem do Mac.

/// Chaves em UserDefaults (não renomear: outras partes do app as leem).
enum WeatherKeys {
    static let cityName = "widget.weather.cityName"
    static let latitude = "widget.weather.latitude"
    static let longitude = "widget.weather.longitude"
    static let fahrenheit = "widget.weather.fahrenheit"
}

@MainActor
final class WeatherModel: ObservableObject {
    /// Intervalo mínimo entre duas leituras.
    static let refreshInterval: TimeInterval = 30 * 60
    /// Depois de uma falha, reabrir a aba só tenta de novo passado este tempo.
    static let retryInterval: TimeInterval = 60

    // Cidade e unidade
    @Published private(set) var cityName: String?
    @Published private(set) var fahrenheit = false

    // Leitura
    @Published private(set) var forecast: WeatherForecast?
    @Published private(set) var updatedAt: Date?
    @Published private(set) var failed = false
    @Published private(set) var loading = false

    // Busca de cidade
    @Published var query = ""
    @Published private(set) var results: [GeoPlace] = []
    @Published private(set) var searching = false
    @Published private(set) var searchMessage: String?

    private let defaults: UserDefaults
    private let session: URLSession
    private var latitude: Double?
    private var longitude: Double?
    private var lastAttempt: Date?
    /// Muda a cada troca de cidade ou unidade; descarta respostas atrasadas.
    private var generation = 0
    private var loopTask: Task<Void, Never>?
    private var searchTask: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: configuration)

        let name = defaults.string(forKey: WeatherKeys.cityName) ?? ""
        let hasCoordinates = defaults.object(forKey: WeatherKeys.latitude) != nil
            && defaults.object(forKey: WeatherKeys.longitude) != nil
        if !name.isEmpty, hasCoordinates {
            cityName = name
            latitude = defaults.double(forKey: WeatherKeys.latitude)
            longitude = defaults.double(forKey: WeatherKeys.longitude)
        }
        fahrenheit = defaults.bool(forKey: WeatherKeys.fahrenheit)
    }

    var hasCity: Bool {
        return cityName != nil && latitude != nil && longitude != nil
    }

    // MARK: - Ciclo (só enquanto o widget está na tela)

    func start() {
        loopTask?.cancel()
        loopTask = Task { [weak self] in
            while !Task.isCancelled {
                let wait: TimeInterval = await self?.refreshIfDue() ?? 0
                if self == nil { return }
                let seconds = max(30, min(WeatherModel.refreshInterval, wait))
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            }
        }
    }

    func stop() {
        loopTask?.cancel()
        loopTask = nil
    }

    /// Lê de novo se a última leitura tem mais de 30 minutos. Devolve em quantos
    /// segundos vale a pena conferir outra vez.
    private func refreshIfDue() async -> TimeInterval {
        guard hasCity else { return WeatherModel.refreshInterval }
        let now = Date()
        if let last = updatedAt {
            let age = now.timeIntervalSince(last)
            if age < WeatherModel.refreshInterval {
                return WeatherModel.refreshInterval - age
            }
        }
        if let attempt = lastAttempt {
            let age = now.timeIntervalSince(attempt)
            if age < WeatherModel.retryInterval {
                return WeatherModel.retryInterval - age
            }
        }
        await refresh()
        return WeatherModel.refreshInterval
    }

    private func refresh() async {
        guard let latitude = latitude, let longitude = longitude else { return }
        guard let url = WeatherAPI.forecastURL(latitude: latitude, longitude: longitude, fahrenheit: fahrenheit) else {
            failed = true
            return
        }
        let requested = generation
        lastAttempt = Date()
        loading = true
        var decoded: WeatherForecast?
        do {
            let (data, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                decoded = try JSONDecoder().decode(WeatherForecast.self, from: data)
            }
        } catch {
            decoded = nil
        }
        // A cidade ou a unidade mudou enquanto a resposta vinha: descarta.
        guard requested == generation else { return }
        loading = false
        if let decoded = decoded {
            forecast = decoded
            updatedAt = Date()
            failed = false
        } else {
            // Mantém a última leitura na tela; só marca a falha.
            failed = true
        }
    }

    // MARK: - Ajustes

    func choose(_ place: GeoPlace) {
        cityName = place.displayName
        latitude = place.latitude
        longitude = place.longitude
        defaults.set(place.displayName, forKey: WeatherKeys.cityName)
        defaults.set(place.latitude, forKey: WeatherKeys.latitude)
        defaults.set(place.longitude, forKey: WeatherKeys.longitude)
        results = []
        query = ""
        searchMessage = nil
        resetReading()
    }

    func setFahrenheit(_ value: Bool) {
        guard fahrenheit != value else { return }
        fahrenheit = value
        defaults.set(value, forKey: WeatherKeys.fahrenheit)
        resetReading()
    }

    /// A leitura antiga é de outra cidade ou outra unidade: não serve mais.
    private func resetReading() {
        generation += 1
        forecast = nil
        updatedAt = nil
        lastAttempt = nil
        failed = false
        loading = false
        Task { [weak self] in
            await self?.refresh()
        }
    }

    func search() {
        searchTask?.cancel()
        guard let url = WeatherAPI.geocodingURL(query: query) else {
            results = []
            searchMessage = nil
            searching = false
            return
        }
        searching = true
        searchMessage = nil
        let session = self.session
        searchTask = Task { [weak self] in
            var found: [GeoPlace]?
            do {
                let (data, _) = try await session.data(from: url)
                found = try JSONDecoder().decode(GeocodingResponse.self, from: data).results
            } catch {
                found = nil
            }
            if Task.isCancelled { return }
            self?.finishSearch(found)
        }
    }

    private func finishSearch(_ found: [GeoPlace]?) {
        searching = false
        if let found = found {
            results = found
            searchMessage = found.isEmpty ? "Nenhuma cidade encontrada com esse nome." : nil
        } else {
            results = []
            searchMessage = "Sem conexão — não foi possível buscar."
        }
    }
}

// MARK: - Widget

@MainActor
final class WeatherWidget: HubWidget {
    let id = "weather"
    let title = "Clima"
    let symbol = "cloud.sun"

    private let model: WeatherModel

    init() {
        model = WeatherModel()
    }

    func makeView() -> AnyView {
        return AnyView(WeatherWidgetView(model: model))
    }

    func makeSettingsView() -> AnyView? {
        return AnyView(WeatherWidgetSettings(model: model))
    }

    func start() {
        model.start()
    }

    func stop() {
        model.stop()
    }
}

enum WeatherText {
    /// "14:32"
    static func clock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    /// "62%"
    static func percent(_ value: Double) -> String {
        return "\(Int(value.rounded()))%"
    }

    /// "12 km/h"
    static func wind(_ value: Double) -> String {
        return "\(Int(value.rounded())) km/h"
    }
}

@MainActor
struct WeatherWidgetView: View {
    @ObservedObject var model: WeatherModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.hasCity {
                WidgetCaption("Escolha uma cidade em Ajustar", color: Theme.textDim)
            } else if let forecast = model.forecast {
                current(forecast)
                details(forecast.current)
                if !forecast.followingDays.isEmpty {
                    days(Array(forecast.followingDays.prefix(3)))
                }
                footer
            } else if model.failed {
                cityLine
                WidgetCaption("Sem conexão — ainda não há leitura para mostrar.", color: Theme.orange)
            } else {
                cityLine
                WidgetCaption("Carregando…", color: Theme.textDim)
            }
        }
    }

    private var cityLine: some View {
        Text(model.cityName ?? "")
            .font(Theme.font(11, .medium))
            .foregroundStyle(Theme.textDim)
            .lineLimit(1)
    }

    private func current(_ forecast: WeatherForecast) -> some View {
        let condition = WeatherCode.describe(forecast.current.weatherCode)
        return HStack(alignment: .center, spacing: 10) {
            Image(systemName: condition.symbol)
                .symbolRenderingMode(.multicolor)
                .font(.system(size: 26))
                .frame(width: 36)
            Text(WeatherFormat.degrees(forecast.current.temperature) + (model.fahrenheit ? "F" : "C"))
                .font(Theme.font(30, .bold))
                .foregroundStyle(Color.white)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            VStack(alignment: .leading, spacing: 1) {
                Text(condition.text)
                    .font(Theme.font(11.5, .semibold))
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                cityLine
            }
            Spacer(minLength: 0)
        }
    }

    private func details(_ now: WeatherCurrent) -> some View {
        var parts: [String] = []
        if let feels = now.apparentTemperature {
            parts.append("Sensação " + WeatherFormat.degrees(feels))
        }
        if let humidity = now.humidity {
            parts.append("Umidade " + WeatherText.percent(humidity))
        }
        if let wind = now.windSpeed {
            parts.append("Vento " + WeatherText.wind(wind))
        }
        return Text(parts.joined(separator: " · "))
            .font(Theme.font(10.5))
            .foregroundStyle(Theme.textDim)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    private func days(_ list: [WeatherDay]) -> some View {
        HStack(spacing: 6) {
            ForEach(list) { day in
                dayTile(day)
            }
        }
    }

    private func dayTile(_ day: WeatherDay) -> some View {
        let condition = WeatherCode.describe(day.weatherCode)
        let maximum = day.maxTemperature.map { WeatherFormat.degrees($0) } ?? "–"
        let minimum = day.minTemperature.map { WeatherFormat.degrees($0) } ?? "–"
        let rain = day.precipitationProbability.map { "chuva " + WeatherText.percent($0) } ?? "chuva –"
        return VStack(spacing: 2) {
            Text(WeatherFormat.weekday(day.date))
                .font(Theme.font(10, .semibold))
                .foregroundStyle(Theme.textDim)
            Image(systemName: condition.symbol)
                .symbolRenderingMode(.multicolor)
                .font(.system(size: 13))
                .frame(height: 16)
            Text(maximum + " / " + minimum)
                .font(Theme.font(10.5, .semibold))
                .foregroundStyle(Color.white)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text(rain)
                .font(Theme.font(9))
                .foregroundStyle(Theme.textFaint)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.field))
        .help(condition.text)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 2) {
            if model.failed {
                WidgetCaption("Sem conexão — mostrando a última leitura", color: Theme.orange)
            }
            if let updated = model.updatedAt {
                WidgetCaption("Atualizado às " + WeatherText.clock(updated) + " · Dados: Open-Meteo")
            } else {
                WidgetCaption("Dados: Open-Meteo")
            }
        }
    }
}

@MainActor
struct WeatherWidgetSettings: View {
    @ObservedObject var model: WeatherModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetCaption(model.cityName.map { "Cidade: " + $0 } ?? "Nenhuma cidade escolhida.", color: Theme.textDim)
            searchField
            if let message = model.searchMessage {
                WidgetCaption(message, color: Theme.orange)
            }
            if !model.results.isEmpty {
                resultList
            }
            SegmentedPills(
                options: [false, true],
                selection: model.fahrenheit,
                label: { $0 ? "°F" : "°C" },
                onSelect: { model.setFahrenheit($0) }
            )
            WidgetCaption("A busca envia ao Open-Meteo só o nome digitado; a previsão, só a coordenada da cidade.")
        }
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            TextField("Buscar cidade", text: $model.query)
                .textFieldStyle(.plain)
                .font(Theme.font(11))
                .foregroundStyle(Color.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.field))
                .onSubmit {
                    model.search()
                }
            Button {
                model.search()
            } label: {
                Text(model.searching ? "Buscando…" : "Buscar")
            }
            .buttonStyle(PillButtonStyle(background: Theme.blue, fontSize: 10.5, horizontalPadding: 10, verticalPadding: 5))
            .disabled(model.searching)
        }
    }

    private var resultList: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(model.results) { place in
                Button {
                    model.choose(place)
                } label: {
                    Text(place.displayName)
                        .font(Theme.font(10.5, .medium))
                        .foregroundStyle(Color.white)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.field))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

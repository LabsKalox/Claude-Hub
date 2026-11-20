import Foundation

// Previsão do tempo pelo Open-Meteo (https://open-meteo.com): sem chave de API
// e sem permissão de localização — a cidade é escolhida à mão no widget.
// Este arquivo só monta URLs e decodifica respostas; quem faz a chamada de rede
// é o widget (Sources/ClaudeHub/Widgets/WeatherWidget.swift).

// MARK: - Cidades (geocodificação)

public struct GeoPlace: Codable, Equatable, Identifiable, Sendable {
    public var name: String
    public var admin1: String?
    public var country: String?
    public var latitude: Double
    public var longitude: Double

    public var id: String {
        return "\(name)|\(latitude)|\(longitude)"
    }

    public init(name: String, admin1: String? = nil, country: String? = nil, latitude: Double, longitude: Double) {
        self.name = name
        self.admin1 = admin1
        self.country = country
        self.latitude = latitude
        self.longitude = longitude
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.lenient(String.self, .name) ?? ""
        admin1 = c.lenient(String.self, .admin1)
        country = c.lenient(String.self, .country)
        latitude = c.lenient(Double.self, .latitude) ?? 0
        longitude = c.lenient(Double.self, .longitude) ?? 0
    }

    /// "São Paulo, São Paulo, Brasil" (sem repetir partes iguais ou vazias).
    public var displayName: String {
        var parts: [String] = []
        for part in [name, admin1 ?? "", country ?? ""] {
            let trimmed = part.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty, !parts.contains(trimmed) {
                parts.append(trimmed)
            }
        }
        return parts.joined(separator: ", ")
    }
}

/// Resposta de /v1/search. Sem resultados, o Open-Meteo omite o campo `results`.
public struct GeocodingResponse: Decodable, Equatable, Sendable {
    public var results: [GeoPlace]

    private enum CodingKeys: String, CodingKey {
        case results
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let all = c.lenient([GeoPlace].self, .results) ?? []
        results = all.filter { !$0.name.isEmpty }
    }
}

// MARK: - Previsão

public struct WeatherCurrent: Equatable, Sendable {
    public var temperature: Double
    public var apparentTemperature: Double?
    public var humidity: Double?
    public var weatherCode: Int
    public var windSpeed: Double?
}

public struct WeatherDay: Equatable, Identifiable, Sendable {
    /// Data local no formato "2026-11-20".
    public var date: String
    public var weatherCode: Int
    public var maxTemperature: Double?
    public var minTemperature: Double?
    public var precipitationProbability: Double?

    public var id: String {
        return date
    }
}

public struct WeatherForecast: Decodable, Equatable, Sendable {
    public var current: WeatherCurrent
    /// Hoje e os dias seguintes, na ordem em que vieram.
    public var days: [WeatherDay]

    /// Os dias depois de hoje (o primeiro item de `days` é hoje).
    public var followingDays: [WeatherDay] {
        return Array(days.dropFirst())
    }

    private enum CodingKeys: String, CodingKey {
        case current, daily
    }

    private enum CurrentKeys: String, CodingKey {
        case temperature = "temperature_2m"
        case apparent = "apparent_temperature"
        case humidity = "relative_humidity_2m"
        case weatherCode = "weather_code"
        case wind = "wind_speed_10m"
    }

    private enum DailyKeys: String, CodingKey {
        case time
        case weatherCode = "weather_code"
        case maxTemperature = "temperature_2m_max"
        case minTemperature = "temperature_2m_min"
        case precipitation = "precipitation_probability_max"
    }

    public init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: CodingKeys.self)

        // Sem a temperatura atual não há o que mostrar: aí sim é erro.
        let now = try root.nestedContainer(keyedBy: CurrentKeys.self, forKey: .current)
        let temperature = try now.decode(Double.self, forKey: .temperature)
        current = WeatherCurrent(
            temperature: temperature,
            apparentTemperature: now.lenient(Double.self, .apparent),
            humidity: now.lenient(Double.self, .humidity),
            weatherCode: Int((now.lenient(Double.self, .weatherCode) ?? 0).rounded()),
            windSpeed: now.lenient(Double.self, .wind)
        )

        var parsed: [WeatherDay] = []
        if let daily = try? root.nestedContainer(keyedBy: DailyKeys.self, forKey: .daily) {
            let dates = daily.lenient([String].self, .time) ?? []
            let codes = daily.lenient([Double?].self, .weatherCode) ?? []
            let maximums = daily.lenient([Double?].self, .maxTemperature) ?? []
            let minimums = daily.lenient([Double?].self, .minTemperature) ?? []
            let rain = daily.lenient([Double?].self, .precipitation) ?? []
            for (index, date) in dates.enumerated() {
                let code = WeatherForecast.value(codes, index)
                parsed.append(WeatherDay(
                    date: date,
                    weatherCode: Int((code ?? 0).rounded()),
                    maxTemperature: WeatherForecast.value(maximums, index),
                    minTemperature: WeatherForecast.value(minimums, index),
                    precipitationProbability: WeatherForecast.value(rain, index)
                ))
            }
        }
        days = parsed
    }

    private static func value(_ list: [Double?], _ index: Int) -> Double? {
        guard index >= 0, index < list.count else { return nil }
        return list[index]
    }
}

// MARK: - URLs

public enum WeatherAPI {
    /// Busca de cidades por nome (até 5 resultados, nomes em português).
    public static func geocodingURL(query: String) -> URL? {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = "geocoding-api.open-meteo.com"
        components.path = "/v1/search"
        components.queryItems = [
            URLQueryItem(name: "name", value: trimmed),
            URLQueryItem(name: "count", value: "5"),
            URLQueryItem(name: "language", value: "pt"),
            URLQueryItem(name: "format", value: "json"),
        ]
        return components.url
    }

    /// Tempo de agora e os próximos dias para uma coordenada.
    public static func forecastURL(latitude: Double, longitude: Double, fahrenheit: Bool = false) -> URL? {
        guard (-90...90).contains(latitude), (-180...180).contains(longitude) else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = "api.open-meteo.com"
        components.path = "/v1/forecast"
        var items = [
            URLQueryItem(name: "latitude", value: coordinate(latitude)),
            URLQueryItem(name: "longitude", value: coordinate(longitude)),
            URLQueryItem(name: "current", value: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m"),
            URLQueryItem(name: "daily", value: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"),
            URLQueryItem(name: "timezone", value: "auto"),
            URLQueryItem(name: "forecast_days", value: "4"),
        ]
        if fahrenheit {
            items.append(URLQueryItem(name: "temperature_unit", value: "fahrenheit"))
        }
        components.queryItems = items
        return components.url
    }

    /// Coordenada com ponto decimal, independente do locale da máquina.
    static func coordinate(_ value: Double) -> String {
        return String(format: "%.4f", value)
    }
}

// MARK: - Códigos de tempo (WMO)

public struct WeatherCondition: Equatable, Sendable {
    /// Descrição em português.
    public var text: String
    /// Nome do SF Symbol.
    public var symbol: String
}

public enum WeatherCode {
    /// Tabela de códigos WMO usada pelo Open-Meteo.
    public static func describe(_ code: Int) -> WeatherCondition {
        switch code {
        case 0: return WeatherCondition(text: "Céu limpo", symbol: "sun.max.fill")
        case 1: return WeatherCondition(text: "Poucas nuvens", symbol: "sun.max.fill")
        case 2: return WeatherCondition(text: "Parcialmente nublado", symbol: "cloud.sun.fill")
        case 3: return WeatherCondition(text: "Nublado", symbol: "cloud.fill")
        case 45, 48: return WeatherCondition(text: "Neblina", symbol: "cloud.fog.fill")
        case 51, 53, 55: return WeatherCondition(text: "Garoa", symbol: "cloud.drizzle.fill")
        case 56, 57: return WeatherCondition(text: "Garoa congelante", symbol: "cloud.sleet.fill")
        case 61: return WeatherCondition(text: "Chuva fraca", symbol: "cloud.rain.fill")
        case 63: return WeatherCondition(text: "Chuva", symbol: "cloud.rain.fill")
        case 65: return WeatherCondition(text: "Chuva forte", symbol: "cloud.heavyrain.fill")
        case 66, 67: return WeatherCondition(text: "Chuva congelante", symbol: "cloud.sleet.fill")
        case 71, 73, 75: return WeatherCondition(text: "Neve", symbol: "cloud.snow.fill")
        case 77: return WeatherCondition(text: "Grãos de neve", symbol: "cloud.snow.fill")
        case 80, 81: return WeatherCondition(text: "Pancadas de chuva", symbol: "cloud.sun.rain.fill")
        case 82: return WeatherCondition(text: "Pancadas fortes", symbol: "cloud.heavyrain.fill")
        case 85, 86: return WeatherCondition(text: "Pancadas de neve", symbol: "cloud.snow.fill")
        case 95: return WeatherCondition(text: "Trovoadas", symbol: "cloud.bolt.rain.fill")
        case 96, 99: return WeatherCondition(text: "Trovoadas com granizo", symbol: "cloud.bolt.rain.fill")
        default: return WeatherCondition(text: "Tempo indefinido", symbol: "cloud.fill")
        }
    }
}

// MARK: - Formatação

public enum WeatherFormat {
    /// "22°" — temperatura arredondada, sem "-0".
    public static func degrees(_ value: Double) -> String {
        let rounded = Int(value.rounded())
        return "\(rounded)°"
    }

    private static let weekdays = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"]

    /// "sex" para "2026-11-20". Devolve a própria data se ela não puder ser lida.
    public static func weekday(_ isoDate: String) -> String {
        let parts = isoDate.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return isoDate }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = 12
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? calendar.timeZone
        guard let date = calendar.date(from: components) else { return isoDate }
        let index = calendar.component(.weekday, from: date) - 1
        guard index >= 0, index < weekdays.count else { return isoDate }
        return weekdays[index]
    }
}

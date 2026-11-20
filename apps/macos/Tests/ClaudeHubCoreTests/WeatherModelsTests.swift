import XCTest
@testable import ClaudeHubCore

final class WeatherModelsTests: XCTestCase {
    // MARK: - Geocodificação

    func testGeocodingResults() throws {
        let response = try JSONDecoder().decode(GeocodingResponse.self, from: Data("""
        {"results": [
          {"id": 3448439, "name": "São Paulo", "latitude": -23.5475, "longitude": -46.63611, "country": "Brasil", "admin1": "São Paulo", "timezone": "America/Sao_Paulo"},
          {"name": "Lisboa", "latitude": 38.71667, "longitude": -9.13333, "country": "Portugal"},
          {"latitude": 1, "longitude": 2}
        ], "generationtime_ms": 0.5}
        """.utf8))
        // O item sem nome é descartado.
        XCTAssertEqual(response.results.count, 2)
        XCTAssertEqual(response.results[0].name, "São Paulo")
        XCTAssertEqual(response.results[0].latitude, -23.5475, accuracy: 0.0001)
        // Nome igual à região não se repete.
        XCTAssertEqual(response.results[0].displayName, "São Paulo, Brasil")
        XCTAssertEqual(response.results[1].displayName, "Lisboa, Portugal")
        XCTAssertNil(response.results[1].admin1)
    }

    func testGeocodingWithoutResultsField() throws {
        let response = try JSONDecoder().decode(GeocodingResponse.self, from: Data("{\"generationtime_ms\": 0.3}".utf8))
        XCTAssertTrue(response.results.isEmpty)
    }

    // MARK: - Previsão

    func testForecastDecoding() throws {
        let forecast = try JSONDecoder().decode(WeatherForecast.self, from: Data("""
        {
          "latitude": -23.5, "longitude": -46.6, "timezone": "America/Sao_Paulo",
          "current_units": {"temperature_2m": "°C"},
          "current": {"time": "2026-11-20T10:00", "interval": 900, "temperature_2m": 22.4, "apparent_temperature": 23.1,
                      "relative_humidity_2m": 61, "weather_code": 3, "wind_speed_10m": 8.2},
          "daily": {
            "time": ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"],
            "weather_code": [3, 61, 95, 0],
            "temperature_2m_max": [26.1, 24.0, null, 28.3],
            "temperature_2m_min": [17.2, 16.5, 15.9, 18.0],
            "precipitation_probability_max": [10, 80, 95]
          }
        }
        """.utf8))
        XCTAssertEqual(forecast.current.temperature, 22.4)
        XCTAssertEqual(forecast.current.apparentTemperature, 23.1)
        XCTAssertEqual(forecast.current.humidity, 61)
        XCTAssertEqual(forecast.current.weatherCode, 3)
        XCTAssertEqual(forecast.current.windSpeed, 8.2)

        XCTAssertEqual(forecast.days.count, 4)
        XCTAssertEqual(forecast.followingDays.count, 3)
        XCTAssertEqual(forecast.followingDays[0].date, "2026-11-21")
        XCTAssertEqual(forecast.followingDays[0].weatherCode, 61)
        XCTAssertEqual(forecast.followingDays[0].precipitationProbability, 80)
        // null no meio da série e série mais curta viram nil, sem derrubar o resto.
        XCTAssertNil(forecast.days[2].maxTemperature)
        XCTAssertEqual(forecast.days[2].minTemperature, 15.9)
        XCTAssertNil(forecast.days[3].precipitationProbability)
        XCTAssertEqual(forecast.days[3].maxTemperature, 28.3)
    }

    func testForecastWithOnlyCurrent() throws {
        let forecast = try JSONDecoder().decode(WeatherForecast.self, from: Data("""
        {"current": {"temperature_2m": -0.4}}
        """.utf8))
        XCTAssertEqual(forecast.current.temperature, -0.4)
        XCTAssertNil(forecast.current.apparentTemperature)
        XCTAssertEqual(forecast.current.weatherCode, 0)
        XCTAssertTrue(forecast.days.isEmpty)
        XCTAssertTrue(forecast.followingDays.isEmpty)
    }

    func testForecastWithoutCurrentTemperatureFails() {
        XCTAssertThrowsError(try JSONDecoder().decode(WeatherForecast.self, from: Data("{\"daily\": {\"time\": []}}".utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(WeatherForecast.self, from: Data("{\"error\": true, \"reason\": \"x\"}".utf8)))
    }

    // MARK: - URLs

    func testGeocodingURL() throws {
        let url = try XCTUnwrap(WeatherAPI.geocodingURL(query: "  São Paulo "))
        let text = url.absoluteString
        XCTAssertTrue(text.hasPrefix("https://geocoding-api.open-meteo.com/v1/search?"))
        XCTAssertTrue(text.contains("count=5"))
        XCTAssertTrue(text.contains("language=pt"))
        XCTAssertTrue(text.contains("format=json"))
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first(where: { $0.name == "name" })?.value, "São Paulo")
        XCTAssertNil(WeatherAPI.geocodingURL(query: "   "))
    }

    func testForecastURL() throws {
        let url = try XCTUnwrap(WeatherAPI.forecastURL(latitude: -23.5475, longitude: -46.63611))
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? {
            return items.first(where: { $0.name == name })?.value
        }
        XCTAssertEqual(url.host, "api.open-meteo.com")
        XCTAssertEqual(url.path, "/v1/forecast")
        XCTAssertEqual(value("latitude"), "-23.5475")
        XCTAssertEqual(value("longitude"), "-46.6361")
        XCTAssertEqual(value("current"), "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m")
        XCTAssertEqual(value("daily"), "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max")
        XCTAssertEqual(value("timezone"), "auto")
        XCTAssertEqual(value("forecast_days"), "4")
        XCTAssertNil(value("temperature_unit"))

        let fahrenheit = try XCTUnwrap(WeatherAPI.forecastURL(latitude: 40.7, longitude: -74, fahrenheit: true))
        XCTAssertTrue(fahrenheit.absoluteString.contains("temperature_unit=fahrenheit"))

        XCTAssertNil(WeatherAPI.forecastURL(latitude: 123, longitude: 0))
        XCTAssertNil(WeatherAPI.forecastURL(latitude: 0, longitude: -200))
    }

    // MARK: - Códigos e formatação

    func testWeatherCodes() {
        XCTAssertEqual(WeatherCode.describe(0).text, "Céu limpo")
        XCTAssertEqual(WeatherCode.describe(0).symbol, "sun.max.fill")
        XCTAssertEqual(WeatherCode.describe(3).text, "Nublado")
        XCTAssertEqual(WeatherCode.describe(63).text, "Chuva")
        XCTAssertEqual(WeatherCode.describe(95).symbol, "cloud.bolt.rain.fill")
        // Código fora da tabela não quebra.
        XCTAssertEqual(WeatherCode.describe(1234).text, "Tempo indefinido")
        for code in [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99] {
            XCTAssertNotEqual(WeatherCode.describe(code).text, "Tempo indefinido", "código \(code)")
            XCTAssertFalse(WeatherCode.describe(code).symbol.isEmpty)
        }
    }

    func testFormatting() {
        XCTAssertEqual(WeatherFormat.degrees(22.4), "22°")
        XCTAssertEqual(WeatherFormat.degrees(22.5), "23°")
        XCTAssertEqual(WeatherFormat.degrees(-0.4), "0°")
        XCTAssertEqual(WeatherFormat.degrees(-3.6), "-4°")
        // 20/11/2026 é uma sexta-feira.
        XCTAssertEqual(WeatherFormat.weekday("2026-11-20"), "sex")
        XCTAssertEqual(WeatherFormat.weekday("2026-11-22"), "dom")
        XCTAssertEqual(WeatherFormat.weekday("data inválida"), "data inválida")
    }
}

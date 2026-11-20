import XCTest
@testable import ClaudeHubCore

final class SystemHealthTests: XCTestCase {
    // MARK: Limiares

    func testCPUBoundaries() {
        XCTAssertEqual(SystemHealth.cpu(usage: 0), .good)
        XCTAssertEqual(SystemHealth.cpu(usage: 0.599), .good)
        XCTAssertEqual(SystemHealth.cpu(usage: 0.60), .warning)
        XCTAssertEqual(SystemHealth.cpu(usage: 0.849), .warning)
        XCTAssertEqual(SystemHealth.cpu(usage: 0.85), .critical)
        XCTAssertEqual(SystemHealth.cpu(usage: 1), .critical)
    }

    func testMemoryBoundaries() {
        XCTAssertEqual(SystemHealth.memory(usedFraction: 0.10), .good)
        XCTAssertEqual(SystemHealth.memory(usedFraction: 0.699), .good)
        XCTAssertEqual(SystemHealth.memory(usedFraction: 0.70), .warning)
        XCTAssertEqual(SystemHealth.memory(usedFraction: 0.879), .warning)
        XCTAssertEqual(SystemHealth.memory(usedFraction: 0.88), .critical)
        XCTAssertEqual(SystemHealth.memory(usedFraction: 1), .critical)
    }

    func testDiskBoundariesUseFreeSpace() {
        XCTAssertEqual(SystemHealth.disk(freeFraction: 0.80), .good)
        XCTAssertEqual(SystemHealth.disk(freeFraction: 0.201), .good)
        XCTAssertEqual(SystemHealth.disk(freeFraction: 0.20), .warning)
        XCTAssertEqual(SystemHealth.disk(freeFraction: 0.101), .warning)
        XCTAssertEqual(SystemHealth.disk(freeFraction: 0.10), .critical)
        XCTAssertEqual(SystemHealth.disk(freeFraction: 0), .critical)
    }

    func testBatteryBoundaries() {
        XCTAssertEqual(SystemHealth.battery(percent: 100, pluggedIn: false), .good)
        XCTAssertEqual(SystemHealth.battery(percent: 31, pluggedIn: false), .good)
        XCTAssertEqual(SystemHealth.battery(percent: 30, pluggedIn: false), .warning)
        XCTAssertEqual(SystemHealth.battery(percent: 16, pluggedIn: false), .warning)
        XCTAssertEqual(SystemHealth.battery(percent: 15, pluggedIn: false), .critical)
        XCTAssertEqual(SystemHealth.battery(percent: 1, pluggedIn: false), .critical)
    }

    func testBatteryPluggedInOrAbsentIsAlwaysGood() {
        XCTAssertEqual(SystemHealth.battery(percent: 3, pluggedIn: true), .good)
        XCTAssertEqual(SystemHealth.battery(percent: nil, pluggedIn: false), .good)
        XCTAssertEqual(SystemHealth.battery(percent: nil, pluggedIn: true), .good)
    }

    func testThermalStates() {
        XCTAssertEqual(SystemHealth.thermal(state: 0), .good)
        XCTAssertEqual(SystemHealth.thermal(state: 1), .warning)
        XCTAssertEqual(SystemHealth.thermal(state: 2), .critical)
        XCTAssertEqual(SystemHealth.thermal(state: 3), .critical)
        XCTAssertEqual(SystemHealth.thermal(state: -1), .good)
        XCTAssertEqual(SystemHealth.thermalLabel(state: 0), "Normal")
        XCTAssertEqual(SystemHealth.thermalLabel(state: 1), "Morno")
        XCTAssertEqual(SystemHealth.thermalLabel(state: 2), "Quente")
        XCTAssertEqual(SystemHealth.thermalLabel(state: 3), "Crítico")
    }

    func testOverallTakesTheWorst() {
        XCTAssertEqual(SystemHealth.overall([]), .good)
        XCTAssertEqual(SystemHealth.overall([.good, .good]), .good)
        XCTAssertEqual(SystemHealth.overall([.good, .warning, .good]), .warning)
        XCTAssertEqual(SystemHealth.overall([.warning, .critical, .good]), .critical)
    }

    func testLevelsAreOrderedAndLabelled() {
        XCTAssertTrue(HealthLevel.good < HealthLevel.warning)
        XCTAssertTrue(HealthLevel.warning < HealthLevel.critical)
        XCTAssertEqual(HealthLevel.good.label, "Bom")
        XCTAssertEqual(HealthLevel.warning.label, "Atenção")
        XCTAssertEqual(HealthLevel.critical.label, "Crítico")
    }

    // MARK: Histórico

    func testHistoryKeepsOrderBeforeFilling() {
        var history = SampleHistory(capacity: 4)
        XCTAssertTrue(history.isEmpty)
        XCTAssertNil(history.last)
        history.append(1)
        history.append(2)
        XCTAssertEqual(history.values, [1, 2])
        XCTAssertEqual(history.count, 2)
        XCTAssertEqual(history.last, 2)
        XCTAssertEqual(history.capacity, 4)
    }

    func testHistoryWrapsAroundDroppingTheOldest() {
        var history = SampleHistory(capacity: 3)
        for value in [1.0, 2.0, 3.0] {
            history.append(value)
        }
        XCTAssertEqual(history.values, [1, 2, 3])
        history.append(4)
        XCTAssertEqual(history.values, [2, 3, 4])
        XCTAssertEqual(history.last, 4)
        history.append(5)
        history.append(6)
        history.append(7)
        XCTAssertEqual(history.values, [5, 6, 7])
        XCTAssertEqual(history.count, 3)
        XCTAssertEqual(history.last, 7)
        XCTAssertEqual(history.maximum, 7)
    }

    func testHistoryCapacityIsAtLeastOne() {
        var history = SampleHistory(capacity: 0)
        XCTAssertEqual(history.capacity, 1)
        history.append(9)
        history.append(8)
        XCTAssertEqual(history.values, [8])
    }

    // MARK: Formatação

    func testPercent() {
        XCTAssertEqual(SystemFormat.percent(fraction: 0.37), "37%")
        XCTAssertEqual(SystemFormat.percent(fraction: 0.375), "38%")
        XCTAssertEqual(SystemFormat.percent(fraction: 0), "0%")
        XCTAssertEqual(SystemFormat.percent(fraction: 1.4), "100%")
        XCTAssertEqual(SystemFormat.percent(fraction: -0.2), "0%")
        XCTAssertEqual(SystemFormat.percent(fraction: Double.nan), "0%")
    }

    func testBytesDecimalLikeFinder() {
        XCTAssertEqual(SystemFormat.bytes(12_400_000_000), "12,4 GB")
        XCTAssertEqual(SystemFormat.bytes(182_000_000_000), "182 GB")
        XCTAssertEqual(SystemFormat.bytes(245_107_195_904), "245 GB")
        XCTAssertEqual(SystemFormat.bytes(16_000_000_000), "16 GB")
        XCTAssertEqual(SystemFormat.bytes(512_000_000), "512 MB")
        XCTAssertEqual(SystemFormat.bytes(2_000_000_000_000), "2 TB")
        XCTAssertEqual(SystemFormat.bytes(0), "0 MB")
    }

    func testBytesBinaryForMemory() {
        let gibibyte = 1_073_741_824.0
        XCTAssertEqual(SystemFormat.bytes(16 * gibibyte, binary: true), "16 GB")
        XCTAssertEqual(SystemFormat.bytes(9.8 * gibibyte, binary: true), "9,8 GB")
        XCTAssertEqual(SystemFormat.bytes(6.25 * gibibyte, binary: true), "6,3 GB")
    }

    func testMinutes() {
        XCTAssertEqual(SystemFormat.minutes(45), "45min")
        XCTAssertEqual(SystemFormat.minutes(60), "1h")
        XCTAssertEqual(SystemFormat.minutes(200), "3h 20min")
        XCTAssertEqual(SystemFormat.minutes(125), "2h 05min")
        XCTAssertEqual(SystemFormat.minutes(-5), "0min")
    }
}

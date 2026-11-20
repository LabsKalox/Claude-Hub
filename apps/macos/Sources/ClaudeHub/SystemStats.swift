import Darwin
import Foundation
import IOKit
import IOKit.ps

/// Leituras baratas do sistema, todas por API pública. Nada aqui lê sensores
/// por caminhos privados (SMC, IOHID): a temperatura em graus não é exposta
/// pelo macOS em Apple Silicon, então o app mostra o estado térmico do sistema.
enum SystemProbe {
    struct CPUTicks {
        var user: Double
        var system: Double
        var idle: Double
        var nice: Double

        var total: Double {
            return user + system + idle + nice
        }
    }

    /// Bateria interna, conforme o IOKit informa.
    struct Battery: Equatable {
        var percent: Int
        var charging: Bool
        /// Ligado na tomada (carregando ou com carga completa).
        var onAC: Bool
        /// Minutos até descarregar; nil quando o sistema ainda está calculando.
        var minutesToEmpty: Int?
        /// Minutos até a carga completa; nil quando não se aplica.
        var minutesToFull: Int?
    }

    static func cpuTicks() -> CPUTicks? {
        var info = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.stride / MemoryLayout<integer_t>.stride)
        let capacity = Int(count)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: capacity) { rebound in
                host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, rebound, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return CPUTicks(
            user: Double(info.cpu_ticks.0),
            system: Double(info.cpu_ticks.1),
            idle: Double(info.cpu_ticks.2),
            nice: Double(info.cpu_ticks.3)
        )
    }

    /// Uso de CPU (0...1) entre duas leituras.
    static func cpuUsage(from previous: CPUTicks, to current: CPUTicks) -> Double? {
        let total = current.total - previous.total
        guard total > 0 else { return nil }
        let idle = current.idle - previous.idle
        return max(0, min(1, 1 - idle / total))
    }

    /// Memória em uso (ativa + fixa + comprimida), em bytes.
    static func memoryUsedBytes() -> Double? {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.stride / MemoryLayout<integer_t>.stride)
        let capacity = Int(count)
        let result = withUnsafeMutablePointer(to: &stats) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: capacity) { rebound in
                host_statistics64(mach_host_self(), HOST_VM_INFO64, rebound, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        var pageSize: vm_size_t = 0
        guard host_page_size(mach_host_self(), &pageSize) == KERN_SUCCESS else { return nil }
        let pages = Double(stats.active_count) + Double(stats.wire_count) + Double(stats.compressor_page_count)
        return pages * Double(pageSize)
    }

    static func memoryTotalBytes() -> Double {
        return Double(ProcessInfo.processInfo.physicalMemory)
    }

    /// Capacidade total e espaço disponível do volume de inicialização, em bytes.
    ///
    /// "/" é o volume de sistema (somente leitura); em algumas versões do macOS
    /// ele informa zero de espaço "para uso importante". Nesse caso a leitura é
    /// refeita na pasta pessoal, que fica no volume de dados do mesmo disco.
    static func disk() -> (total: Double, available: Double)? {
        let keys: Set<URLResourceKey> = [
            .volumeTotalCapacityKey,
            .volumeAvailableCapacityForImportantUsageKey,
            .volumeAvailableCapacityKey,
        ]
        let candidates = [URL(fileURLWithPath: "/"), URL(fileURLWithPath: NSHomeDirectory())]
        var fallback: (total: Double, available: Double)?
        for url in candidates {
            guard let values = try? url.resourceValues(forKeys: keys),
                  let total = values.volumeTotalCapacity, total > 0 else {
                continue
            }
            if let important = values.volumeAvailableCapacityForImportantUsage, important > 0 {
                return (Double(total), Double(important))
            }
            if fallback == nil, let plain = values.volumeAvailableCapacity, plain > 0 {
                fallback = (Double(total), Double(plain))
            }
        }
        return fallback
    }

    /// Bateria interna; nil em Macs sem bateria.
    static func battery() -> Battery? {
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(snapshot)?.takeRetainedValue() else {
            return nil
        }
        let sources = list as NSArray
        for item in sources {
            let source = item as AnyObject
            guard let unmanaged = IOPSGetPowerSourceDescription(snapshot, source) else { continue }
            let description = unmanaged.takeUnretainedValue() as NSDictionary
            guard let current = description[kIOPSCurrentCapacityKey] as? Int,
                  let maximum = description[kIOPSMaxCapacityKey] as? Int,
                  maximum > 0 else {
                continue
            }
            let state = description[kIOPSPowerSourceStateKey] as? String
            let onAC = state == kIOPSACPowerValue
            let charging = (description[kIOPSIsChargingKey] as? Bool) ?? false
            let percent = Int((Double(current) / Double(maximum) * 100).rounded())
            // O IOKit usa -1 enquanto ainda está estimando.
            let toEmpty = description[kIOPSTimeToEmptyKey] as? Int
            let toFull = description[kIOPSTimeToFullChargeKey] as? Int
            return Battery(
                percent: max(0, min(100, percent)),
                charging: charging,
                onAC: onAC,
                minutesToEmpty: (toEmpty ?? -1) > 0 && !onAC ? toEmpty : nil,
                minutesToFull: (toFull ?? -1) > 0 && charging ? toFull : nil
            )
        }
        return nil
    }

    /// Ciclos de carga da bateria (registro público do IOKit); nil se o Mac não informar.
    static func batteryCycleCount() -> Int? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSmartBattery"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        let property = IORegistryEntryCreateCFProperty(service, "CycleCount" as CFString, kCFAllocatorDefault, 0)
        guard let value = property?.takeRetainedValue() else { return nil }
        return (value as? NSNumber)?.intValue
    }

    /// Estado térmico do sistema: 0 nominal, 1 morno, 2 quente, 3 crítico.
    static func thermalState() -> Int {
        return ProcessInfo.processInfo.thermalState.rawValue
    }
}

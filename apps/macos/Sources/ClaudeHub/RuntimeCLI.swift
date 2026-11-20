import Foundation
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

/// Onde está o runtime Node embutido no app.
struct RuntimeLocation {
    let directory: URL
    let node: URL
    let script: URL
}

enum RuntimeCLIError: Error {
    /// Build sem runtime (por exemplo, compilado direto no Xcode).
    case runtimeMissing
    case launchFailed(String)
    case timedOut(seconds: Int)
    case cancelled
    /// A CLI terminou sem imprimir o objeto JSON do contrato.
    case notJSON(status: Int32, output: String)

    var message: String {
        switch self {
        case .runtimeMissing:
            return "Runtime não embutido neste build."
        case .launchFailed(let reason):
            return "Não foi possível iniciar a CLI do Claude Hub: \(reason)"
        case .timedOut(let seconds):
            return "A CLI do Claude Hub não respondeu em \(seconds) s."
        case .cancelled:
            return "Operação cancelada."
        case .notJSON(let status, let output):
            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                return "A CLI do Claude Hub terminou com código \(status) e sem saída."
            }
            return "A CLI do Claude Hub terminou com código \(status): \(trimmed)"
        }
    }

    static func describe(_ error: Error) -> String {
        if let known = error as? RuntimeCLIError {
            return known.message
        }
        return error.localizedDescription
    }
}

/// Executa a CLI embutida (`runtime/bin/node runtime/claude-hub.mjs … --json`).
///
/// Toda a lógica de instalação vive na CLI; aqui só há o transporte: localizar
/// o runtime, rodar o processo fora da thread principal e decodificar o JSON.
enum RuntimeCLI {
    /// Runtime em CLAUDE_HUB_RUNTIME_DIR, senão em Contents/Resources/runtime.
    /// nil quando a pasta, o Node ou a CLI não existem (build de desenvolvimento).
    static func locate(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main
    ) -> RuntimeLocation? {
        let directory: URL
        if let custom = environment["CLAUDE_HUB_RUNTIME_DIR"], !custom.isEmpty {
            directory = URL(fileURLWithPath: custom, isDirectory: true)
        } else if let resources = bundle.resourceURL {
            directory = resources.appendingPathComponent("runtime", isDirectory: true)
        } else {
            return nil
        }
        let node = directory.appendingPathComponent("bin", isDirectory: true).appendingPathComponent("node", isDirectory: false)
        let script = directory.appendingPathComponent("claude-hub.mjs", isDirectory: false)
        let files = FileManager.default
        guard files.isExecutableFile(atPath: node.path), files.fileExists(atPath: script.path) else {
            return nil
        }
        return RuntimeLocation(directory: directory, node: node, script: script)
    }

    static var isAvailable: Bool {
        return locate() != nil
    }

    /// Roda um comando e decodifica o objeto JSON que ele imprime. O código de
    /// saída é ignorado quando há JSON: a CLI sai com 1 para `ok: false`, e o
    /// motivo vem no próprio objeto.
    static func run<T: Decodable>(_ type: T.Type, _ arguments: [String], timeout: TimeInterval = 60) async throws -> T {
        let output = try await execute(arguments, timeout: timeout)
        do {
            return try SetupJSON.decode(type, from: output.standardOutput)
        } catch {
            let errorText = String(data: output.standardError, encoding: .utf8) ?? ""
            let outputText = String(data: output.standardOutput, encoding: .utf8) ?? ""
            let text = errorText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? outputText : errorText
            throw RuntimeCLIError.notJSON(status: output.status, output: String(text.suffix(600)))
        }
    }

    // MARK: - Processo

    private struct Output {
        let standardOutput: Data
        let standardError: Data
        let status: Int32
    }

    /// Estado compartilhado entre a thread que espera o processo, os leitores
    /// de saída, o temporizador e o cancelamento da Task.
    private final class Runner: @unchecked Sendable {
        let process = Process()
        private let lock = NSLock()
        private var cancelledFlag = false
        private var timedOutFlag = false
        private var stdoutData = Data()
        private var stderrData = Data()
        private var stdoutClosed = false
        private var stderrClosed = false

        var cancelled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return cancelledFlag
        }

        var timedOut: Bool {
            lock.lock()
            defer { lock.unlock() }
            return timedOutFlag
        }

        var collectedOutput: Data {
            lock.lock()
            defer { lock.unlock() }
            return stdoutData
        }

        var collectedError: Data {
            lock.lock()
            defer { lock.unlock() }
            return stderrData
        }

        /// Os dois canais chegaram ao fim.
        var drained: Bool {
            lock.lock()
            defer { lock.unlock() }
            return stdoutClosed && stderrClosed
        }

        func appendStdout(_ chunk: Data) {
            lock.lock()
            stdoutData.append(chunk)
            lock.unlock()
        }

        func appendStderr(_ chunk: Data) {
            lock.lock()
            stderrData.append(chunk)
            lock.unlock()
        }

        func closeStdout() {
            lock.lock()
            stdoutClosed = true
            lock.unlock()
        }

        func closeStderr() {
            lock.lock()
            stderrClosed = true
            lock.unlock()
        }

        func cancel() {
            lock.lock()
            cancelledFlag = true
            lock.unlock()
            stop()
        }

        func expire() {
            lock.lock()
            timedOutFlag = true
            lock.unlock()
            stop()
        }

        private func stop() {
            if process.isRunning {
                process.terminate()
            }
        }
    }

    private static func execute(_ arguments: [String], timeout: TimeInterval) async throws -> Output {
        guard let location = locate() else {
            throw RuntimeCLIError.runtimeMissing
        }
        let appPath = Bundle.main.bundlePath
        let runner = Runner()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Output, Error>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        let output = try runBlocking(
                            runner: runner,
                            location: location,
                            arguments: arguments,
                            appPath: appPath,
                            timeout: timeout
                        )
                        continuation.resume(returning: output)
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        } onCancel: {
            runner.cancel()
        }
    }

    /// Bloqueia a thread atual (nunca a principal) até a CLI terminar.
    private static func runBlocking(
        runner: Runner,
        location: RuntimeLocation,
        arguments: [String],
        appPath: String,
        timeout: TimeInterval
    ) throws -> Output {
        if runner.cancelled {
            throw RuntimeCLIError.cancelled
        }
        let process = runner.process
        process.executableURL = location.node
        process.arguments = [location.script.path] + arguments + ["--json"]
        process.currentDirectoryURL = location.directory

        // Herda o ambiente (CLAUDE_HUB_HOME, portas…) e acrescenta o necessário.
        var environment = ProcessInfo.processInfo.environment
        environment["NODE_NO_WARNINGS"] = "1"
        environment["CLAUDE_HUB_APP_PATH"] = appPath
        process.environment = environment

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.standardInput = FileHandle.nullDevice

        // A saída é lida conforme chega, nos dois canais: se um encher sem ser
        // lido, a CLI trava. Ler por callback (e não até o fim do arquivo) evita
        // ficar preso quando um processo filho da CLI herda o pipe e continua vivo
        // — por exemplo, o hub recém-iniciado.
        let stdoutHandle = stdoutPipe.fileHandleForReading
        let stderrHandle = stderrPipe.fileHandleForReading
        stdoutHandle.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                runner.closeStdout()
            } else {
                runner.appendStdout(chunk)
            }
        }
        stderrHandle.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                runner.closeStderr()
            } else {
                runner.appendStderr(chunk)
            }
        }

        do {
            try process.run()
        } catch {
            stdoutHandle.readabilityHandler = nil
            stderrHandle.readabilityHandler = nil
            throw RuntimeCLIError.launchFailed(error.localizedDescription)
        }

        let deadline = DispatchWorkItem {
            runner.expire()
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: deadline)

        process.waitUntilExit()
        deadline.cancel()

        // O que a CLI escreveu antes de sair já está no pipe; espera um instante
        // os leitores esvaziarem, sem depender do fechamento do canal.
        var waited = 0
        while !runner.drained && waited < 60 {
            Thread.sleep(forTimeInterval: 0.01)
            waited += 1
        }
        stdoutHandle.readabilityHandler = nil
        stderrHandle.readabilityHandler = nil

        if runner.cancelled {
            throw RuntimeCLIError.cancelled
        }
        if runner.timedOut {
            throw RuntimeCLIError.timedOut(seconds: Int(timeout))
        }
        return Output(standardOutput: runner.collectedOutput, standardError: runner.collectedError, status: process.terminationStatus)
    }
}

import AppKit
import SwiftUI

// Música em reprodução, só com APIs públicas:
//  - LEITURA: os avisos que o Música e o Spotify publicam no
//    DistributedNotificationCenter a cada troca de faixa ou de estado. Não pede
//    permissão nenhuma e não usa frameworks privados.
//  - CONTROLE: AppleScript ("tell application … to playpause"), enviado apenas
//    quando você clica num botão. É aí que o macOS pede a permissão de Automação.
// Limite conhecido: só aparece o que tocou DEPOIS de o Claude Hub abrir (os
// players não informam a faixa atual a quem chega depois, e perguntar exigiria
// um Apple Event sem clique seu).

/// De qual aplicativo veio a faixa.
enum MusicSource: String {
    case music
    case spotify

    /// Nome mostrado na tela.
    var displayName: String {
        switch self {
        case .music: return "Música"
        case .spotify: return "Spotify"
        }
    }

    /// Nome usado no AppleScript.
    var scriptName: String {
        switch self {
        case .music: return "Music"
        case .spotify: return "Spotify"
        }
    }

    var bundleID: String {
        switch self {
        case .music: return "com.apple.Music"
        case .spotify: return "com.spotify.client"
        }
    }

    var notificationName: String {
        switch self {
        case .music: return "com.apple.Music.playerInfo"
        case .spotify: return "com.spotify.client.PlaybackStateChanged"
        }
    }
}

enum MusicCommand {
    case previous
    case playPause
    case next

    var script: String {
        switch self {
        case .previous: return "previous track"
        case .playPause: return "playpause"
        case .next: return "next track"
        }
    }
}

struct NowPlayingTrack: Equatable {
    var title: String
    var artist: String
    var album: String
    var source: MusicSource
    var playing: Bool
}

@MainActor
final class NowPlayingModel: ObservableObject {
    @Published private(set) var track: NowPlayingTrack?
    @Published private(set) var controlError: String?
    @Published private(set) var sending = false

    private var playerObservers: [NSObjectProtocol] = []
    private var workspaceObserver: NSObjectProtocol?

    // MARK: - Escuta

    func startListening() {
        guard playerObservers.isEmpty else { return }
        let center = DistributedNotificationCenter.default()
        for source in [MusicSource.music, MusicSource.spotify] {
            let token = center.addObserver(
                forName: Notification.Name(source.notificationName),
                object: nil,
                queue: OperationQueue.main
            ) { [weak self] note in
                // Só textos saem do aviso; nada mais atravessa para a MainActor.
                let info = note.userInfo
                let state = info?["Player State"] as? String
                let name = info?["Name"] as? String
                let artist = info?["Artist"] as? String
                let album = info?["Album"] as? String
                Task { @MainActor [weak self] in
                    self?.received(source: source, state: state, name: name, artist: artist, album: album)
                }
            }
            playerObservers.append(token)
        }

        // Player fechado: a faixa dele deixa de valer.
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification,
            object: nil,
            queue: OperationQueue.main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let bundleID = app?.bundleIdentifier
            Task { @MainActor [weak self] in
                self?.applicationQuit(bundleID: bundleID)
            }
        }
    }

    func stopListening() {
        let center = DistributedNotificationCenter.default()
        for token in playerObservers {
            center.removeObserver(token)
        }
        playerObservers = []
        if let token = workspaceObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(token)
            workspaceObserver = nil
        }
        track = nil
        controlError = nil
    }

    private func received(source: MusicSource, state: String?, name: String?, artist: String?, album: String?) {
        let playing = state == "Playing"
        let title = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        if state == "Stopped" || title.isEmpty {
            if track?.source == source {
                track = nil
            }
            return
        }
        // Um player pausado não toma o lugar do outro que está tocando.
        if !playing, let current = track, current.source != source, current.playing {
            return
        }
        track = NowPlayingTrack(
            title: title,
            artist: (artist ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
            album: (album ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
            source: source,
            playing: playing
        )
        controlError = nil
    }

    private func applicationQuit(bundleID: String?) {
        guard let current = track, current.source.bundleID == bundleID else { return }
        track = nil
    }

    // MARK: - Controle

    /// Envia o comando ao player que informou a faixa — nunca a outro, e só se
    /// ele estiver aberto (um Apple Event para um app fechado o abriria).
    func send(_ command: MusicCommand) {
        guard !sending, let current = track else { return }
        let source = current.source
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: source.bundleID).isEmpty else {
            track = nil
            return
        }
        sending = true
        controlError = nil
        let text = "tell application \"\(source.scriptName)\" to \(command.script)"
        let appName = source.displayName
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            // O script é criado e executado na mesma thread, fora da principal:
            // o primeiro envio pode ficar esperando o aviso de permissão do macOS.
            var errorInfo: NSDictionary?
            var failure: String?
            if let script = NSAppleScript(source: text) {
                _ = script.executeAndReturnError(&errorInfo)
                if let info = errorInfo {
                    let number = (info[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? 0
                    failure = NowPlayingModel.describeFailure(number: number, appName: appName)
                }
            } else {
                failure = "Não foi possível montar o comando para o \(appName)."
            }
            let message = failure
            Task { @MainActor [weak self] in
                self?.finished(message)
            }
        }
    }

    private func finished(_ failure: String?) {
        sending = false
        controlError = failure
    }

    /// -1743 = errAEEventNotPermitted (Automação negada); -1744 = o macOS precisaria
    /// perguntar e não pôde.
    nonisolated static func describeFailure(number: Int, appName: String) -> String {
        if number == -1743 || number == -1744 {
            return "O macOS não permitiu controlar \(appName). Autorize em Ajustes do Sistema → Privacidade e Segurança → Automação."
        }
        return "O \(appName) não respondeu ao comando."
    }
}

// MARK: - Widget

@MainActor
final class MusicWidget: HubWidget {
    let id = "music"
    let title = "Música"
    let symbol = "music.note"

    private let model: NowPlayingModel

    init() {
        model = NowPlayingModel()
    }

    func makeView() -> AnyView {
        return AnyView(MusicWidgetView(model: model))
    }

    /// A escuta fica ligada enquanto o widget estiver ligado, mesmo fora da tela:
    /// os avisos só chegam no momento da troca de faixa.
    func enabledChanged(_ enabled: Bool) {
        if enabled {
            model.startListening()
        } else {
            model.stopListening()
        }
    }
}

@MainActor
struct MusicWidgetView: View {
    @ObservedObject var model: NowPlayingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let track = model.track {
                trackInfo(track)
                controls(track)
            } else {
                WidgetCaption("Nada tocando no Música ou no Spotify", color: Theme.textDim)
            }
            if let error = model.controlError {
                WidgetCaption(error, color: Theme.orange)
            }
        }
    }

    private func trackInfo(_ track: NowPlayingTrack) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(track.title)
                .font(Theme.font(13, .semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .truncationMode(.tail)
            Text(track.artist.isEmpty ? "Artista não informado" : track.artist)
                .font(Theme.font(11, .medium))
                .foregroundStyle(Theme.textDim)
                .lineLimit(1)
            if !track.album.isEmpty {
                Text(track.album)
                    .font(Theme.font(10))
                    .foregroundStyle(Theme.textFaint)
                    .lineLimit(1)
            }
            HStack(spacing: 5) {
                StatusDot(color: track.playing ? Theme.green : Theme.grey, size: 6)
                Text("\(track.source.displayName) · \(track.playing ? "tocando" : "pausado")")
                    .font(Theme.font(10))
                    .foregroundStyle(Theme.textFaint)
            }
            .padding(.top, 2)
        }
    }

    private func controls(_ track: NowPlayingTrack) -> some View {
        HStack(spacing: 6) {
            controlButton("backward.fill", help: "Faixa anterior", command: .previous)
            controlButton(track.playing ? "pause.fill" : "play.fill", help: track.playing ? "Pausar" : "Tocar", command: .playPause)
            controlButton("forward.fill", help: "Próxima faixa", command: .next)
            Spacer(minLength: 0)
        }
        .disabled(model.sending)
        .opacity(model.sending ? 0.6 : 1)
    }

    private func controlButton(_ symbol: String, help: String, command: MusicCommand) -> some View {
        Button {
            model.send(command)
        } label: {
            Image(systemName: symbol)
                .font(Theme.font(11, .semibold))
                .foregroundStyle(Color.white)
                .frame(width: 34, height: 26)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.field))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

enum QRCode {
    /// QR code gerado localmente com CoreImage (nada sai do Mac).
    static func image(for text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let representation = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: representation.size)
        image.addRepresentation(representation)
        return image
    }
}

/// Pareamento do iPhone: código de uso único, QR do link quando o hub tem a
/// URL https, e a contagem até o código expirar.
@MainActor
struct PairingView: View {
    @EnvironmentObject private var store: HubStore

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            qrArea
                .frame(width: 190, height: 190)
            VStack(alignment: .leading, spacing: 8) {
                Text("Parear iPhone")
                    .font(Theme.font(16, .bold))
                    .foregroundStyle(Color.white)
                details
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    Button("Novo código") {
                        store.requestPairingCode()
                    }
                    .buttonStyle(PillButtonStyle(background: Theme.buttonNeutral, fontSize: 11, horizontalPadding: 12, verticalPadding: 5))
                    Button("Fechar") {
                        store.closePairing()
                    }
                    .buttonStyle(PillButtonStyle(background: Theme.blue, fontSize: 11, horizontalPadding: 12, verticalPadding: 5))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private var qrArea: some View {
        if let link = store.pairing?.url, let image = QRCode.image(for: link) {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white))
        } else {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Theme.card)
                .overlay(
                    Image(systemName: "qrcode")
                        .font(Theme.font(44))
                        .foregroundStyle(Theme.textFaint)
                )
        }
    }

    @ViewBuilder
    private var details: some View {
        if let pairing = store.pairing {
            Text("Código de uso único")
                .font(Theme.font(10.5))
                .foregroundStyle(Theme.textDim)
            Text(pairing.code)
                .font(Font.system(size: 26, weight: .bold, design: .monospaced))
                .foregroundStyle(Color.white)
                .textSelection(.enabled)
            Ticking(every: 1) { now in
                Text(PairingView.expiryText(expiresAt: pairing.expiresAt, now: now + store.state.clockSkew))
                    .font(Theme.font(10.5, .medium))
                    .foregroundStyle(Theme.textFaint)
                    .monospacedDigit()
            }
            if let link = pairing.url {
                Text("Aponte a câmera do iPhone para o QR, ou abra:")
                    .font(Theme.font(11))
                    .foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                Text(link)
                    .font(Theme.mono(10.5))
                    .foregroundStyle(Theme.link)
                    .lineLimit(2)
                    .textSelection(.enabled)
            } else {
                Text("O hub ainda não sabe a URL https do iPhone, então não há QR. Defina-a no Terminal e gere um novo código:")
                    .font(Theme.font(11))
                    .foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                Text("pnpm hub set-url https://…")
                    .font(Theme.mono(11))
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.field))
                    .textSelection(.enabled)
                Text("Enquanto isso, abra a PWA no iPhone e digite o código acima.")
                    .font(Theme.font(11))
                    .foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else if let error = store.pairingError {
            Text(error)
                .font(Theme.font(11.5, .medium))
                .foregroundStyle(Theme.red)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text("Gerando código…")
                .font(Theme.font(11.5))
                .foregroundStyle(Theme.textDim)
        }
    }

    static func expiryText(expiresAt: Double, now: Double) -> String {
        let seconds = Int(max(0, ((expiresAt - now) / 1000).rounded(.up)))
        if seconds == 0 { return "Código expirado — gere um novo." }
        let rest = seconds % 60
        return "Expira em \(seconds / 60):\(rest < 10 ? "0" : "")\(rest)"
    }
}

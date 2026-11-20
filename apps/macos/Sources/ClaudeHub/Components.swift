import AppKit
import QuartzCore
import SwiftUI
#if canImport(ClaudeHubCore)
import ClaudeHubCore
#endif

// MARK: - Ícone (estrela de 8 raios, desenhada em código)

/// Quatro traços arredondados cruzados no centro: uma estrela de oito raios.
/// Símbolo próprio do projeto (não usa marcas de terceiros).
struct StarburstShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let side = min(rect.width, rect.height)
        let thickness = side * 0.17
        let ray = CGRect(x: -side / 2, y: -thickness / 2, width: side, height: thickness)
        for index in 0..<4 {
            let angle = CGFloat(index) * CGFloat.pi / 4
            let transform = CGAffineTransform(translationX: rect.midX, y: rect.midY).rotated(by: angle)
            path.addPath(Path(roundedRect: ray, cornerRadius: thickness / 2), transform: transform)
        }
        return path
    }
}

struct StarburstIcon: View {
    var color: Color = Theme.starburst
    var size: CGFloat = 13

    var body: some View {
        StarburstShape()
            .fill(color)
            .frame(width: size, height: size)
    }
}

/// Ícone do app: quadrado arredondado coral com a estrela branca.
struct AppBadge: View {
    var size: CGFloat = 20

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
            .fill(Theme.coral)
            .frame(width: size, height: size)
            .overlay(StarburstIcon(color: .white, size: size * 0.68))
    }
}

// MARK: - Indicadores

struct StatusDot: View {
    var color: Color
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
    }
}

/// Anel giratório. A rotação é uma CABasicAnimation: roda no servidor de
/// renderização e não consome CPU do app a cada quadro.
struct SpinnerRing: NSViewRepresentable {
    var color: NSColor = NSColor(srgbRed: 0.961, green: 0.647, blue: 0.141, alpha: 1)
    var lineWidth: CGFloat = 2

    func makeNSView(context: Context) -> SpinnerNSView {
        return SpinnerNSView(color: color, lineWidth: lineWidth)
    }

    func updateNSView(_ nsView: SpinnerNSView, context: Context) {}
}

final class SpinnerNSView: NSView {
    private let track = CAShapeLayer()
    private let ring = CAShapeLayer()
    private let lineWidth: CGFloat

    init(color: NSColor, lineWidth: CGFloat) {
        self.lineWidth = lineWidth
        super.init(frame: .zero)
        wantsLayer = true
        for shape in [track, ring] {
            shape.fillColor = nil
            shape.lineWidth = lineWidth
            shape.lineCap = .round
            layer?.addSublayer(shape)
        }
        track.strokeColor = NSColor.white.withAlphaComponent(0.16).cgColor
        ring.strokeColor = color.cgColor
        ring.strokeEnd = 0.7
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func layout() {
        super.layout()
        let inset = lineWidth / 2
        let circle = CGPath(ellipseIn: bounds.insetBy(dx: inset, dy: inset), transform: nil)
        track.frame = bounds
        ring.frame = bounds
        track.path = circle
        ring.path = circle
        startIfNeeded()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            ring.removeAnimation(forKey: "spin")
        } else {
            startIfNeeded()
        }
    }

    private func startIfNeeded() {
        guard window != nil, ring.animation(forKey: "spin") == nil else { return }
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.fromValue = 0
        spin.toValue = -2 * Double.pi
        spin.duration = 1
        spin.repeatCount = .infinity
        spin.isRemovedOnCompletion = false
        ring.add(spin, forKey: "spin")
    }
}

/// Anel de progresso mensurável (parado, começa no topo).
struct ProgressRing: View {
    var fraction: Double
    var size: CGFloat = 14

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.white.opacity(0.16), lineWidth: 2)
            Circle()
                .trim(from: 0, to: CGFloat(max(0.04, min(1, fraction))))
                .stroke(Theme.orange, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: size, height: size)
    }
}

/// Quatro pontos que acendem em sequência (duas atualizações por segundo).
struct AnimatedDots: View {
    private static let step: TimeInterval = 0.5

    var body: some View {
        TimelineView(.periodic(from: Date(), by: AnimatedDots.step)) { context in
            let phase = Int(context.date.timeIntervalSinceReferenceDate / AnimatedDots.step) % 4
            HStack(spacing: 3) {
                ForEach(0..<4, id: \.self) { index in
                    Circle()
                        .fill(Color.white.opacity(index <= phase ? 0.85 : 0.25))
                        .frame(width: 3, height: 3)
                }
            }
        }
    }
}

struct ProgressBar: View {
    var fraction: Double
    var color: Color = Theme.blue
    var height: CGFloat = 4

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.10))
                Capsule()
                    .fill(color)
                    .frame(width: max(height, proxy.size.width * CGFloat(max(0, min(1, fraction)))))
            }
        }
        .frame(height: height)
    }
}

// MARK: - Botões

/// Botão em pílula ("Negar", "Permitir", "Responder").
struct PillButtonStyle: ButtonStyle {
    var background: Color
    var foreground: Color = .white
    var fontSize: CGFloat = 12
    var horizontalPadding: CGFloat = 14
    var verticalPadding: CGFloat = 6

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.font(fontSize, .semibold))
            .foregroundStyle(foreground)
            .lineLimit(1)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .background(Capsule().fill(background))
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Capsule())
    }
}

/// Botão só com ícone, sem moldura.
struct IconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.font(12, .medium))
            .foregroundStyle(Theme.textDim)
            .frame(width: 26, height: 26)
            .background(Circle().fill(Color.white.opacity(configuration.isPressed ? 0.14 : 0.0)))
            .contentShape(Rectangle())
    }
}

/// Texto clicável ("Responder no Claude").
struct TextLinkButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.font(11.5, .semibold))
            .foregroundStyle(Theme.link)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(Rectangle())
    }
}

// MARK: - Relógio

/// Reavalia o conteúdo a cada `interval` segundos — só enquanto está na tela.
struct Ticking<Content: View>: View {
    let interval: TimeInterval
    let content: (Double) -> Content

    init(every interval: TimeInterval, @ViewBuilder content: @escaping (Double) -> Content) {
        self.interval = interval
        self.content = content
    }

    var body: some View {
        TimelineView(.periodic(from: Date(), by: interval)) { context in
            content(context.date.timeIntervalSince1970 * 1000)
        }
    }
}

// MARK: - Desempenho do Mac

/// Cartão azul-escuro dos indicadores: degradê suave e borda de 1 px.
struct NavyCardBackground: ViewModifier {
    var radius: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.cardGradient))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(Theme.navyBorder, lineWidth: 1))
    }
}

extension View {
    func navyCard(radius: CGFloat = 12) -> some View {
        return modifier(NavyCardBackground(radius: radius))
    }
}

/// Ponto do semáforo com o rótulo ("Bom", "Atenção", "Crítico").
struct HealthBadge: View {
    let level: HealthLevel
    var showLabel: Bool = true

    var body: some View {
        HStack(spacing: 4) {
            StatusDot(color: Theme.healthColor(level), size: 6)
            if showLabel {
                Text(level.label)
                    .font(Theme.font(9.5, .semibold))
                    .foregroundStyle(Theme.healthColor(level))
                    .lineLimit(1)
            }
        }
    }
}

/// Gráfico de linha com preenchimento suave. `values` vão de 0 a 1, do mais
/// antigo para o mais novo; o ponto mais recente fica encostado na direita e o
/// gráfico cresce para a esquerda até `capacity` pontos.
struct PerformanceSparkline: View {
    let values: [Double]
    var capacity: Int = 60
    var color: Color = Theme.blue

    var body: some View {
        GeometryReader { proxy in
            let points = PerformanceSparkline.points(values: values, capacity: capacity, size: proxy.size)
            ZStack {
                PerformanceSparkline.baseline(size: proxy.size)
                    .stroke(Color.white.opacity(0.08), style: StrokeStyle(lineWidth: 1, dash: [2, 3]))
                PerformanceSparkline.area(points: points, height: proxy.size.height)
                    .fill(LinearGradient(
                        colors: [color.opacity(0.38), color.opacity(0.03)],
                        startPoint: .top,
                        endPoint: .bottom
                    ))
                PerformanceSparkline.line(points: points)
                    .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            }
        }
    }

    static func points(values: [Double], capacity: Int, size: CGSize) -> [CGPoint] {
        guard !values.isEmpty, size.width > 0, size.height > 0 else { return [] }
        let slots = max(2, capacity)
        let step = size.width / CGFloat(slots - 1)
        let visible = Array(values.suffix(slots))
        let inset: CGFloat = 1.5
        let usable = max(1, size.height - inset * 2)
        var result: [CGPoint] = []
        for (index, value) in visible.enumerated() {
            let clamped = CGFloat(max(0, min(1, value)))
            let x = size.width - CGFloat(visible.count - 1 - index) * step
            let y = inset + (1 - clamped) * usable
            result.append(CGPoint(x: x, y: y))
        }
        return result
    }

    static func line(points: [CGPoint]) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        if points.count == 1 {
            path.addLine(to: CGPoint(x: first.x + 0.5, y: first.y))
        }
        for point in points.dropFirst() {
            path.addLine(to: point)
        }
        return path
    }

    static func area(points: [CGPoint], height: CGFloat) -> Path {
        var path = Path()
        guard let first = points.first, let last = points.last, points.count > 1 else { return path }
        path.move(to: CGPoint(x: first.x, y: height))
        for point in points {
            path.addLine(to: point)
        }
        path.addLine(to: CGPoint(x: last.x, y: height))
        path.closeSubpath()
        return path
    }

    /// Linha de referência dos 50%.
    static func baseline(size: CGSize) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: size.height / 2))
        path.addLine(to: CGPoint(x: size.width, y: size.height / 2))
        return path
    }
}

// swift-tools-version:5.9
import PackageDescription

// Dois módulos no SwiftPM:
//  - ClaudeHubCore: modelos, estado e cliente do hub (só Foundation).
//  - ClaudeHub:     o app (SwiftUI + AppKit).
// O projeto Xcode compila as duas pastas num único alvo; por isso os fontes do
// app usam `#if canImport(ClaudeHubCore)` antes de importar o núcleo.
let package = Package(
    name: "ClaudeHub",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ClaudeHubCore", targets: ["ClaudeHubCore"]),
        .executable(name: "ClaudeHub", targets: ["ClaudeHub"]),
    ],
    targets: [
        .target(
            name: "ClaudeHubCore",
            path: "Sources/ClaudeHubCore"
        ),
        .executableTarget(
            name: "ClaudeHub",
            dependencies: ["ClaudeHubCore"],
            path: "Sources/ClaudeHub",
            exclude: ["Assets.xcassets"]
        ),
        .testTarget(
            name: "ClaudeHubCoreTests",
            dependencies: ["ClaudeHubCore"],
            path: "Tests/ClaudeHubCoreTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)

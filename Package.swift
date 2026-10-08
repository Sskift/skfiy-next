// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "skfiy",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "skfiy", targets: ["skfiy"]),
        .library(name: "SkfiyKit", targets: ["SkfiyKit"])
    ],
    targets: [
        .target(
            name: "SkfiyKit",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "skfiy",
            dependencies: ["SkfiyKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "SkfiyKitTests",
            dependencies: ["SkfiyKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)

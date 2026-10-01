// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "skfiy",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "skfiy", targets: ["skfiy"]),
        .executable(name: "skfiy-guardian", targets: ["skfiy-guardian"]),
        .library(name: "SkfiyKit", targets: ["SkfiyKit"])
    ],
    targets: [
        .target(name: "LockedUseCore", linkerSettings: [
            .linkedFramework("ApplicationServices"), .linkedFramework("Security"),
            .linkedFramework("SystemConfiguration")
        ]),
        .executableTarget(name: "skfiy-guardian", dependencies: ["LockedUseCore"],
                          swiftSettings: [.swiftLanguageMode(.v5)]),
        .target(
            name: "SkfiyKit",
            dependencies: ["LockedUseCore"],
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

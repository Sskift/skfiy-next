// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "skfiy",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "skfiy", targets: ["skfiy"]),
        .executable(name: "skfiy-locked-guardian", targets: ["skfiy-locked-guardian"]),
        .library(name: "SkfiyKit", targets: ["SkfiyKit"])
    ],
    targets: [
        .target(name: "LockedUseSupport", path: "locked-use/Support", publicHeadersPath: "include",
                linkerSettings: [.linkedFramework("Security"), .linkedFramework("SystemConfiguration"), .linkedLibrary("bsm")]),
        .target(name: "LockedUseKit", dependencies: ["LockedUseSupport"],
                swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "skfiy-locked-guardian", dependencies: ["LockedUseKit", "LockedUseSupport"],
                          swiftSettings: [.swiftLanguageMode(.v5)]),
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
            dependencies: ["SkfiyKit", "LockedUseKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)

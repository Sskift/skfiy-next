// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "skfiy-helper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "skfiy-helper", targets: ["skfiyHelper"])
    ],
    targets: [
        .executableTarget(
            name: "skfiyHelper",
            path: "Sources/skfiy-helper",
            exclude: ["Info.plist"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("IOKit"),
                .linkedFramework("Vision"),
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/skfiy-helper/Info.plist"
                ])
            ]
        )
    ]
)

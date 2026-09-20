// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AdamMacRuntime",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "AdamMacRuntime", targets: ["AdamMacRuntime"]),
        .executable(name: "adam-agent", targets: ["AdamAgentCLI"]),
        .executable(name: "AdamMacApp", targets: ["AdamMacApp"])
    ],
    targets: [
        .target(name: "AdamMacRuntime"),
        .executableTarget(name: "AdamAgentCLI", dependencies: ["AdamMacRuntime"]),
        .executableTarget(
            name: "AdamMacApp",
            dependencies: ["AdamMacRuntime"],
            exclude: ["Info.plist"]
        ),
        .testTarget(name: "AdamMacRuntimeTests", dependencies: ["AdamMacRuntime"])
    ],
    swiftLanguageModes: [.v5]
)

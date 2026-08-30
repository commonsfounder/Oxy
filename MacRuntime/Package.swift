// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AdamMacRuntime",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "AdamMacRuntime", targets: ["AdamMacRuntime"])
    ],
    targets: [
        .target(name: "AdamMacRuntime"),
        .testTarget(name: "AdamMacRuntimeTests", dependencies: ["AdamMacRuntime"])
    ],
    swiftLanguageModes: [.v5]
)

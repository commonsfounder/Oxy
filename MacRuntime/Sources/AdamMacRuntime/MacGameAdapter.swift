import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

public enum MacGameAdapterError: Error, Equatable {
    case windowNotFound
    case screenshotUnavailable
    case imageEncodingFailed
    case keyboardEventUnavailable
    case mouseEventUnavailable
    case inputPermissionRequired
}

public struct MacGameWindowDescriptor: Sendable, Equatable, Identifiable {
    public let id: UInt32
    public let title: String
    public let applicationName: String

    public init(id: UInt32, title: String, applicationName: String) {
        self.id = id
        self.title = title
        self.applicationName = applicationName
    }
}

/// Access to the windows Adam is allowed to observe. The caller still chooses the window;
/// this catalog never captures the whole desktop implicitly.
public final class MacGameWindowCatalog: @unchecked Sendable {
    public init() {}

    public func list() async throws -> [MacGameWindowDescriptor] {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        return content.windows
            .filter { $0.isOnScreen }
            .map {
                MacGameWindowDescriptor(
                    id: $0.windowID,
                    title: $0.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                    applicationName: $0.owningApplication?.applicationName ?? ""
                )
            }
            .filter { !$0.title.isEmpty || !$0.applicationName.isEmpty }
    }

    public func makeAdapter(
        for windowID: UInt32,
        name: String? = nil,
        width: Int = 1280,
        height: Int = 720
    ) async throws -> MacWindowGameAdapter {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw MacGameAdapterError.windowNotFound
        }
        return MacWindowGameAdapter(window: window, name: name, width: width, height: height)
    }
}

/// The real Mac edge of a game session. It intentionally speaks the generic GameAdapter
/// protocol so the session authority does not know whether input comes from a Mac, console,
/// or a test adapter.
public final class MacWindowGameAdapter: GameAdapter, @unchecked Sendable {
    public let name: String

    private let contentFilter: SCContentFilter
    private let configuration: SCStreamConfiguration
    private var frameNumber = 0

    public init(window: SCWindow, name: String? = nil, width: Int = 1280, height: Int = 720) {
        self.name = name?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? name!
            : window.owningApplication?.applicationName ?? window.title ?? "Mac game"
        self.contentFilter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = max(320, width)
        configuration.height = max(240, height)
        configuration.showsCursor = false
        self.configuration = configuration
    }

    public func observe() async throws -> GameFrame {
        guard MacGamePermissions.screenCaptureIsGranted else {
            throw MacGameAdapterError.screenshotUnavailable
        }

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: contentFilter,
            configuration: configuration
        )
        guard let imageData = Self.pngData(for: image) else {
            throw MacGameAdapterError.imageEncodingFailed
        }

        frameNumber += 1
        let digest = SHA256.hash(data: imageData)
            .map { String(format: "%02x", $0) }
            .joined()
        return GameFrame(
            id: "frame-\(frameNumber)",
            fingerprint: digest,
            imageData: imageData
        )
    }

    public func send(_ input: GameInput) async throws {
        guard MacGamePermissions.inputIsGranted else {
            throw MacGameAdapterError.inputPermissionRequired
        }

        for event in input.events {
            switch event {
            case let .key(code, down):
                guard let keyboardEvent = CGEvent(
                    keyboardEventSource: nil,
                    virtualKey: CGKeyCode(code),
                    keyDown: down
                ) else {
                    throw MacGameAdapterError.keyboardEventUnavailable
                }
                keyboardEvent.post(tap: .cghidEventTap)

            case let .click(x, y):
                let point = CGPoint(x: x, y: y)
                guard
                    let mouseDown = CGEvent(
                        mouseEventSource: nil,
                        mouseType: .leftMouseDown,
                        mouseCursorPosition: point,
                        mouseButton: .left
                    ),
                    let mouseUp = CGEvent(
                        mouseEventSource: nil,
                        mouseType: .leftMouseUp,
                        mouseCursorPosition: point,
                        mouseButton: .left
                    )
                else {
                    throw MacGameAdapterError.mouseEventUnavailable
                }
                mouseDown.post(tap: .cghidEventTap)
                mouseUp.post(tap: .cghidEventTap)
            }
        }
    }

    private static func pngData(for image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}

public enum MacGamePermissions {
    public static var screenCaptureIsGranted: Bool {
        CGPreflightScreenCaptureAccess()
    }

    @discardableResult
    public static func requestScreenCapture() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    public static var inputIsGranted: Bool {
        CGPreflightPostEventAccess()
    }

    @discardableResult
    public static func requestInputAccess() -> Bool {
        CGRequestPostEventAccess()
    }
}

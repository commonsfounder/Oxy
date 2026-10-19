import Foundation
import Photos
import Vision
import CoreLocation
import UIKit

/// Reads the user's own photos on this iPhone and sends Adam short written notes about them.
/// The pictures never leave the phone. Off until the user switches it on in Preferences.
@MainActor
final class PhotoLearner {
    static let shared = PhotoLearner()
    static let enabledKey = "adam.photoLearning.enabled"
    static let statusKey = "adam.photoLearning.status"
    private static let doneKey = "adam.photoLearning.done"
    private static let perRun = 80
    private static let batch = 20

    private var isRunning = false
    private var sentNotes = 0
    private var failedSends = 0
    private var looked = 0

    private static func record(_ text: String) {
        let stamp = Date().formatted(date: .omitted, time: .shortened)
        UserDefaults.standard.set("\(text) (\(stamp))", forKey: statusKey)
    }
    private let geocoder = CLGeocoder()
    private var placeCache: [String: String] = [:]

    private var done: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: Self.doneKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue.suffix(8000)), forKey: Self.doneKey) }
    }

    /// Asks for photo access (whole library or the photos the user picks) and returns whether any was granted.
    func requestAccess() async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        return status == .authorized || status == .limited
    }

    func runIfEnabled() async {
        guard UserDefaults.standard.bool(forKey: Self.enabledKey) else { return }
        await run()
    }

    func run() async {
        guard !isRunning else { return }
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else {
            Self.record("Photo access is off. Turn it on in the Settings app.")
            return
        }
        isRunning = true
        defer { isRunning = false }
        sentNotes = 0
        failedSends = 0
        looked = 0

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        options.fetchLimit = 600
        let assets = PHAsset.fetchAssets(with: options)

        var seen = done
        var pending: [[String: Any]] = []
        var handled = 0
        for index in 0..<assets.count {
            if handled >= Self.perRun || Task.isCancelled { break }
            let asset = assets.object(at: index)
            if seen.contains(asset.localIdentifier) { continue }
            handled += 1
            looked += 1
            seen.insert(asset.localIdentifier)
            guard let image = await loadImage(asset) else { continue }
            let text = await describe(image, asset: asset)
            guard !text.isEmpty else { continue }
            var note: [String: Any] = ["text": text]
            if let date = asset.creationDate { note["date"] = ISO8601DateFormatter().string(from: date) }
            pending.append(note)
            if pending.count >= Self.batch { await send(pending); pending = [] }
        }
        if !pending.isEmpty { await send(pending) }
        done = seen
        if failedSends > 0 {
            Self.record("Couldn't send some notes. Try Scan now again.")
        } else if looked == 0 {
            Self.record("Nothing new to look at.")
        } else {
            Self.record("Looked at \(looked) photos and kept \(sentNotes) notes.")
        }
    }

    func forgetEverything() async {
        _ = try? await APIClient.shared.request(path: "/memory/photos", method: "DELETE")
        UserDefaults.standard.removeObject(forKey: Self.doneKey)
    }

    private func send(_ notes: [[String: Any]]) async {
        do {
            _ = try await APIClient.shared.request(path: "/memory/photos", method: "POST", body: ["notes": notes])
            sentNotes += notes.count
        } catch {
            failedSends += 1
        }
    }

    /// A small copy of the photo, only if it is already on the phone (nothing is downloaded from iCloud).
    private func loadImage(_ asset: PHAsset) async -> CGImage? {
        await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = false
            options.isSynchronous = false
            var resumed = false
            PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: 1024, height: 1024), contentMode: .aspectFit, options: options) { image, info in
                if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: image?.cgImage)
            }
        }
    }

    private func describe(_ image: CGImage, asset: PHAsset) async -> String {
        let (labels, words) = await Task.detached(priority: .utility) { () -> ([String], String) in
            let classify = VNClassifyImageRequest()
            let recognise = VNRecognizeTextRequest()
            recognise.recognitionLevel = .accurate
            recognise.usesLanguageCorrection = true
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            try? handler.perform([classify, recognise])
            let generic: Set<String> = ["structure", "material", "textile", "fabric", "indoor", "outdoor", "wood", "plant", "sky", "cloud", "ground", "water", "adult", "people", "machine", "container", "furniture", "room", "floor", "wall"]
            let labels = (classify.results ?? [])
                .filter { $0.confidence > 0.4 && !generic.contains($0.identifier) }
                .prefix(3)
                .map { $0.identifier.replacingOccurrences(of: "_", with: " ") }
            let lines = (recognise.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            return (Array(labels), lines.joined(separator: " "))
        }.value

        var parts: [String] = []
        if !labels.isEmpty { parts.append(labels.joined(separator: ", ")) }
        let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count >= 12 { parts.append("text reads \"\(String(trimmed.prefix(160)))\"") }
        if let place = await place(for: asset) { parts.append("near \(place)") }
        // A photo with no readable text and no clear subject adds nothing worth remembering.
        guard !labels.isEmpty || trimmed.count >= 12 else { return "" }
        return parts.joined(separator: "; ")
    }

    private func place(for asset: PHAsset) async -> String? {
        guard let location = asset.location else { return nil }
        let key = String(format: "%.2f,%.2f", location.coordinate.latitude, location.coordinate.longitude)
        if let cached = placeCache[key] { return cached.isEmpty ? nil : cached }
        let name = (try? await geocoder.reverseGeocodeLocation(location))?.first?.locality ?? ""
        placeCache[key] = name
        return name.isEmpty ? nil : name
    }
}

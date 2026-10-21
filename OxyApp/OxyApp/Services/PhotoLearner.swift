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
    /// Bump this when the photo reader improves, so everything is read again once with the better one.
    private static let readerVersion = 2
    private static let versionKey = "adam.photoLearning.readerVersion"
    private static let perRun = 250
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

    /// Looks at new photos each time the app opens, and keeps going through an older library until it is all done.
    func runIfEnabled() async {
        guard UserDefaults.standard.bool(forKey: Self.enabledKey) else { return }
        if UserDefaults.standard.integer(forKey: Self.versionKey) != Self.readerVersion {
            await forgetEverything()
            UserDefaults.standard.set(Self.readerVersion, forKey: Self.versionKey)
        }
        let deadline = Date().addingTimeInterval(15 * 60)
        while await run(), Date() < deadline, !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
        }
    }

    @discardableResult
    func run() async -> Bool {
        guard !isRunning else { return false }
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined { _ = await requestAccess(); status = PHPhotoLibrary.authorizationStatus(for: .readWrite) }
        guard status == .authorized || status == .limited else {
            Self.record("Photo access is off. Turn it on in the Settings app.")
            return false
        }
        isRunning = true
        defer { isRunning = false }
        sentNotes = 0
        failedSends = 0
        looked = 0

        // Screenshots first (they are where flyers, bills and products live), then everything else, newest first.
        let todo = unreadAssets(limit: Self.perRun)
        let total = PHAsset.fetchAssets(with: .image, options: nil).count
        var seen = done
        var pending: [[String: Any]] = []
        var processed = 0
        let width = 4
        var index = 0
        while index < todo.count, !Task.isCancelled {
            let chunk = Array(todo[index..<min(index + width, todo.count)])
            index += width
            let notes = await withTaskGroup(of: [String: Any]?.self) { group in
                for asset in chunk { group.addTask { @MainActor in await self.process(asset) } }
                var out: [[String: Any]] = []
                for await note in group { if let note { out.append(note) } }
                return out
            }
            pending.append(contentsOf: notes)
            for asset in chunk { seen.insert(asset.localIdentifier) }
            processed += chunk.count
            looked += chunk.count
            done = seen
            Self.progress(read: seen.count, total: total)
            if pending.count >= Self.batch { await send(pending); pending = [] }
        }
        if !pending.isEmpty { await send(pending) }
        done = seen
        if failedSends > 0 {
            Self.record("Couldn't read some photos. They'll be tried again.")
        } else if looked == 0 {
            Self.record("Nothing new to look at.")
        } else {
            Self.record("Looked at \(looked) photos and kept \(sentNotes) notes.")
        }
        UserDefaults.standard.removeObject(forKey: Self.progressKey)
        return processed >= Self.perRun
    }

    /// The next photos to read: screenshots first, then the rest, skipping any already read.
    private func unreadAssets(limit: Int) -> [PHAsset] {
        let seen = done
        func fetch(screenshots: Bool) -> [PHAsset] {
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            let screenshot = PHAssetMediaSubtype.photoScreenshot.rawValue
            options.predicate = NSPredicate(format: "mediaType == %d AND (mediaSubtypes & %d) \(screenshots ? "!=" : "==") 0", PHAssetMediaType.image.rawValue, screenshot)
            options.fetchLimit = 20000
            let result = PHAsset.fetchAssets(with: options)
            var out: [PHAsset] = []
            for index in 0..<result.count {
                let asset = result.object(at: index)
                if !seen.contains(asset.localIdentifier) { out.append(asset) }
                if out.count >= limit { break }
            }
            return out
        }
        let shots = fetch(screenshots: true)
        return shots.count >= limit ? shots : shots + fetch(screenshots: false).prefix(limit - shots.count)
    }

    /// One photo: read it on the phone, ask Adam to describe it, and fall back to the on-phone note if that fails.
    private func process(_ asset: PHAsset) async -> [String: Any]? {
        guard let image = await loadImage(asset) else { return nil }
        let text = await describe(image, asset: asset)
        if let jpeg = Self.smallJPEG(image), await describeInCloud(jpeg, asset: asset, hint: text) { return nil }
        guard !text.isEmpty else { return nil }
        var note: [String: Any] = ["text": text]
        if let date = asset.creationDate { note["date"] = ISO8601DateFormatter().string(from: date) }
        return note
    }

    /// Read so far and in total, for Home to show while the first pass runs.
    static let progressKey = "adam.photoLearning.progress"
    private static func progress(read: Int, total: Int) {
        UserDefaults.standard.set(["read": read, "total": total], forKey: progressKey)
    }

    /// Asks Adam to describe one photo. True means the server handled it (kept a note or skipped a private photo).
    private func describeInCloud(_ jpeg: Data, asset: PHAsset, hint: String) async -> Bool {
        var fields: [String: String] = [:]
        if !hint.isEmpty { fields["text"] = String(hint.prefix(300)) }
        if let date = asset.creationDate { fields["date"] = ISO8601DateFormatter().string(from: date) }
        if let place = await place(for: asset) { fields["place"] = place }
        do {
            let data = try await APIClient.shared.multipartRequest(
                path: "/memory/photos/describe", fields: fields, fileField: "image",
                fileName: "photo.jpg", mimeType: "image/jpeg", fileData: jpeg
            )
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let saved = json["saved"] as? Int { sentNotes += saved }
            return true
        } catch {
            failedSends += 1
            return false
        }
    }

    /// Longest side 512 points, light compression: enough to see what is in it, small enough to be cheap.
    private static func smallJPEG(_ image: CGImage) -> Data? {
        let longest = CGFloat(max(image.width, image.height))
        let scale = min(1, 512 / longest)
        let size = CGSize(width: CGFloat(image.width) * scale, height: CGFloat(image.height) * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.6) { _ in
            UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: size))
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
        if trimmed.count >= 12 { parts.append("text reads \"\(String(trimmed.prefix(320)))\"") }
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

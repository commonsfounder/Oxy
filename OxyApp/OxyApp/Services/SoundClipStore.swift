import AVFoundation
import Foundation
import Observation

/// A few seconds of sound kept with each household alert, only when the person has switched it on, so they
/// can say whether Adam heard right. Clips stay on this iPhone (not in backups), and go after 30 days.
@MainActor
@Observable
final class SoundClipStore {
    static let shared = SoundClipStore()
    static let preferenceKey = "adam_keep_sound_clips"
    static let seconds = 5.0
    private static let keepDays = 30.0
    private static let maxClips = 60

    struct Clip: Codable, Identifiable, Equatable {
        enum Verdict: String, Codable { case right, wrong }
        let id: String
        /// What Adam thought it heard, e.g. "knock" or "smoke_alarm".
        let sound: String
        /// What Adam thought it heard, in words: "Knocking", "Smoke alarm".
        let title: String
        let heardAt: Date
        var verdict: Verdict?
        var fileName: String { "\(id).wav" }
    }

    private(set) var clips: [Clip] = []
    private let folder: URL

    var isEnabled: Bool { UserDefaults.standard.bool(forKey: Self.preferenceKey) }

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        folder = support.appendingPathComponent("SoundClips", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = folder
        try? excluded.setResourceValues(values)
        clips = (try? JSONDecoder().decode([Clip].self, from: Data(contentsOf: indexURL))) ?? []
        prune()
    }

    func url(for clip: Clip) -> URL { folder.appendingPathComponent(clip.fileName) }

    func save(samples: [Float], sampleRate: Double, sound: String, title: String, at date: Date) {
        guard isEnabled, !samples.isEmpty, sampleRate > 0 else { return }
        let clip = Clip(id: UUID().uuidString, sound: sound, title: title, heardAt: date, verdict: nil)
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        buffer.frameLength = buffer.frameCapacity
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false
        ]
        do {
            let file = try AVAudioFile(forWriting: url(for: clip), settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            try file.write(from: buffer)
        } catch {
            return
        }
        clips.insert(clip, at: 0)
        clips.sort { $0.heardAt > $1.heardAt }
        prune()
        persist()
    }

    func mark(_ clip: Clip, _ verdict: Clip.Verdict) {
        guard let index = clips.firstIndex(where: { $0.id == clip.id }) else { return }
        clips[index].verdict = clips[index].verdict == verdict ? nil : verdict
        persist()
    }

    func delete(_ clip: Clip) {
        try? FileManager.default.removeItem(at: url(for: clip))
        clips.removeAll { $0.id == clip.id }
        persist()
    }

    func deleteAll() {
        for clip in clips { try? FileManager.default.removeItem(at: url(for: clip)) }
        clips.removeAll()
        persist()
    }

    /// Copies of the marked clips, named so the answer travels with the file:
    /// `knock-right-<time>.wav` was a knock; `knock-wrong-<time>.wav` was something else.
    func exportMarked() -> [URL] {
        let exportFolder = FileManager.default.temporaryDirectory.appendingPathComponent("SoundClipsExport", isDirectory: true)
        try? FileManager.default.removeItem(at: exportFolder)
        try? FileManager.default.createDirectory(at: exportFolder, withIntermediateDirectories: true)
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyyMMdd-HHmmss"
        return clips.compactMap { clip in
            guard let verdict = clip.verdict else { return nil }
            let copy = exportFolder.appendingPathComponent("\(clip.sound)-\(verdict.rawValue)-\(stamp.string(from: clip.heardAt)).wav")
            return (try? FileManager.default.copyItem(at: url(for: clip), to: copy)) != nil ? copy : nil
        }
    }

    #if DEBUG
    /// Debug only (OXY_DEBUG_YOU=sounds): three short tones standing in for real alerts.
    func seedPreviewClips() {
        UserDefaults.standard.set(true, forKey: Self.preferenceKey)
        guard clips.isEmpty else { return }
        let rate = 16_000.0
        for (offset, (sound, title, pitch)) in [("knock", "Knocking", 220.0), ("smoke_alarm", "Smoke alarm", 3_100.0), ("door_bell", "Doorbell", 660.0)].enumerated() {
            let samples = (0..<Int(rate)).map { Float(0.3 * sin(2 * .pi * pitch * Double($0) / rate)) }
            save(samples: samples, sampleRate: rate, sound: sound, title: title, at: Date().addingTimeInterval(Double(-offset) * 3_000))
        }
        if let first = clips.first { mark(first, .wrong) }
    }
    #endif

    private var indexURL: URL { folder.appendingPathComponent("clips.json") }

    private func prune() {
        let cutoff = Date().addingTimeInterval(-Self.keepDays * 24 * 3600)
        let expired = clips.enumerated().filter { $0.element.heardAt < cutoff || $0.offset >= Self.maxClips }.map(\.element)
        guard !expired.isEmpty else { return }
        for clip in expired { try? FileManager.default.removeItem(at: url(for: clip)) }
        clips.removeAll { clip in expired.contains { $0.id == clip.id } }
        persist()
    }

    private func persist() {
        try? JSONEncoder().encode(clips).write(to: indexURL, options: .atomic)
    }
}

import Contacts
import CoreLocation
import EventKit
import Foundation
import HealthKit
import MapKit
import MediaPlayer
import MessageUI
import AVFoundation
import MusicKit
import UIKit
import UserNotifications

struct NativeContactHint: Codable, Equatable {
    let displayName: String
    let phone: String?
    let email: String?
}

struct NativePlaceResult: Equatable {
    let name: String
    let address: String
    let distanceMeters: CLLocationDistance?
    let mapURL: URL
}

struct NativeLocalActionResult: Equatable, Sendable {
    let action: String
    let text: String
    let cardText: String
    let actionSummary: String
    let deepLink: String?
    let success: Bool
    let error: String?

    init(
        action: String,
        text: String,
        cardText: String,
        actionSummary: String,
        deepLink: String?,
        success: Bool = true,
        error: String? = nil
    ) {
        self.action = action
        self.text = text
        self.cardText = cardText
        self.actionSummary = actionSummary
        self.deepLink = deepLink
        self.success = success
        self.error = error
    }
}

struct NativeHealthSnapshot: Codable {
    var latestHeartRate: Double?
    var restingHeartRate: Double?
    var stepCountToday: Double?
    var sleepMinutesLastNight: Double?
    var recentWorkouts: [NativeWorkoutSummary]?
}

struct NativeWorkoutSummary: Codable, Equatable {
    let activity: String
    let durationMinutes: Double
    let energyKilocalories: Double?
    let distanceMeters: Double?
    let endedAt: Date
}

private struct ITunesSongResult: Decodable {
    let resultCount: Int
    let results: [ITunesSong]
}

private struct ITunesSong: Decodable {
    let trackId: Int?
    let trackName: String?
    let artistName: String?
    let trackViewUrl: String?
}

struct NativeCapabilities: Codable {
    var notifications: Bool
    var healthKit: Bool
    var musicKit: Bool
    var contacts: Bool
    var reminders: Bool
    var locationAlways: Bool
}

@MainActor
final class NativeIntegrationManager {
    static let shared = NativeIntegrationManager()

    private let healthStore = HKHealthStore()
    private let contactStore = CNContactStore()
    private let eventStore = EKEventStore()
    private let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue)
    private var lastMusicQuery: String?
    private var lastMusicError: String?
    private var musicHistory: [String] = []

    private init() {}

    func bootstrap(userId: String) {
        guard !userId.isEmpty else { return }
        Task {
            await requestNotificationPermission(userId: userId)
            await syncNativeContext(userId: userId)
        }
    }

    func requestNotificationPermission(userId: String) async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            }
        } catch {}
    }

    func registerPushToken(_ deviceToken: Data, userId: String) async {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: "oxy_push_token")
        do {
            _ = try await APIClient.shared.request(
                path: "/devices/register",
                method: "POST",
                body: [
                    "userId": userId,
                    "platform": "ios",
                    "pushToken": token,
                    "timezone": TimeZone.current.identifier
                ]
            )
        } catch {}
    }

    func requestNativePermissions(userId: String) async {
        LocationManager.shared.requestAlwaysPermission()
        await requestHealthPermission()
        await requestContactsPermission()
        await requestReminderPermission()
        await requestCalendarPermission()
        await syncNativeContext(userId: userId)
    }

    func syncNativeContext(userId: String) async {
        guard !userId.isEmpty else { return }
        let settings = loadSettings()
        let health = await healthSnapshot()
        let capabilities = await nativeCapabilities()
        var body: [String: Any] = [
            "userId": userId,
            "health": health.dictionary,
            "capabilities": capabilities.dictionary,
            "settings": settings.nativeDictionary
        ]
        if let location = LocationManager.shared.locationDict {
            body["location"] = location
        }
        do {
            _ = try await APIClient.shared.request(path: "/native/context", method: "POST", body: body)
        } catch {}
    }

    func markCurrentLocationAsHome(userId: String) async {
        LocationManager.shared.requestLocation()
        guard let location = LocationManager.shared.locationDict else { return }
        var settings = loadSettings()
        settings.homeLatitude = location["latitude"]
        settings.homeLongitude = location["longitude"]
        saveSettings(settings)
        await syncNativeContext(userId: userId)
    }

    func openMessage(recipient: String, body: String) {
        let encodedRecipient = recipient.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? recipient
        let encodedBody = body.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? body
        if let url = URL(string: "sms:\(encodedRecipient)&body=\(encodedBody)") {
            UIApplication.shared.open(url)
        }
    }

    func openFaceTime(recipient: String) {
        let encoded = recipient.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? recipient
        if let url = URL(string: "facetime://\(encoded)") {
            UIApplication.shared.open(url)
        }
    }

    func localContextHints(for message: String) async -> [String: Any] {
        var hints: [String: Any] = [:]
        if isContactResolutionRequest(message) {
            let contacts = await contactHints(in: contactQuery(from: message))
            if !contacts.isEmpty {
                hints["contacts"] = contacts.map(\.dictionary)
            }
        }
        return hints
    }

    func executeLocalRequest(_ message: String) async -> NativeLocalActionResult? {
        let normalized = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return nil }
        let lower = normalized.lowercased()
        if shouldLetBrainHandleFirst(normalized) {
            return nil
        }
        if lower.contains("uber") || lower.contains("taxi") || lower.contains("ride") {
            return nil
        }

        if let result = await prepareNativeMessage(from: normalized) {
            return result
        }

        if let result = await nativeDiagnostics(for: normalized) {
            return result
        }

        if !requiresOnlineMusicResolution(normalized),
           let result = await handleNativeMusicRequest(normalized) {
            return result
        }

        if let result = await answerNativeHealthRequest(normalized) {
            return result
        }

        if let result = await createNativeReminder(from: normalized) {
            return result
        }

        if let result = await createNativeCalendarEvent(from: normalized) {
            return result
        }

        if shouldUseNativePlaceSearch(normalized), let result = await findNativePlace(for: normalized) {
            return result
        }

        return nil
    }

    private func shouldLetBrainHandleFirst(_ message: String) -> Bool {
        let lower = message.lowercased()
        let trimmed = lower.trimmingCharacters(in: .whitespacesAndNewlines)
        if requiresOnlineMusicResolution(message) {
            return true
        }
        if isAmbiguousContextReference(trimmed) {
            return true
        }
        if lower.contains("last song i asked")
            || lower.contains("last track i asked")
            || lower.contains("song i asked you")
            || lower.contains("track i asked you")
            || lower.contains("thing i asked you to play") {
            return true
        }
        if trimmed == "look it up"
            || trimmed == "search it"
            || trimmed == "google it"
            || trimmed == "check online" {
            return true
        }
        if lower.contains("bruh")
            || lower.contains("huh")
            || lower.contains("what do you mean")
            || lower.contains("that is wrong")
            || lower.contains("that's wrong")
            || lower.contains("not what i")
            || lower.contains("i mean")
            || lower.contains("try again") {
            return true
        }
        if lower.contains("remind me")
            || lower.contains("create a reminder")
            || lower.contains("set a reminder")
            || lower.contains("text ")
            || lower.contains("message ")
            || lower.contains("call ")
            || lower.contains("facetime")
            || lower.contains("add to calendar")
            || lower.contains("schedule ")
            || lower.contains("calendar event") {
            return false
        }
        if lower.contains("latest")
            || lower.contains("current")
            || lower.contains("right now")
            || lower.contains("today")
            || lower.contains("news")
            || lower.contains("price")
            || lower.contains("popular")
            || lower.contains("best")
            || lower.contains("top")
            || lower.contains("chart")
            || lower.contains("ranking")
            || lower.contains("weather")
            || lower.contains("forecast") {
            return true
        }
        if trimmed.range(of: #"^(who|what|when|where|why|how|is|are|do|does|did|can|could|should|would|will)\b"#, options: .regularExpression) != nil {
            return true
        }
        return false
    }

    private func isAmbiguousContextReference(_ trimmed: String) -> Bool {
        if [
            "it", "that", "this", "there", "same", "again", "do it", "do that",
            "book it", "book that", "open it", "open that", "send it",
            "play it", "play that", "play this", "play that one", "play this one",
            "that one", "this one", "the other one", "last one"
        ].contains(trimmed) {
            return true
        }
        if trimmed.contains("what about")
            || trimmed.contains("no i mean")
            || trimmed.contains("nah i mean")
            || trimmed.contains("actually i mean")
            || trimmed.contains("is that right")
            || trimmed.contains("are you sure")
            || trimmed.contains("send it to")
            || trimmed.contains("open the nearest one")
            || trimmed.contains("book that") {
            return true
        }
        return false
    }

    func playResolvedMusicQuery(_ query: String) async -> NativeLocalActionResult? {
        let cleaned = query.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        guard !cleaned.isEmpty else { return nil }
        return await playNativeMusicQuery(cleaned)
    }

    private func nativeDiagnostics(for message: String) async -> NativeLocalActionResult? {
        let lower = message.lowercased()
        guard lower.contains("diagnose oxy")
            || lower.contains("native diagnostics")
            || lower.contains("oxy diagnostics")
            || lower.contains("why is oxy not working") else { return nil }

        let contactsStatus = CNContactStore.authorizationStatus(for: .contacts)
        let musicStatus = MusicAuthorization.currentStatus
        let canSendText = MFMessageComposeViewController.canSendText()
        var lines = [
            "Contacts: \(authorizationLabel(contactsStatus))",
            "Can send iMessage/SMS: \(canSendText ? "yes" : "no")",
            "MusicKit: \(musicAuthorizationLabel(musicStatus))",
            "Apple Music app installed: \(UIApplication.shared.canOpenURL(URL(string: "music://")!) ? "yes" : "no")"
        ]
        if musicStatus == .authorized {
            do {
                let subscription = try await MusicSubscription.current
                lines.append("Can play Apple Music catalog: \(subscription.canPlayCatalogContent ? "yes" : "no")")
                lines.append("Cloud library enabled: \(subscription.hasCloudLibraryEnabled ? "yes" : "no")")
            } catch {
                lines.append("Music subscription check failed: \(String(describing: error))")
            }
        }
        if let lastMusicError, !lastMusicError.isEmpty {
            lines.append("Last music error: \(lastMusicError)")
        }
        return NativeLocalActionResult(
            action: "native_diagnostics",
            text: lines.joined(separator: "\n"),
            cardText: lines.joined(separator: "\n"),
            actionSummary: "Native diagnostics",
            deepLink: nil
        )
    }

    private func authorizationLabel(_ status: CNAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not requested"
        case .limited: return "limited"
        @unknown default: return "unknown"
        }
    }

    private func musicAuthorizationLabel(_ status: MusicAuthorization.Status) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not requested"
        @unknown default: return "unknown"
        }
    }

    private func prepareNativeMessage(from message: String) async -> NativeLocalActionResult? {
        guard let parsed = parseMessageRequest(message) else { return nil }
        let contacts = await contactHints(in: parsed.contact)
        let matched = contacts.first
        let recipient = matched?.phone ?? matched?.email ?? normalizedMessageAddress(parsed.contact)
        guard let recipient, !recipient.isEmpty else {
            return NativeLocalActionResult(
                action: "send_message",
                text: "I need a phone number for \(parsed.contact). Turn on Contacts access for Oxy or include the number.",
                cardText: "No phone number found for \(parsed.contact)",
                actionSummary: "Message needs contact",
                deepLink: nil,
                success: false,
                error: "No message address found."
            )
        }

        let label = matched?.displayName ?? parsed.contact
        let encodedRecipient = recipient.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? recipient
        let encodedBody = parsed.body.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? parsed.body
        return NativeLocalActionResult(
            action: "send_message",
            text: "Message ready for \(label). Review and tap Send.",
            cardText: "To \(label) · \(parsed.body)",
            actionSummary: "Message ready",
            deepLink: "sms:\(encodedRecipient)?&body=\(encodedBody)"
        )
    }

    private func parseMessageRequest(_ message: String) -> (contact: String, body: String)? {
        let patterns = [
            #"(?i)^(?:please\s+)?(?:send\s+)?(?:a\s+)?message\s+to\s+(.+?)\s+(?:saying|that says|and say|say)\s+(.+)$"#,
            #"(?i)^(?:please\s+)?(?:text|message)\s+(.+?)\s+(?:saying|that says|and say|say)\s+(.+)$"#,
            #"(?i)^(?:please\s+)?send\s+(.+?)\s+(?:a\s+)?message\s+(?:saying|that says|and say|say)\s+(.+)$"#
        ]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(message.startIndex..<message.endIndex, in: message)
            guard let match = regex.firstMatch(in: message, range: range), match.numberOfRanges >= 3,
                  let contactRange = Range(match.range(at: 1), in: message),
                  let bodyRange = Range(match.range(at: 2), in: message) else { continue }
            let contact = String(message[contactRange]).trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
            let body = String(message[bodyRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !contact.isEmpty, !body.isEmpty {
                return (contact, body)
            }
        }
        return nil
    }

    private func normalizedMessageAddress(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.range(of: #"^\+?[0-9][0-9\s().-]{5,}$"#, options: .regularExpression) != nil {
            return trimmed
        }
        if trimmed.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil {
            return trimmed
        }
        return nil
    }

    private func handleNativeMusicRequest(_ message: String) async -> NativeLocalActionResult? {
        let lower = message.lowercased()
        guard lower.contains("music")
            || lower.contains("song")
            || lower.contains("playlist")
            || lower == "pause"
            || lower.hasPrefix("pause ")
            || lower == "resume"
            || lower.hasPrefix("resume ")
            || lower == "resume it"
            || lower == "unpause"
            || lower.hasPrefix("unpause ")
            || lower == "next"
            || lower == "previous"
            || lower == "back"
            || lower.contains("pause playback")
            || lower.contains("resume playback")
            || lower.contains("skip")
            || lower.hasPrefix("play ")
            || lower.hasPrefix("listen to ")
            || lower.hasPrefix("add ") else { return nil }

        if let result = await handleMusicTransportCommand(lower) {
            return result
        }

        if lower.contains("playlist") || lower.hasPrefix("add ") {
            return await addNativeMusicItem(from: message)
        }
        return await playNativeMusic(from: message)
    }

    private func requiresOnlineMusicResolution(_ message: String) -> Bool {
        let lower = message.lowercased()
        guard lower.contains("play") || lower.contains("song") || lower.contains("music") || lower.contains("track") else {
            return false
        }
        return lower.contains("billboard")
            || lower.contains("hot 100")
            || lower.contains("chart")
            || lower.contains("number one")
            || lower.contains("no. 1")
            || lower.contains("top song")
            || lower.contains("top track")
            || lower.contains("most popular")
            || lower.contains("most streamed")
            || lower.contains("viral")
            || lower.contains("right now")
            || lower.contains("currently")
            || lower.contains("today")
            || lower.contains("latest")
            || lower.contains("trending")
    }

    private func requestMusicPermission() async -> Bool {
        switch MusicAuthorization.currentStatus {
        case .authorized:
            return true
        case .notDetermined:
            return await MusicAuthorization.request() == .authorized
        default:
            return false
        }
    }

    private func handleMusicTransportCommand(_ lower: String) async -> NativeLocalActionResult? {
        let systemPlayer = MPMusicPlayerController.systemMusicPlayer
        let appPlayer = MPMusicPlayerController.applicationMusicPlayer

        if lower == "previous" || lower == "back" || lower.contains("previous song") || lower.contains("last track") {
            try? await ApplicationMusicPlayer.shared.skipToPreviousEntry()
            try? await SystemMusicPlayer.shared.skipToPreviousEntry()
            systemPlayer.skipToPreviousItem()
            appPlayer.skipToPreviousItem()
            return NativeLocalActionResult(
                action: "music_control",
                text: "Going back.",
                cardText: "Previous track",
                actionSummary: "Previous track",
                deepLink: nil
            )
        }

        guard !lower.hasPrefix("play ") && !lower.hasPrefix("listen to ") else { return nil }

        if lower == "pause" || lower.hasPrefix("pause ") || lower.contains("pause music") || lower.contains("pause playback") {
            ApplicationMusicPlayer.shared.pause()
            SystemMusicPlayer.shared.pause()
            systemPlayer.pause()
            appPlayer.pause()
            return NativeLocalActionResult(
                action: "music_control",
                text: "Paused.",
                cardText: "Playback paused",
                actionSummary: "Music paused",
                deepLink: nil
            )
        }

        if lower == "resume"
            || lower == "resume it"
            || lower == "play"
            || lower == "unpause"
            || lower.hasPrefix("resume ")
            || lower.hasPrefix("unpause ")
            || lower.contains("resume music")
            || lower.contains("resume playback")
            || lower.contains("unpause music")
            || lower.contains("unpause playback") {
            try? await ApplicationMusicPlayer.shared.play()
            try? await SystemMusicPlayer.shared.play()
            systemPlayer.play()
            appPlayer.play()
            return NativeLocalActionResult(
                action: "music_control",
                text: "Resumed.",
                cardText: "Playback resumed",
                actionSummary: "Music resumed",
                deepLink: nil
            )
        }

        if lower == "next" || lower.contains("next song") || lower.contains("skip this") || lower.contains("skip song") {
            try? await ApplicationMusicPlayer.shared.skipToNextEntry()
            try? await SystemMusicPlayer.shared.skipToNextEntry()
            systemPlayer.skipToNextItem()
            appPlayer.skipToNextItem()
            return NativeLocalActionResult(
                action: "music_control",
                text: "Skipped.",
                cardText: "Next track",
                actionSummary: "Music skipped",
                deepLink: nil
            )
        }

        return nil
    }

    private func playNativeMusic(from message: String) async -> NativeLocalActionResult? {
        let query = resolvedMusicQuery(from: message)
        guard !query.isEmpty else { return nil }
        return await playNativeMusicQuery(query)
    }

    private func playNativeMusicQuery(_ query: String) async -> NativeLocalActionResult? {
        guard await requestMusicPermission() else {
            return NativeLocalActionResult(
                action: "play_music",
                text: "Turn on Apple Music access and I can play that natively.",
                cardText: "Enable Apple Music access",
                actionSummary: "Music needs access",
                deepLink: "music://",
                success: false,
                error: "Apple Music permission is not authorized."
            )
        }

        do {
            if let song = try? await withMusicTimeout(seconds: 4) { try await self.searchCatalogSong(query) } {
                try await playResolvedSong(song, query: query)
                recordPlayedMusic("\(song.title) \(song.artistName)")
                lastMusicError = nil
                return NativeLocalActionResult(
                    action: "play_music",
                    text: "Playing \(song.title) by \(song.artistName).",
                    cardText: "\(song.title) · \(song.artistName)",
                    actionSummary: "Music playing",
                    deepLink: song.url?.absoluteString ?? "music://"
                )
            }

            if let iTunesSong = try await withMusicTimeout(seconds: 4) { try await self.searchITunesSong(query) } {
                guard let trackId = iTunesSong.trackId else {
                    throw NSError(domain: "OxyMusic", code: 5, userInfo: [NSLocalizedDescriptionKey: "Missing iTunes track ID"])
                }
                try await playWithStoreID(String(trackId))
                let title = iTunesSong.trackName ?? query
                let artist = iTunesSong.artistName ?? "Apple Music"
                recordPlayedMusic("\(title) \(artist)")
                lastMusicError = nil
                return NativeLocalActionResult(
                    action: "play_music",
                    text: "Playing \(title) by \(artist).",
                    cardText: "\(title) · \(artist)",
                    actionSummary: "Music playing",
                    deepLink: iTunesSong.trackViewUrl ?? "music://"
                )
            }

            do {
                try playLocalLibraryItem(matching: query)
                recordPlayedMusic(query)
                lastMusicError = nil
                return NativeLocalActionResult(
                    action: "play_music",
                    text: "Playing \(query).",
                    cardText: query,
                    actionSummary: "Music playing",
                    deepLink: "music://"
                )
            } catch {}

            return NativeLocalActionResult(
                action: "play_music",
                text: "I couldn't find that song in Apple Music.",
                cardText: query,
                actionSummary: "Music not found",
                deepLink: "music://",
                success: false,
                error: "No Apple Music or iTunes result for \(query)."
            )
        } catch {
            lastMusicError = String(describing: error)
            let userFacingError = musicPlaybackErrorMessage(error)
            return NativeLocalActionResult(
                action: "play_music",
                text: userFacingError,
                cardText: query,
                actionSummary: "Music failed",
                deepLink: nil,
                success: false,
                error: String(describing: error)
            )
        }
    }

    private func playResolvedSong(_ song: Song, query: String) async throws {
        var failures: [String] = []
        do {
            try prepareAudioSessionForMusic()
            let player = ApplicationMusicPlayer.shared
            player.queue = ApplicationMusicPlayer.Queue(for: [song])
            try await withMusicTimeout(seconds: 5) {
                try await player.prepareToPlay()
                try await player.play()
            }
            return
        } catch {
            failures.append("ApplicationMusicPlayer: \(String(describing: error))")
        }

        do {
            try prepareAudioSessionForMusic()
            let player = SystemMusicPlayer.shared
            player.queue = SystemMusicPlayer.Queue(for: [song])
            try await withMusicTimeout(seconds: 5) {
                try await player.prepareToPlay()
                try await player.play()
            }
            return
        } catch {
            failures.append("SystemMusicPlayer: \(String(describing: error))")
        }

        do {
            try await playWithMediaPlayer(song)
            return
        } catch {
            failures.append("Store queue: \(String(describing: error))")
        }

        do {
            try playLocalLibraryItem(matching: "\(song.title) \(song.artistName)")
            return
        } catch {
            failures.append("Local library: \(String(describing: error))")
        }

        do {
            try playLocalLibraryItem(matching: query)
            return
        } catch {
            failures.append("Local query: \(String(describing: error))")
        }

        throw NSError(
            domain: "OxyMusic",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: failures.joined(separator: " | ")]
        )
    }

    private func playWithMediaPlayer(_ song: Song) async throws {
        let storeID = song.id.rawValue
        guard !storeID.isEmpty else {
            throw NSError(domain: "OxyMusic", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing Apple Music store ID"])
        }
        try await playWithStoreID(storeID)
    }

    private func playWithStoreID(_ storeID: String) async throws {
        guard !storeID.isEmpty, storeID != "0" else {
            throw NSError(domain: "OxyMusic", code: 6, userInfo: [NSLocalizedDescriptionKey: "Missing playable store ID"])
        }
        try prepareAudioSessionForMusic()
        let player = MPMusicPlayerController.systemMusicPlayer
        let descriptor = MPMusicPlayerStoreQueueDescriptor(storeIDs: [storeID])
        player.setQueue(with: descriptor)
        try await withMusicTimeout(seconds: 5) {
            try await player.prepareToPlay()
        }
        player.play()
    }

    private func addStoreIDToLibrary(_ storeID: String) async throws {
        guard !storeID.isEmpty, storeID != "0" else {
            throw NSError(domain: "OxyMusic", code: 8, userInfo: [NSLocalizedDescriptionKey: "Missing store ID for library add"])
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            MPMediaLibrary.default().addItem(withProductID: storeID) { _, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    private func addStoreID(_ storeID: String, toPlaylistNamed playlistName: String) async throws -> String {
        guard !storeID.isEmpty, storeID != "0" else {
            throw NSError(domain: "OxyMusic", code: 9, userInfo: [NSLocalizedDescriptionKey: "Missing store ID for playlist add"])
        }
        guard let playlist = findMediaPlaylist(named: playlistName) else {
            throw NSError(domain: "OxyMusic", code: 10, userInfo: [NSLocalizedDescriptionKey: "Playlist not found: \(playlistName)"])
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            playlist.addItem(withProductID: storeID) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
        return playlist.name ?? playlistName
    }

    private func findMediaPlaylist(named name: String) -> MPMediaPlaylist? {
        let normalized = normalizeMusicText(name)
        return MPMediaQuery.playlists().collections?
            .compactMap { $0 as? MPMediaPlaylist }
            .first { playlist in
                let playlistName = normalizeMusicText(playlist.name ?? "")
                return playlistName == normalized || playlistName.contains(normalized) || normalized.contains(playlistName)
            }
    }

    private func playLocalLibraryItem(matching query: String) throws {
        let normalizedQuery = normalizeMusicText(query)
        guard !normalizedQuery.isEmpty else {
            throw NSError(domain: "OxyMusic", code: 3, userInfo: [NSLocalizedDescriptionKey: "Empty music query"])
        }
        let mediaQuery = MPMediaQuery.songs()
        let item = mediaQuery.items?.first { item in
            let title = normalizeMusicText(item.title ?? "")
            let artist = normalizeMusicText(item.artist ?? "")
            let combined = normalizeMusicText("\(item.title ?? "") \(item.artist ?? "")")
            return combined.contains(normalizedQuery)
                || normalizedQuery.contains(combined)
                || title.contains(normalizedQuery)
                || normalizedQuery.contains(title)
                || (!artist.isEmpty && normalizedQuery.contains(artist) && !title.isEmpty && normalizedQuery.contains(title))
        }
        guard let item else {
            throw NSError(domain: "OxyMusic", code: 4, userInfo: [NSLocalizedDescriptionKey: "No matching local library item"])
        }
        try prepareAudioSessionForMusic()
        let player = MPMusicPlayerController.applicationMusicPlayer
        let collection = MPMediaItemCollection(items: [item])
        player.setQueue(with: collection)
        player.play()
    }

    private func prepareAudioSessionForMusic() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
    }

    private func searchITunesSong(_ query: String) async throws -> ITunesSong? {
        var components = URLComponents(string: "https://itunes.apple.com/search")
        components?.queryItems = [
            URLQueryItem(name: "term", value: query),
            URLQueryItem(name: "media", value: "music"),
            URLQueryItem(name: "entity", value: "song"),
            URLQueryItem(name: "limit", value: "1"),
            URLQueryItem(name: "country", value: Locale.current.region?.identifier ?? "GB")
        ]
        guard let url = components?.url else {
            throw NSError(domain: "OxyMusic", code: 7, userInfo: [NSLocalizedDescriptionKey: "Invalid iTunes search URL"])
        }
        let (data, response) = try await withMusicTimeout(seconds: 4) {
            try await URLSession.shared.data(from: url)
        }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw NSError(domain: "OxyMusic", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "iTunes search failed with HTTP \(http.statusCode)"])
        }
        let decoded = try JSONDecoder().decode(ITunesSongResult.self, from: data)
        guard decoded.resultCount > 0 else { return nil }
        return decoded.results.first { $0.trackId != nil }
    }

    private func musicPlaybackErrorMessage(_ error: Error) -> String {
        let details = String(describing: error)
        if details.localizedCaseInsensitiveContains("No matching local library item") {
            return "I found the song, but iOS would not start Apple Music playback. Add it to your library or try another song."
        }
        return "I found the song, but iOS would not start playback. Try again from the Music app once, then ask me again."
    }

    private func musicAddErrorMessage(_ error: Error) -> String {
        let details = String(describing: error)
        if details.localizedCaseInsensitiveContains("Playlist not found") {
            return "I couldn't find that playlist in your Apple Music library."
        }
        if details.localizedCaseInsensitiveContains("developerTokenRequestFailed") {
            return "Apple Music would not allow playlist editing through MusicKit yet, but playback still works."
        }
        return "Apple Music couldn't add that yet."
    }

    private func addNativeMusicItem(from message: String) async -> NativeLocalActionResult? {
        guard await requestMusicPermission() else {
            return NativeLocalActionResult(
                action: "add_to_music_playlist",
                text: "Turn on Apple Music access and I can add music natively.",
                cardText: "Enable Apple Music access",
                actionSummary: "Music needs access",
                deepLink: "music://",
                success: false,
                error: "Apple Music permission is not authorized."
            )
        }

        let parsedRequest = parseMusicAddRequest(message)
        let parsed = (
            query: resolvedMusicReference(parsedRequest.query),
            playlistName: parsedRequest.playlistName
        )
        guard !parsed.query.isEmpty else { return nil }

        do {
            if let song = try? await searchCatalogSong(parsed.query) {
                if let playlistName = parsed.playlistName, !playlistName.isEmpty {
                    guard let playlist = try await findLibraryPlaylist(named: playlistName) else {
                        return NativeLocalActionResult(
                            action: "add_to_music_playlist",
                            text: "I found \(song.title), but couldn't find a playlist called \(playlistName).",
                            cardText: "\(song.title) · Missing playlist: \(playlistName)",
                            actionSummary: "Playlist not found",
                            deepLink: "music://",
                            success: false,
                            error: "Playlist not found: \(playlistName)."
                        )
                    }
                    try await MusicLibrary.shared.add(song, to: playlist)
                    return NativeLocalActionResult(
                        action: "add_to_music_playlist",
                        text: "Added \(song.title) by \(song.artistName) to \(playlist.name).",
                        cardText: "\(song.title) · \(playlist.name)",
                        actionSummary: "Added to playlist",
                        deepLink: playlist.url?.absoluteString ?? song.url?.absoluteString ?? "music://"
                    )
                }

                try await MusicLibrary.shared.add(song)
                return NativeLocalActionResult(
                    action: "add_to_music_playlist",
                    text: "Added \(song.title) by \(song.artistName) to your Apple Music library.",
                    cardText: "\(song.title) · Library",
                    actionSummary: "Added to library",
                    deepLink: song.url?.absoluteString ?? "music://"
                )
            }

            guard let iTunesSong = try await searchITunesSong(parsed.query),
                  let trackId = iTunesSong.trackId else {
                return NativeLocalActionResult(
                    action: "add_to_music_playlist",
                    text: "I couldn't find \(parsed.query) in Apple Music.",
                    cardText: parsed.query,
                    actionSummary: "Music not found",
                    deepLink: "music://",
                    success: false,
                    error: "No Apple Music or iTunes result for \(parsed.query)."
                )
            }

            let title = iTunesSong.trackName ?? parsed.query
            let artist = iTunesSong.artistName ?? "Apple Music"
            let storeID = String(trackId)
            if let playlistName = parsed.playlistName, !playlistName.isEmpty {
                let addedPlaylistName = try await addStoreID(storeID, toPlaylistNamed: playlistName)
                return NativeLocalActionResult(
                    action: "add_to_music_playlist",
                    text: "Added \(title) by \(artist) to \(addedPlaylistName).",
                    cardText: "\(title) · \(addedPlaylistName)",
                    actionSummary: "Added to playlist",
                    deepLink: iTunesSong.trackViewUrl ?? "music://"
                )
            }

            try await addStoreIDToLibrary(storeID)
            return NativeLocalActionResult(
                action: "add_to_music_playlist",
                text: "Added \(title) by \(artist) to your Apple Music library.",
                cardText: "\(title) · Library",
                actionSummary: "Added to library",
                deepLink: iTunesSong.trackViewUrl ?? "music://"
            )
        } catch {
            return NativeLocalActionResult(
                action: "add_to_music_playlist",
                text: musicAddErrorMessage(error),
                cardText: parsed.query,
                actionSummary: "Music add failed",
                deepLink: nil,
                success: false,
                error: String(describing: error)
            )
        }
    }

    private func searchCatalogSong(_ query: String) async throws -> Song? {
        var request = MusicCatalogSearchRequest(term: query, types: [Song.self])
        request.limit = 1
        let response = try await request.response()
        return response.songs.first
    }

    private func withMusicTimeout<T>(seconds: Double, operation: @escaping () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask {
                try await operation()
            }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                throw NSError(
                    domain: "OxyMusic",
                    code: 408,
                    userInfo: [NSLocalizedDescriptionKey: "Apple Music timed out."]
                )
            }
            guard let value = try await group.next() else {
                throw NSError(
                    domain: "OxyMusic",
                    code: 408,
                    userInfo: [NSLocalizedDescriptionKey: "Apple Music timed out."]
                )
            }
            group.cancelAll()
            return value
        }
    }

    private func findLibraryPlaylist(named name: String) async throws -> Playlist? {
        var request = MusicLibraryRequest<Playlist>()
        request.limit = 100
        let response = try await request.response()
        let normalized = normalizeMusicText(name)
        return response.items.first { playlist in
            let playlistName = normalizeMusicText(playlist.name)
            return playlistName == normalized || playlistName.contains(normalized) || normalized.contains(playlistName)
        }
    }

    private func cleanMusicQuery(_ message: String) -> String {
        var text = message
        let patterns = [
            #"(?i)^play\s+"#,
            #"(?i)^listen to\s+"#,
            #"(?i)\bon apple music\b"#,
            #"(?i)\bin apple music\b"#,
            #"(?i)\bthe song\b"#,
            #"(?i)\bsong\b"#,
            #"(?i)\bmusic\b"#
        ]
        for pattern in patterns {
            text = text.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
        }
        return text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    }

    private func resolvedMusicQuery(from message: String) -> String {
        let query = cleanMusicQuery(message)
        return resolvedMusicReference(query)
    }

    private func resolvedMusicReference(_ query: String) -> String {
        let normalized = normalizeMusicText(query)
        if isPreviousMusicReference(normalized), let previous = previousMusicQuery {
            return previous
        }
        if isLastMusicReference(normalized), let lastMusicQuery, !lastMusicQuery.isEmpty {
            return lastMusicQuery
        }
        if ["it", "that", "this", "that one", "this one"].contains(normalized),
           let lastMusicQuery,
            !lastMusicQuery.isEmpty {
            return lastMusicQuery
        }
        return query
    }

    private var previousMusicQuery: String? {
        guard musicHistory.count >= 2 else { return nil }
        return musicHistory[musicHistory.count - 2]
    }

    private func recordPlayedMusic(_ query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        lastMusicQuery = trimmed
        if musicHistory.last != trimmed {
            musicHistory.append(trimmed)
        }
        if musicHistory.count > 12 {
            musicHistory.removeFirst(musicHistory.count - 12)
        }
    }

    private func isLastMusicReference(_ normalized: String) -> Bool {
        ["last", "last song", "last again", "last song again", "the last", "the last again", "the last song", "the last song again", "same", "same song", "same again", "it again", "that again", "this again", "play it again", "play that again", "play this again"].contains(normalized)
    }

    private func isPreviousMusicReference(_ normalized: String) -> Bool {
        ["previous", "previous song", "previous again", "previous song again", "the previous", "the previous song", "the previous song again"].contains(normalized)
    }

    private func parseMusicAddRequest(_ message: String) -> (query: String, playlistName: String?) {
        var text = message
            .replacingOccurrences(of: #"(?i)^add\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)\bthe song\b"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)\bon apple music\b"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)\bin apple music\b"#, with: " ", options: .regularExpression)

        if let range = text.range(of: #"(?i)\s+to\s+(my\s+)?playlist\s+"#, options: .regularExpression) {
            let query = String(text[..<range.lowerBound])
            let playlist = String(text[range.upperBound...])
            return (cleanMusicQuery(query), cleanPlaylistName(playlist))
        }

        if let range = text.range(of: #"(?i)\s+to\s+(my\s+)?library\b"#, options: .regularExpression) {
            let query = String(text[..<range.lowerBound])
            return (cleanMusicQuery(query), nil)
        }

        text = text.replacingOccurrences(of: #"(?i)\bto my music\b"#, with: " ", options: .regularExpression)
        return (cleanMusicQuery(text), nil)
    }

    private func cleanPlaylistName(_ text: String) -> String {
        text.replacingOccurrences(of: #"(?i)\bplaylist\b"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)^(called|named|titled)\s+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    }

    private func normalizeMusicText(_ text: String) -> String {
        text.lowercased()
            .replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func answerNativeHealthRequest(_ message: String) async -> NativeLocalActionResult? {
        let lower = message.lowercased()
        let isHealthRequest = lower.contains("health")
            || lower.contains("steps")
            || lower.contains("step count")
            || lower.contains("heart rate")
            || lower.contains("bpm")
            || lower.contains("resting heart")
            || lower.contains("sleep")
            || lower.contains("slept")
            || lower.contains("workout")
            || lower.contains("workouts")
            || lower.contains("exercise")
        guard isHealthRequest else { return nil }

        guard HKHealthStore.isHealthDataAvailable() else {
            return NativeLocalActionResult(
                action: "check_health",
                text: "Health data is not available on this device.",
                cardText: "HealthKit unavailable",
                actionSummary: "Health unavailable",
                deepLink: nil
            )
        }

        await requestHealthPermission()
        let snapshot = await healthSnapshot()

        if lower.contains("steps") || lower.contains("step count") {
            let range = healthDateRange(from: lower)
            guard let steps = await stepCount(start: range.start, end: range.end) else {
                return noHealthDataResult("steps \(range.label)")
            }
            let count = Int(steps.rounded())
            return NativeLocalActionResult(
                action: "check_health",
                text: "Apple Health shows \(count.formatted()) steps \(range.label).",
                cardText: "\(count.formatted()) steps \(range.label)",
                actionSummary: "Steps checked",
                deepLink: "x-apple-health://"
            )
        }

        if lower.contains("sleep") || lower.contains("slept") {
            guard let minutes = snapshot.sleepMinutesLastNight else {
                return noHealthDataResult("sleep last night")
            }
            let formatted = formatDurationMinutes(minutes)
            return NativeLocalActionResult(
                action: "check_health",
                text: "Apple Health shows \(formatted) of sleep for your latest overnight sleep window.",
                cardText: "\(formatted) sleep",
                actionSummary: "Sleep checked",
                deepLink: "x-apple-health://"
            )
        }

        if lower.contains("heart rate") || lower.contains("bpm") || lower.contains("resting heart") {
            let latest = snapshot.latestHeartRate.map { "\(Int($0.rounded())) bpm" }
            let resting = snapshot.restingHeartRate.map { "resting \(Int($0.rounded())) bpm" }
            let parts = [latest, resting].compactMap { $0 }
            guard !parts.isEmpty else {
                return noHealthDataResult("heart rate")
            }
            return NativeLocalActionResult(
                action: "check_health",
                text: "Your latest Health heart data is \(parts.joined(separator: ", ")).",
                cardText: parts.joined(separator: " · "),
                actionSummary: "Heart checked",
                deepLink: "x-apple-health://"
            )
        }

        if lower.contains("workout") || lower.contains("workouts") || lower.contains("exercise") {
            let workouts = snapshot.recentWorkouts ?? []
            guard !workouts.isEmpty else {
                return noHealthDataResult("recent workouts")
            }
            let first = workouts[0]
            let text = "Your latest workout was \(first.activity.lowercased()) for \(formatDurationMinutes(first.durationMinutes))."
            let detail = workouts.prefix(3).map(formatWorkoutSummary).joined(separator: "\n")
            return NativeLocalActionResult(
                action: "check_health",
                text: text,
                cardText: detail,
                actionSummary: "Workouts checked",
                deepLink: "x-apple-health://"
            )
        }

        let parts = [
            snapshot.stepCountToday.map { "\(Int($0.rounded()).formatted()) steps today" },
            snapshot.sleepMinutesLastNight.map { "\(formatDurationMinutes($0)) sleep" },
            snapshot.latestHeartRate.map { "\(Int($0.rounded())) bpm latest heart rate" },
            snapshot.recentWorkouts?.first.map { "latest workout: \($0.activity.lowercased()), \(formatDurationMinutes($0.durationMinutes))" }
        ].compactMap { $0 }
        guard !parts.isEmpty else {
            return noHealthDataResult("Health")
        }
        return NativeLocalActionResult(
            action: "check_health",
            text: "Here is your latest Health snapshot: \(parts.joined(separator: "; ")).",
            cardText: parts.joined(separator: "\n"),
            actionSummary: "Health checked",
            deepLink: "x-apple-health://"
        )
    }

    private func noHealthDataResult(_ label: String) -> NativeLocalActionResult {
        NativeLocalActionResult(
            action: "check_health",
            text: "I could not read \(label) from Health yet. Open Health permissions for Oxy, then try again.",
            cardText: "Enable Health access for Oxy",
            actionSummary: "Health needs access",
            deepLink: "x-apple-health://"
        )
    }

    private func requestHealthPermission() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let identifiers: [HKQuantityTypeIdentifier] = [.heartRate, .restingHeartRate, .stepCount]
        let quantityTypes = identifiers.compactMap { HKObjectType.quantityType(forIdentifier: $0) }
        let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
        let workoutType = HKObjectType.workoutType()
        var readTypes = Set<HKObjectType>(quantityTypes)
        if let sleepType { readTypes.insert(sleepType) }
        readTypes.insert(workoutType)
        do {
            try await healthStore.requestAuthorization(toShare: [], read: readTypes)
        } catch {}
    }

    private func requestContactsPermission() async {
        _ = try? await contactStore.requestAccess(for: .contacts)
    }

    private func requestReminderPermission() async {
        if #available(iOS 17.0, *) {
            _ = try? await eventStore.requestFullAccessToReminders()
        } else {
            _ = try? await eventStore.requestAccess(to: .reminder)
        }
    }

    private func requestCalendarPermission() async {
        if #available(iOS 17.0, *) {
            _ = try? await eventStore.requestFullAccessToEvents()
        } else {
            _ = try? await eventStore.requestAccess(to: .event)
        }
    }

    private func nativeCapabilities() async -> NativeCapabilities {
        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        let contactStatus = CNContactStore.authorizationStatus(for: .contacts)
        let reminderStatus = EKEventStore.authorizationStatus(for: .reminder)
        let locationStatus = LocationManager.shared.authorizationStatus
        let remindersAuthorized: Bool
        if #available(iOS 17.0, *) {
            remindersAuthorized = reminderStatus == .fullAccess || reminderStatus == .writeOnly
        } else {
            remindersAuthorized = reminderStatus == .authorized
        }
        return NativeCapabilities(
            notifications: notificationSettings.authorizationStatus == .authorized || notificationSettings.authorizationStatus == .provisional,
            healthKit: HKHealthStore.isHealthDataAvailable(),
            musicKit: MusicAuthorization.currentStatus == .authorized,
            contacts: contactStatus == .authorized,
            reminders: remindersAuthorized,
            locationAlways: locationStatus == .authorizedAlways
        )
    }

    private func healthSnapshot() async -> NativeHealthSnapshot {
        guard HKHealthStore.isHealthDataAvailable() else { return NativeHealthSnapshot() }
        return NativeHealthSnapshot(
            latestHeartRate: await latestQuantity(.heartRate, unit: HKUnit.count().unitDivided(by: .minute())),
            restingHeartRate: await latestQuantity(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute())),
            stepCountToday: await sumQuantityToday(.stepCount, unit: .count()),
            sleepMinutesLastNight: await sleepMinutesLastNight(),
            recentWorkouts: await recentWorkouts(limit: 3)
        )
    }

    private func latestQuantity(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit) async -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return nil }
        return await withCheckedContinuation { continuation in
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
            let query = HKSampleQuery(sampleType: type, predicate: nil, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                let value = (samples?.first as? HKQuantitySample)?.quantity.doubleValue(for: unit)
                continuation.resume(returning: value)
            }
            healthStore.execute(query)
        }
    }

    private func sumQuantityToday(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit) async -> Double? {
        if identifier == .stepCount {
            return await stepCount(start: Calendar.current.startOfDay(for: Date()), end: Date())
        }
        return await sumQuantity(identifier, unit: unit, start: Calendar.current.startOfDay(for: Date()), end: Date())
    }

    private func sumQuantity(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, start: Date, end: Date) async -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return nil }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        return await withCheckedContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, stats, _ in
                continuation.resume(returning: stats?.sumQuantity()?.doubleValue(for: unit))
            }
            healthStore.execute(query)
        }
    }

    private func stepCount(start: Date, end: Date) async -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: .stepCount), end > start else { return nil }
        let calendar = Calendar.current
        let anchorDate = calendar.startOfDay(for: start)
        var interval = DateComponents()
        interval.day = 1

        return await withCheckedContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: nil,
                options: .cumulativeSum,
                anchorDate: anchorDate,
                intervalComponents: interval
            )
            query.initialResultsHandler = { _, collection, _ in
                guard let collection else {
                    continuation.resume(returning: nil)
                    return
                }
                var total = 0.0
                collection.enumerateStatistics(from: start, to: end) { statistics, _ in
                    total += statistics.sumQuantity()?.doubleValue(for: .count()) ?? 0
                }
                continuation.resume(returning: total)
            }
            healthStore.execute(query)
        }
    }

    private func healthDateRange(from lower: String) -> (start: Date, end: Date, label: String) {
        let calendar = Calendar.current
        let now = Date()
        let todayStart = calendar.startOfDay(for: now)

        if lower.contains("yesterday") {
            let start = calendar.date(byAdding: .day, value: -1, to: todayStart) ?? todayStart
            return (start, todayStart, "yesterday")
        }

        if lower.contains("this morning") {
            let noon = calendar.date(byAdding: .hour, value: 12, to: todayStart) ?? now
            return (todayStart, min(noon, now), "this morning")
        }

        return (todayStart, now, "today")
    }

    private func sleepMinutesLastNight() async -> Double? {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return nil }
        let calendar = Calendar.current
        let now = Date()
        let todayStart = calendar.startOfDay(for: now)
        let broadStart = calendar.date(byAdding: .hour, value: -54, to: todayStart) ?? calendar.date(byAdding: .day, value: -2, to: now) ?? now
        let predicate = HKQuery.predicateForSamples(withStart: broadStart, end: now, options: .strictEndDate)
        return await withCheckedContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                let sleepSamples = (samples as? [HKCategorySample] ?? [])
                    .filter { Self.isAsleepSample($0) }

                let candidateMinutes = [0, -1, -2].compactMap { dayOffset -> Double? in
                    guard let dayStart = calendar.date(byAdding: .day, value: dayOffset, to: todayStart),
                          let windowStart = calendar.date(byAdding: .hour, value: -6, to: dayStart),
                          let plannedWindowEnd = calendar.date(byAdding: .hour, value: 18, to: dayStart) else {
                        return nil
                    }
                    let windowEnd = min(plannedWindowEnd, now)
                    let intervals = sleepSamples.compactMap { sample -> (Date, Date)? in
                        let start = max(sample.startDate, windowStart)
                        let end = min(sample.endDate, windowEnd)
                        guard end > start else { return nil }
                        return (start, end)
                    }
                    return Self.mergedMinutes(intervals)
                }

                let latestMeaningful = candidateMinutes.first { $0 >= 90 }
                let fallback = candidateMinutes.max()
                let minutes = latestMeaningful ?? fallback ?? 0
                continuation.resume(returning: minutes > 0 ? minutes : nil)
            }
            healthStore.execute(query)
        }
    }

    private nonisolated static func isAsleepSample(_ sample: HKCategorySample) -> Bool {
        sample.value == HKCategoryValueSleepAnalysis.asleepCore.rawValue
            || sample.value == HKCategoryValueSleepAnalysis.asleepDeep.rawValue
            || sample.value == HKCategoryValueSleepAnalysis.asleepREM.rawValue
            || sample.value == HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue
    }

    private nonisolated static func mergedMinutes(_ intervals: [(Date, Date)]) -> Double {
        let sorted = intervals.sorted { $0.0 < $1.0 }
        var merged: [(Date, Date)] = []
        for interval in sorted {
            guard let last = merged.last else {
                merged.append(interval)
                continue
            }
            if interval.0 <= last.1 {
                merged[merged.count - 1] = (last.0, max(last.1, interval.1))
            } else {
                merged.append(interval)
            }
        }
        return merged.reduce(0.0) { total, interval in
            total + interval.1.timeIntervalSince(interval.0) / 60.0
        }
    }

    private func recentWorkouts(limit: Int) async -> [NativeWorkoutSummary] {
        let type = HKObjectType.workoutType()
        let start = Calendar.current.date(byAdding: .day, value: -14, to: Date()) ?? Date()
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date())
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
        return await withCheckedContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: limit, sortDescriptors: [sort]) { _, samples, _ in
                let workouts = (samples as? [HKWorkout] ?? []).map { workout in
                    NativeWorkoutSummary(
                        activity: workout.workoutActivityType.displayName,
                        durationMinutes: workout.duration / 60.0,
                        energyKilocalories: workout.totalEnergyBurned?.doubleValue(for: .kilocalorie()),
                        distanceMeters: workout.totalDistance?.doubleValue(for: .meter()),
                        endedAt: workout.endDate
                    )
                }
                continuation.resume(returning: workouts)
            }
            healthStore.execute(query)
        }
    }

    private func contactHints(in message: String) async -> [NativeContactHint] {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized:
            break
        case .notDetermined:
            guard (try? await contactStore.requestAccess(for: .contacts)) == true else { return [] }
        default:
            return []
        }

        let query = message.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        guard !query.isEmpty else { return [] }
        return await withTaskGroup(of: [NativeContactHint].self) { group in
            group.addTask {
                Self.lookupContacts(matching: query)
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                return []
            }
            let result = await group.next() ?? []
            group.cancelAll()
            return result
        }
    }

    private nonisolated static func lookupContacts(matching query: String) -> [NativeContactHint] {
        let keys: [CNKeyDescriptor] = [
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactNicknameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor
        ]
        let lower = query.lowercased()
        let store = CNContactStore()

        func hint(from contact: CNContact) -> NativeContactHint {
            let names = [
                "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespaces),
                contact.givenName,
                contact.familyName,
                contact.nickname
            ].filter { !$0.isEmpty }
            return NativeContactHint(
                displayName: names.first ?? "Contact",
                phone: contact.phoneNumbers.first?.value.stringValue,
                email: contact.emailAddresses.first.map { String($0.value) }
            )
        }

        func ranked(_ hints: [NativeContactHint]) -> [NativeContactHint] {
            hints.sorted { lhs, rhs in
                let lhsHasPhone = lhs.phone?.isEmpty == false
                let rhsHasPhone = rhs.phone?.isEmpty == false
                if lhsHasPhone != rhsHasPhone { return lhsHasPhone }
                let lhsExact = lhs.displayName.lowercased() == lower
                let rhsExact = rhs.displayName.lowercased() == lower
                if lhsExact != rhsExact { return lhsExact }
                return lhs.displayName.count < rhs.displayName.count
            }
        }

        do {
            let predicate = CNContact.predicateForContacts(matchingName: query)
            let contacts = try store.unifiedContacts(matching: predicate, keysToFetch: keys)
            let hints = ranked(contacts.map(hint))
            if !hints.isEmpty {
                return Array(hints.prefix(5))
            }
        } catch {}

        let request = CNContactFetchRequest(keysToFetch: keys)
        var matches: [NativeContactHint] = []
        do {
            try store.enumerateContacts(with: request) { contact, stop in
                let names = [
                    contact.givenName,
                    contact.familyName,
                    "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespaces),
                    contact.nickname
                ].filter { !$0.isEmpty }
                guard names.contains(where: { name in
                    let normalized = name.lowercased()
                    return normalized == lower || normalized.contains(lower) || lower.contains(normalized)
                }) else { return }
                matches.append(hint(from: contact))
                if matches.count >= 5 { stop.pointee = true }
            }
        } catch {
            return []
        }
        return ranked(matches)
    }

    private func isLocalPlaceRequest(_ text: String) -> Bool {
        let lower = text.lowercased()
        return lower.contains("nearest")
            || lower.contains("closest")
            || lower.contains("near me")
            || lower.contains("nearby")
            || lower.hasPrefix("where is")
            || lower.hasPrefix("where's")
    }

    private func shouldUseNativePlaceSearch(_ text: String) -> Bool {
        let lower = text.lowercased()
        return lower.contains("open maps")
            || lower.contains("open in maps")
            || lower.contains("show me on maps")
            || lower.contains("apple maps")
    }

    private func isContactResolutionRequest(_ text: String) -> Bool {
        let lower = text.lowercased()
        return lower.contains("text ")
            || lower.contains("message ")
            || lower.contains("call ")
            || lower.contains("facetime")
            || lower.contains("email ")
            || lower.contains("send ")
    }

    private func contactQuery(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = trimmed.range(of: #"(?i)\bto\s+([A-Za-z][A-Za-z .'-]{1,60})(?:[?.!]|$)"#, options: .regularExpression) {
            var contact = String(trimmed[range])
            contact = contact.replacingOccurrences(of: #"(?i)^\s*to\s+"#, with: "", options: .regularExpression)
            return contact.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        }
        return trimmed
    }

    private func findNativePlace(for message: String) async -> NativeLocalActionResult? {
        guard let place = await searchPlace(for: message) else { return nil }
        let distance = place.distanceMeters.map(formatDistance) ?? ""
        let text = "I found \(place.name)\(place.address.isEmpty ? "" : ", \(place.address)")\(distance.isEmpty ? "." : ", \(distance) away.")"
        let detail = [place.address, distance.isEmpty ? nil : "\(distance) away"].compactMap { $0 }.joined(separator: " · ")
        return NativeLocalActionResult(
            action: "find_place",
            text: text,
            cardText: detail.isEmpty ? "Open in Maps" : detail,
            actionSummary: "Place found",
            deepLink: place.mapURL.absoluteString
        )
    }

    private func searchPlace(for message: String) async -> NativePlaceResult? {
        let query = cleanPlaceQuery(message)
        guard !query.isEmpty else { return nil }
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        let origin = LocationManager.shared.lastLocation
        if let origin {
            request.region = MKCoordinateRegion(center: origin.coordinate, latitudinalMeters: 25_000, longitudinalMeters: 25_000)
        }
        guard let response = try? await MKLocalSearch(request: request).start() else { return nil }
        let sortedItems = response.mapItems.sorted { lhs, rhs in
            guard let origin else { return false }
            let left = CLLocation(latitude: lhs.placemark.coordinate.latitude, longitude: lhs.placemark.coordinate.longitude).distance(from: origin)
            let right = CLLocation(latitude: rhs.placemark.coordinate.latitude, longitude: rhs.placemark.coordinate.longitude).distance(from: origin)
            return left < right
        }
        guard let item = sortedItems.first else { return nil }

        let placemark = item.placemark
        let address = [placemark.thoroughfare, placemark.locality, placemark.postalCode]
            .compactMap { $0 }
            .joined(separator: ", ")
        let distance = origin.map { CLLocation(latitude: placemark.coordinate.latitude, longitude: placemark.coordinate.longitude).distance(from: $0) }
        let label = (item.name ?? query).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let url = URL(string: "https://maps.apple.com/?ll=\(placemark.coordinate.latitude),\(placemark.coordinate.longitude)&q=\(label)")!
        return NativePlaceResult(
            name: item.name ?? query,
            address: address,
            distanceMeters: distance,
            mapURL: url
        )
    }

    private func cleanPlaceQuery(_ message: String) -> String {
        var text = message.lowercased()
        let replacements = [
            "can you tell me where the",
            "where's the",
            "where is the",
            "nearest",
            "closest",
            "near me",
            "nearby",
            "directions to",
            "navigate to",
            "route to",
            "bus to",
            "buses to",
            "get me to",
            "i need to be at",
            "what bus can i take"
        ]
        for replacement in replacements {
            text = text.replacingOccurrences(of: replacement, with: " ")
        }
        text = text.replacingOccurrences(of: "\\bby\\b", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\bis\\b", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\b\\d{1,2}:\\d{2}\\b", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    }

    private func createNativeReminder(from message: String) async -> NativeLocalActionResult? {
        let lower = message.lowercased()
        guard lower.hasPrefix("remind me") || lower.hasPrefix("reminder") || lower.hasPrefix("create a reminder") else { return nil }
        await requestReminderPermission()
        guard remindersAuthorized else {
            return NativeLocalActionResult(action: "create_reminder", text: "Turn on Reminders access and I can create that natively.", cardText: "Enable Reminders access", actionSummary: "Reminder needs access", deepLink: nil)
        }

        let parsedDate = detectedDate(in: message)
        let title = cleanReminderTitle(message, date: parsedDate)
        guard !title.isEmpty else { return nil }
        let reminder = EKReminder(eventStore: eventStore)
        reminder.title = title
        reminder.calendar = eventStore.defaultCalendarForNewReminders()
        if let parsedDate {
            reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: parsedDate)
            let alarm = EKAlarm(absoluteDate: parsedDate)
            reminder.addAlarm(alarm)
        }
        do {
            try eventStore.save(reminder, commit: true)
            let timeText = parsedDate.map { DateFormatter.localizedString(from: $0, dateStyle: .none, timeStyle: .short) }
            return NativeLocalActionResult(
                action: "create_reminder",
                text: timeText.map { "Reminder set for \($0): \(title)." } ?? "Reminder set: \(title).",
                cardText: timeText.map { "\(title) · \($0)" } ?? title,
                actionSummary: "Reminder created",
                deepLink: "x-apple-reminderkit://"
            )
        } catch {
            return nil
        }
    }

    private func createNativeCalendarEvent(from message: String) async -> NativeLocalActionResult? {
        let lower = message.lowercased()
        guard lower.contains("calendar") || lower.contains("add event") || lower.contains("schedule") else { return nil }
        await requestCalendarPermission()
        guard calendarAuthorized else {
            return NativeLocalActionResult(action: "create_calendar_event", text: "Turn on Calendar access and I can create that natively.", cardText: "Enable Calendar access", actionSummary: "Calendar needs access", deepLink: nil)
        }
        guard let start = detectedDate(in: message) else { return nil }
        let title = cleanCalendarTitle(message, date: start)
        guard !title.isEmpty else { return nil }
        let event = EKEvent(eventStore: eventStore)
        event.title = title
        event.startDate = start
        event.endDate = Calendar.current.date(byAdding: .hour, value: 1, to: start) ?? start.addingTimeInterval(3600)
        event.calendar = eventStore.defaultCalendarForNewEvents
        do {
            try eventStore.save(event, span: .thisEvent, commit: true)
            let timeText = DateFormatter.localizedString(from: start, dateStyle: .medium, timeStyle: .short)
            return NativeLocalActionResult(
                action: "create_calendar_event",
                text: "Added \(title) to Calendar for \(timeText).",
                cardText: "\(title) · \(timeText)",
                actionSummary: "Calendar updated",
                deepLink: "calshow://"
            )
        } catch {
            return nil
        }
    }

    private var remindersAuthorized: Bool {
        let status = EKEventStore.authorizationStatus(for: .reminder)
        if #available(iOS 17.0, *) {
            return status == .fullAccess || status == .writeOnly
        }
        return status == .authorized
    }

    private var calendarAuthorized: Bool {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) {
            return status == .fullAccess || status == .writeOnly
        }
        return status == .authorized
    }

    private func detectedDate(in message: String) -> Date? {
        let range = NSRange(message.startIndex..<message.endIndex, in: message)
        return detector?.firstMatch(in: message, options: [], range: range)?.date
    }

    private func cleanReminderTitle(_ message: String, date: Date?) -> String {
        var title = message
            .replacingOccurrences(of: #"(?i)^remind me to\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)^remind me\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)^create a reminder to\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)^reminder to\s+"#, with: "", options: .regularExpression)
        if let match = dateMatch(in: message) {
            title = title.replacingOccurrences(of: match, with: "")
        }
        return title.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    }

    private func cleanCalendarTitle(_ message: String, date: Date?) -> String {
        var title = message
            .replacingOccurrences(of: #"(?i)add\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)to (my )?calendar"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)schedule\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)event\s+"#, with: "", options: .regularExpression)
        if let match = dateMatch(in: message) {
            title = title.replacingOccurrences(of: match, with: "")
        }
        return title.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    }

    private func dateMatch(in message: String) -> String? {
        let range = NSRange(message.startIndex..<message.endIndex, in: message)
        guard let match = detector?.firstMatch(in: message, options: [], range: range),
              let swiftRange = Range(match.range, in: message) else { return nil }
        return String(message[swiftRange])
    }

    private func formatDistance(_ meters: CLLocationDistance) -> String {
        if meters < 1000 {
            return "\(Int(meters.rounded())) m"
        }
        return String(format: "%.1f km", meters / 1000)
    }

    private func formatDurationMinutes(_ minutes: Double) -> String {
        let total = max(0, Int(minutes.rounded()))
        let hours = total / 60
        let remainder = total % 60
        if hours > 0 && remainder > 0 {
            return "\(hours)h \(remainder)m"
        }
        if hours > 0 {
            return "\(hours)h"
        }
        return "\(remainder)m"
    }

    private func formatWorkoutSummary(_ workout: NativeWorkoutSummary) -> String {
        let date = DateFormatter.localizedString(from: workout.endedAt, dateStyle: .short, timeStyle: .none)
        var parts = ["\(workout.activity)", formatDurationMinutes(workout.durationMinutes)]
        if let energy = workout.energyKilocalories {
            parts.append("\(Int(energy.rounded())) kcal")
        }
        if let distance = workout.distanceMeters, distance > 0 {
            parts.append(formatDistance(distance))
        }
        return "\(date): \(parts.joined(separator: " · "))"
    }

    private func loadSettings() -> OxySettings {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            return saved
        }
        return OxySettings()
    }

    private func saveSettings(_ settings: OxySettings) {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: "oxy_settings")
        }
    }
}

private extension Encodable {
    var dictionary: [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return object
    }
}

extension OxySettings {
    var nativeDictionary: [String: Any] {
        var dict = dictionary
        if let homeLatitude, let homeLongitude {
            dict["homeLocation"] = ["latitude": homeLatitude, "longitude": homeLongitude]
        }
        return dict
    }
}

private extension HKWorkoutActivityType {
    var displayName: String {
        switch self {
        case .running: return "Run"
        case .walking: return "Walk"
        case .cycling: return "Cycle"
        case .traditionalStrengthTraining: return "Strength training"
        case .functionalStrengthTraining: return "Functional strength"
        case .highIntensityIntervalTraining: return "HIIT"
        case .yoga: return "Yoga"
        case .swimming: return "Swim"
        case .dance: return "Dance"
        case .mindAndBody: return "Mind and body"
        case .coreTraining: return "Core training"
        case .pilates: return "Pilates"
        case .rowing: return "Rowing"
        case .elliptical: return "Elliptical"
        case .stairClimbing: return "Stair climbing"
        case .soccer: return "Football"
        case .basketball: return "Basketball"
        case .tennis: return "Tennis"
        case .other: return "Workout"
        default: return "Workout"
        }
    }
}

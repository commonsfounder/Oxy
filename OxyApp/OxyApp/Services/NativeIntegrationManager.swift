import Contacts
import CoreLocation
import EventKit
import Foundation
import HealthKit
import MapKit
import MediaPlayer
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

struct NativeLocalActionResult: Equatable {
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
            let contacts = await contactHints(in: message)
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
        if lower.contains("uber") || lower.contains("taxi") || lower.contains("ride") {
            return nil
        }

        if let result = await handleNativeMusicRequest(normalized) {
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

    private func handleNativeMusicRequest(_ message: String) async -> NativeLocalActionResult? {
        let lower = message.lowercased()
        guard lower.contains("music")
            || lower.contains("song")
            || lower.contains("playlist")
            || lower.hasPrefix("play ")
            || lower.hasPrefix("listen to ")
            || lower.hasPrefix("add ") else { return nil }

        if lower.contains("playlist") || lower.hasPrefix("add ") {
            return await addNativeMusicItem(from: message)
        }
        return await playNativeMusic(from: message)
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

    private func playNativeMusic(from message: String) async -> NativeLocalActionResult? {
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

        let query = resolvedMusicQuery(from: message)
        guard !query.isEmpty else { return nil }

        do {
            guard let song = try await searchCatalogSong(query) else {
                return NativeLocalActionResult(
                    action: "play_music",
                    text: "I couldn't find that song in Apple Music.",
                    cardText: query,
                    actionSummary: "Music not found",
                    deepLink: "music://",
                    success: false,
                    error: "No Apple Music catalog result for \(query)."
                )
            }
            do {
                let player = SystemMusicPlayer.shared
                player.queue = SystemMusicPlayer.Queue(for: [song])
                try await player.play()
            } catch {
                try await playWithMediaPlayer(song)
            }
            lastMusicQuery = "\(song.title) \(song.artistName)"
            return NativeLocalActionResult(
                action: "play_music",
                text: "Playing \(song.title) by \(song.artistName).",
                cardText: "\(song.title) · \(song.artistName)",
                actionSummary: "Music playing",
                deepLink: song.url?.absoluteString ?? "music://"
            )
        } catch {
            return NativeLocalActionResult(
                action: "play_music",
                text: "Apple Music couldn't play that yet. Check Music access and your Apple Music subscription.",
                cardText: query,
                actionSummary: "Music failed",
                deepLink: nil,
                success: false,
                error: String(describing: error)
            )
        }
    }

    private func playWithMediaPlayer(_ song: Song) async throws {
        let storeID = song.id.rawValue
        guard !storeID.isEmpty else {
            throw NSError(domain: "OxyMusic", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing Apple Music store ID"])
        }
        let player = MPMusicPlayerController.systemMusicPlayer
        player.setQueue(with: [storeID])
        player.play()
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

        let parsed = parseMusicAddRequest(message)
        guard !parsed.query.isEmpty else { return nil }

        do {
            guard let song = try await searchCatalogSong(parsed.query) else {
                return NativeLocalActionResult(
                    action: "add_to_music_playlist",
                    text: "I couldn't find \(parsed.query) in Apple Music.",
                    cardText: parsed.query,
                    actionSummary: "Music not found",
                    deepLink: "music://",
                    success: false,
                    error: "No Apple Music catalog result for \(parsed.query)."
                )
            }

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
        } catch {
            return NativeLocalActionResult(
                action: "add_to_music_playlist",
                text: "Apple Music couldn't add that yet. Check Music access and try again.",
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
        let normalized = normalizeMusicText(query)
        if ["it", "that", "this", "that one", "this one"].contains(normalized),
           let lastMusicQuery,
           !lastMusicQuery.isEmpty {
            return lastMusicQuery
        }
        return query
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
            guard let steps = snapshot.stepCountToday else {
                return noHealthDataResult("steps today")
            }
            let count = Int(steps.rounded())
            return NativeLocalActionResult(
                action: "check_health",
                text: "You have \(count.formatted()) steps today.",
                cardText: "\(count.formatted()) steps today",
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
                text: "Health shows \(formatted) of sleep from the latest overnight window.",
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
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return nil }
        let start = Calendar.current.startOfDay(for: Date())
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date())
        return await withCheckedContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, stats, _ in
                continuation.resume(returning: stats?.sumQuantity()?.doubleValue(for: unit))
            }
            healthStore.execute(query)
        }
    }

    private func sleepMinutesLastNight() async -> Double? {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return nil }
        let start = Calendar.current.date(byAdding: .hour, value: -18, to: Date()) ?? Date()
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date())
        return await withCheckedContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                let minutes = (samples as? [HKCategorySample] ?? [])
                    .filter { $0.value == HKCategoryValueSleepAnalysis.asleepCore.rawValue || $0.value == HKCategoryValueSleepAnalysis.asleepDeep.rawValue || $0.value == HKCategoryValueSleepAnalysis.asleepREM.rawValue || $0.value == HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue }
                    .reduce(0.0) { $0 + $1.endDate.timeIntervalSince($1.startDate) / 60.0 }
                continuation.resume(returning: minutes > 0 ? minutes : nil)
            }
            healthStore.execute(query)
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
        guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else { return [] }
        let keys: [CNKeyDescriptor] = [
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactNicknameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        var matches: [NativeContactHint] = []
        let lower = message.lowercased()

        do {
            try contactStore.enumerateContacts(with: request) { contact, stop in
                let names = [
                    contact.givenName,
                    contact.familyName,
                    "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespaces),
                    contact.nickname
                ].filter { !$0.isEmpty }
                guard names.contains(where: { lower.contains($0.lowercased()) }) else { return }
                matches.append(NativeContactHint(
                    displayName: CNContactFormatter.string(from: contact, style: .fullName) ?? names.first ?? "Contact",
                    phone: contact.phoneNumbers.first?.value.stringValue,
                    email: contact.emailAddresses.first.map { String($0.value) }
                ))
                if matches.count >= 5 { stop.pointee = true }
            }
        } catch {
            return []
        }
        return matches
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
        guard let response = try? await MKLocalSearch(request: request).start(),
              let item = response.mapItems.first else { return nil }

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

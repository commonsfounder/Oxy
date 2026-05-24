import Contacts
import CoreLocation
import EventKit
import Foundation
import HealthKit
import UIKit
import UserNotifications

struct NativeHealthSnapshot: Codable {
    var latestHeartRate: Double?
    var restingHeartRate: Double?
    var stepCountToday: Double?
    var sleepMinutesLastNight: Double?
}

struct NativeCapabilities: Codable {
    var notifications: Bool
    var healthKit: Bool
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

    private func requestHealthPermission() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let identifiers: [HKQuantityTypeIdentifier] = [.heartRate, .restingHeartRate, .stepCount]
        let quantityTypes = identifiers.compactMap { HKObjectType.quantityType(forIdentifier: $0) }
        let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
        var readTypes = Set<HKObjectType>(quantityTypes)
        if let sleepType { readTypes.insert(sleepType) }
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

    private func nativeCapabilities() async -> NativeCapabilities {
        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        let contactStatus = CNContactStore.authorizationStatus(for: .contacts)
        let reminderStatus = EKEventStore.authorizationStatus(for: .reminder)
        let locationStatus = LocationManager.shared.authorizationStatus
        return NativeCapabilities(
            notifications: notificationSettings.authorizationStatus == .authorized || notificationSettings.authorizationStatus == .provisional,
            healthKit: HKHealthStore.isHealthDataAvailable(),
            contacts: contactStatus == .authorized,
            reminders: reminderStatus == .authorized || reminderStatus == .fullAccess,
            locationAlways: locationStatus == .authorizedAlways
        )
    }

    private func healthSnapshot() async -> NativeHealthSnapshot {
        guard HKHealthStore.isHealthDataAvailable() else { return NativeHealthSnapshot() }
        return NativeHealthSnapshot(
            latestHeartRate: await latestQuantity(.heartRate, unit: HKUnit.count().unitDivided(by: .minute())),
            restingHeartRate: await latestQuantity(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute())),
            stepCountToday: await sumQuantityToday(.stepCount, unit: .count()),
            sleepMinutesLastNight: await sleepMinutesLastNight()
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

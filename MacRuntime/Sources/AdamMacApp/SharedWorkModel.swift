import AdamMacRuntime
import AVFoundation
import Foundation
import Security

@MainActor
final class SharedWorkModel: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var identifier = ""
    @Published var password = ""
    @Published var input = ""
    @Published private(set) var userID: String?
    @Published private(set) var tasks: [SharedWorkTask] = []
    @Published private(set) var selected: SharedWorkTask?
    @Published private(set) var status = "Sign in with the account on your phone."
    @Published private(set) var busy = false
    @Published private(set) var speaking = false
    @Published private(set) var delivery: SpokenDelivery?
    var speechAllowed = true

    private var client: SharedWorkClient?
    private let speech = AVSpeechSynthesizer()
    private var activeUtterance: AVSpeechUtterance?
    private var speechOffset = 0
    private var generation = UUID()
    private let baseURL: URL
    private var storageKey: String { "AdamSharedWork:" + baseURL.absoluteString + ":" + (userID ?? "") }

    private struct SavedState: Codable {
        var taskID: String?
        var delivery: SpokenDelivery?
        var announced: [String]
    }
    private var saved = SavedState(announced: [])

    init(baseURL: URL = URL(string: "https://milgrain-live-2026.fly.dev")!) {
        self.baseURL = baseURL
        super.init()
        speech.delegate = self
        if let session = SharedWorkCredentials.read(server: baseURL.absoluteString) {
            connect(session)
        }
    }

    func signIn() async {
        guard !busy else { return }
        busy = true
        defer { busy = false; password = "" }
        do {
            let unauthenticated = try SharedWorkClient(baseURL: baseURL)
            let session = try await unauthenticated.signIn(identifier: identifier.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            try SharedWorkCredentials.save(session, server: baseURL.absoluteString)
            connect(session)
            await refresh()
        } catch { status = error.localizedDescription }
    }

    private func connect(_ session: SharedWorkSession) {
        generation = UUID()
        userID = session.userId
        client = try? SharedWorkClient(baseURL: baseURL, token: session.token)
        if let data = UserDefaults.standard.data(forKey: storageKey),
           let state = try? JSONDecoder().decode(SavedState.self, from: data) { saved = state }
        delivery = saved.delivery
        status = "Connected"
    }

    func signOut() {
        generation = UUID()
        interrupt()
        SharedWorkCredentials.remove(server: baseURL.absoluteString)
        client = nil
        userID = nil
        selected = nil
        tasks = []
        delivery = nil
        saved = SavedState(announced: [])
        status = "Sign in with the account on your phone."
    }

    func refresh() async {
        guard let client else { return }
        let epoch = generation
        do {
            let fetched = try await client.tasks()
            guard epoch == generation else { return }
            tasks = fetched
            if let id = saved.taskID {
                let task = try await client.task(id: id)
                guard epoch == generation, saved.taskID == id else { return }
                selected = task
                announce(task)
            }
            status = selected?.statusText ?? "Connected"
        } catch {
            guard epoch == generation else { return }
            status = error.localizedDescription
        }
    }

    func select(_ task: SharedWorkTask) {
        interrupt()
        selected = task
        saved.taskID = task.id
        delivery = nil
        saved.delivery = nil
        persist()
        status = task.statusText
        announce(task)
    }

    func submit(_ transcript: String? = nil) async {
        let goal = (transcript ?? input).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, !busy, !goal.isEmpty else { return }
        interrupt()
        busy = true
        let epoch = generation
        defer { busy = false }
        do {
            let task = try await client.create(goal: goal)
            guard epoch == generation else { return }
            input = ""
            select(task)
            try await client.start(id: task.id)
            guard epoch == generation else { return }
            await refresh()
        } catch {
            guard epoch == generation else { return }
            status = error.localizedDescription + " Refresh Work before trying again."
        }
    }

    func startSelected() async {
        guard let client, let task = selected, !busy, !task.awaitingApproval,
              ["pending", "paused", "failed"].contains(task.status) else { return }
        busy = true
        defer { busy = false }
        do {
            try await client.start(id: task.id)
            await refresh()
        } catch { status = error.localizedDescription }
    }

    private func announce(_ task: SharedWorkTask) {
        guard speechAllowed, !speaking, let text = task.spokenUpdate,
              !saved.announced.contains(task.announcementID) else { return }
        // An interrupted update remains resumable until a newer state supersedes it.
        if delivery?.id == task.announcementID { return }
        delivery = SpokenDelivery(id: task.announcementID, text: text)
        saved.delivery = delivery
        persist()
        resumeSpeaking()
    }

    func interrupt() {
        activeUtterance = nil
        speech.stopSpeaking(at: .immediate)
        speaking = false
        saved.delivery = delivery
        persist()
    }

    func resumeSpeaking() {
        guard !speaking, let delivery, !delivery.finished, !delivery.remaining.isEmpty else { return }
        speechOffset = delivery.deliveredUTF16
        let utterance = AVSpeechUtterance(string: delivery.remaining)
        activeUtterance = utterance
        speaking = true
        speech.speak(utterance)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, utterance === self.activeUtterance else { return }
            self.delivery?.markDelivered(before: self.speechOffset + range.location)
            self.saved.delivery = self.delivery
            self.persist()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, utterance === self.activeUtterance else { return }
            self.delivery?.complete()
            if let id = self.delivery?.id { self.saved.announced.append(id) }
            self.saved.announced = Array(self.saved.announced.suffix(100))
            self.saved.delivery = self.delivery
            self.activeUtterance = nil
            self.speaking = false
            self.persist()
            if let selected = self.selected { self.announce(selected) }
        }
    }

    private func persist() {
        guard userID != nil, let data = try? JSONEncoder().encode(saved) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }
}

private enum SharedWorkCredentials {
    static func query(server: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "ai.oxy.adam.shared-work",
         kSecAttrAccount as String: server]
    }

    static func read(server: String) -> SharedWorkSession? {
        var attributes = query(server: server)
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(attributes as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(SharedWorkSession.self, from: data)
    }

    static func save(_ session: SharedWorkSession, server: String) throws {
        let data = try JSONEncoder().encode(session)
        var attributes = query(server: server)
        let updates = [kSecValueData as String: data]
        var status = SecItemUpdate(attributes as CFDictionary, updates as CFDictionary)
        if status == errSecItemNotFound {
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(attributes as CFDictionary, nil)
        }
        if status != errSecSuccess { throw SharedWorkError.response(Int(status)) }
    }

    static func remove(server: String) { SecItemDelete(query(server: server) as CFDictionary) }
}

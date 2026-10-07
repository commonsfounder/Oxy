import SwiftUI
import LocalAuthentication

struct VaultView: View {
    @Environment(\.dismiss) private var systemDismiss
    @Environment(\.revealClose) private var revealClose
    private func dismiss() { if let revealClose { revealClose() } else { systemDismiss() } }

    @State private var credentials: [VaultCredentialSummary] = []
    @State private var grants: [VaultGrantSummary] = []
    @State private var uses: [VaultCredentialUse] = []
    @State private var isLoading = true
    @State private var isUnlocked = false
    @State private var errorMessage: String?
    @State private var showEntrySheet = false
    @State private var showGrantSheet = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Saved logins", onBack: revealClose == nil ? { dismiss() } : nil)

                    if !isUnlocked {
                        lockedState
                    } else if isLoading {
                        VStack(spacing: 12) {
                            OxySkeletonCard(height: 72)
                            OxySkeletonCard(height: 72)
                        }
                        .padding(.horizontal, AppSpacing.margin)
                        .padding(.top, 16)
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 28) {
                                if let errorMessage {
                                    ErrorBanner(message: errorMessage, onRetry: { Task { await loadAll() } })
                                }
                                credentialsSection
                                grantsSection
                                activitySection
                            }
                            .padding(.horizontal, AppSpacing.margin)
                            .padding(.vertical, 16)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
            .toolbar(.hidden, for: .navigationBar)
            .task {
                #if DEBUG
                if ProcessInfo.processInfo.environment["OXY_DEBUG_VAULT"] == "1" {
                    let decoder = JSONDecoder()
                    credentials = (try? decoder.decode([VaultCredentialSummary].self, from: Data(#"[{"id":"c1","site":"johnlewis.com","label":"John Lewis","username":"chizi@example.com","updated_at":"2026-10-01T10:00:00Z"},{"id":"c2","site":"tesco.com","label":"Tesco","username":"","updated_at":"2026-10-02T10:00:00Z"}]"#.utf8))) ?? []
                    grants = (try? decoder.decode([VaultGrantSummary].self, from: Data(#"[{"id":"g1","site":"johnlewis.com","scope":"site","max_uses":5,"use_count":1}]"#.utf8))) ?? []
                    uses = (try? decoder.decode([VaultCredentialUse].self, from: Data(#"[{"id":"u1","site":"johnlewis.com","outcome":"used","created_at":"2026-10-05T09:00:00Z"},{"id":"u2","site":"unknown-shop.example","outcome":"denied","reason":"not_permitted","created_at":"2026-10-05T09:30:00Z"}]"#.utf8))) ?? []
                    isUnlocked = true
                    isLoading = false
                    return
                }
                #endif
                await authenticateAndLoad()
            }
            .refreshable { await loadAll() }
            .sheet(isPresented: $showEntrySheet) {
                VaultCredentialEntrySheet { saved in
                    credentials.removeAll { $0.site == saved.site }
                    credentials.insert(saved, at: 0)
                }
            }
            .sheet(isPresented: $showGrantSheet) {
                VaultGrantEntrySheet { granted in
                    grants.insert(granted, at: 0)
                }
            }
        }
    }

    // MARK: - Sections

    private var lockedState: some View {
        VStack(spacing: 18) {
            AdamDot(solid: false, size: 14)
            Text(errorMessage ?? "Use Face ID to see saved logins.")
                .font(.appBody(15))
                .foregroundStyle(Color.appMuted)
                .multilineTextAlignment(.center)
            Button {
                HapticManager.shared.impact(.light)
                Task { await authenticateAndLoad() }
            } label: {
                Text("Unlock")
                    .font(.appBody(15, weight: .medium))
                    .foregroundStyle(Color.appOnAction)
                    .padding(.horizontal, 22)
                    .frame(minHeight: 44)
                    .background(Capsule().fill(Color.appAction))
            }
            .buttonStyle(.appScale(0.97))
        }
        .padding(.horizontal, AppSpacing.margin)
        .padding(.top, 96)
    }

    private func quietAction(_ title: String, role: Color = .appAccent, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            Text(title)
                .font(.appBody(14, weight: .medium))
                .foregroundStyle(role)
                .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.plain)
    }

    private var credentialsSection: some View {
        SettingsGroup(title: "Saved sign-ins") {
            if credentials.isEmpty {
                SettingsStatement(text: "No saved sign-ins", solid: false)
                    .padding(.horizontal, 4)
            } else {
                SettingsList {
                    ForEach(Array(credentials.enumerated()), id: \.element.id) { index, credential in
                        if index > 0 { SettingsRule() }
                        SettingsRow(
                            title: credential.label,
                            subtitle: "\(credential.site) · \(credential.username.isEmpty ? "No username" : credential.username)"
                        ) {
                            quietAction("Remove", role: .appDestructive) {
                                Task { await removeCredential(credential) }
                            }
                        }
                    }
                }
            }
            quietAction("Add a sign-in") { showEntrySheet = true }
                .padding(.horizontal, 4)
        }
    }

    // A saved password is only half the picture: the other half is when Adam may use it
    // without asking first. Those permissions existed as API only, so the one thing a person
    // most needs to be able to undo was the one thing they could not see.
    private var grantsSection: some View {
        SettingsGroup(title: "Sign-in permissions") {
            if grants.isEmpty {
                SettingsStatement(text: "Every sign-in is asked for", solid: false)
                    .padding(.horizontal, 4)
            } else {
                SettingsList {
                    ForEach(Array(grants.enumerated()), id: \.element.id) { index, grant in
                        if index > 0 { SettingsRule() }
                        SettingsRow(title: grant.site, subtitle: grant.detailLine) {
                            if grant.isLive {
                                quietAction("Revoke", role: .appDestructive) {
                                    Task { await revokeGrant(grant) }
                                }
                            }
                        }
                    }
                }
            }
            quietAction("Add a permission") { showGrantSheet = true }
                .padding(.horizontal, 4)
        }
    }

    // Refusals are listed alongside successes on purpose. A denied row is what shows a page
    // trying to steer Adam at a site you never permitted, and it is only visible if it is
    // shown even when nothing went wrong.
    private var activitySection: some View {
        SettingsGroup(title: "Recent sign-in activity") {
            if uses.isEmpty {
                SettingsStatement(text: "Nothing yet", solid: false)
                    .padding(.horizontal, 4)
            } else {
                SettingsList {
                    ForEach(Array(uses.enumerated()), id: \.element.id) { index, use in
                        if index > 0 { SettingsRule() }
                        SettingsRow(title: use.site, subtitle: use.detailLine)
                    }
                }
            }
        }
    }

    // MARK: - Face ID gate

    private func authenticateAndLoad() async {
        let context = LAContext()
        var evalError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &evalError) else {
            await MainActor.run {
                errorMessage = "Face ID isn't available on this device."
                isUnlocked = false
                isLoading = false
            }
            return
        }
        do {
            let success = try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: "Unlock saved sign-ins"
            )
            await MainActor.run { isUnlocked = success }
            if success { await loadAll() }
        } catch {
            await MainActor.run {
                errorMessage = "Face ID unlock failed."
                isUnlocked = false
                isLoading = false
            }
        }
    }

    // MARK: - Networking

    private func loadCredentials() async {
        await MainActor.run { isLoading = true }
        do {
            let data = try await APIClient.shared.request(path: "/vault/credentials")
            let response = try JSONDecoder().decode(VaultCredentialsResponse.self, from: data)
            await MainActor.run {
                credentials = response.credentials
                errorMessage = nil
                isLoading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isLoading = false
            }
        }
    }

    // The permissions and the log are read alongside the credentials rather than lazily on
    // tap: a permission you have to go looking for is not one you will notice is still live.
    private func loadAll() async {
        await loadCredentials()
        await loadGrants()
        await loadUses()
    }

    private func loadGrants() async {
        do {
            let data = try await APIClient.shared.request(path: "/vault/grants")
            let response = try JSONDecoder().decode(VaultGrantsResponse.self, from: data)
            await MainActor.run { grants = response.grants }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    private func loadUses() async {
        do {
            let data = try await APIClient.shared.request(
                path: "/vault/credential-uses",
                queryItems: [URLQueryItem(name: "limit", value: "25")]
            )
            let response = try JSONDecoder().decode(VaultCredentialUsesResponse.self, from: data)
            await MainActor.run { uses = response.uses }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    private func revokeGrant(_ grant: VaultGrantSummary) async {
        do {
            _ = try await APIClient.shared.request(path: "/vault/grants/\(grant.id)", method: "DELETE")
            // Refetched rather than removed locally: a revoked permission stays in the list
            // as revoked, which is the record. Dropping the row would read as "there was
            // never a permission here".
            await loadGrants()
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    private func removeCredential(_ credential: VaultCredentialSummary) async {
        do {
            _ = try await APIClient.shared.request(path: "/vault/credentials/\(credential.id)", method: "DELETE")
            await MainActor.run { withAnimation(.appStandard) { credentials.removeAll { $0.id == credential.id } } }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }
}

// MARK: - Credential entry

private struct VaultCredentialEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    let onSaved: (VaultCredentialSummary) -> Void

    @State private var site = ""
    @State private var label = ""
    @State private var username = ""
    @State private var password = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Site (e.g. delta.com)", text: $site)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField("Label (e.g. Delta SkyMiles)", text: $label)
                    TextField("Username or email", text: $username)
                        .textInputAutocapitalization(.never)
                        .textContentType(.username)
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                } footer: {
                    Text("Encrypted. Used only after you approve sign-in.")
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Add sign-in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!isFormPlausible)
                    }
                }
            }
        }
    }

    private var isFormPlausible: Bool {
        !site.trimmingCharacters(in: .whitespaces).isEmpty
            && !label.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        do {
            let data = try await APIClient.shared.request(
                path: "/vault/credentials",
                method: "POST",
                body: [
                    "site": site.trimmingCharacters(in: .whitespaces),
                    "label": label.trimmingCharacters(in: .whitespaces),
                    "username": username.trimmingCharacters(in: .whitespaces),
                    "password": password
                ]
            )
            let response = try JSONDecoder().decode(VaultCredentialSaveResponse.self, from: data)
            if let saved = response.credential {
                onSaved(saved)
                dismiss()
            } else {
                errorMessage = "The credential couldn't be saved."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isSaving = false
    }
}

// MARK: - Permission entry

// Only standing permissions are created here. A task-scoped one binds to a single browsing
// run and can only be granted in response to Adam asking during that run, so offering it
// on this screen would produce a permission with nothing to attach to.
private struct VaultGrantEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    let onGranted: (VaultGrantSummary) -> Void

    @State private var site = ""
    @State private var lifetime: Lifetime = .week
    @State private var limitUses = false
    @State private var maxUses = 5
    @State private var isSaving = false
    @State private var errorMessage: String?

    enum Lifetime: String, CaseIterable, Identifiable {
        case day, week, month
        var id: String { rawValue }
        var label: String {
            switch self {
            case .day: return "1 day"
            case .week: return "7 days"
            case .month: return "30 days"
            }
        }
        // The server caps a permission at 30 days (MAX_TTL_MINUTES); nothing here may exceed it.
        var minutes: Int {
            switch self {
            case .day: return 1440
            case .week: return 10080
            case .month: return 43200
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Site (e.g. delta.com)", text: $site)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    Picker("Expires after", selection: $lifetime) {
                        ForEach(Lifetime.allCases) { option in
                            Text(option.label).tag(option)
                        }
                    }
                    Toggle("Limit number of sign-ins", isOn: $limitUses)
                    if limitUses {
                        Stepper("At most \(maxUses)", value: $maxUses, in: 1...50)
                    }
                } footer: {
                    Text("Adam signs in to this site without asking, until it expires or you revoke it.")
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Allow sign-in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Allow") { Task { await save() } }
                            .disabled(site.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        var body: [String: Any] = [
            "site": site.trimmingCharacters(in: .whitespaces),
            "scope": "standing",
            "ttlMinutes": lifetime.minutes
        ]
        if limitUses { body["maxUses"] = maxUses }
        do {
            let data = try await APIClient.shared.request(path: "/vault/grants", method: "POST", body: body)
            let response = try JSONDecoder().decode(VaultGrantSaveResponse.self, from: data)
            if let grant = response.grant {
                onGranted(grant)
                dismiss()
            } else {
                errorMessage = "The permission couldn't be saved."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isSaving = false
    }
}

// MARK: - Models

struct VaultCredentialSummary: Codable, Equatable, Identifiable {
    let id: String
    let site: String
    let label: String
    let username: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, site, label, username
        case updatedAt = "updated_at"
    }
}

private struct VaultCredentialsResponse: Codable {
    let credentials: [VaultCredentialSummary]
}

private struct VaultCredentialSaveResponse: Codable {
    let saved: Bool
    let credential: VaultCredentialSummary?
}

struct VaultGrantSummary: Codable, Equatable, Identifiable {
    let id: String
    let site: String
    let scope: String
    let taskId: String?
    let expiresAt: String?
    let maxUses: Int?
    let useCount: Int?
    let revokedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, site, scope
        case taskId = "task_id"
        case expiresAt = "expires_at"
        case maxUses = "max_uses"
        case useCount = "use_count"
        case revokedAt = "revoked_at"
    }

    var isRevoked: Bool { revokedAt != nil }

    var isExpired: Bool {
        guard let expiry = Date.oxyParse(expiresAt) else { return true }
        return expiry <= Date()
    }

    var isExhausted: Bool {
        guard let maxUses else { return false }
        return (useCount ?? 0) >= maxUses
    }

    /// Only a permission that would actually authorise a sign-in right now is worth
    /// offering a Revoke button for; the rest are history.
    var isLive: Bool { !isRevoked && !isExpired && !isExhausted }

    var detailLine: String {
        if isRevoked { return "Revoked" }
        if isExpired { return "Expired" }

        var parts: [String] = [scope == "task" ? "Just this once" : "Until \(Self.expiryText(expiresAt))"]
        if let maxUses {
            parts.append("\(useCount ?? 0) of \(maxUses) used")
        } else if let useCount, useCount > 0 {
            parts.append(useCount == 1 ? "1 sign-in" : "\(useCount) sign-ins")
        }
        return parts.joined(separator: " · ")
    }

    private static func expiryText(_ value: String?) -> String {
        guard let date = Date.oxyParse(value) else { return "—" }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }
}

struct VaultCredentialUse: Codable, Equatable, Identifiable {
    let id: String
    let site: String
    let outcome: String
    let reason: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, site, outcome, reason
        case createdAt = "created_at"
    }

    var detailLine: String {
        var parts: [String] = [Self.outcomeText(outcome, reason: reason)]
        if let when = Self.timeText(createdAt) { parts.append(when) }
        return parts.joined(separator: " · ")
    }

    private static func outcomeText(_ outcome: String, reason: String?) -> String {
        switch outcome {
        case "used": return reason == "stored_session" ? "Reused a saved session" : "Signed in"
        case "failed": return "Sign-in failed"
        case "denied":
            guard let reason, !reason.isEmpty else { return "Refused" }
            return "Refused — " + readable(reason)
        default: return outcome
        }
    }

    // The server's refusal reasons are machine names. Left as-is they would read as a bug
    // report rather than as an answer to "why didn't it sign in?".
    private static func readable(_ reason: String) -> String {
        switch reason {
        case "no_grant": return "no permission set"
        case "revoked": return "permission revoked"
        case "expired": return "permission expired"
        case "use_limit_reached": return "use limit reached"
        case "wrong_task": return "permission was for another task"
        case "site_not_granted", "site_not_requested": return "site not permitted"
        case "not_user_granted": return "permission was not set by you"
        case "use_count_failed": return "could not record the use"
        case "use_count_raced": return "another task was signing in at the same time"
        case "import_refused": return "session import refused"
        case "lookup_failed": return "permission could not be read"
        default: return reason.replacingOccurrences(of: "_", with: " ")
        }
    }

    private static func timeText(_ value: String?) -> String? {
        guard let date = Date.oxyParse(value) else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

private struct VaultGrantsResponse: Codable {
    let grants: [VaultGrantSummary]
}

private struct VaultCredentialUsesResponse: Codable {
    let uses: [VaultCredentialUse]
}

private struct VaultGrantSaveResponse: Codable {
    let granted: Bool
    let grant: VaultGrantSummary?
}

#Preview {
    VaultView()
}

import SwiftUI

/// A task-scoped entry point for the portable checkout profile. The browser tells us
/// only which broad categories a visible merchant form requires; this sheet never sees
/// payment fields, passwords, or the page's form values.
struct CheckoutInformationSheet: View {
    @Environment(\.dismiss) private var dismiss
    let fields: [String]
    let onSaved: () -> Void

    @State private var email = ""
    @State private var title = ""
    @State private var name = ""
    @State private var phone = ""
    @State private var line1 = ""
    @State private var line2 = ""
    @State private var city = ""
    @State private var postcode = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var requested: Set<String> { Set(fields) }

    var body: some View {
        NavigationStack {
            Form {
                if requested.contains("email") {
                    Section("Email") {
                        TextField("Email address", text: $email)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.emailAddress)
                            .textContentType(.emailAddress)
                    }
                }

                if requested.contains("title") || requested.contains("name") {
                    Section("Name") {
                        if requested.contains("title") {
                            TextField("Title", text: $title)
                                .textContentType(.namePrefix)
                        }
                        if requested.contains("name") {
                            TextField("Full name", text: $name)
                                .textContentType(.name)
                        }
                    }
                }

                if requested.contains("phone") {
                    Section("Contact") {
                        TextField("Mobile number", text: $phone)
                            .keyboardType(.phonePad)
                            .textContentType(.telephoneNumber)
                    }
                }

                if requested.contains("address") {
                    Section("Billing address") {
                        TextField("Address line 1", text: $line1)
                            .textContentType(.streetAddressLine1)
                        TextField("Address line 2", text: $line2)
                            .textContentType(.streetAddressLine2)
                        TextField("City", text: $city)
                            .textContentType(.addressCity)
                        TextField("Postcode", text: $postcode)
                            .textContentType(.postalCode)
                            .textInputAutocapitalization(.characters)
                    }
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Checkout details")
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
                            .disabled(!isComplete)
                    }
                }
            }
        }
    }

    private var isComplete: Bool {
        (!requested.contains("email") || email.contains("@"))
            && (!requested.contains("title") || !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            && (!requested.contains("name") || !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            && (!requested.contains("phone") || !phone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            && (!requested.contains("address") || (
                !line1.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && !city.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && !postcode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ))
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        var body: [String: Any] = [:]
        if requested.contains("email") { body["email"] = email.trimmingCharacters(in: .whitespacesAndNewlines) }
        if requested.contains("title") { body["title"] = title.trimmingCharacters(in: .whitespacesAndNewlines) }
        if requested.contains("name") { body["name"] = name.trimmingCharacters(in: .whitespacesAndNewlines) }
        if requested.contains("phone") { body["phone"] = phone.trimmingCharacters(in: .whitespacesAndNewlines) }
        if requested.contains("address") {
            body["address"] = [
                "line1": line1.trimmingCharacters(in: .whitespacesAndNewlines),
                "line2": line2.trimmingCharacters(in: .whitespacesAndNewlines),
                "city": city.trimmingCharacters(in: .whitespacesAndNewlines),
                "postcode": postcode.trimmingCharacters(in: .whitespacesAndNewlines)
            ]
        }
        do {
            _ = try await APIClient.shared.request(path: "/checkout-profile", method: "POST", body: body)
            dismiss()
            onSaved()
        } catch {
            errorMessage = error.localizedDescription
        }
        isSaving = false
    }
}

#Preview {
    CheckoutInformationSheet(fields: ["email", "name", "phone", "address"], onSaved: {})
}

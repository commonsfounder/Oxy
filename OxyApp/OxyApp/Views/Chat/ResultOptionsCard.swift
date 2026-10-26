import SwiftUI

/// The actual objects returned by a search, with a readable large-text collection.
struct ResultOptionsCard: View {
    let action: ActionResult
    let messageID: UUID

    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var comparing = false
    private var options: [ResultOption] { action.results ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            let headerLayout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
            headerLayout {
                Text("\(options.count) options")
                    .font(.sectionLabel).foregroundStyle(Color.appMuted)
                if !typeSize.isAccessibilitySize { Spacer(minLength: 8) }
                if options.count >= 2 {
                    Button {
                        HapticManager.shared.impact(.light)
                        comparing = true
                    } label: {
                        HStack(spacing: 8) {
                            Text("Compare").font(.appBody(15, weight: .semibold))
                            AppIcon("arrow-up-right", size: 15).accessibilityHidden(true)
                        }
                        .foregroundStyle(Color.appAccent)
                        .frame(minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }
            }
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(options) { option in card(option).id("result-option-\(messageID)-\(option.id)") }
                }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(options) { option in
                            card(option).frame(width: 252).id("result-option-\(messageID)-\(option.id)")
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned)
            }
        }
        .sheet(isPresented: $comparing) {
            CompareSheet(table: .results(options))
                .presentationDragIndicator(.visible)
        }
    }

    private func card(_ option: ResultOption) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 12) {
                if let link = option.imageUrl, let url = URL(string: link) {
                    AsyncImage(url: url, transaction: Transaction(animation: .appFast)) { phase in
                        switch phase {
                        case .success(let image): image.resizable().scaledToFill().transition(.opacity)
                        default: Color.appSurface2
                        }
                    }
                    .frame(height: typeSize.isAccessibilitySize ? 180 : 120)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .accessibilityHidden(true)
                }
                if let source = option.source {
                    Text(source).font(.appBody(13, weight: .medium)).foregroundStyle(Color.appMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(option.title).font(.headline).foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
                if let price = option.price {
                    Text(price).font(.title2.weight(.bold)).foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let facts = facts(option) {
                    Text(facts).font(.rowSecondary).foregroundStyle(Color.appMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let subtitle = option.subtitle {
                    Text(subtitle).font(.rowSecondary).foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let note = option.note {
                    Text(note).font(.rowSecondary).foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            if let link = option.url, let url = URL(string: link) {
                Button {
                    HapticManager.shared.impact(.light)
                    UIApplication.shared.open(url)
                } label: {
                    HStack(spacing: 10) {
                        Text("View").font(.appBody(15, weight: .semibold))
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        AppIcon("arrow-up-right", size: 16).accessibilityHidden(true)
                    }
                    .foregroundStyle(Color.appAccent)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.appScale)
                .accessibilityLabel("View \(option.title)")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 16))
    }

    private func facts(_ option: ResultOption) -> String? {
        guard let rating = option.rating else { return nil }
        let count = option.ratingCount.map { " (\($0))" } ?? ""
        return "★ \(String(format: "%.1f", rating))\(count)"
    }
}

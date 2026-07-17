import SwiftUI

// MARK: - Generated-for-the-job step content (Video B pattern)
//
// Each case swaps the whole body of AgentTaskSessionView. Shared shell (title,
// glass plates, selection language) lives here; domain data comes from the plan
// generator today and from real connectors later.

private struct StepTitleBlock: View {
    let title: String
    let subtitle: String?
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(ink)
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 15))
                    .foregroundStyle(ink.opacity(0.55))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 8)
    }
}

private struct SelectableGlassRow<Content: View>: View {
    var isSelected: Bool
    @ViewBuilder var content: Content
    var ink: Color
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 12) {
            content
            Spacer(minLength: 0)
            ZStack {
                Circle()
                    .fill(isSelected ? ink : ink.opacity(0.08))
                    .frame(width: 26, height: 26)
                if isSelected {
                    AppIcon("check", size: 12, weight: .bold)
                        .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
                } else {
                    AppIcon("plus", size: 12)
                        .foregroundStyle(ink.opacity(0.6))
                }
            }
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(isSelected ? ink.opacity(colorScheme == .dark ? 0.14 : 0.07) : Color.clear)
        }
        .background { MissionGlassPlate() }
    }
}

// MARK: - Plan board

struct PlanBoardStepView: View {
    let entries: [PlanEntry]
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("In progress")
                .font(.system(size: 13, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(ink.opacity(0.45))

            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                    HStack(spacing: 12) {
                        ZStack {
                            Circle()
                                .fill(entry.status == .done ? ink : ink.opacity(0.08))
                                .frame(width: 26, height: 26)
                            if entry.status == .done {
                                AppIcon("check", size: 12, weight: .bold)
                                    .foregroundStyle(.white)
                            } else {
                                Text("\(index + 1)")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(ink.opacity(0.55))
                            }
                        }
                        Text(entry.title)
                            .font(.system(size: 16, weight: entry.status == .active ? .semibold : .regular))
                            .foregroundStyle(entry.status == .pending ? ink.opacity(0.45) : ink)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 12)

                    if index < entries.count - 1 {
                        Divider().overlay(ink.opacity(0.08))
                    }
                }
            }
            .padding(16)
            .background { MissionGlassPlate() }
        }
    }
}

// MARK: - Time picker

struct TimePickerStepView: View {
    @Bindable var step: AgentStep
    let slots: [TimeSlotOption]
    var ink: Color

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitleBlock(title: "Choose a time", subtitle: "You have several free slots", ink: ink)

            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(slots) { slot in
                    let isSelected = step.selectedID == slot.id
                    Button {
                        HapticManager.shared.impact(.light)
                        step.selectedID = slot.id
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(slot.time)
                                    .font(.system(size: 18, weight: .semibold))
                                    .foregroundStyle(ink)
                                Spacer()
                                ZStack {
                                    Circle().fill(isSelected ? ink : ink.opacity(0.08)).frame(width: 22, height: 22)
                                    AppIcon(isSelected ? "check" : "plus", size: 11, weight: .bold)
                                        .foregroundStyle(isSelected ? Color.white : ink.opacity(0.6))
                                }
                            }
                            Text(slot.label)
                                .font(.system(size: 12))
                                .foregroundStyle(ink.opacity(0.5))
                        }
                        .padding(14)
                        .background {
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .fill(isSelected ? ink.opacity(0.07) : Color.clear)
                        }
                        .background { MissionGlassPlate() }
                    }
                    .buttonStyle(.appScale(0.97))
                }
            }
        }
    }
}

// MARK: - Place picker

struct PlacePickerStepView: View {
    @Bindable var step: AgentStep
    let subtitle: String
    let results: [PlaceOption]
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitleBlock(title: step.title, subtitle: subtitle, ink: ink)

            VStack(spacing: 10) {
                ForEach(results) { place in
                    let isSelected = step.selectedID == place.id
                    Button {
                        HapticManager.shared.impact(.light)
                        step.selectedID = place.id
                    } label: {
                        SelectableGlassRow(isSelected: isSelected, content: {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Text(place.name)
                                        .font(.system(size: 16, weight: .semibold))
                                        .foregroundStyle(ink)
                                    Text(place.rating)
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(ink.opacity(0.5))
                                }
                                Text(place.tag)
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(ink.opacity(0.55))
                                Text(place.blurb)
                                    .font(.system(size: 13))
                                    .foregroundStyle(ink.opacity(0.5))
                            }
                        }, ink: ink)
                    }
                    .buttonStyle(.appScale(0.98))
                }
            }
        }
    }
}

// MARK: - Person picker

struct PersonPickerStepView: View {
    @Bindable var step: AgentStep
    let people: [PersonOption]
    let draftMessage: String
    var ink: Color
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitleBlock(title: step.title, subtitle: nil, ink: ink)

            Text(draftMessage)
                .font(.system(size: 14))
                .foregroundStyle(ink.opacity(0.75))
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background { MissionGlassPlate() }
                .padding(.bottom, 14)

            VStack(spacing: 10) {
                ForEach(people) { person in
                    let isSelected = step.selectedID == person.id
                    Button {
                        HapticManager.shared.impact(.light)
                        step.selectedID = person.id
                    } label: {
                        SelectableGlassRow(isSelected: isSelected, content: {
                            HStack(spacing: 12) {
                                Circle()
                                    .fill(ink.opacity(0.1))
                                    .frame(width: 38, height: 38)
                                    .overlay(
                                        Text(person.name.prefix(1))
                                            .font(.system(size: 15, weight: .semibold))
                                            .foregroundStyle(ink.opacity(0.7))
                                    )
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(person.name)
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundStyle(ink)
                                    Text(person.relation)
                                        .font(.system(size: 12))
                                        .foregroundStyle(ink.opacity(0.5))
                                }
                            }
                        }, ink: ink)
                    }
                    .buttonStyle(.appScale(0.98))
                }
            }
        }
    }
}

// MARK: - Ride confirm

struct RideConfirmStepView: View {
    let details: RideDetails
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitleBlock(title: "Book a ride", subtitle: "\(details.eta) away", ink: ink)

            VStack(spacing: 0) {
                rideRow(icon: "location", label: "Pickup", value: details.pickup)
                Divider().overlay(ink.opacity(0.08))
                rideRow(icon: "pin", label: "Drop-off", value: details.dropoff)
                if let price = details.price {
                    Divider().overlay(ink.opacity(0.08))
                    rideRow(icon: "card", label: "Estimate", value: price)
                }
            }
            .padding(16)
            .background { MissionGlassPlate() }
        }
    }

    private func rideRow(icon: String, label: String, value: String) -> some View {
        HStack(spacing: 12) {
            AppIcon(icon, size: 16)
                .foregroundStyle(ink.opacity(0.6))
                .frame(width: 20)
            Text(label)
                .font(.system(size: 14))
                .foregroundStyle(ink.opacity(0.55))
            Spacer()
            Text(value)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(ink)
        }
        .padding(.vertical, 10)
    }
}

// MARK: - Payment confirm (trust surface — Phase 4)

struct PaymentConfirmStepView: View {
    let details: PaymentDetails
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitleBlock(title: "Confirm payment", subtitle: nil, ink: ink)

            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(details.merchant)
                        .font(.system(size: 15))
                        .foregroundStyle(ink.opacity(0.6))
                    Spacer()
                    Text(details.amount)
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(ink)
                }
                Divider().overlay(ink.opacity(0.08))
                Text(details.detail)
                    .font(.system(size: 13))
                    .foregroundStyle(ink.opacity(0.5))
            }
            .padding(18)
            .background { MissionGlassPlate() }

            Text("You can cancel any time before this is charged.")
                .font(.system(size: 12))
                .foregroundStyle(ink.opacity(0.4))
                .padding(.top, 12)
        }
    }
}

// MARK: - Product detail (buy job — data-driven, Gleb-styled)

struct ProductDetailStepView: View {
    let details: ProductDetails
    var ink: Color
    @State private var swatchIndex = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepTitleBlock(title: details.name, subtitle: details.subtitle, ink: ink)

            if let priceText = details.priceText {
                VStack(alignment: .leading, spacing: 2) {
                    Text("PRICE")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(1.2)
                        .foregroundStyle(ink.opacity(0.45))
                    Text(priceText)
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(ink)
                }
            }

            if !details.specs.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(details.specs, id: \.self) { spec in
                            Text(spec)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(ink.opacity(0.7))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(.ultraThinMaterial, in: Capsule())
                        }
                    }
                }
            }

            // Generic hero plate — an honest placeholder until a real product-lookup
            // connector supplies imagery. Tinted by the chosen finish; no hardcoded art.
            ZStack {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(Color.white.opacity(0.45))
                selectedSwatch.map { s in
                    RadialGradient(
                        colors: [
                            Color(red: s.red, green: s.green, blue: s.blue).opacity(0.55),
                            Color(red: 0.85, green: 0.9, blue: 1.0).opacity(0.3),
                            .clear
                        ],
                        center: .center, startRadius: 8, endRadius: 200
                    )
                }
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.7), lineWidth: 0.7)
                AppIcon("cube", size: 60)
                    .foregroundStyle(ink.opacity(0.4))
                    .shadow(color: .black.opacity(0.08), radius: 12, y: 6)
            }
            .frame(height: 190)
            .frame(maxWidth: .infinity)
            .shadow(color: .black.opacity(0.06), radius: 16, y: 8)

            if !details.swatches.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(selectedSwatch?.name.uppercased() ?? "FINISH")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(1.2)
                        .foregroundStyle(ink.opacity(0.45))
                    HStack(spacing: 12) {
                        ForEach(Array(details.swatches.enumerated()), id: \.element.id) { index, swatch in
                            Circle()
                                .fill(Color(red: swatch.red, green: swatch.green, blue: swatch.blue))
                                .frame(width: 26, height: 26)
                                .overlay(
                                    Circle().strokeBorder(
                                        swatchIndex == index ? ink.opacity(0.8) : Color.black.opacity(0.1),
                                        lineWidth: swatchIndex == index ? 2 : 0.5
                                    )
                                )
                                .scaleEffect(swatchIndex == index ? 1.08 : 1)
                                .onTapGesture {
                                    withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { swatchIndex = index }
                                    HapticManager.shared.impact(.light)
                                }
                        }
                    }
                }
            }

            if details.priceText == nil {
                HStack(spacing: 6) {
                    AppIcon("shield-check", size: 13)
                    Text("Final price is confirmed at checkout")
                        .font(.system(size: 12))
                }
                .foregroundStyle(ink.opacity(0.45))
            }
        }
    }

    private var selectedSwatch: ProductSwatch? {
        details.swatches.indices.contains(swatchIndex) ? details.swatches[swatchIndex] : nil
    }
}

// MARK: - Working hero (Phase 3 — holographic search)

struct WorkingHeroStepView: View {
    let title: String
    let status: String
    var ink: Color
    @State private var pulse = false
    @State private var rotation: Double = 0

    var body: some View {
        VStack(spacing: 22) {
            Spacer(minLength: 40)

            ZStack {
                // Radar rings
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .strokeBorder(
                            AngularGradient(
                                colors: [
                                    Color(red: 0.7, green: 0.85, blue: 1.0).opacity(0.0),
                                    Color(red: 0.6, green: 0.8, blue: 1.0).opacity(0.45),
                                    Color(red: 1.0, green: 0.85, blue: 0.7).opacity(0.25),
                                    Color(red: 0.7, green: 0.85, blue: 1.0).opacity(0.0)
                                ],
                                center: .center
                            ),
                            lineWidth: 1.2
                        )
                        .frame(width: CGFloat(150 + i * 44), height: CGFloat(150 + i * 44))
                        .scaleEffect(pulse ? 1.04 : 0.96)
                        .opacity(pulse ? 0.9 : 0.55)
                        .rotationEffect(.degrees(rotation + Double(i * 20)))
                }

                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color(red: 0.75, green: 0.88, blue: 1.0).opacity(0.55),
                                Color(red: 1.0, green: 0.9, blue: 0.8).opacity(0.25),
                                .clear
                            ],
                            center: .center,
                            startRadius: 6,
                            endRadius: 90
                        )
                    )
                    .frame(width: 150, height: 150)
                    .scaleEffect(pulse ? 1.02 : 0.98)
            }
            .frame(height: 240)
            .onAppear {
                withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true)) {
                    pulse = true
                }
                withAnimation(.linear(duration: 12).repeatForever(autoreverses: false)) {
                    rotation = 360
                }
            }

            VStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(ink)
                Text(status)
                    .font(.system(size: 14))
                    .foregroundStyle(ink.opacity(0.5))
            }

            Spacer(minLength: 60)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Session done

struct SessionDoneStepView: View {
    let title: String
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            AppIcon("check-circle", size: 30)
                .foregroundStyle(ink.opacity(0.8))
            Text(title)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(ink)
            Text("All set — this will land on Home as a status card.")
                .font(.system(size: 14))
                .foregroundStyle(ink.opacity(0.55))
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { MissionGlassPlate() }
    }
}

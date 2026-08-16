import SwiftUI

// MARK: - Home board

// MARK: - Live header

struct LiveWorkHeader: View {
    let count: Int
    let waitingCount: Int

    var body: some View {
        HStack(spacing: 10) {
            PulsingWorkDot(active: true)

            Text(label)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(GlebChrome.ink.opacity(0.8))
                .contentTransition(.numericText())

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(Capsule().fill(Color.appSurface))
        .overlay(Capsule().strokeBorder(Color.appHairline, lineWidth: 0.5))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }

    private var label: String {
        if count == 0 { return "Nothing running" }
        if waitingCount == count {
            return count == 1 ? "Waiting to hear back on 1 thing" : "Waiting to hear back on \(count) things"
        }
        return count == 1 ? "1 in progress" : "\(count) in progress"
    }
}

struct PulsingWorkDot: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var big = false

    var body: some View {
        ZStack {
            if !reduceMotion {
                Circle()
                    .fill(Color.appAccent.opacity(0.28))
                    .frame(width: 18, height: 18)
                    .scaleEffect(big ? 1.0 : 0.55)
                    .opacity(big ? 0.0 : 0.9)
            }
            Circle()
                .fill(Color.appAccent)
                .frame(width: 7, height: 7)
        }
        .frame(width: 18, height: 18)
        .onAppear {
            guard active, !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.7).repeatForever(autoreverses: false)) {
                big = true
            }
        }
    }
}

// MARK: - Lane

struct BoardLaneSection: View {
    let lane: BoardLane
    let items: [BoardItem]
    let onOpen: (BoardItem) -> Void
    let onDecide: (BoardItem, Bool, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(lane.title)
                    .font(.appBody(14, weight: .semibold))
                    .foregroundStyle(GlebChrome.ink.opacity(lane == .needsYou ? 0.75 : 0.42))

                Text("\(items.count)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(GlebChrome.ink.opacity(0.5))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(GlebChrome.ink.opacity(0.07)))

                Spacer(minLength: 0)
            }
            .padding(.leading, 2)

            ForEach(items) { item in
                BoardCard(lane: lane, item: item, onOpen: { onOpen(item) },
                          onDecide: { approved, choice in onDecide(item, approved, choice) })
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.97, anchor: .top)),
                        removal: .opacity.combined(with: .scale(scale: 0.97, anchor: .top))
                    ))
            }
        }
    }
}

// MARK: - Card

struct BoardCard: View {
    let lane: BoardLane
    let item: BoardItem
    let onOpen: () -> Void
    let onDecide: (Bool, String?) -> Void

    var body: some View {
        switch lane {
        case .needsYou: needsYouCard
        case .handling: handlingCard
        case .changed, .completed: ledgerCard
        }
    }

    private var needsYouCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                AppIcon(item.overdue == true ? "alert-circle" : "bolt", size: 15)
                    .foregroundStyle(item.overdue == true ? Color.red.opacity(0.75) : Color.appAccent)
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(GlebChrome.ink)
                        .fixedSize(horizontal: false, vertical: true)

                    if let line = questionLine, !line.isEmpty {
                        Text(line)
                            .font(.system(size: 14))
                            .foregroundStyle(GlebChrome.ink.opacity(0.62))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }

            if let options = item.options, !options.isEmpty {
                choiceButtons(options)
            } else if item.hasDecision {
                approvalButtons
            } else {
                openButton("Open")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { MissionGlassPlate() }
        .contentShape(Rectangle())
    }

    private var questionLine: String? {
        let prompt = item.prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let prompt, !prompt.isEmpty { return prompt }
        return item.detail
    }

    private func choiceButtons(_ options: [BoardChoice]) -> some View {
        VStack(spacing: 6) {
            ForEach(options) { option in
                Button {
                    HapticManager.shared.impact(.light)
                    onDecide(true, option.label)
                } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.label)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(GlebChrome.ink)
                            if let detail = option.detail, !detail.isEmpty {
                                Text(detail)
                                    .font(.system(size: 12))
                                    .foregroundStyle(GlebChrome.ink.opacity(0.5))
                            }
                        }
                        Spacer(minLength: 0)
                        AppIcon("chevron-right", size: 12)
                            .foregroundStyle(GlebChrome.ink.opacity(0.3))
                    }
                    .padding(.horizontal, 13)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                        .fill(Color.appSurface2.opacity(0.72)))
                }
                .buttonStyle(.appScale(0.98))
            }
        }
        .padding(.top, 12)
    }

    private var approvalButtons: some View {
        HStack(spacing: 8) {
            Button {
                HapticManager.shared.impact(.medium)
                onDecide(true, nil)
            } label: {
                Text("Approve")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(GlebChrome.ink)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Capsule().fill(Color.appAccent.opacity(0.22)))
            }
            .buttonStyle(.appScale(0.97))

            Button {
                HapticManager.shared.impact(.light)
                onDecide(false, nil)
            } label: {
                Text("Not now")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(GlebChrome.ink.opacity(0.6))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Capsule().fill(Color.white.opacity(0.4)))
            }
            .buttonStyle(.appScale(0.97))
        }
        .padding(.top, 12)
    }

    private func openButton(_ title: String) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            onOpen()
        } label: {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                AppIcon("arrow-right", size: 12)
            }
            .foregroundStyle(GlebChrome.ink)
            .padding(.horizontal, 15)
            .padding(.vertical, 10)
            .background(Capsule().fill(Color.appAccent.opacity(0.18)))
        }
        .buttonStyle(.appScale(0.97))
        .padding(.top, 12)
    }

    private var handlingCard: some View {
        Button(action: { HapticManager.shared.impact(.light); onOpen() }) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 10) {
                    if item.waitingExternal == true {
                        AppIcon("clock", size: 15)
                            .foregroundStyle(GlebChrome.ink.opacity(0.4))
                            .padding(.top, 1)
                    } else {
                        PulsingWorkDot(active: true)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(GlebChrome.ink)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)

                        if let detail = subtitle, !detail.isEmpty {
                            Text(detail)
                                .font(.system(size: 13))
                                .foregroundStyle(GlebChrome.ink.opacity(0.55))
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                    AppIcon("chevron-right", size: 12)
                        .foregroundStyle(GlebChrome.ink.opacity(0.25))
                        .padding(.top, 3)
                }

                if let progress = item.progress, progress.total > 0 {
                    ProgressRail(progress: progress)
                        .padding(.top, 13)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { MissionGlassPlate() }
        }
        .buttonStyle(.appScale(0.99))
    }

    private var subtitle: String? {
        if item.waitingExternal == true {
            let detail = item.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
            return detail?.isEmpty == false ? detail : "Waiting to hear back"
        }
        return item.detail
    }

    private var ledgerCard: some View {
        Button(action: { HapticManager.shared.impact(.light); onOpen() }) {
            HStack(alignment: .top, spacing: 10) {
                AppIcon(ledgerIcon, size: 14)
                    .foregroundStyle(ledgerTint)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(GlebChrome.ink.opacity(0.9))
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)

                    if let detail = item.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 12.5))
                            .foregroundStyle(GlebChrome.ink.opacity(0.5))
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: 0)

                if let relative = item.date?.oxyRelativeShort {
                    Text(relative)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(GlebChrome.ink.opacity(0.35))
                        .padding(.top, 2)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { MissionGlassPlate() }
        }
        .buttonStyle(.appScale(0.99))
    }

    private var ledgerIcon: String {
        if item.failed == true { return "alert-circle" }
        return lane == .completed ? "check-circle" : "dotted"
    }

    private var ledgerTint: Color {
        if item.failed == true { return Color.red.opacity(0.6) }
        return lane == .completed ? Color.appAccent.opacity(0.75) : GlebChrome.ink.opacity(0.35)
    }
}

// MARK: - Progress

struct ProgressRail: View {
    let progress: BoardProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(GlebChrome.ink.opacity(0.08))
                    Capsule()
                        .fill(Color.appAccent.opacity(0.75))
                        .frame(width: max(proxy.size.width * progress.fraction, 6))
                        .animation(.spring(response: 0.55, dampingFraction: 0.85), value: progress.fraction)
                }
            }
            .frame(height: 4)

            Text("Step \(progress.done) of \(progress.total)")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(GlebChrome.ink.opacity(0.42))
        }
    }
}

// MARK: - Relative time

extension Date {
    /// "4m", "2h", "yesterday" — a ledger needs the age of a row at a glance, not a date.
    var oxyRelativeShort: String {
        let seconds = Date().timeIntervalSince(self)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h" }
        let days = Int(seconds / 86400)
        return days == 1 ? "yesterday" : "\(days)d"
    }
}

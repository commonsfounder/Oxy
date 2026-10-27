import SwiftUI

/// The first screen: what Adam knows about home right now, in priority order.
/// One sentence leads; devices follow as sentences; then only what is real: a decision, work, things noticed, watches.
struct HomeNowView: View {
    var model: ThreadBoardModel
    var onSetUp: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    private var devices: [HomeModel.Device] { model.home?.devices ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xxl) {
            VStack(alignment: .leading, spacing: AppSpacing.lg) {
                Text(headline)
                    .font(.role(.display)).tracking(typeSize.isAccessibilitySize ? 0 : -0.8)
                    .foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .contentTransition(.opacity)
                if !devices.isEmpty {
                    VStack(alignment: .leading, spacing: AppSpacing.sm) {
                        ForEach(devices) { device in deviceSentence(device) }
                    }
                } else if model.home != nil {
                    Text("Pair a display and this screen shows what's happening at home.")
                        .font(.role(.body)).foregroundStyle(Color.appMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(action: onSetUp) {
                        Text("Add a display")
                            .font(.role(.callout, weight: .semibold))
                            .foregroundStyle(Color.appOnAction)
                            .padding(.horizontal, AppSpacing.xl)
                            .frame(minHeight: 48)
                            .background(Color.appAction, in: Capsule())
                    }
                    .buttonStyle(.appScale(0.97))
                }
            }
            ThreadBoardCards(model: model, sections: [.decisions, .work, .noticed, .watching])
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.appStandard, value: headline)
    }

    /// The single most important fact about home, as a sentence.
    private var headline: String {
        guard model.hasLoaded, model.home != nil else {
            return model.refreshFailed ? "Couldn't reach Adam." : " "
        }
        let needs = model.needsYou.count
        if needs == 1 { return "One thing needs you." }
        if needs > 1 { return "\(Self.word(needs)) things need you." }
        if devices.isEmpty { return "Adam isn't set up at home yet." }
        let offline = devices.filter { !$0.online }
        if offline.count == devices.count {
            return devices.count == 1 ? "\(devices[0].name) is offline." : "Adam's displays are offline."
        }
        if offline.count == 1 { return "\(offline[0].name) is offline." }
        if offline.count > 1 { return "\(Self.word(offline.count)) displays are offline." }
        let working = model.working.count
        if working == 1 { return "Adam is on one thing." }
        if working > 1 { return "Adam is on \(Self.word(working).lowercased()) things." }
        return "All quiet at home."
    }

    private static func word(_ n: Int) -> String {
        ["Zero", "One", "Two", "Three", "Four", "Five", "Six"].indices.contains(n)
            ? ["Zero", "One", "Two", "Three", "Four", "Five", "Six"][n] : "\(n)"
    }

    private func deviceSentence(_ device: HomeModel.Device) -> some View {
        let seen = device.lastSeenAt.flatMap(DisplayTimestampParser.date(from:))
        let sentence: Text = {
            if device.online { return Text("\(device.name) is online.") }
            guard let seen else { return Text("\(device.name) hasn't connected yet.") }
            return Text("\(device.name) is offline. Last seen \(ThreadBoardCards.when(seen)).")
        }()
        return HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
            StatusDot(color: device.online ? Color.appSuccess : Color.appMuted.opacity(0.45))
            sentence
                .font(.role(.body))
                .foregroundStyle(device.online ? Color.appInk : Color.appMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

import AVFoundation
import SwiftUI

/// The first screen, laid out like the app for a home device: the home drawn as a map with Adam's
/// devices on it, then what needs you, a short summary of what happened, work running, and earlier events.
struct HomeNowView: View {
    var model: ThreadBoardModel
    var onSetUp: () -> Void

    @State private var openWorkflow: HomeOpenWorkflow?

    private var home: HomeModel? { model.home }
    private var devices: [HomeModel.Device] { home?.devices ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            if let home {
                if devices.isEmpty {
                    HomeMapEmpty(onSetUp: onSetUp)
                } else if devices.contains(where: \.online) {
                    HomeMap(rooms: HomeMap.rooms(from: home), compact: !model.needsYou.isEmpty)
                } else {
                    HomeOfflineDisplays(devices: devices, onFix: onSetUp)
                }
            } else if model.refreshFailed {
                Text("Couldn't reach Adam.").font(.role(.body)).foregroundStyle(Color.appMuted)
                    .padding(.vertical, AppSpacing.xxl)
            } else {
                ProgressView().tint(Color.appMuted).frame(maxWidth: .infinity, minHeight: 220)
            }
            ForEach(model.needsYou.prefix(2)) { item in
                HomeAskCard(item: item, model: model) { openWorkflow = HomeOpenWorkflow(id: $0) }
            }
            if model.needsYou.isEmpty, let summary {
                HomeSummary(title: Self.partOfDay(), text: summary)
            }
            ForEach(model.working.prefix(3)) { item in
                HomeWorkCard(item: item, model: model) { openWorkflow = HomeOpenWorkflow(id: $0) }
            }
            if !earlier.isEmpty {
                HomeEarlier(lines: earlier) { openWorkflow = HomeOpenWorkflow(id: $0) }
                    .padding(.top, AppSpacing.sm)
                    .id("board-noticed")
            }
            if let watches = home?.watches, !watches.isEmpty {
                HomeWatching(watches: watches)
                    .padding(.top, AppSpacing.sm)
            }
            if model.refreshFailed && home != nil {
                Text("Couldn't refresh. Showing what was saved.")
                    .font(.role(.footnote)).foregroundStyle(Color.appMuted)
            }
            if let message = model.errorMessage {
                Text(message).font(.role(.footnote)).foregroundStyle(Color.appMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.appStandard, value: model.needsYou.map(\.id))
        .sheet(item: $openWorkflow) { open in
            WorkflowTimelineView(workflowId: open.id, onChanged: { Task { await model.refresh() } })
        }
    }

    // MARK: Status line under the title

    /// One plain line for the header: the most important thing about home.
    static func status(_ model: ThreadBoardModel) -> (text: String, color: Color)? {
        guard model.hasLoaded, let home = model.home else { return nil }
        let needs = model.needsYou.count
        if needs == 1 { return ("One thing needs you", .appNeedsYou) }
        if needs > 1 { return ("\(needs) things need you", .appNeedsYou) }
        if home.devices.isEmpty { return ("No display paired", .appMuted) }
        if model.working.count == 1 { return ("Working on one thing", .appSuccess) }
        if model.working.count > 1 { return ("Working on \(model.working.count) things", .appSuccess) }
        let on = home.devices.filter(\.online)
        if on.isEmpty { return (home.devices.count == 1 ? "Display offline" : "Displays offline", .appMuted) }
        let rooms = Set(on.compactMap(\.room))
        if rooms.count == 1, let room = rooms.first { return ("On in the \(room.lowercased())", .appSuccess) }
        return (on.count == 1 ? "1 display on" : "\(on.count) displays on", .appSuccess)
    }

    // MARK: Summary written from real events

    private static func partOfDay(_ date: Date = Date()) -> String {
        switch Calendar.current.component(.hour, from: date) {
        case 5..<12: return "This morning"
        case 12..<18: return "This afternoon"
        default: return "This evening"
        }
    }

    /// Up to three of today's facts, newest first, as plain sentences. Nothing is inferred or invented.
    private var summary: String? {
        var facts: [(Date, String)] = []
        // When every display is off, the card above already says so.
        for device in devices where !device.online && devices.contains(where: \.online) {
            if let seen = device.lastSeenAt.flatMap(DisplayTimestampParser.date(from:)), Calendar.current.isDateInToday(seen) {
                facts.append((seen, "The \(device.name.lowercasedFirst) went offline at \(Self.clock(seen))."))
            }
        }
        for line in earlier where !line.failed {
            guard let date = line.date, Calendar.current.isDateInToday(date) else { continue }
            facts.append((date, "\(line.title.trimmingCharacters(in: CharacterSet(charactersIn: "."))) at \(Self.clock(date))."))
        }
        let picked = facts.sorted { $0.0 > $1.0 }.prefix(3).map(\.1)
        return picked.isEmpty ? nil : picked.joined(separator: " ")
    }

    static func clock(_ date: Date) -> String {
        date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }

    // MARK: Earlier: finished work, updates, device reports and sounds

    private var earlier: [HomeLine] {
        var lines = model.finished.suffix(4).map {
            HomeLine(id: "o-\($0.id)", date: $0.date, title: $0.failed == true ? "Couldn't finish: \($0.title)" : $0.title,
                     detail: $0.detail, icon: $0.failed == true ? "alert-circle" : "check", workflowID: $0.workflowId, failed: $0.failed == true)
        }
        lines += model.board.changed.prefix(4).map {
            HomeLine(id: "c-\($0.id)", date: $0.date, title: $0.title, detail: $0.detail, icon: "box", workflowID: $0.workflowId)
        }
        lines += (home?.observations ?? []).prefix(6).map {
            HomeLine(id: "s-\($0.id)", date: DisplayTimestampParser.date(from: $0.at), title: $0.summary, detail: $0.room, icon: "display")
        }
        if SoundClipStore.shared.isEnabled {
            let dayAgo = Date().addingTimeInterval(-86_400)
            lines += SoundClipStore.shared.clips.filter { $0.heardAt > dayAgo }.prefix(3).map {
                HomeLine(id: "h-\($0.id)", date: $0.heardAt, title: "Heard \($0.title.lowercased())", detail: nil, icon: "waveform")
            }
        }
        return Array(lines.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }.prefix(5))
    }
}

struct HomeOpenWorkflow: Identifiable { let id: String }

struct HomeLine: Identifiable {
    let id: String
    let date: Date?
    let title: String
    let detail: String?
    let icon: String
    var workflowID: String?
    var failed = false
}

private extension String {
    var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
}

// MARK: - The map

/// The home drawn in isometric, one floor plate per room, with each paired device standing in it.
/// The plan is laid out from the rooms you've named; it is not a measured floor plan.
struct HomeMap: View {
    struct Room: Identifiable {
        let name: String
        let devices: [HomeModel.Device]
        var id: String { "\(name)-\(devices.map(\.id).joined())" }
        var lit: Bool { devices.contains(where: \.online) }
    }

    var rooms: [Room]
    var compact = false

    static func rooms(from home: HomeModel) -> [Room] {
        var rooms = home.rooms.filter { !$0.devices.isEmpty }.map { Room(name: $0.name, devices: $0.devices) }
        if rooms.isEmpty {
            let placed = home.devices.filter { $0.room != nil }
            let byRoom = Dictionary(grouping: placed, by: { $0.room ?? "" })
            rooms = byRoom.keys.sorted().map { Room(name: $0, devices: byRoom[$0] ?? []) }
        }
        let loose = home.unassignedDevices.isEmpty ? home.devices.filter { $0.room == nil } : home.unassignedDevices
        // A display not placed in a room yet is labelled by its own name.
        rooms += loose.map { Room(name: $0.name, devices: [$0]) }
        let ordered = rooms.sorted { a, b in
            a.lit != b.lit ? a.lit : a.devices.count > b.devices.count
        }
        return Array(ordered.prefix(4))
    }

    /// Plan rectangles in floor units, by how many rooms there are.
    private var plan: [CGRect] {
        switch rooms.count {
        case 1: return [CGRect(x: 0, y: 0, width: 6.4, height: 4.6)]
        case 2: return [CGRect(x: 0, y: 0, width: 5.2, height: 4.4), CGRect(x: 5.2, y: 0, width: 3.6, height: 4.4)]
        case 3: return [CGRect(x: 0, y: 0, width: 5.2, height: 4.4), CGRect(x: 5.2, y: 0, width: 3.6, height: 4.4),
                        CGRect(x: 0, y: 4.4, width: 8.8, height: 1.8)]
        default: return [CGRect(x: 0, y: 0, width: 5, height: 3.4), CGRect(x: 5, y: 0, width: 3.8, height: 3.4),
                         CGRect(x: 0, y: 3.4, width: 5, height: 2.8), CGRect(x: 5, y: 3.4, width: 3.8, height: 2.8)]
        }
    }

    private struct Iso {
        let scale: CGFloat
        let origin: CGPoint
        func point(_ x: CGFloat, _ y: CGFloat, _ z: CGFloat = 0) -> CGPoint {
            let c = cos(CGFloat.pi / 6), s = sin(CGFloat.pi / 6)
            return CGPoint(x: origin.x + (x - y) * c * scale, y: origin.y + (x + y) * s * scale - z * scale)
        }
    }

    private func iso(in size: CGSize) -> Iso {
        let bounds = plan.reduce(CGRect.null) { $0.union($1) }
        let c = cos(CGFloat.pi / 6), s = sin(CGFloat.pi / 6)
        let isoWidth = (bounds.width + bounds.height) * c
        let isoHeight = (bounds.width + bounds.height) * s
        let scale = min(size.width * 0.7 / isoWidth, (size.height - 76) / isoHeight)
        let left = (size.width - isoWidth * scale) / 2
        let top = size.height - isoHeight * scale - 14
        return Iso(scale: scale, origin: CGPoint(x: left + bounds.height * c * scale, y: top))
    }

    private func spot(_ index: Int, in room: CGRect, of count: Int) -> (CGFloat, CGFloat) {
        let step = room.width / CGFloat(count + 1)
        return (room.minX + step * CGFloat(index + 1), room.midY - 0.2)
    }

    var body: some View {
        GeometryReader { proxy in
            let g = iso(in: proxy.size)
            let tags = labels(g: g, width: proxy.size.width)
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    for (index, room) in rooms.enumerated() where index < plan.count {
                        drawRoom(plan[index], lit: room.lit, g: g, context: &context)
                    }
                    for (index, room) in rooms.enumerated() where index < plan.count {
                        let count = min(room.devices.count, 3)
                        for (n, device) in room.devices.prefix(3).enumerated() {
                            let s = spot(n, in: plan[index], of: count)
                            drawDevice(at: g.point(s.0, s.1), online: device.online, g: g, context: &context)
                        }
                    }
                    for tag in tags {
                        var line = Path()
                        line.move(to: tag.anchor)
                        line.addLine(to: tag.end)
                        context.stroke(line, with: .color(Color.appMuted.opacity(0.7)), lineWidth: 1)
                        context.fill(Path(ellipseIn: CGRect(x: tag.anchor.x - 2, y: tag.anchor.y - 2, width: 4, height: 4)),
                                     with: .color(Color.appMuted))
                    }
                }
                ForEach(tags) { tag in
                    VStack(alignment: tag.trailing ? .trailing : .leading, spacing: 1) {
                        Text(tag.title).font(.role(.footnote, weight: .medium)).foregroundStyle(Color.appInk)
                        Text(tag.state).font(.role(.caption, weight: .medium))
                            .foregroundStyle(tag.online ? Color.appSuccess : Color.appMuted)
                    }
                    .fixedSize()
                    .frame(width: proxy.size.width / 2 - 4, alignment: tag.trailing ? .trailing : .leading)
                    .position(x: tag.trailing ? proxy.size.width * 0.75 - 2 : proxy.size.width * 0.25 + 2, y: tag.textY + 14)
                }
            }
        }
        .frame(height: compact ? 214 : 252)
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        rooms.map { room in
            let names = room.devices.map { "\($0.name) \($0.online ? "online" : "offline")" }.joined(separator: ", ")
            return "\(room.name): \(names)"
        }.joined(separator: ". ")
    }

    private func drawRoom(_ r: CGRect, lit: Bool, g: Iso, context: inout GraphicsContext) {
        let h: CGFloat = 0.5
        let floor = [g.point(r.minX, r.minY), g.point(r.maxX, r.minY), g.point(r.maxX, r.maxY), g.point(r.minX, r.maxY)]
        let back = [g.point(r.minX, r.minY), g.point(r.maxX, r.minY), g.point(r.maxX, r.minY, h), g.point(r.minX, r.minY, h)]
        let side = [g.point(r.minX, r.minY), g.point(r.minX, r.maxY), g.point(r.minX, r.maxY, h), g.point(r.minX, r.minY, h)]
        let edge = Color.appInk.opacity(lit ? 0.42 : 0.3)
        let faces: [([CGPoint], Color)] = [
            (floor, lit ? Color.appSuccess.opacity(0.12) : Color.appInk.opacity(0.05)),
            (back, Color.appInk.opacity(lit ? 0.1 : 0.07)),
            (side, Color.appInk.opacity(lit ? 0.08 : 0.055)),
        ]
        for (points, fill) in faces {
            var path = Path()
            path.addLines(points)
            path.closeSubpath()
            context.fill(path, with: .color(fill))
            context.stroke(path, with: .color(edge), lineWidth: 1)
        }
    }

    private func drawDevice(at base: CGPoint, online: Bool, g: Iso, context: inout GraphicsContext) {
        if online {
            let glow = CGRect(x: base.x - g.scale * 2.2, y: base.y - g.scale * 1.1, width: g.scale * 4.4, height: g.scale * 2.2)
            context.fill(Path(ellipseIn: glow), with: .radialGradient(
                Gradient(colors: [Color.appSuccess.opacity(0.32), Color.appSuccess.opacity(0)]),
                center: base, startRadius: 0, endRadius: g.scale * 2.2))
        }
        let size = CGSize(width: g.scale * 1.5, height: g.scale * 1.15)
        DisplayGlyph.draw(in: CGRect(x: base.x - size.width / 2, y: base.y - size.height, width: size.width, height: size.height),
                          online: online, context: &context)
    }

    private struct Tag: Identifiable {
        let id: String
        let title: String
        let state: String
        let online: Bool
        let anchor: CGPoint
        let end: CGPoint
        let textY: CGFloat
        let trailing: Bool
    }

    private func labels(g: Iso, width: CGFloat) -> [Tag] {
        var result: [Tag] = []
        var used: [Bool: [CGFloat]] = [true: [], false: []]
        for (index, room) in rooms.enumerated() where index < plan.count {
            let count = min(room.devices.count, 3)
            guard count > 0 else { continue }
            let s = spot(0, in: plan[index], of: count)
            let base = g.point(s.0, s.1)
            let anchor = CGPoint(x: base.x, y: base.y - g.scale * 1.3)
            let trailing = anchor.x > width / 2
            // Labels sit in the empty corners above the plan, stacked per side, never over a floor.
            let textY = CGFloat(used[trailing, default: []].count) * 40
            used[trailing, default: []].append(textY)
            let endX = trailing ? width - 62 : 62
            result.append(Tag(id: room.name, title: room.name, state: state(for: room), online: room.lit,
                              anchor: anchor, end: CGPoint(x: endX, y: textY + 34), textY: textY, trailing: trailing))
        }
        return result
    }

    private func state(for room: Room) -> String {
        let on = room.devices.filter(\.online).count
        if on == room.devices.count { return on == 1 ? "On" : "\(on) displays on" }
        if on > 0 { return "\(on) of \(room.devices.count) on" }
        return DisplayGlyph.offline(room.devices)
    }
}

/// A small screen on a speaker base, the shape of Adam's display. No lens, so it never reads as a camera.
struct DisplayGlyph: View {
    var online: Bool

    var body: some View {
        Canvas { context, size in
            Self.draw(in: CGRect(origin: .zero, size: size), online: online, context: &context)
        }
        .aspectRatio(1.3, contentMode: .fit)
        .accessibilityHidden(true)
    }

    static func draw(in rect: CGRect, online: Bool, context: inout GraphicsContext) {
        let screen = CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height * 0.74)
        let corner = screen.height * 0.16
        let edge = Color.appInk.opacity(online ? 0.75 : 0.5)
        context.fill(Path(roundedRect: screen, cornerRadius: corner, style: .continuous),
                     with: .color(online ? Color.appSuccess.opacity(0.22) : Color.appSurface2))
        context.stroke(Path(roundedRect: screen.insetBy(dx: 0.5, dy: 0.5), cornerRadius: corner, style: .continuous),
                       with: .color(edge), lineWidth: 1)
        if online {
            let inset = screen.width * 0.16
            for (n, share) in [0.5, 0.32].enumerated() {
                let bar = CGRect(x: screen.minX + inset, y: screen.minY + screen.height * (0.34 + CGFloat(n) * 0.2),
                                 width: (screen.width - inset * 2) * share, height: max(1.5, screen.height * 0.08))
                context.fill(Path(roundedRect: bar, cornerRadius: bar.height / 2), with: .color(Color.appInk.opacity(0.7)))
            }
        }
        var base = Path()
        base.move(to: CGPoint(x: rect.midX - rect.width * 0.22, y: screen.maxY))
        base.addLine(to: CGPoint(x: rect.midX + rect.width * 0.22, y: screen.maxY))
        base.addLine(to: CGPoint(x: rect.midX + rect.width * 0.3, y: rect.maxY))
        base.addLine(to: CGPoint(x: rect.midX - rect.width * 0.3, y: rect.maxY))
        base.closeSubpath()
        context.fill(base, with: .color(Color.appInk.opacity(online ? 0.4 : 0.26)))
    }

    /// "Off since 20:55", "Off since Mon", or "Not set up yet" when it has never connected.
    static func offline(_ devices: [HomeModel.Device]) -> String {
        let seen = devices.compactMap { $0.lastSeenAt.flatMap(DisplayTimestampParser.date(from:)) }.max()
        guard let seen else { return "Not set up yet" }
        let when = Calendar.current.isDateInToday(seen) ? HomeNowView.clock(seen) : seen.formatted(.dateTime.weekday(.wide))
        return "Off since \(when)"
    }
}

/// Every display is off: say so plainly, say what to check, and give the one button that fixes it.
private struct HomeOfflineDisplays: View {
    let devices: [HomeModel.Device]
    var onFix: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    private var neverConnected: Bool { devices.allSatisfy { $0.lastSeenAt == nil } }

    private func title(_ device: HomeModel.Device) -> String {
        guard let room = device.room, !device.name.localizedCaseInsensitiveContains(room) else { return device.name }
        return "\(room) display"
    }

    var body: some View {
        HomePanel {
            VStack(alignment: .leading, spacing: AppSpacing.lg) {
                VStack(spacing: AppSpacing.md) {
                    ForEach(devices.prefix(3)) { device in
                        let row = typeSize.isAccessibilitySize
                            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AppSpacing.sm))
                            : AnyLayout(HStackLayout(spacing: AppSpacing.md))
                        row {
                            DisplayGlyph(online: false).frame(width: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(title(device)).font(.role(.body, weight: .semibold)).foregroundStyle(Color.appInk)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(DisplayGlyph.offline([device])).font(.role(.footnote)).foregroundStyle(Color.appMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                Text(neverConnected
                     ? "Finish setting it up so Adam can hear and show things at home."
                     : devices.count == 1
                        ? "Adam can't hear or show anything until it's back. Check it's plugged in and on your Wi\u{2011}Fi."
                        : "Adam can't hear or show anything until they're back. Check they're plugged in and on your Wi\u{2011}Fi.")
                    .font(.role(.callout)).foregroundStyle(Color.appInk.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                HomeButton(title: neverConnected ? "Finish setting up" : "Reconnect", primary: true, action: onFix)
            }
        }
    }
}

/// Nothing paired: one empty room outline and the way to add a display.
private struct HomeMapEmpty: View {
    var onSetUp: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            ZStack {
                IsoOutline()
                    .stroke(Color.appInk.opacity(0.24), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .frame(width: 236, height: 136)
                VStack(spacing: 2) {
                    Text("No display yet").font(.role(.footnote, weight: .medium)).foregroundStyle(Color.appInk)
                    Text("NOTHING PAIRED").font(.reading(.caption)).tracking(0.5).foregroundStyle(Color.appMuted)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 210)
            .accessibilityElement(children: .combine)
            Text("Pair a display and Adam shows each room and what it hears there.")
                .font(.role(.body)).foregroundStyle(Color.appMuted)
                .fixedSize(horizontal: false, vertical: true)
            HomeButton(title: "Add a display", primary: true, action: onSetUp)
        }
    }
}

private struct IsoOutline: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
        path.closeSubpath()
        return path
    }
}

// MARK: - Panels

struct HomePanel<Content: View>: View {
    var outline: Color? = nil
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(AppSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.appSurface, in: RoundedRectangle(cornerRadius: AppRadius.surface, style: .continuous))
            .overlay {
                if let outline {
                    RoundedRectangle(cornerRadius: AppRadius.surface, style: .continuous).strokeBorder(outline, lineWidth: 1)
                }
            }
    }
}

/// What Adam wants to do, what it costs, one clear button and a way out.
struct HomeAskCard: View {
    let item: BoardItem
    var model: ThreadBoardModel
    var open: (String) -> Void

    private var question: String {
        if item.title.lowercased().contains("needs your approval"),
           let prompt = item.prompt?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty { return prompt }
        return item.title
    }

    private var facts: ApprovalFacts { ApprovalFacts(detail: item.detail == question ? nil : item.detail) }

    private var factLine: String {
        var parts = facts.others
        if let card = facts.card { parts.append("card \(card)") }
        return parts.joined(separator: " · ")
    }

    private var busy: Bool { model.submittingDecisions.contains(item.id) || model.acknowledged[item.id] != nil }
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let lead = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AppSpacing.md))
            : AnyLayout(HStackLayout(alignment: .top, spacing: AppSpacing.md))
        return HomePanel(outline: Color.appNeedsYou.opacity(0.3)) {
            VStack(alignment: .leading, spacing: AppSpacing.md) {
                lead {
                    AppIcon(facts.amount != nil ? "card" : "person-check", size: 22)
                        .foregroundStyle(Color.appNeedsYou)
                        .frame(width: 52, height: 52)
                        .background(Color.appNeedsYou.opacity(0.12), in: RoundedRectangle(cornerRadius: AppRadius.control, style: .continuous))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: AppSpacing.xs) {
                        Text(question).font(.role(.body, weight: .semibold)).foregroundStyle(Color.appInk)
                            .fixedSize(horizontal: false, vertical: true)
                        if !factLine.isEmpty {
                            Text(factLine).font(.role(.footnote)).foregroundStyle(Color.appMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                if let amount = facts.amount {
                    HStack(alignment: .firstTextBaseline, spacing: AppSpacing.sm) {
                        Text(amount).font(.system(.largeTitle).weight(.bold)).monospacedDigit()
                            .tracking(-0.6).foregroundStyle(Color.appInk)
                        if let qualifier = facts.qualifier {
                            Text(qualifier.lowercased() == "up to" ? "at most" : qualifier.lowercased())
                                .font(.role(.footnote, weight: .medium)).foregroundStyle(Color.appMuted)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                if busy {
                    HStack(spacing: AppSpacing.sm) {
                        ProgressView().tint(Color.appMuted)
                        Text(model.submittingDecisions.contains(item.id) ? "Sending your answer" : "Waiting for confirmation")
                            .font(.role(.callout)).foregroundStyle(Color.appMuted)
                    }
                    .frame(minHeight: 44)
                } else {
                    if let error = model.decisionErrors[item.id] {
                        Text(error).font(.role(.callout)).foregroundStyle(Color.appDanger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    buttons
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var buttons: some View {
        VStack(spacing: AppSpacing.sm) {
            if let workflowID = item.workflowId {
                HomeButton(title: facts.amount != nil ? "Review and pay" : "Review", primary: true) { open(workflowID) }
                    .disabled(model.refreshFailed)
            } else if item.hasDecision, let options = item.options, !options.isEmpty {
                ForEach(options) { option in
                    HomeButton(title: option.label, primary: option.id == options.first?.id) {
                        Task { await model.decide(item, approved: true, choice: option.id) }
                    }
                }
            } else if item.hasDecision {
                HomeButton(title: "Approve", primary: true) { Task { await model.decide(item, approved: true) } }
            }
            if item.hasDecision {
                HomeButton(title: "Decline", primary: false) { Task { await model.decide(item, approved: false) } }
            }
        }
    }
}

struct HomeButton: View {
    let title: String
    var primary = true
    var ink: Color? = nil
    let action: () -> Void

    var body: some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            Text(title)
                .font(.role(.body, weight: .semibold))
                .foregroundStyle(primary ? (ink ?? Color.appOnAction) : Color.appInk)
                .multilineTextAlignment(.center)
                .padding(.horizontal, AppSpacing.lg)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background {
                    if primary { Capsule().fill(Color.appAction) }
                    else { Capsule().strokeBorder(Color.appCardOutline, lineWidth: 1) }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.appScale(0.97))
    }
}

/// A few plain sentences about today, built only from events the app has.
private struct HomeSummary: View {
    let title: String
    let text: String

    var body: some View {
        HomePanel {
            VStack(alignment: .leading, spacing: AppSpacing.sm) {
                Text(title).font(.role(.footnote, weight: .semibold)).foregroundStyle(Color.appMuted)
                    .accessibilityAddTraits(.isHeader)
                Text(text).font(.role(.body)).foregroundStyle(Color.appInk.opacity(0.9))
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Work running now: that it is live, what it's doing this moment, how far along, and what you can do about it.
struct HomeWorkCard: View {
    let item: BoardItem
    var model: ThreadBoardModel
    var open: (String) -> Void

    private var waiting: Bool { item.waitingExternal == true }

    /// The step happening now. A trailing ellipsis reads as cut-off text, and the live dot already says "ongoing".
    private var step: String? {
        guard let d = item.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !d.isEmpty, d != item.title else { return nil }
        var text = d
        while text.hasSuffix("…") || text.hasSuffix(".") { text.removeLast() }
        return text
    }

    private func liveLine(_ now: Date) -> String {
        let lead = waiting ? "Waiting for a reply" : "Working"
        guard let date = item.date else { return lead }
        let minutes = Int(now.timeIntervalSince(date) / 60)
        let when = minutes < 1 ? "just now" : minutes < 60 ? "\(minutes) min ago" : "at \(HomeNowView.clock(date))"
        return "\(lead) · last step \(when)"
    }

    var body: some View {
        HomePanel {
            VStack(alignment: .leading, spacing: AppSpacing.md) {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    HStack(spacing: AppSpacing.sm) {
                        LiveDot(active: !waiting)
                        Text(liveLine(context.date)).font(.role(.footnote, weight: .medium))
                            .foregroundStyle(waiting ? Color.appMuted : Color.appSuccess)
                    }
                }
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    Text(item.title).font(.role(.body, weight: .semibold)).foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                    if let step {
                        Text(step).font(.role(.callout)).foregroundStyle(Color.appInk.opacity(0.8))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
                if let p = item.progress, p.total > 0 {
                    VStack(alignment: .leading, spacing: AppSpacing.xs) {
                        Capsule().fill(Color.appInk.opacity(0.14)).frame(height: 4)
                            .overlay(alignment: .leading) {
                                GeometryReader { geo in
                                    Capsule().fill(Color.appInk).frame(width: max(4, geo.size.width * p.fraction))
                                }
                            }
                        Text("Step \(min(p.done + 1, p.total)) of \(p.total)").font(.role(.footnote)).monospacedDigit()
                            .foregroundStyle(Color.appMuted)
                    }
                    .accessibilityElement(children: .combine)
                } else if !waiting {
                    WorkingBar()
                }
                actions
            }
        }
    }

    @ViewBuilder private var actions: some View {
        let stopping = model.stopping.contains(item.id)
        if item.workflowId != nil || item.taskId != nil {
            HStack(spacing: AppSpacing.sm) {
                if let id = item.workflowId {
                    HomeButton(title: "See progress", primary: false) { open(id) }
                }
                if item.taskId != nil {
                    Button { Task { await model.stop(item) } } label: {
                        HStack(spacing: AppSpacing.sm) {
                            if stopping { ProgressView().tint(Color.appInk) }
                            else { RoundedRectangle(cornerRadius: 2).fill(Color.appInk).frame(width: 10, height: 10) }
                            Text(stopping ? "Stopping" : "Stop").font(.role(.body, weight: .semibold)).foregroundStyle(Color.appInk)
                        }
                        .padding(.horizontal, AppSpacing.lg)
                        .frame(minWidth: 104, minHeight: 50)
                        .background(Color.appSurface2, in: Capsule())
                        .overlay(Capsule().strokeBorder(Color.appCardOutline, lineWidth: 1))
                    }
                    .buttonStyle(.appScale(0.97))
                    .disabled(stopping)
                    .accessibilityLabel("Stop \(item.title)")
                }
            }
        }
    }
}

/// A small green light that breathes while work is running. Holds still with Reduce Motion.
private struct LiveDot: View {
    var active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        ZStack {
            if active && !reduceMotion {
                Circle().fill(Color.appSuccess.opacity(0.35))
                    .scaleEffect(pulse ? 2.2 : 1).opacity(pulse ? 0 : 1)
            }
            Circle().fill(active ? Color.appSuccess : Color.appMuted)
        }
        .frame(width: 7, height: 7)
        .accessibilityHidden(true)
        .onAppear {
            guard active, !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { pulse = true }
        }
    }
}

/// For work with no step count: a slow sweep that says "still going" without inventing a percentage.
private struct WorkingBar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweep = false

    var body: some View {
        Capsule().fill(Color.appInk.opacity(0.14)).frame(height: 4)
            .overlay(alignment: .leading) {
                GeometryReader { geo in
                    Capsule().fill(Color.appSuccess.opacity(0.85))
                        .frame(width: geo.size.width * 0.28)
                        .offset(x: reduceMotion ? 0 : (sweep ? geo.size.width * 0.72 : 0))
                }
            }
            .clipShape(Capsule())
            .accessibilityHidden(true)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) { sweep = true }
            }
    }
}

/// Earlier events: an icon, what happened, and the time on the right.
private struct HomeEarlier: View {
    let lines: [HomeLine]
    var open: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Earlier").font(.role(.footnote, weight: .semibold)).foregroundStyle(Color.appMuted)
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, AppSpacing.xs)
            ForEach(lines) { line in
                if let id = line.workflowID {
                    Button { open(id) } label: { row(line) }.buttonStyle(.plain)
                } else {
                    row(line)
                }
            }
        }
    }

    private func row(_ line: HomeLine) -> some View {
        HStack(alignment: .center, spacing: AppSpacing.md) {
            AppIcon(line.icon, size: 15)
                .foregroundStyle(line.failed ? Color.appDanger : Color.appMuted)
                .frame(width: 32, height: 32)
                .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(line.title).font(.role(.callout, weight: .medium)).foregroundStyle(Color.appInk)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = line.detail, !detail.isEmpty {
                    Text(detail).font(.role(.footnote)).foregroundStyle(Color.appMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let date = line.date {
                Text(Calendar.current.isDateInToday(date) ? HomeNowView.clock(date) : date.formatted(.dateTime.weekday(.abbreviated)))
                    .font(.reading(.caption, weight: .medium)).foregroundStyle(Color.appMuted)
            }
        }
        .padding(.vertical, AppSpacing.md)
        .overlay(alignment: .bottom) { Color.appHairline.frame(height: 0.5) }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct HomeWatching: View {
    let watches: [HomeModel.Watch]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Watching").font(.role(.footnote, weight: .semibold)).foregroundStyle(Color.appMuted)
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, AppSpacing.xs)
            ForEach(watches.prefix(4)) { watch in
                HStack(alignment: .center, spacing: AppSpacing.md) {
                    AppIcon("clock", size: 15).foregroundStyle(Color.appSuccess)
                        .frame(width: 32, height: 32)
                        .background(Color.appSuccess.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(watch.title).font(.role(.callout, weight: .medium)).foregroundStyle(Color.appInk)
                        if let detail = watch.detail, !detail.isEmpty {
                            Text(detail).font(.role(.footnote)).foregroundStyle(Color.appMuted)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, AppSpacing.md)
                .overlay(alignment: .bottom) { Color.appHairline.frame(height: 0.5) }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

// MARK: - Alarm takeover

/// A serious sound heard in the last few minutes takes over the screen until it is dealt with.
enum HomeAlarm {
    static let serious = ["smoke", "carbon", "monoxide", "glass", "cry"]
    static let dismissedKey = "adam_alarm_dismissed"

    @MainActor
    static func current(now: Date = Date()) -> SoundClipStore.Clip? {
        let dismissed = Set(UserDefaults.standard.stringArray(forKey: dismissedKey) ?? [])
        return SoundClipStore.shared.clips
            .filter { clip in
                let text = (clip.sound + " " + clip.title).lowercased()
                return now.timeIntervalSince(clip.heardAt) < 300 && clip.verdict == nil && !dismissed.contains(clip.id)
                    && serious.contains(where: { text.contains($0) })
            }
            .max { $0.heardAt < $1.heardAt }
    }

    static func dismiss(_ clip: SoundClipStore.Clip) {
        var dismissed = UserDefaults.standard.stringArray(forKey: dismissedKey) ?? []
        dismissed.append(clip.id)
        UserDefaults.standard.set(Array(dismissed.suffix(50)), forKey: dismissedKey)
    }
}

struct HomeAlarmView: View {
    let clip: SoundClipStore.Clip
    var onDone: () -> Void

    @State private var player: AVAudioPlayer?
    @State private var now = Date()
    @State private var levels: [CGFloat] = []

    private static let deep = Color(red: 0.48, green: 0.09, blue: 0.05)

    var body: some View {
        ZStack {
            RadialGradient(colors: [Color(red: 0.76, green: 0.2, blue: 0.12), Self.deep, Color(red: 0.2, green: 0.03, blue: 0.02)],
                           center: UnitPoint(x: 0.5, y: 0.25), startRadius: 10, endRadius: 700)
                .ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                Text(clip.title)
                    .font(.system(.largeTitle).weight(.bold)).tracking(-0.8)
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, AppSpacing.xxl)
                Text("Adam heard it on this iPhone.")
                    .font(.role(.body, weight: .medium)).foregroundStyle(.white.opacity(0.85))
                    .padding(.top, AppSpacing.md)
                HStack(alignment: .center, spacing: 3) {
                    ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                        Capsule().fill(.white.opacity(0.75)).frame(height: max(6, level * 96))
                    }
                }
                .frame(height: 100)
                .padding(.top, AppSpacing.xxl)
                .accessibilityHidden(true)
                Text("HEARD \(HomeNowView.clock(clip.heardAt)) · \(ago)")
                    .font(.reading(.caption, weight: .medium)).tracking(0.5)
                    .foregroundStyle(.white.opacity(0.7))
                    .padding(.top, AppSpacing.md)
                Spacer(minLength: AppSpacing.xxl)
                VStack(spacing: AppSpacing.sm) {
                    Button {
                        HapticManager.shared.impact(.medium)
                        HomeAlarm.dismiss(clip)
                        onDone()
                    } label: {
                        Text("I'm dealing with it").font(.role(.body, weight: .bold)).foregroundStyle(Self.deep)
                            .frame(maxWidth: .infinity, minHeight: 54)
                            .background(Color(red: 1, green: 0.95, blue: 0.93), in: Capsule())
                    }
                    .buttonStyle(.appScale(0.97))
                    Button { play() } label: {
                        Text("Play what Adam heard")
                            .font(.role(.body, weight: .semibold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .background(.white.opacity(0.16), in: Capsule())
                    }
                    .buttonStyle(.appScale(0.97))
                    Button {
                        SoundClipStore.shared.mark(clip, .wrong)
                        HomeAlarm.dismiss(clip)
                        onDone()
                    } label: {
                        Text("It's a false alarm").font(.role(.callout, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.bottom, AppSpacing.lg)
            }
            .padding(.horizontal, AppSpacing.xl)
        }
        .onAppear {
            levels = Self.levels(of: SoundClipStore.shared.url(for: clip))
            HapticManager.shared.error()
        }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { now = $0 }
    }

    private var ago: String {
        let seconds = max(0, Int(now.timeIntervalSince(clip.heardAt)))
        return seconds < 60 ? "\(seconds) SECONDS AGO" : "\(seconds / 60) MIN AGO"
    }

    private func play() {
        guard let p = try? AVAudioPlayer(contentsOf: SoundClipStore.shared.url(for: clip)) else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        player = p
        p.play()
    }

    /// The loudness of the saved clip in 48 slices, so the picture is the actual sound.
    private static func levels(of url: URL) -> [CGFloat] {
        guard let file = try? AVAudioFile(forReading: url),
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: buffer)) != nil, let data = buffer.floatChannelData?[0] else {
            return Array(repeating: 0.3, count: 48)
        }
        let count = Int(buffer.frameLength), slices = 48, size = max(1, count / slices)
        var out: [CGFloat] = []
        for i in 0..<slices {
            var peak: Float = 0
            for j in (i * size)..<min(count, (i + 1) * size) { peak = max(peak, abs(data[j])) }
            out.append(CGFloat(peak))
        }
        let top = max(out.max() ?? 1, 0.001)
        return out.map { $0 / top }
    }
}

/// In the conversation: the same ask and work cards as Home, at the moment they matter.
struct HomeMomentCards: View {
    var model: ThreadBoardModel
    @State private var openWorkflow: HomeOpenWorkflow?

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            ForEach(model.needsYou.prefix(2)) { item in
                HomeAskCard(item: item, model: model) { openWorkflow = HomeOpenWorkflow(id: $0) }
                    .id("board-decision-\(item.id)")
            }
            ForEach(model.working.prefix(2)) { item in
                HomeWorkCard(item: item, model: model) { openWorkflow = HomeOpenWorkflow(id: $0) }
            }
        }
        .sheet(item: $openWorkflow) { open in
            WorkflowTimelineView(workflowId: open.id, onChanged: { Task { await model.refresh() } })
        }
    }
}

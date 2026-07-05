import SwiftUI

// MARK: - Turn receipt

/// One quiet line per assistant turn summarising the work behind the answer
/// ("Read 7 emails and checked your calendar"). Individual tool calls never get
/// their own permanent blocks; they live inside this row's expansion. Rich
/// handoffs (Uber, travel) stay as dedicated cards and never enter this row.
struct TurnReceiptRow: View {
    let actions: [ActionResult]
    var onOpenAction: ((ActionResult) -> Void)? = nil

    @State private var isExpanded = false

    private var steps: [ReceiptStep] { actions.map(ReceiptStep.init) }

    /// Detail worth revealing: several steps, a step with somewhere to go, or a
    /// step whose detail says more than its phrase. Otherwise the row is static.
    private var isExpandable: Bool {
        steps.count > 1 || steps.contains { $0.detail != nil } || linkedSteps.count > 1
    }

    private var linkedSteps: [ReceiptStep] { steps.filter { $0.action.hasReceiptLink } }

    /// A lone link-only step opens directly instead of expanding to a one-row list.
    private var directOpenStep: ReceiptStep? {
        guard steps.count == 1, let only = steps.first, only.action.hasReceiptLink,
              only.detail == nil else { return nil }
        return only
    }

    private var rowState: ReceiptStep.State {
        if steps.contains(where: { $0.state == .failure }) { return .failure }
        if steps.allSatisfy({ $0.state == .neutral }) { return .neutral }
        return .success
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: primaryAction) {
                collapsedLine
            }
            .buttonStyle(.appScale(0.99))
            .disabled(!isExpandable && directOpenStep == nil)

            if isExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(steps) { step in
                        stepRow(step)
                    }
                }
                .padding(.leading, 22)
                .padding(.bottom, 6)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.appStandard, value: isExpanded)
    }

    // MARK: Collapsed line

    private var collapsedLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            glyph(for: rowState)

            Text(summaryLine)
                .font(.appBody(13))
                .foregroundStyle(Color.appMuted)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 8)

            if let _ = directOpenStep {
                HStack(spacing: 3) {
                    Text("Open")
                        .font(.appBody(12.5, weight: .medium))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                }
                .foregroundStyle(Color.appTitanium)
            } else if isExpandable {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.appMuted.opacity(0.75))
                    .rotationEffect(.degrees(isExpanded ? 180 : 0))
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(summaryLine)
        .accessibilityHint(isExpandable ? "Double tap to show what was done." : "")
    }

    /// "Read 7 emails and checked your calendar" — fragments joined into one
    /// sentence, first letter capitalised, de-duplicated so three searches in a
    /// turn read as one clause.
    private var summaryLine: String {
        var seen = Set<String>()
        let fragments = steps.map(\.fragment).filter { seen.insert($0).inserted }
        guard let first = fragments.first else { return "Done" }
        let joined: String
        switch fragments.count {
        case 1: joined = first
        case 2: joined = "\(first) and \(fragments[1])"
        default: joined = fragments.dropLast().joined(separator: ", ") + " and " + fragments.last!
        }
        return joined.prefix(1).uppercased() + joined.dropFirst()
    }

    // MARK: Expanded steps

    private func stepRow(_ step: ReceiptStep) -> some View {
        Button {
            if step.action.hasReceiptLink { onOpenAction?(step.action) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                glyph(for: step.state)
                VStack(alignment: .leading, spacing: 1) {
                    Text(step.fragment.prefix(1).uppercased() + step.fragment.dropFirst())
                        .font(.appBody(13))
                        .foregroundStyle(Color.appInk.opacity(0.94))
                    if let detail = step.detail {
                        Text(detail)
                            .font(.appBody(12))
                            .foregroundStyle(Color.appMuted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                if step.action.hasReceiptLink {
                    HStack(spacing: 3) {
                        Text("Open")
                            .font(.appBody(12, weight: .medium))
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                    }
                    .foregroundStyle(Color.appTitanium)
                }
            }
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.99))
        .disabled(!step.action.hasReceiptLink)
    }

    @ViewBuilder
    private func glyph(for state: ReceiptStep.State) -> some View {
        Group {
            switch state {
            case .success:
                // Muted, not green — green is reserved for world-changing outcomes.
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.appMuted)
            case .failure:
                Image(systemName: "exclamationmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.appDanger)
            case .neutral:
                Circle()
                    .fill(Color.appMuted.opacity(0.5))
                    .frame(width: 5, height: 5)
            }
        }
        .frame(width: 12, alignment: .center)
    }

    private func primaryAction() {
        if let direct = directOpenStep {
            onOpenAction?(direct.action)
        } else if isExpandable {
            isExpanded.toggle()
        }
    }
}

// MARK: - Step model

/// A completed tool call rendered as one human step inside the turn receipt.
/// Purely presentational — the underlying `ActionResult` is kept intact.
private struct ReceiptStep: Identifiable {
    enum State { case success, failure, neutral }

    let action: ActionResult

    var id: String { action.id }

    var state: State {
        if isSoftMiss { return .neutral }
        return action.success ? .success : .failure
    }

    /// Lowercase sentence fragment, joinable into the collapsed summary:
    /// "read 7 emails", "checked your calendar", "searched the web".
    var fragment: String {
        let compact = compactText
        if !action.success {
            if action.action == "find_place" {
                return "couldn't find nearby places"
            }
            return "couldn't finish \(shortName)"
        }
        if isSoftMiss {
            switch action.action {
            case "get_emails", "search_emails": return "searched your inbox — no matches"
            case "get_calendar_events": return "checked your calendar — nothing there"
            default: return "\(shortName) — no matches"
            }
        }
        switch action.action {
        case "get_emails", "search_emails":
            if let count = Self.firstInteger(in: compact) {
                return "read \(count) \(count == 1 ? "email" : "emails")"
            }
            return "read your email"
        case "get_calendar_events":
            return "checked your calendar"
        case "web_search":
            return "searched the web"
        case "find_place":
            return "found a place"
        case "check_health":
            return "checked your health data"
        default:
            if let summary = action.actionSummary, !summary.isEmpty {
                return summary.prefix(1).lowercased() + summary.dropFirst()
            }
            return shortName
        }
    }

    /// Optional one-line supporting detail for the expanded step — only when the
    /// raw text says more than the fragment already does.
    var detail: String? {
        let compact = compactText
        guard !compact.isEmpty else { return nil }
        if !action.success, action.action == "find_place" {
            return "Location access is off. Enable location permissions, then retry."
        }
        if isSoftMiss { return nil }
        // Counted reads are fully described by the fragment; a repeat is noise.
        if action.success, !isSoftMiss {
            switch action.action {
            case "get_emails", "search_emails", "get_calendar_events", "web_search":
                return nil
            default:
                break
            }
        }
        guard compact.localizedCaseInsensitiveCompare(fragment) != .orderedSame else { return nil }
        return compact
    }

    private var compactText: String {
        (action.cardText ?? action.text ?? action.error ?? "")
            .strippingMarkdown
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var shortName: String {
        action.action.replacingOccurrences(of: "_", with: " ")
    }

    /// A benign "nothing to return" result (no matching emails, no events) —
    /// neither a success worth a checkmark nor a failure. Ported from the old
    /// per-action card so zero-result searches keep their neutral treatment.
    private var isSoftMiss: Bool {
        let haystack = (action.text ?? action.cardText ?? action.error ?? "").lowercased()
        guard haystack.count < 120 else { return false }
        let softPhrases = [
            "no matching", "no matches", "nothing matching", "no results",
            "no emails matching", "no messages matching", "couldn't find any",
            "found nothing", "0 results", "no upcoming", "no events matching"
        ]
        return softPhrases.contains { haystack.hasPrefix($0) || haystack.contains($0) && haystack.count < 60 }
    }

    private static func firstInteger(in text: String) -> Int? {
        guard let range = text.range(of: #"\b\d+\b"#, options: .regularExpression) else { return nil }
        return Int(text[range])
    }
}

private extension ActionResult {
    var hasReceiptLink: Bool { deepLink != nil || webLink != nil }
}

#Preview {
    VStack(alignment: .leading, spacing: 24) {
        TurnReceiptRow(actions: [
            ActionResult(action: "get_emails", success: true, text: "Found 7 emails from today"),
            ActionResult(action: "get_calendar_events", success: true, text: "3 events tomorrow")
        ])
        TurnReceiptRow(actions: [
            ActionResult(action: "search_emails", success: true, text: "No matching emails found")
        ])
        TurnReceiptRow(actions: [
            ActionResult(action: "get_emails", success: true, text: "Found 4 emails"),
            ActionResult(action: "get_calendar_events", success: false, error: "Calendar timed out")
        ])
        TurnReceiptRow(actions: [
            ActionResult(action: "find_place", success: true, text: "Found Luca, Clerkenwell", webLink: "https://maps.apple.com")
        ])
    }
    .padding(20)
    .background(Color.appBackground)
}

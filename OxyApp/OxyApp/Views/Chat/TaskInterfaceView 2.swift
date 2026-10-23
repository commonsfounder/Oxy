import SwiftUI

struct TaskInterfaceSpec: Codable, Equatable {
    let title: String
    let mode: String
    let panel: [TaskInterfaceBlock]
    let asks: [String]?
}

struct TaskInterfaceBlock: Codable, Equatable, Identifiable {
    let id: String
    let type: String
    let text: String?
    let style: String?
    let value: Double?
    let unit: String?
    let label: String?
    let decimals: Int?
    let items: [TaskInterfaceItem]?
    let columns: [String]?
    let rows: [[String]]?
    let fields: [TaskInterfaceField]?
    let submit: String?
    let ask: String?
}

struct TaskInterfaceItem: Codable, Equatable {
    let title: String?
    let detail: String?
    let ask: String?
    let facts: [TaskInterfaceFact]?
    let label: String?
    let value: Double?
    let from: String?
    let to: String?

    enum CodingKeys: String, CodingKey { case title, detail, ask, facts, label, value, from, to }

    init(from decoder: Decoder) throws {
        if let text = try? decoder.singleValueContainer().decode(String.self) {
            title = text; detail = nil; ask = nil; facts = nil
            label = nil; value = nil; from = nil; to = nil
        } else {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            title = try c.decodeIfPresent(String.self, forKey: .title)
            detail = try c.decodeIfPresent(String.self, forKey: .detail)
            ask = try c.decodeIfPresent(String.self, forKey: .ask)
            facts = try c.decodeIfPresent([TaskInterfaceFact].self, forKey: .facts)
            label = try c.decodeIfPresent(String.self, forKey: .label)
            value = try c.decodeIfPresent(Double.self, forKey: .value)
            from = try c.decodeIfPresent(String.self, forKey: .from)
            to = try c.decodeIfPresent(String.self, forKey: .to)
        }
    }
}

struct TaskInterfaceFact: Codable, Equatable {
    let label: String
    let value: String
}

struct TaskInterfaceField: Codable, Equatable, Identifiable {
    let id: String
    let label: String
    let type: String
    let required: Bool
    let placeholder: String?
}

// Layout follows the decision, while actions stay ordinary turns in this conversation.
struct TaskInterfaceView: View {
    let spec: TaskInterfaceSpec
    let onAsk: (String) -> Void

    @State private var values: [String: String] = [:]
    @State private var checked: Set<String> = []
    @State private var formError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(spec.title)
                .font(.sectionTitle)
                .foregroundStyle(Color.appInk)
                .accessibilityAddTraits(.isHeader)
            ForEach(spec.panel) { block in
                panel(block)
            }
            if let asks = spec.asks, !asks.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(asks, id: \.self) { ask in requestButton(ask, request: ask) }
                }
            }
            if let formError {
                Text(formError).font(.rowSecondary).foregroundStyle(Color.appWarning)
                    .accessibilityIdentifier("interface-error")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("task-interface")
    }

    @ViewBuilder
    private func panel(_ block: TaskInterfaceBlock) -> some View {
        switch block.type {
        case "text":
            Text(block.text ?? "")
                .font(block.style == "h" ? .sectionTitle : .bodyText)
                .foregroundStyle(block.style == "sub" ? Color.appMuted : Color.appInk)
                .fixedSize(horizontal: false, vertical: true)
        case "choices": choices(block)
        case "compare": comparison(block)
        case "table": table(block)
        case "form": form(block)
        case "steps": checklist(block)
        case "number":
            VStack(alignment: .leading, spacing: 6) {
                if let label = block.label { Text(label).font(.rowSecondary).foregroundStyle(Color.appMuted) }
                Text(number(block.value ?? 0, decimals: block.decimals ?? 0) + (block.unit.map { " \($0)" } ?? ""))
                    .font(.heroTitle).monospacedDigit().foregroundStyle(Color.appInk)
            }
        case "bars": bars(block)
        case "timeline": timeline(block)
        default: EmptyView()
        }
    }

    private func choices(_ block: TaskInterfaceBlock) -> some View {
        VStack(spacing: 8) {
            ForEach(Array((block.items ?? []).enumerated()), id: \.offset) { _, item in
                Button { send(item.ask ?? "") } label: {
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item.title ?? "").font(.rowTitle).foregroundStyle(Color.appInk)
                            if let detail = item.detail { Text(detail).font(.rowSecondary).foregroundStyle(Color.appMuted) }
                        }
                        Spacer(minLength: 8)
                        AppIcon("arrow-up-right", size: 14).foregroundStyle(Color.appMuted)
                    }
                    .padding(14).frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .settingsSurface(radius: 16)
                }
                .buttonStyle(.appScale(0.98))
                .accessibilityIdentifier("interface-choice-\(block.id)")
            }
        }
    }

    private func comparison(_ block: TaskInterfaceBlock) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(Array((block.items ?? []).enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading, spacing: 14) {
                        Text(item.title ?? "").font(.sectionTitle).foregroundStyle(Color.appInk)
                        ForEach(Array((item.facts ?? []).enumerated()), id: \.offset) { _, fact in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(fact.label).font(.fineprint).foregroundStyle(Color.appMuted)
                                Text(fact.value).font(.bodyText).foregroundStyle(Color.appInk)
                            }
                        }
                        if let ask = item.ask { requestButton("Choose \(item.title ?? "option")", request: ask) }
                    }
                    .padding(16).frame(width: 238, alignment: .leading).settingsSurface(radius: 16)
                }
            }
        }
        .accessibilityIdentifier("interface-comparison")
    }

    private func table(_ block: TaskInterfaceBlock) -> some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                tableRow(block.columns ?? [], header: true)
                ForEach(Array((block.rows ?? []).enumerated()), id: \.offset) { _, row in
                    Divider().overlay(Color.appCardOutline)
                    tableRow(row, header: false)
                }
            }
        }
        .accessibilityIdentifier("interface-table")
    }

    private func tableRow(_ cells: [String], header: Bool) -> some View {
        HStack(alignment: .top, spacing: 16) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                Text(cell).font(header ? .rowTitle : .bodyText)
                    .foregroundStyle(header ? Color.appInk : Color.appMuted)
                    .frame(width: 126, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }

    private func form(_ block: TaskInterfaceBlock) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(block.fields ?? []) { field in
                VStack(alignment: .leading, spacing: 8) {
                    Text(field.label + (field.required ? " (required)" : ""))
                        .font(.rowTitle).foregroundStyle(Color.appInk)
                    TextField(field.label, text: fieldValue(block: block.id, field: field.id), prompt: Text(field.placeholder ?? field.label).foregroundStyle(Color.appMuted), axis: .vertical)
                        .lineLimit(field.type == "multiline" ? 3...6 : 1...2)
                        .keyboardType(field.type == "number" ? .decimalPad : .default)
                        .font(.bodyText).foregroundStyle(Color.appInk)
                        .padding(12).frame(minHeight: 48).settingsSurface(radius: 12)
                        .accessibilityLabel(field.label)
                        .accessibilityIdentifier("interface-field-\(field.id)")
                }
            }
            Button {
                let fields = block.fields ?? []
                if let missing = fields.first(where: { $0.required && value(block.id, $0.id).isEmpty }) {
                    formError = "Enter \(missing.label.lowercased())."; return
                }
                if let invalid = fields.first(where: { $0.type == "number" && !value(block.id, $0.id).isEmpty && Double(value(block.id, $0.id)) == nil }) {
                    formError = "Enter a number for \(invalid.label.lowercased())."; return
                }
                let details = fields.compactMap { field -> String? in
                    let text = value(block.id, field.id)
                    return text.isEmpty ? nil : "\(field.label): \(text)"
                }
                send(([block.ask ?? "Use these details"] + details).joined(separator: "\n"))
            } label: {
                Text(block.submit ?? "Continue").font(.control)
                    .foregroundStyle(Color.appOnAction).frame(maxWidth: .infinity, minHeight: 48)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color.appAction))
            }
            .buttonStyle(.appScale(0.98))
            .accessibilityIdentifier("interface-submit")
        }
    }

    private func checklist(_ block: TaskInterfaceBlock) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array((block.items ?? []).enumerated()), id: \.offset) { index, item in
                let key = "\(block.id).\(index)"
                Button {
                    if checked.contains(key) { checked.remove(key) } else { checked.insert(key) }
                    HapticManager.shared.impact(.light)
                } label: {
                    HStack(alignment: .center, spacing: 12) {
                        Circle().fill(checked.contains(key) ? Color.appAccent : Color.clear)
                            .overlay(Circle().strokeBorder(checked.contains(key) ? Color.appAccent : Color.appMuted, lineWidth: 1.5))
                            .frame(width: 20, height: 20)
                        Text(item.title ?? "").font(.bodyText).foregroundStyle(Color.appInk)
                            .strikethrough(checked.contains(key))
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 48).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.title ?? "Item")
                .accessibilityValue(checked.contains(key) ? "Checked" : "Unchecked")
            }
            requestButton("Share progress", request: checklistRequest(block))
        }
        .accessibilityIdentifier("interface-checklist")
    }

    private func checklistRequest(_ block: TaskInterfaceBlock) -> String {
        let done = (block.items ?? []).enumerated().compactMap { index, item in checked.contains("\(block.id).\(index)") ? item.title : nil }
        return "Checklist progress: " + (done.isEmpty ? "No items checked" : done.joined(separator: "; "))
    }

    private func bars(_ block: TaskInterfaceBlock) -> some View {
        let items = block.items ?? []
        let maximum = max(items.compactMap(\.value).max() ?? 1, 1)
        return VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                VStack(spacing: 6) {
                    HStack {
                        Text(item.label ?? "")
                        Spacer()
                        Text(number(item.value ?? 0, decimals: 0) + (block.unit.map { " \($0)" } ?? "")).monospacedDigit()
                    }.font(.bodyText).foregroundStyle(Color.appInk)
                    GeometryReader { geometry in
                        Capsule().fill(Color.appCardOutline)
                            .overlay(alignment: .leading) {
                                Capsule().fill(Color.appAccent).frame(width: geometry.size.width * min(max((item.value ?? 0) / maximum, 0), 1))
                            }
                    }.frame(height: 6).accessibilityHidden(true)
                }
            }
        }
    }

    private func timeline(_ block: TaskInterfaceBlock) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array((block.items ?? []).enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: 18) {
                    Text((item.from ?? "") + (item.to.map { "–\($0)" } ?? ""))
                        .font(.fineprint).monospacedDigit().foregroundStyle(Color.appMuted).frame(width: 94, alignment: .leading)
                    Text(item.label ?? "").font(.bodyText).foregroundStyle(Color.appInk)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func requestButton(_ label: String, request: String) -> some View {
        Button { send(request) } label: {
            Text(label).font(.control).foregroundStyle(Color.appAccent)
                .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle()).multilineTextAlignment(.leading)
        }.buttonStyle(.plain)
    }

    private func fieldValue(block: String, field: String) -> Binding<String> {
        let key = "\(block).\(field)"
        return Binding(get: { values[key] ?? "" }, set: { values[key] = String($0.prefix(160)); formError = nil })
    }

    private func value(_ block: String, _ field: String) -> String {
        (values["\(block).\(field)"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func number(_ value: Double, decimals: Int) -> String {
        value.formatted(.number.precision(.fractionLength(decimals)))
    }

    private func send(_ request: String) {
        guard !request.isEmpty else { return }
        formError = nil
        HapticManager.shared.impact(.light)
        onAsk("For \(spec.title): \(request)")
    }
}

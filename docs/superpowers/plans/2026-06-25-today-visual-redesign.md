# Today Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Today's flat seven-card stack with a living weather hero plus a user-composed board of real-data cards (Inbox, Incoming, Agenda, Reminders), and stop the proactive briefing from surfacing AI "what matters" filler.

**Architecture:** The Incoming card rides the *existing* proactive pipeline — a new heuristic parser folds delivery/order/reservation items into `gatherProactiveContext`, which already ships in `briefings.metadata` (exactly like `emails`). iOS reads them off `Briefing.metadata`. Card visibility + order is client-only state in `@AppStorage`. The hero is a restyle of the existing `hero`/`weatherCard` pair into one full-bleed condition-reactive band.

**Tech Stack:** Node.js (CommonJS, `node:test`/`node:assert`) for backend; SwiftUI (iOS 17+, MeshGradient on 18+) for the app. Design tokens in `OxyApp/OxyApp/Extensions/NamelessTheme.swift`.

## Global Constraints

- **Monochrome only.** Hue is reserved for status (`NamelessStatusDot`, `nmlAttention` amber, `nmlDanger` coral). No new colors. Richness comes from type, imagery, motion, and titanium/white data-viz. (`NamelessTheme.swift`)
- **Typography by role:** Fraunces serif (`.nmlDisplay`) for greeting/identity only; Inter (`.nmlBody`) for UI; monospace (`.nmlMono`) for telemetry/numbers. (`NamelessTheme.swift` lines 118-149)
- **Today finish tracks the clock**, not a manual toggle: `TodayFinish.isLight` (07:00–18:59 = light). Palette via `TodayPalette` / the view's `p`.
- **No AI "what matters" text on Today.** No motivational/priority narration surfaces in the redesigned screen.
- **Cards hide when empty** — never render an empty/"nothing here" box (the current `agendaCard`/`inboxCard` already follow this).
- **Backend tests:** `npm run smoke` (`node --test test/smoke/*.test.js`). New backend logic is TDD'd here.
- **iOS tests:** This repo has **no XCTest/XCUITest harness**. SwiftUI tasks are verified by an Xcode build succeeding plus a described visual check in the simulator — not by unit tests. Do not invent Swift test files.
- **Commit frequently**, one task per commit. End commit messages with the Co-Authored-By trailer used in this repo.

---

## File Structure

**Backend (Node):**
- Create `api/services/incoming.js` — `extractIncoming(emails)` heuristic parser. One responsibility: turn raw inbox emails into structured Incoming items.
- Create `test/smoke/incoming.test.js` — parser tests.
- Modify `api/index.js` — fold `extractIncoming` into `gatherProactiveContext` (~line 4982-5013) and into the briefing `metadata` (~line 5327); trim weather prose + Today signal surfacing from `buildIntervalBriefing` (~line 5214-5273).

**iOS (Swift):**
- Modify `OxyApp/OxyApp/Models/Message.swift` — add `BriefingIncoming`, extend `BriefingMetadata` + `Briefing`.
- Create `OxyApp/OxyApp/Views/Proactive/TodayLayout.swift` — `TodayCardKind` enum + `TodayLayout` `@AppStorage`-backed order/visibility model.
- Create `OxyApp/OxyApp/Views/Proactive/IncomingCard.swift` — the Incoming card view + delivery progress bar.
- Modify `OxyApp/OxyApp/Views/Proactive/ProactiveView.swift` — promote hero, render cards from layout, drop signals/briefing/activity, add edit/reorder + Add-a-card picker.

---

## Task 1: Incoming parser (`extractIncoming`)

**Files:**
- Create: `api/services/incoming.js`
- Test: `test/smoke/incoming.test.js`

**Interfaces:**
- Consumes: an array of emails shaped like `gatherProactiveContext` produces — `{ from, subject, snippet, date }` (all strings; `date` ISO or null).
- Produces: `extractIncoming(emails) -> IncomingItem[]` where
  `IncomingItem = { kind: 'delivery'|'reservation', title: string, vendor: string, status: string, eta: string|null, stage: 0|1|2|3|null }`.
  `stage` is the delivery progress (0 ordered → 3 delivered); `null` for reservations.

- [ ] **Step 1: Write the failing test**

```js
// test/smoke/incoming.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { extractIncoming } = require('../../api/services/incoming');

test('detects an out-for-delivery shipment with stage 2', () => {
  const items = extractIncoming([
    { from: 'Amazon.co.uk <ship-confirm@amazon.co.uk>',
      subject: 'Your package is out for delivery',
      snippet: 'Sony WH-1000XM5 will arrive today by 6pm', date: '2026-06-25T08:00:00Z' }
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'delivery');
  assert.equal(items[0].vendor, 'Amazon');
  assert.equal(items[0].stage, 2);
  assert.match(items[0].status, /out for delivery/i);
});

test('detects a reservation with no progress stage', () => {
  const items = extractIncoming([
    { from: 'OpenTable <reservations@opentable.com>',
      subject: 'Your reservation at Lasan is confirmed',
      snippet: 'Table for 2 on Saturday 8:00pm', date: '2026-06-24T10:00:00Z' }
  ]);
  assert.equal(items[0].kind, 'reservation');
  assert.equal(items[0].stage, null);
  assert.match(items[0].title, /Lasan/);
});

test('ignores ordinary mail', () => {
  const items = extractIncoming([
    { from: 'Sarah <sarah@example.com>', subject: 'Re: Friday', snippet: 'does the venue still work?', date: null }
  ]);
  assert.deepEqual(items, []);
});

test('maps shipped vs delivered to stages 1 and 3', () => {
  const shipped = extractIncoming([
    { from: 'shipment-tracking@amazon.co.uk', subject: 'Your order has shipped', snippet: 'on its way', date: null }
  ]);
  assert.equal(shipped[0].stage, 1);
  const delivered = extractIncoming([
    { from: 'auto-confirm@amazon.co.uk', subject: 'Delivered: your package', snippet: 'left at front door', date: null }
  ]);
  assert.equal(delivered[0].stage, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/incoming.test.js`
Expected: FAIL — `Cannot find module '../../api/services/incoming'`.

- [ ] **Step 3: Write minimal implementation**

```js
// api/services/incoming.js
//
// Heuristic parser: turn raw inbox emails into structured "Incoming" items
// (deliveries + reservations). ponytail: pure keyword/vendor heuristics, no LLM —
// upgrade to a model pass only if real-world coverage proves thin.

const DELIVERY_STAGES = [
  { stage: 3, re: /\b(delivered|was delivered|left at|handed to)\b/i, status: 'Delivered' },
  { stage: 2, re: /\b(out for delivery|arriving today|on the van|with your courier)\b/i, status: 'Out for delivery' },
  { stage: 1, re: /\b(shipped|dispatched|on its way|has been sent)\b/i, status: 'Shipped' },
  { stage: 0, re: /\b(order (confirmed|received|placed)|thanks for your order|we got your order)\b/i, status: 'Ordered' }
];

const RESERVATION_RE = /\b(reservation|booking|table for|booked|your booking)\b/i;
const RESERVATION_CONFIRMED_RE = /\b(confirmed|is confirmed)\b/i;

// Known senders → display vendor. Falls back to the email display name.
const VENDORS = [
  { re: /amazon/i, name: 'Amazon' },
  { re: /opentable/i, name: 'OpenTable' },
  { re: /resy/i, name: 'Resy' },
  { re: /(royalmail|royal mail)/i, name: 'Royal Mail' },
  { re: /(dpd|evri|hermes|ups|fedex|dhl)/i, name: 'Courier' }
];

function vendorOf(from) {
  for (const v of VENDORS) if (v.re.test(from)) return v.name;
  const name = String(from || '').split('<')[0].trim().replace(/"/g, '');
  return name || 'Unknown';
}

function normalize(s) { return String(s || '').trim(); }

function extractIncoming(emails = []) {
  const items = [];
  for (const email of emails) {
    const from = normalize(email.from);
    const subject = normalize(email.subject);
    const snippet = normalize(email.snippet);
    const hay = `${subject} ${snippet}`;

    const stageMatch = DELIVERY_STAGES.find(s => s.re.test(hay) || s.re.test(from));
    if (stageMatch) {
      items.push({
        kind: 'delivery',
        title: subject.replace(/^(re:|fwd:)\s*/i, '') || 'Package',
        vendor: vendorOf(from),
        status: stageMatch.status,
        eta: snippet.match(/\b(today|tomorrow)\b[^.]*?(by\s*\d{1,2}\s*(am|pm)?)?/i)?.[0] || null,
        stage: stageMatch.stage
      });
      continue;
    }

    if (RESERVATION_RE.test(hay)) {
      items.push({
        kind: 'reservation',
        title: subject.replace(/^(re:|fwd:)\s*/i, '') || 'Reservation',
        vendor: vendorOf(from),
        status: RESERVATION_CONFIRMED_RE.test(hay) ? 'Confirmed' : 'Pending',
        eta: snippet.match(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b[^.]*?(\d{1,2}(:\d{2})?\s*(am|pm)?)?/i)?.[0] || null,
        stage: null
      });
    }
  }
  return items;
}

module.exports = { extractIncoming };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/incoming.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add api/services/incoming.js test/smoke/incoming.test.js
git commit -m "feat(today): heuristic Incoming parser for deliveries + reservations"
```

---

## Task 2: Fold Incoming into the proactive pipeline

**Files:**
- Modify: `api/index.js` — `gatherProactiveContext` (~4965-5013) and the briefing `metadata` object (~5327).

**Interfaces:**
- Consumes: `extractIncoming` from Task 1; `context.emails` already built in `gatherProactiveContext`.
- Produces: `context.incoming: IncomingItem[]` and `metadata.incoming` on stored briefings.

- [ ] **Step 1: Require the parser**

At the top of `api/index.js` with the other service requires, add:

```js
const { extractIncoming } = require('./services/incoming');
```

- [ ] **Step 2: Populate `context.incoming` in `gatherProactiveContext`**

In `gatherProactiveContext`, after the `context.emails = ...` assignment block completes (just before `context.location = ...` at ~line 5008), add:

```js
  // Structured deliveries/reservations parsed from the same Primary-inbox emails.
  context.incoming = extractIncoming(context.emails);
```

- [ ] **Step 3: Ship it in the briefing metadata**

In `maybeCreateIntervalBriefing`, find the `metadata` object (~line 5327):

```js
  const metadata = { window: window.id, date: todayKey, emails: ctx.emails, lead, signals };
```

Change it to:

```js
  const metadata = { window: window.id, date: todayKey, emails: ctx.emails, incoming: ctx.incoming, lead, signals };
```

- [ ] **Step 4: Verify the bundle still loads**

Run: `node --check api/index.js && npm run smoke`
Expected: no syntax error; existing smoke suite still passes.

- [ ] **Step 5: Commit**

```bash
git add api/index.js
git commit -m "feat(today): carry parsed Incoming items in briefing metadata"
```

---

## Task 3: iOS model — `BriefingIncoming`

**Files:**
- Modify: `OxyApp/OxyApp/Models/Message.swift` (`BriefingMetadata` ~275-279, `Briefing` ~248-273).

**Interfaces:**
- Consumes: the `metadata.incoming` JSON from Task 2.
- Produces: `Briefing.incoming -> [BriefingIncoming]` for the views (Tasks 6-7).

- [ ] **Step 1: Add the model**

After `struct BriefingEmail` in `Message.swift`, add:

```swift
/// A delivery, order, or reservation parsed server-side from the user's inbox.
/// `stage` is delivery progress 0…3 (ordered→delivered); nil for reservations.
struct BriefingIncoming: Codable, Equatable, Identifiable {
    let kind: String        // "delivery" | "reservation"
    let title: String
    let vendor: String
    let status: String
    let eta: String?
    let stage: Int?

    var id: String { vendor + "|" + title }
    var isDelivery: Bool { kind == "delivery" }
    var cleanTitle: String { title.decodingHTMLEntities() }
}
```

- [ ] **Step 2: Extend `BriefingMetadata`**

```swift
struct BriefingMetadata: Codable, Equatable {
    let emails: [BriefingEmail]?
    let incoming: [BriefingIncoming]?
    let lead: String?
    let signals: [BriefingSignal]?
}
```

- [ ] **Step 3: Expose it on `Briefing`**

After `var emails: [BriefingEmail] { metadata?.emails ?? [] }` add:

```swift
    var incoming: [BriefingIncoming] { metadata?.incoming ?? [] }
```

- [ ] **Step 4: Verify the build**

Run: `xcodebuild -scheme OxyApp -destination 'platform=iOS Simulator,name=iPhone 15' build` (or build in Xcode).
Expected: build succeeds (decoding is additive; older briefings without `incoming` decode to nil).

- [ ] **Step 5: Commit**

```bash
git add OxyApp/OxyApp/Models/Message.swift
git commit -m "feat(today): BriefingIncoming model + metadata field"
```

---

## Task 4: Living weather hero

**Files:**
- Modify: `OxyApp/OxyApp/Views/Proactive/ProactiveView.swift` — replace `hero` (134-173) and remove the standalone `weatherCard` (208-275) from the body; keep `weatherDetailGrid`, `weatherDetail`, `weatherExpanded`.

**Interfaces:**
- Consumes: `weather` (`OxyWeatherService.OxyWeatherSnapshot`), `greeting`, `dateLine`, `weatherExpanded`, `p`/`lightMode`.
- Produces: a `hero` view that is the full-bleed top band and the single source of weather on Today.

- [ ] **Step 1: Replace `hero` with the living version**

Replace the `hero` computed property (lines 134-173) with:

```swift
    // MARK: - Hero (living weather)

    private var hero: some View {
        ZStack(alignment: .bottomLeading) {
            HeroSky(condition: weather?.symbolName, light: lightMode)
                .frame(height: 264)
                .clipShape(RoundedRectangle(cornerRadius: 0))

            // Top row: day/night glyph + refresh, pinned top-trailing.
            VStack {
                HStack {
                    Spacer()
                    Image(systemName: lightMode ? "sun.max" : "moon.stars")
                        .font(.system(size: 14))
                        .foregroundStyle(p.muted)
                    Button(action: { Task { await checkNow() } }) {
                        if isChecking { ProgressView().scaleEffect(0.7).tint(p.muted) }
                        else { Image(systemName: "arrow.clockwise").font(.system(size: 15)).foregroundStyle(p.titanium) }
                    }
                    .buttonStyle(.nmlScale).disabled(isChecking).accessibilityLabel("Refresh")
                }
                Spacer()
            }
            .padding(.top, 8)

            // Greeting + temperature, bottom-leading. Whole hero is the tap target.
            Button {
                guard weather != nil else { return }
                HapticManager.shared.impact(.light)
                withAnimation(.nmlStandard) { weatherExpanded.toggle() }
            } label: {
                VStack(alignment: .leading, spacing: 0) {
                    Text(greeting)
                        .font(.nmlDisplay(31, weight: .light))
                        .foregroundStyle(p.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(dateLine)
                        .font(.nmlBody(12)).tracking(0.5).foregroundStyle(p.muted)
                        .padding(.top, 6)
                    if let weather {
                        HStack(alignment: .firstTextBaseline, spacing: 2) {
                            Text("\(Int(weather.temperatureC.rounded()))")
                                .font(.nmlDisplay(56, weight: .light))
                                .foregroundStyle(p.ink)
                                .contentTransition(.numericText())
                            Text("°").font(.nmlDisplay(24, weight: .light)).foregroundStyle(p.ink)
                            Text("  \(weather.conditionDescription) · feels \(Int(weather.apparentC.rounded()))°")
                                .font(.nmlBody(13)).foregroundStyle(p.muted)
                        }
                        .padding(.top, 14)
                    }
                    if weatherExpanded, let weather {
                        weatherDetailGrid(weather)
                            .padding(.top, 14)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.nmlScale(0.99))
        }
        .padding(.horizontal, 4)
    }
```

- [ ] **Step 2: Add the `HeroSky` condition-reactive backdrop**

At the bottom of `ProactiveView.swift` (file scope, after the struct), add:

```swift
/// The hero's atmospheric backdrop. Night = dark gradient with moon + stars;
/// day = soft light wash. ponytail: 5 broad looks keyed off the SF Symbol name —
/// expand only if a condition reads wrong in practice.
private struct HeroSky: View {
    let condition: String?   // OxyWeatherService symbolName, e.g. "cloud.rain"
    let light: Bool

    private var isRain: Bool { (condition ?? "").contains("rain") || (condition ?? "").contains("drizzle") }
    private var isCloud: Bool { (condition ?? "").contains("cloud") }

    var body: some View {
        ZStack {
            LinearGradient(colors: skyColors, startPoint: .top, endPoint: .bottom)
            if !light {
                // Moon + a few stars only at night.
                Circle()
                    .fill(RadialGradient(colors: [Color(white: 0.95), Color(white: 0.78)],
                                         center: .init(x: 0.38, y: 0.35), startRadius: 1, endRadius: 26))
                    .frame(width: 44, height: 44)
                    .blur(radius: 0.3)
                    .shadow(color: .white.opacity(0.18), radius: 18)
                    .offset(x: 110, y: -78)
                ForEach(0..<6, id: \.self) { i in
                    Circle().fill(Color.white.opacity(0.6))
                        .frame(width: 1.6, height: 1.6)
                        .offset(x: [-120, -40, 40, 120, -90, 70][i], y: [-90, -60, -84, -50, -30, -90][i])
                }
            }
            if isRain {
                // Faint diagonal rain hairlines, monochrome.
                Canvas { ctx, size in
                    for i in stride(from: 0, to: Int(size.width), by: 22) {
                        var path = Path()
                        path.move(to: CGPoint(x: Double(i), y: 0))
                        path.addLine(to: CGPoint(x: Double(i) - 10, y: size.height))
                        ctx.stroke(path, with: .color(.white.opacity(0.06)), lineWidth: 0.5)
                    }
                }
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    private var skyColors: [Color] {
        if light {
            return isCloud || isRain
                ? [Color(white: 0.86), Color(white: 0.94)]
                : [Color(red: 0.80, green: 0.88, blue: 0.97), Color(white: 0.97)]
        }
        return isRain
            ? [Color(red: 0.10, green: 0.11, blue: 0.13), Color.black]
            : [Color(red: 0.16, green: 0.19, blue: 0.26), Color.black]
    }
}
```

- [ ] **Step 3: Remove the standalone weather card from the body**

In `body`, delete the `weatherCard` invocation (lines 62-65) and its `.opacity/.offset/.animation` modifiers. (The `weatherCard` property can stay defined and unused for now, or be deleted — deletion preferred. `weatherDetailGrid`/`weatherDetail` stay; the hero uses them.)

- [ ] **Step 4: Verify the build + visual**

Run: build in Xcode, run in simulator.
Expected: hero fills the top with a night sky + moon (or day wash), big serif temperature, greeting overlaid; tapping anywhere on the hero expands the detail grid; no separate weather card below.

- [ ] **Step 5: Commit**

```bash
git add OxyApp/OxyApp/Views/Proactive/ProactiveView.swift
git commit -m "feat(today): living weather hero replaces hero + weather card"
```

---

## Task 5: Card layout model (`TodayLayout`)

**Files:**
- Create: `OxyApp/OxyApp/Views/Proactive/TodayLayout.swift`

**Interfaces:**
- Produces:
  - `enum TodayCardKind: String, CaseIterable, Codable { case incoming, inbox, agenda, reminders }` with `var title: String`.
  - `@Observable final class TodayLayout` with `var order: [TodayCardKind]`, `var hidden: Set<TodayCardKind>`, `func visibleOrdered() -> [TodayCardKind]`, `func move(from:to:)`, `func toggle(_:)`, persisting to `UserDefaults` under `today_layout_v1`.

- [ ] **Step 1: Write the model**

```swift
// OxyApp/OxyApp/Views/Proactive/TodayLayout.swift
import SwiftUI

/// The card types the Today board can show. Order here is the default order.
enum TodayCardKind: String, CaseIterable, Codable, Identifiable {
    case incoming, inbox, agenda, reminders
    var id: String { rawValue }
    var title: String {
        switch self {
        case .incoming:  return "Incoming"
        case .inbox:     return "Inbox"
        case .agenda:    return "Agenda"
        case .reminders: return "Reminders"
        }
    }
}

/// User-composed Today board state: which cards show and in what order.
/// Client-only — persisted to UserDefaults, no backend, no migration.
@Observable final class TodayLayout {
    private static let key = "today_layout_v1"
    private struct Persisted: Codable { var order: [TodayCardKind]; var hidden: [TodayCardKind] }

    var order: [TodayCardKind]
    var hidden: Set<TodayCardKind>

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
           let saved = try? JSONDecoder().decode(Persisted.self, from: data) {
            // Fold in any kinds added in a later app version, drop any removed.
            let known = Set(TodayCardKind.allCases)
            var restored = saved.order.filter { known.contains($0) }
            for kind in TodayCardKind.allCases where !restored.contains(kind) { restored.append(kind) }
            order = restored
            hidden = Set(saved.hidden).intersection(known)
        } else {
            order = TodayCardKind.allCases
            hidden = []
        }
    }

    func visibleOrdered() -> [TodayCardKind] { order.filter { !hidden.contains($0) } }

    func isHidden(_ kind: TodayCardKind) -> Bool { hidden.contains(kind) }

    func toggle(_ kind: TodayCardKind) {
        if hidden.contains(kind) { hidden.remove(kind) } else { hidden.insert(kind) }
        persist()
    }

    func move(from source: IndexSet, to destination: Int) {
        order.move(fromOffsets: source, toOffset: destination)
        persist()
    }

    private func persist() {
        let payload = Persisted(order: order, hidden: Array(hidden))
        if let data = try? JSONEncoder().encode(payload) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }
}
```

- [ ] **Step 2: Verify the build**

Run: build in Xcode.
Expected: compiles. (No unit test — this is pure model code with no harness; its behavior is exercised by Task 8's reorder UI and verified visually.)

- [ ] **Step 3: Commit**

```bash
git add OxyApp/OxyApp/Views/Proactive/TodayLayout.swift
git commit -m "feat(today): TodayLayout — composable card order + visibility"
```

---

## Task 6: Render the board from layout; drop the AI cards

**Files:**
- Modify: `OxyApp/OxyApp/Views/Proactive/ProactiveView.swift` — `body` (43-103); add `@State private var layout = TodayLayout()`.

**Interfaces:**
- Consumes: `TodayLayout` (Task 5), `IncomingCard` (Task 7), existing `inboxCard`/`agendaCard`/`remindersCard`.
- Produces: a body that renders `hero` then `layout.visibleOrdered()` cards via a `@ViewBuilder func card(for:)`.

- [ ] **Step 1: Add the layout state**

Below the existing `@State` declarations (near line 22), add:

```swift
    @State private var layout = TodayLayout()
    @State private var editingBoard = false
```

- [ ] **Step 2: Add a card dispatcher**

Add this method near the other card properties:

```swift
    @ViewBuilder private func card(for kind: TodayCardKind, index: Int) -> some View {
        Group {
            switch kind {
            case .incoming:  IncomingCard(items: incomingItems, palette: p)
            case .inbox:     inboxCard
            case .agenda:    if !events.isEmpty { agendaCard }
            case .reminders: remindersCard
            }
        }
        .opacity(contentAppeared ? 1 : 0)
        .offset(y: contentAppeared ? 0 : 14)
        .animation(.nmlSpring.delay(0.04 + Double(index) * 0.05), value: contentAppeared)
    }

    /// Incoming items off the freshest briefing's metadata (same source as inbox).
    private var incomingItems: [BriefingIncoming] {
        visibleBriefings.first?.incoming ?? []
    }
```

- [ ] **Step 3: Replace the card stack in `body`**

Replace the `else` branch contents (lines 57-96 — the `signalsCard … briefingCard` block and the empty-state) with:

```swift
                        } else {
                            ForEach(Array(layout.visibleOrdered().enumerated()), id: \.element) { idx, kind in
                                card(for: kind, index: idx)
                            }

                            addCardRow

                            if !hasAnyContent {
                                EmptyProactiveState(palette: p)
                                    .opacity(contentAppeared ? 1 : 0)
                                    .offset(y: contentAppeared ? 0 : 14)
                                    .animation(.nmlSpring.delay(0.06), value: contentAppeared)
                            }
                        }
```

- [ ] **Step 4: Delete the dead AI cards**

Delete the `signalsCard` property (577-...), `briefingCard`, `activityCard` (458-508), `sleepRow`, `sleepLabel`, `topSignals`, `signalRow`, and the `discuss(_:)` helper if now unreferenced. Delete the `steps`/`sleepMinutes` state and their loads only if nothing else uses them (check `loadDashboard`). ponytail: leave a `// removed: AI "what matters"/activity cards — see 2026-06-25 redesign` breadcrumb. If a symbol is still referenced elsewhere, keep it; the build tells you.

- [ ] **Step 5: Add a placeholder `addCardRow` (real UI in Task 8)**

```swift
    private var addCardRow: some View {
        Button { HapticManager.shared.impact(.light); editingBoard = true } label: {
            HStack(spacing: 9) {
                Image(systemName: "plus").font(.system(size: 15))
                Text("Add a card").font(.nmlBody(14))
            }
            .foregroundStyle(p.muted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .overlay(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous)
                .strokeBorder(p.hairline, style: StrokeStyle(lineWidth: 0.5, dash: [4, 4])))
        }
        .buttonStyle(.nmlScale(0.99))
    }
```

- [ ] **Step 6: Verify the build + visual**

Run: build + simulator.
Expected: hero, then Incoming/Inbox/Agenda/Reminders in order, each hiding when empty; a dashed "Add a card" row at the bottom; no "What matters"/briefing/activity cards anywhere.

- [ ] **Step 7: Commit**

```bash
git add OxyApp/OxyApp/Views/Proactive/ProactiveView.swift
git commit -m "feat(today): render composable board, remove AI what-matters cards"
```

---

## Task 7: Incoming card view

**Files:**
- Create: `OxyApp/OxyApp/Views/Proactive/IncomingCard.swift`

**Interfaces:**
- Consumes: `[BriefingIncoming]` (Task 3), `TodayPalette`.
- Produces: `IncomingCard(items:palette:)`. Renders nothing when `items` is empty (board rule).

- [ ] **Step 1: Write the view**

```swift
// OxyApp/OxyApp/Views/Proactive/IncomingCard.swift
import SwiftUI

struct IncomingCard: View {
    let items: [BriefingIncoming]
    let palette: TodayPalette
    private var p: TodayPalette { palette }

    var body: some View {
        if !items.isEmpty {
            TodayCard {
                Text("Incoming").font(.nmlBody(11, weight: .semibold))
                    .tracking(2.4).foregroundStyle(p.muted)
                    .textCase(.uppercase).padding(.bottom, 14)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(items.prefix(4).enumerated()), id: \.element.id) { index, item in
                        row(item)
                        if index < min(items.count, 4) - 1 {
                            Divider().overlay(p.hairline).padding(.vertical, 14)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func row(_ item: BriefingIncoming) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.cleanTitle).font(.nmlBody(14, weight: .medium))
                    .foregroundStyle(p.ink).lineLimit(1)
                Spacer(minLength: 8)
                if let eta = item.eta, !eta.isEmpty {
                    Text(eta).font(.nmlMono(11)).foregroundStyle(p.titanium)
                }
            }
            Text("\(item.vendor) · \(item.status.lowercased())")
                .font(.nmlBody(12)).foregroundStyle(p.muted).padding(.top, 2)
            if item.isDelivery, let stage = item.stage {
                progressBar(stage: stage).padding(.top, 10)
            }
        }
    }

    /// Four-segment monochrome delivery progress: ordered→shipped→out→delivered.
    @ViewBuilder private func progressBar(stage: Int) -> some View {
        HStack(spacing: 4) {
            ForEach(0..<4, id: \.self) { i in
                Capsule()
                    .fill(i <= stage ? p.titanium : p.hairline)
                    .frame(height: 3)
            }
        }
    }
}
```

- [ ] **Step 2: Verify the build + visual**

Run: build + simulator (needs a briefing whose metadata carries `incoming`; otherwise the card is correctly absent).
Expected: when present, an Incoming card with title + vendor·status, ETA in mono, and a 4-segment progress bar for deliveries.

- [ ] **Step 3: Commit**

```bash
git add OxyApp/OxyApp/Views/Proactive/IncomingCard.swift
git commit -m "feat(today): Incoming card with monochrome delivery progress"
```

---

## Task 8: Edit board — toggle + reorder

**Files:**
- Modify: `OxyApp/OxyApp/Views/Proactive/ProactiveView.swift` — wire `editingBoard` to a sheet.

**Interfaces:**
- Consumes: `layout` (`TodayLayout`), `editingBoard` (Task 6).
- Produces: a `.sheet` presenting `TodayBoardEditor(layout:)` that lists all `TodayCardKind`s with a `NamelessToggle` each and native drag-reorder.

- [ ] **Step 1: Add the editor view**

At file scope in `ProactiveView.swift` (or a new `TodayBoardEditor.swift` — your call; keep it next to the view), add:

```swift
/// Sheet for composing the Today board: reorder via drag, toggle visibility.
struct TodayBoardEditor: View {
    @Bindable var layout: TodayLayout
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(layout.order) { kind in
                    HStack {
                        Text(kind.title).font(.nmlBody(15)).foregroundStyle(Color.nmlInk)
                        Spacer()
                        NamelessToggle(isOn: Binding(
                            get: { !layout.isHidden(kind) },
                            set: { _ in layout.toggle(kind) }
                        ))
                    }
                    .listRowBackground(Color.nmlSurface)
                }
                .onMove { layout.move(from: $0, to: $1) }
            }
            .environment(\.editMode, .constant(.active))
            .scrollContentBackground(.hidden)
            .background(Color.nmlObsidian)
            .navigationTitle("Edit Today")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.foregroundStyle(Color.nmlInk)
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}
```

- [ ] **Step 2: Present it**

On the `ScrollView` (or the outer `ZStack`) in `body`, add:

```swift
                .sheet(isPresented: $editingBoard) {
                    TodayBoardEditor(layout: layout)
                }
```

- [ ] **Step 3: Verify the build + visual**

Run: build + simulator.
Expected: tapping "Add a card" opens a sheet listing the four cards; toggles hide/show them on Today; drag-reordering changes their order; both persist across app relaunch (UserDefaults).

- [ ] **Step 4: Commit**

```bash
git add OxyApp/OxyApp/Views/Proactive/ProactiveView.swift
git commit -m "feat(today): board editor — toggle + drag-reorder cards"
```

---

## Task 9: Stop the briefing surfacing AI filler on Today

**Files:**
- Modify: `api/index.js` — `buildIntervalBriefing` system prompt (~5214-5270).

**Interfaces:**
- Consumes: nothing new.
- Produces: briefings whose `signals`/`lead` no longer drive Today (the iOS side already stopped reading them in Task 6); weather prose removed so no stale temperature text persists anywhere.

Rationale: Task 6 already removes the *consumption* of `lead`/`signals` on Today. This task stops the *generation* of the now-unused, cost-incurring narration and the weather prose, per the spec's "no AI what matters on Today" + "hero owns weather."

- [ ] **Step 1: Strip weather from the briefing prompt**

In the `systemPrompt` of `buildIntervalBriefing`, remove weather from the grounding instruction. Change (line ~5216):

```
Ground everything in what's actually real: the calendar, reminders, emails, location, health and weather shown or found via Google Search grounding (use their coordinates for weather).
```

to:

```
Ground everything in what's actually real: the calendar, reminders, emails, location and health shown. The Today screen owns weather — never mention temperature, forecast, or conditions.
```

And in "Hard rules", change `Do NOT invent calendar events, emails, weather, deadlines, or tasks` to keep "weather" in the ban list (it already forbids inventing it — leave that). Add one rule:

```
- Never mention weather, temperature, or forecast. The Today screen shows it.
```

- [ ] **Step 2: Decide signal scope (keep generation OFF for Today)**

The simplest correct move: since Today no longer renders `signals`, and no other surface consumes the interval briefing's `signals`, stop auto-running and generating them for Today by short-circuiting. In `maybeCreateIntervalBriefing`, after `const { lead, signals: rawSignals } = await buildIntervalBriefing(...)`, replace the executeSafeSignals + signals path with an empty feed:

```js
  // Today no longer surfaces AI "what matters" signals (2026-06-25 redesign).
  // Keep `lead` for legacy/body text only; drop signal generation + auto-execution.
  const signals = [];
  const executed = Array.isArray(state.executed) ? state.executed : [];
```

(Leave `executeSafeSignals` defined; it's still used by other proactive paths. Verify with a grep that nothing else breaks.)

- [ ] **Step 3: Verify**

Run: `node --check api/index.js && npm run smoke`
Expected: passes. Grep `grep -n "executeSafeSignals\|\.signals" api/index.js` to confirm no other consumer regressed; if `proactive-signals.test.js` asserts signals are generated, update it to the new "no signals on Today" expectation.

- [ ] **Step 4: Commit**

```bash
git add api/index.js test/smoke/proactive-signals.test.js
git commit -m "feat(today): stop generating AI what-matters signals + weather prose"
```

---

## Self-Review

**Spec coverage:**
- Living weather hero (locked, no tap-pill, condition-reactive, tap-expand) → Task 4. ✓
- Composable board, toggle + reorder, AppStorage, no migration → Tasks 5, 6, 8. ✓
- v1 library Inbox/Incoming/Agenda/Reminders → Tasks 6 (inbox/agenda/reminders reused), 7 (incoming). ✓
- Incoming parser, heuristic-first, hide-when-empty → Tasks 1, 7. ✓
- Remove signals/briefing/activity cards → Task 6. ✓
- Briefing cleanup (no AI what-matters, hero owns weather) → Task 9. ✓
- Non-goal: no custom-card builder (toggle+reorder only) → respected (Task 8). ✓

**Placeholder scan:** `addCardRow` is explicitly built in Task 6 Step 5 and wired in Task 8 — not a placeholder. No TBDs. Task 6 Step 4 deletions are guarded by "the build tells you," which is honest given the unread tail of the 852-line file rather than a hand-wave.

**Type consistency:** `BriefingIncoming` fields (`kind/title/vendor/status/eta/stage`) match the parser's `IncomingItem` (Task 1) and the card's usage (Task 7). `TodayCardKind` cases match the dispatcher in Task 6. `incomingItems`/`incoming` naming consistent across Tasks 2, 3, 6, 7.

**Known soft spot:** Task 6 Step 4 (deleting dead cards) depends on the unread portion of `ProactiveView.swift` (lines 600-852: `signalRow`, `briefingCard`, helpers). The implementer must let the compiler guide which symbols are safe to remove — called out explicitly rather than guessed.

# Milgrain UI/UX Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn six screens that read like three stitched-together design systems into one coherent, trustworthy product — starting by purging leaked trace data from the Memory system, then unifying the design language, then rebuilding the worst screens on that single foundation.

**Architecture:** The app already has the *right values* (dark charcoal canvas, gold accent, SF type, serif reserved for the wordmark/greetings). The problem is (a) the backend writes internal trace strings into the user-facing `memories` table, and (b) `AppTheme.swift` grew **two parallel component sets** — the `app*` family (Chat/Today) and the `mg*` "Milgrain" family (Settings/Connectors/Memory/Pendant) — plus a graveyard of no-op shims and contradictory rules. We fix the data leak first, then collapse the two component families into one canonical set, then rebuild each screen on it. No new brand; this is consolidation, not reinvention.

**Tech Stack:** SwiftUI (iOS 18+, dark-only), `OxyApp/OxyApp.xcodeproj` scheme `OxyApp`. Backend: Node.js in `api/` (Cloud Run, auto-deploys on push to `origin/main`). Backend tests: `npm test`.

---

## Global Constraints

These are the design-system decisions every task inherits. **Values marked ⚑ are recommendations to confirm before Phase 2 begins.**

### Canonical type scale (one ramp, all screens)
Replace ad-hoc `.system(size:)` / mixed `.appDisplay` / `.appBody` calls with these five roles. All use SF (`design: .rounded` only for `heroDisplay`); serif (`appDisplay`) is reserved for greetings + Memory category headers ONLY.

| Role | Font | Use |
|---|---|---|
| `heroDisplay` | 30 / semibold / rounded ⚑ (was 46) | The one big identity moment per screen (More name, Today greeting). **Capped at 30** so it stops shoving content down (audit #12). |
| `screenTitle` | 20 / semibold | Screen headers (Memory, Settings, Pendant, Connections). |
| `sectionTitle` | 15 / semibold, `.appMuted` | Group headers within a screen. Replaces the 20pt `MilgrainSectionHeader` and the 11pt uppercase eyebrow — pick **one** section-header treatment. ⚑ |
| `rowTitle` | 16 / regular, `.appInk` | Primary row text. |
| `rowSecondary` | 13 / regular, `.appMuted` | Captions, status, descriptions. Never below `.appMuted` (0.72 white). |

### One content margin
⚑ **`AppSpacing.margin = 20`** everywhere (matches Chat's existing `chatMargin`). Currently: Chat 20, Settings-family 24, Connectors 16, header 12. Unify all to 20, header included. Edge-to-edge components (dividers, aurora) are the only exceptions.

### Selection state language (unmistakable)
One pattern for mutually-exclusive choices: a **filled accent capsule** behind the selected segment (gold `appAccent` fill, `appOnAccent` text; unselected = `.appMuted` on clear). This replaces `MilgrainSegmentedControl`'s thin-hairline/weight-only cue (audit #6, #38). For binary toggles: keep one toggle component (see below).

### Semantic color roles (LOCKED)
Define roles, don't force one color onto every state:
- **Gold (`appAccent`)** — brand identity, selection, focus, primary actions.
- **Green (`appSuccess`/`appLive`)** — reserved for *genuine success or healthy operational state* (e.g. a completed action, live telemetry streaming). **NOT** used merely because something is "connected."
- **Neutral (`appInk`/`appMuted`)** — default text and quiet emphasis.
- **Danger (`appDanger`)** — destructive/error.

Consequence for Connections (audit #32, #51): a connected app's state is communicated through **clear text + a subtle neutral/gold treatment**, not a green check. Green is retired from "connected." One state, one action per row — never a check + label + button all saying the same thing.

### Component canon (delete the duplicates)
Keep exactly one of each; the rest become thin aliases or are deleted:

| Keep | Delete / alias to it |
|---|---|
| `AppSectionHeader` (renamed→`sectionTitle` style) | `MilgrainSectionHeader`, `AppSectionTitle` |
| `AppToggle` | `MilgrainToggle` |
| `AppSegmented` (new, filled-capsule) | `MilgrainSegmentedControl` |
| `AppDivider` | `MilgrainDivider` |
| `AppRow` (new shared row) | hand-rolled rows in every screen |
| `AppCard` | `TodayCard`, `EditorialPlate` (Today keeps `TodayCard` only if it needs the glass finish) |

### Copy rules
- Consumer language, never engineering. No `WAKEWORD`, `BLE BUDS`, `HAPTIC FORCE`, `CHIN TILT` as UI labels (audit #43–44).
- Sentence case for descriptions; Title Case for titles. No screen-wide uppercase (audit #4).
- Terminology (LOCKED): **"Connections"** for the integrations screen — used in both the More-tab row and the screen title (was "Apps" row → "Connectors" title, audit #19).

### Motion / a11y
Ease-out only (tokens already exist: `.appFast/.appStandard/.appRelax`). Every reveal must enhance already-visible content. Tap targets ≥44pt (helpers already do this).

---

## Audit → Task traceability

Every one of the 52 audit points maps to a task below. Nothing is dropped.

| Audit points | Task |
|---|---|
| 22, 23 (trace leak, garbage data) | 1.1, 1.2, 1.3 |
| 24, 26, 27, 28, 29, 25 (Memory controls/affordance) | 1.4, 1.5 |
| 1, 4 (type hierarchy) | 2.1, 2.2 |
| 2 (margins) | 2.1, 7.x |
| 3, 40, 41 (vertical spacing / grouping) | 2.3, 5.2 |
| 5 (secondary contrast) | 2.2 |
| 6, 38 (selection state) | 2.4 |
| 7 (interaction-pattern sprawl) | 2.4, 2.5 |
| 30–37 (Connectors) | 3.1, 3.2, 3.3 |
| 8, 9, 10, 11, 13 (Today) | 4.1, 4.2, 4.3 |
| 39, 42 (Initiative scale, copy) | 5.1, 5.3 |
| 43–49 (Pendant) | 6.1, 6.2, 6.3 |
| 16, 17, 18, 19, 20, 21, 12 (More screen) | 7.1, 7.2 |
| 14, 15, 50 (tab bar / nav consistency) | 7.3, 7.4 |
| 51, 52 (brand carry-through / config-heaviness) | cross-cutting; verified in 2.2, 4.1, 7.1 |

---

## Phase 1 — Memory trust (backend + one screen)

*Highest priority per the user. Mostly self-contained. Restores trust before any pixels move.*

### Task 1.1: Stop writing trace strings into user memories

**Files:**
- Modify: `api/index.js:5442`
- Test: `api/__tests__/` (locate existing memory test or add `memory-agent-episodic.test.js`)

**Interfaces:**
- Produces: agent-episodic turns no longer land in the `memories` table read by `/memory/:userId/items`.

- [ ] **Step 1: Write the failing test** — assert that the agent-turn logging path does not call `saveMemory` with an `agent_episodic` category (or does not write to `memories` at all). Use the existing test harness/mocks in `api/__tests__`; spy on `saveMemory`.

- [ ] **Step 2: Run it, verify it fails** — `npm test -- memory-agent-episodic` → FAIL.

- [ ] **Step 3: Implement** — Remove the `saveMemory(... 'agent_episodic')` call at `api/index.js:5442`. If a trace record is still wanted for ops, write it to a dedicated non-user store (e.g. an `agent_traces` table or structured log via the existing `trace` object), **never** the `memories` table. Minimal change: delete the line.

- [ ] **Step 4: Run tests** — `npm test` → PASS (full suite must stay green per CLAUDE.md).

- [ ] **Step 5: Commit** — `fix(memory): stop writing agent trace strings into user-facing memories`

### Task 1.2: Filter internal categories out of the Memory read path (defense in depth)

**Files:**
- Modify: the `/memory/:userId/items` handler in `api/index.js` (locate via `grep -n "items" api/index.js` near the memory routes)
- Test: same test file as 1.1

**Interfaces:**
- Consumes: `memories` rows with a `category`/`source` column.
- Produces: `/memory/:userId/items` returns only user-facing memories (excludes `agent_episodic` and any other internal categories), even if legacy junk rows still exist.

- [ ] **Step 1: Failing test** — seed a memory with category `agent_episodic` and one with `manual`; assert the endpoint returns only the `manual` one.
- [ ] **Step 2: Verify fail** — `npm test` → FAIL.
- [ ] **Step 3: Implement** — add `.neq('category', 'agent_episodic')` (and an allowlist if categories are richer) to the Supabase query. Confirm the column name via `grep -n "from('memories')" api/index.js`.
- [ ] **Step 4: Verify pass** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `fix(memory): exclude internal agent categories from the items endpoint`

### Task 1.3: Purge existing junk rows (one-time data migration)

**Files:**
- Create: `supabase/migrations/<timestamp>_purge_agent_episodic_memories.sql`

- [ ] **Step 1: Write migration** —
```sql
-- Remove leaked agent trace strings that were surfaced as user memories.
delete from memories where category = 'agent_episodic';
delete from memories where content like 'Agent handled goal ~%';
```
- [ ] **Step 2: Verify locally** if a local Supabase stack is available (`supabase db reset` / `supabase migration up`); otherwise review the SQL and note it applies on next deploy. **Do not run against production without the user's explicit go-ahead.**
- [ ] **Step 3: Commit** — `chore(db): purge leaked agent_episodic memories`

### Task 1.4: Memory screen — real search field + honest count + inline edit/delete

**Files:**
- Modify: `OxyApp/OxyApp/Views/Memory/MemoryView.swift`

**Interfaces:**
- Consumes: `MemoryItem`, `AppRow` (Task 2.5), `AppSegmented`/`AppLineField`.
- Produces: `MemoryRow` gains tap-to-edit; search reads as an active field; count reads "N memories".

- [ ] **Step 1: Fix the search field** — the `AppLineField` "Search memories…" is too dim to read as active (audit #28). Add a leading `magnifyingglass` glyph and raise placeholder contrast to `.appMuted`. Replace `AppLineField` here with a small dedicated `MemorySearchField` (icon + field + clear button) — screenshot-verify it reads as tappable.
- [ ] **Step 2: Fix the count** — `MemoryView.swift:90-95`: render `"\(items.count) memories"` (or move it under the header), not a bare `55` (audit #27).
- [ ] **Step 3: Add edit** — `MemoryRow` (`:286`) becomes a `Button` that opens an edit sheet (reuse `MemoryDropBox` in an "edit" mode; PUT to `/memory/.../items/\(id)` — confirm the route exists, else add it). Give the row a chevron or clear tap affordance (audit #24, #29).
- [ ] **Step 4: Provenance cue** — show `item.sourceLabel` ("Saved" / "Learned") as a quiet trailing caption per row so users can tell added-by-me from learned-from-conversation (audit #25).
- [ ] **Step 5: Build & verify** — build scheme `OxyApp`; run in simulator; confirm search reads active, count reads "N memories", tapping a row opens edit, provenance shows. Screenshot.
- [ ] **Step 6: Commit** — `feat(memory): active search, honest count, inline edit, provenance`

### Task 1.5: Harden the client-side category classifier

**Files:**
- Modify: `OxyApp/OxyApp/Views/Memory/MemoryView.swift:387-396`

- [ ] **Step 1:** The classifier is fine structurally, but ensure a genuinely empty/garbage memory ("huh") lands in "Notes" rather than a confident bucket. Add a guard: memories shorter than 3 meaningful chars → "Notes". (The garbage itself is prevented upstream by better extraction — out of scope here; note it as a follow-up backend task.)
- [ ] **Step 2: Build & verify**, then **Commit** — `fix(memory): route degenerate memories to Notes`

---

## Phase 2 — Unify the design system

*The multiplier. Every later phase lands on this. No screens change behavior; this is component consolidation + a locked type/spacing/selection language.*

### Task 2.1: Add canonical spacing + type roles; set one margin

**Files:**
- Modify: `OxyApp/OxyApp/Extensions/AppTheme.swift`

**Interfaces:**
- Produces: `AppSpacing.margin` (=20), `Font.heroDisplay/screenTitle/sectionTitle/rowTitle/rowSecondary` helpers.

- [ ] **Step 1:** Add to `AppSpacing`: `static let margin: CGFloat = 20`.
- [ ] **Step 2:** Add typed font helpers (thin wrappers over existing `appDisplay`/`appBody` so call sites read semantically):
```swift
extension Font {
    static var screenTitle: Font { .appBody(20, weight: .semibold) }
    static var rowTitle: Font    { .appBody(16, weight: .regular) }
    static var rowSecondary: Font { .appBody(13, weight: .regular) }
    // heroDisplay stays serif for greetings only; sans elsewhere per role.
    static func heroDisplay(_ size: CGFloat = 30) -> Font { .appDisplay(size, weight: .semibold) }
}
```
- [ ] **Step 3: Build** — `xcodebuild -project OxyApp/OxyApp.xcodeproj -scheme OxyApp -destination 'generic/platform=iOS Simulator' build` → succeeds.
- [ ] **Step 4: Commit** — `feat(design): canonical spacing + type roles`

### Task 2.2: Delete the graveyard + collapse mg* section header/divider into app*

**Files:**
- Modify: `OxyApp/OxyApp/Extensions/AppTheme.swift`

- [ ] **Step 1:** Make `MilgrainSectionHeader` and `AppSectionTitle` thin aliases of a single `AppSectionHeader` styled as `sectionTitle` (15/semibold, `.appMuted`). Keep the type names so call sites compile; unify the visual.
- [ ] **Step 2:** Make `MilgrainDivider` an alias of `AppDivider`.
- [ ] **Step 3:** Delete confirmed-dead no-op shims that no call site depends on: the `appGlass`, `appHairline(radius:)` no-ops, `DropCapText`, `EditorialPlate`, `AppGrain`/`AtmosphereSky`/`AppRule` **only if** grep shows zero non-Today references. Run `grep -rn "EditorialPlate\|DropCapText\|AppRule\|AppGrain" OxyApp` first; delete only the truly unused.
- [ ] **Step 4:** Resolve the contradictory card doctrine: `AppCard` currently renders *no* surface ("content on pure black") while the header comment promises lifted surfaces. Decide ⚑: settings-family rows sit flat on canvas separated by dividers (current Memory/Settings look) — so keep `AppCard` flat, and delete the `TodayCard` usage in `ProfileView` (`:161`) in favor of flat rows for consistency.
- [ ] **Step 5: Build & verify** every screen still renders (Chat, Today, Memory, Settings, Connectors, Pendant, More, Profile). Screenshot each.
- [ ] **Step 6: Commit** — `refactor(design): collapse mg* components into app*, delete dead shims`

### Task 2.3: One screen header, one margin, applied everywhere

**Files:**
- Modify: `OxyApp/OxyApp/Views/Components/ScreenHeaderView.swift`, and every screen's outer `.padding(.horizontal, ...)`.

- [ ] **Step 1:** `ScreenHeaderView` title → `.screenTitle`; horizontal padding 12 → `AppSpacing.margin` (20). Back chevron stays.
- [ ] **Step 2:** Replace `.padding(.horizontal, 24)` → `.padding(.horizontal, AppSpacing.margin)` in `SettingsView`, `PendantStatusView`, `ProfileView`, `MoreView`; Memory `listRowInsets` leading/trailing 24 → 20; Connectors `.padding(16)` → `AppSpacing.margin`.
- [ ] **Step 3: Build & verify** — navigate every screen; content no longer jumps horizontally between tabs (audit #2). Screenshot Chat→More→Connections and confirm the left edge is stable.
- [ ] **Step 4: Commit** — `refactor(design): single content margin + unified screen header`

### Task 2.4: New `AppSegmented` — filled-capsule selection

**Files:**
- Modify: `OxyApp/OxyApp/Extensions/AppTheme.swift` (add `AppSegmented`), alias `MilgrainSegmentedControl` to it.

**Interfaces:**
- Produces: `AppSegmented(options:labels:selection:)` — same signature as `MilgrainSegmentedControl` so Settings/Pendant call sites don't change.

- [ ] **Step 1: Implement** the filled-capsule control:
```swift
struct AppSegmented: View {
    let options: [String]
    var labels: [String]? = nil
    @Binding var selection: String
    private func label(_ i: Int) -> String { labels?[safe: i] ?? options[i] }
    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(options.enumerated()), id: \.element) { i, option in
                let isSel = selection == option
                Button {
                    withAnimation(.appStandard) { selection = option }
                    HapticManager.shared.impact(.light)
                } label: {
                    Text(label(i))
                        .font(.appBody(14, weight: isSel ? .semibold : .regular))
                        .foregroundStyle(isSel ? Color.appOnAccent : Color.appMuted)
                        .frame(maxWidth: .infinity).frame(minHeight: 40)
                        .background(
                            Capsule().fill(isSel ? Color.appAccent : Color.clear)
                        )
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSel ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(4)
        .background(Capsule().fill(Color.white.opacity(0.06)))
    }
}
```
(Add a small `Collection` `subscript(safe:)` helper if not present.)
- [ ] **Step 2:** Alias: `typealias MilgrainSegmentedControl = AppSegmented` OR replace usages directly in Settings/Pendant.
- [ ] **Step 3: Build & verify** in Settings — the selected Bubble/Maps/Transport option is now unmistakable (audit #6, #38). Screenshot.
- [ ] **Step 4: Commit** — `feat(design): filled-capsule AppSegmented with clear selection state`

### Task 2.5: Shared `AppRow`

**Files:**
- Modify: `OxyApp/OxyApp/Extensions/AppTheme.swift`

**Interfaces:**
- Produces: `AppRow(title:subtitle:trailing:onTap:)` — the one row primitive for Memory/Settings/Connections/Pendant/More/Account nav & action rows (audit #7).

- [ ] **Step 1: Implement** a row with: `rowTitle` leading text, optional `rowSecondary` subtitle, an optional trailing `AnyView` (chevron / status / toggle / segmented), 16pt vertical padding, `.appScale(0.98)` when tappable, 44pt min height.
- [ ] **Step 2: Build.** (Migration of call sites happens per-screen in later phases to keep diffs reviewable.)
- [ ] **Step 3: Commit** — `feat(design): shared AppRow primitive`

---

## Phase 3 — Rebuild Connections (worst screen)

*Full rewrite onto the unified primitives. Kills the grid tiles, green checks, uppercase pills, and legacy `oxy*` tokens.*

### Task 3.1: Convert to a single-column list on app* tokens

**Files:**
- Modify: `OxyApp/OxyApp/Views/Connectors/ConnectorsView.swift`
- Delete: `OxyApp/OxyApp/Views/Connectors/ConnectorsView 2.swift` (stray duplicate in the working tree)

- [ ] **Step 1:** Replace the `.navigationTitle("Connectors")/.large` + `oxySurface1` toolbar with a `ScreenHeaderView(title: "Connections", onBack:)` to match every other settings-family screen (audit #30, #50).
- [ ] **Step 2:** Replace the `LazyVGrid` two-column tile grid (`:153`) and `ConnectorCard` with a single-column list of `AppRow`s: leading app icon (fixed 40×40 container, consistent corner radius — audit #34), title + capability subtitle, trailing status/action. Google is just another row — no special wide treatment (audit #31, #33).
- [ ] **Step 3: Delete `ConnectorsView 2.swift`** (`git rm`).
- [ ] **Step 4: Build & verify** — rows have a stable rhythm; icons are contained/consistent. Screenshot.
- [ ] **Step 5: Commit** — `refactor(connectors): single-column list on the unified design system`

### Task 3.2: One state, one action (kill the triple signal + uppercase pills)

**Files:**
- Modify: `ConnectorsView.swift`

- [ ] **Step 1:** Remove `ConnectorCheckmark` (green check), the green "Connected" text, AND the uppercase `DISCONNECT` — replace with **one** trailing element: a gold `appAccent` status dot + "Connected" label when connected, and a single tappable "Connect"/"Disconnect" action (Title Case, not uppercase tracked — audit #32, #35). Update `Connector.statusColor` to use `appAccent` not `oxyGreen`, and `actionLabel`/`actionTint` to drop uppercase.
- [ ] **Step 2:** Split capability from state in the subtitle: `"Gmail · Calendar"` as the capability caption; connection state lives only in the trailing dot/label — not jammed into one string (`googleSubtitle` `:132`, audit #37).
- [ ] **Step 3: Build & verify** — each row shows exactly one state + one action. Screenshot.
- [ ] **Step 4: Commit** — `refactor(connectors): one status, one action per row; retire green checks`

### Task 3.3: Section copy + grouping

**Files:**
- Modify: `ConnectorsView.swift:51-54`

- [ ] **Step 1:** Rename sections: `"I can handle for you"` → a clean grouping like `"Connected"` / `"Available"`; `"Quick opens (I pre-fill everything)"` → `"Quick actions"` (audit #36). Use `AppSectionHeader`.
- [ ] **Step 2: Build & verify**, **Commit** — `refactor(connectors): human section copy`

---

## Phase 4 — Collapse Today's empty-state overload

**Files:** `OxyApp/OxyApp/Views/Proactive/ProactiveView.swift` (READ FIRST during execution — not yet read at plan time), `TodayLayout.swift`.

### Task 4.1: Collapse low-information empty states

- [ ] **Step 1: Read `ProactiveView.swift`** fully to map the current card rendering, greeting, empty states, and "Edit board" control.
- [ ] **Step 2:** When a card (Agenda/Reminders/Health/Incoming/Inbox) has no data, collapse it to a single quiet line inside a shared "Nothing scheduled" summary rather than three full-height empty cards (audit #8, #9). Only render full cards for sections with real content or a genuine action (e.g. "Connect Health").
- [ ] **Step 3:** Merge the semantically overlapping "Your day"/"Tonight" empty states into one (audit #9).
- [ ] **Step 4: Build & verify** with an empty account — Today no longer spends a full screen saying nothing. Screenshot.
- [ ] **Step 5: Commit** — `feat(today): collapse empty cards into one quiet summary`

### Task 4.2: Card hierarchy (actionable vs passive)

- [ ] **Step 1:** Give actionable cards (Connect Health, an overdue reminder) a distinct treatment from passive info (calendar readout) — e.g. a gold accent affordance on the actionable ones — instead of every section being the same dark rounded rectangle (audit #10).
- [ ] **Step 2: Build & verify**, **Commit** — `feat(today): differentiate actionable vs passive cards`

### Task 4.3: Promote "Edit board" + tame the scroll indicator

- [ ] **Step 1:** Move "Edit board" from low-contrast floating text to a clear control near the header (an overflow/"Customise" button) (audit #11).
- [ ] **Step 2:** Hide/soften the intrusive scroll indicator (`.scrollIndicators(.hidden)` or subtle) (audit #13).
- [ ] **Step 3: Build & verify**, **Commit** — `feat(today): promote Customise control, quiet scroll indicator`

---

## Phase 5 — Settings controls

**Files:** `OxyApp/OxyApp/Views/Settings/SettingsView.swift`

### Task 5.1: Clearer Initiative progression

- [ ] **Step 1:** Rename `OxySettings.autonomyLevels` from `["Quiet","Low","Balanced","Active","Bold"]` to the LOCKED progression `["Reactive","Reserved","Balanced","Proactive","Autonomous"]` (audit #39). Update `normalizedAutonomy` to map ALL legacy stored values (`Quiet/Low/Medium/Medium-High/High/Assertive/Bold`) onto the new five so no user loses their setting. Update `InitiativeScroller.description` strings to match.
- [ ] **Step 2: Build & verify** the migration: a device with `autonomy = "Bold"` resolves to `"Autonomous"` and displays selected. **Commit** — `feat(settings): clearer Initiative scale with legacy migration`

### Task 5.2: Grouping + spacing

- [ ] **Step 1:** Reduce the 36pt inter-section gap (`VStack(spacing: 36)` `:31`) to a rhythm that doesn't read as missing content (audit #40) — e.g. 28pt, with `AppSectionHeader` giving each group a clear boundary (audit #41). Rows already sit on canvas w/ dividers — keep that, just tighten.
- [ ] **Step 2: Build & verify**, **Commit** — `refactor(settings): tighter section rhythm`

### Task 5.3: Consumer copy

- [ ] **Step 1:** `"Confirm Sensitive Apps"` → `"Ask before sensitive actions"` with the existing description (audit #42).
- [ ] **Step 2: Build & verify**, **Commit** — `refactor(settings): plain-language labels`

---

## Phase 6 — Pendant: engineering panel → consumer device screen

**Files:** `OxyApp/OxyApp/Views/PendantStatusView.swift`

### Task 6.1: Translate hardware labels to consumer language

- [ ] **Step 1:** `configRow` labels + values become human: `WAKEWORD`→"Wake gesture", values `CHIN TILT`→"Chin tilt" / `TAP`→"Tap"; `AUDIO OUTPUT`→"Audio", `BLE BUDS`→"Earbuds" / `WHISPER HAPTICS`→"Whisper"; `HAPTIC FORCE`→"Vibration", `LOW/MID/HIGH`→"Light/Medium/Strong" (audit #43, #44). Store keys stay the same; only display text changes.
- [ ] **Step 2:** Replace the cycle-on-tap `configRow` + `chevron.up.chevron.down` (audit #49) with `AppSegmented` (or a `Menu`) so options are visible and selection is clear.
- [ ] **Step 3: Build & verify**, **Commit** — `refactor(pendant): consumer language + visible option controls`

### Task 6.2: Collapse the disconnected Live/Config dead weight

- [ ] **Step 1:** While disconnected, collapse the "Live" section (currently a full section saying "No live data") and either hide or clearly disable Hardware config so it doesn't look editable-but-inert (audit #47, #48). When disconnected, the screen leads with pairing help.
- [ ] **Step 2: Build & verify** in both states (connected via a mock/preview, disconnected). **Commit** — `feat(pendant): collapse live/config while disconnected`

### Task 6.3: Better scanning + Cancel affordance

- [ ] **Step 1:** Give "Scanning…" a spinner + a "hold the pendant nearby" hint so it doesn't sit dead (audit #45); make "Cancel" read as an active control (raise contrast from `.appMuted`, give it a clear tap style) (audit #46).
- [ ] **Step 2: Build & verify**, **Commit** — `feat(pendant): scanning feedback + clear Cancel`

---

## Phase 7 — More screen, brand, and navigation consistency

### Task 7.1: Rework the More screen

**Files:** `OxyApp/OxyApp/Views/MainTabView.swift` (`MoreView`, `:77`)

- [ ] **Step 1:** Drop the 46pt name to `heroDisplay` (30) so it stops dominating (audit #12, #16).
- [ ] **Step 2:** Fix the wordmark: `BrandWordmark` default is 14pt muted + heavily letter-spaced → illegible (audit #17). Raise height/contrast (e.g. height 18, `.appInk.opacity(0.9)`), or move it to a less prominent spot; verify it reads as a wordmark not noise.
- [ ] **Step 3:** Add subtitles / grouping to the four rows so Memory (personalisation) / Apps (integrations) / Settings (config) / Pendant (hardware) aren't presented as equivalent (audit #18). Use `AppRow` with `subtitle`.
- [ ] **Step 4:** Rename the More-tab row "Apps" → "Connections" so it matches the destination screen title from Task 3.1 (audit #19 resolved).
- [ ] **Step 5:** Pendant trailing status: replace persistent "Pairing…" with a concise resting state — "Not connected" / device name / "Connected" — don't surface a live async spinner on a nav row (audit #20).
- [ ] **Step 6:** Sign Out: move out of the floating low-contrast center position into a clear account section at the bottom with a secondary/destructive treatment (audit #21). Consider routing it through the existing `ProfileView` account section instead of duplicating here.
- [ ] **Step 7: Build & verify**, **Commit** — `refactor(more): calmer identity, legible wordmark, grouped rows, anchored sign-out`

### Task 7.2: Reconcile More vs Account

- [ ] **Step 1:** Decide the conceptual split ⚑: More = app configuration hub; Account (`ProfileView`) = identity + lifecycle. Ensure Sign Out lives in Account (it already does, grouped well) and More links to it rather than re-implementing the confirm dialog (audit #16 conceptual mismatch).
- [ ] **Step 2: Build & verify**, **Commit** — `refactor(nav): single home for sign-out (Account)`

### Task 7.3: One tab-bar geometry

**Files:** `OxyApp/OxyApp/Views/MainTabView.swift`

- [ ] **Step 1:** The tab bar is the stock `TabView` (`:36`), so geometry is already shared — the per-screenshot variance (audit #14) is background/margin bleed. Verify each tab presents the same safe-area and background beneath the bar. If a custom floating bar is intended, extract it to one component used identically across tabs.
- [ ] **Step 2:** Assess bar height/insets (audit #15) — if using the stock bar, this is largely fixed; document that a custom pill bar is a separate design decision (flag ⚑, don't build speculatively).
- [ ] **Step 3: Build & verify** across all three tabs. **Commit** if changes made — `fix(tabbar): consistent geometry/background across tabs`

### Task 7.4: Predictable back navigation

**Files:** `ScreenHeaderView.swift` + all pushed screens

- [ ] **Step 1:** Confirm every presented sub-screen (Memory, Settings, Pendant, Connections/Apps, Account) uses `ScreenHeaderView(onBack:)` with the same chevron + title position, and Connections now has a visible back control after Task 3.1 (audit #50).
- [ ] **Step 2: Build & verify** — back affordance is identical everywhere. **Commit** — `fix(nav): uniform back control across all sub-screens`

---

## Self-Review (coverage check)

- **Spec coverage:** All 52 audit points appear in the traceability table and map to a task. Points 51 (brand carry-through) and 52 (config-heaviness) are cross-cutting outcomes verified during 2.2/4.1/7.1 rather than single tasks — flagged as such.
- **Backend vs UI:** Memory garbage (#23) has two causes — trace leakage (fixed, 1.1–1.3) and low-quality LLM fact-extraction (noted as a follow-up backend task in 1.5; out of scope for a UI plan but recorded so it isn't lost).
- **Migration safety:** Task 5.1 and 1.3 both carry explicit legacy-data handling so no user loses settings or has memories silently deleted without the mapping/purge being deliberate.
- **Decisions to confirm (⚑):** margin=20, hero cap=30, section-header treatment, selection = filled capsule, connected color = gold, terminology "Apps", Initiative labels, card doctrine (flat), custom-vs-stock tab bar. These are recommendations baked into the plan; the user can override any before Phase 2.

## Deploy note
Per CLAUDE.md: backend changes (Phase 1) only take effect on push to `origin/main` (Cloud Run auto-deploys). `npm test` must stay green before any commit. iOS changes ship via the app build.

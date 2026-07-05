# Chat Redesign Specification — "The Quiet Agent"

**Status:** Approved design direction, ready for implementation
**Date:** 2026-07-05
**Scope:** `OxyApp/OxyApp/Views/Chat/*` (ChatView, MessageBubble, ChatInputBar, ActionReviewSheet, StatusIndicator, WelcomeCard) + AppTheme additions
**Supersedes:** the per-tool receipt-row model and the ActionReviewSheet bottom sheet
**Constraints honored:** DESIGN.md July 3/4 corrections stand — no text below 72% white, no weight below `.regular`, assistant prose stays plain on the canvas, dark-only.

---

## 0. The core diagnosis and the one big idea

The current chat renders **tools** as first-class citizens. Every connector call becomes a
persistent artifact (`ActionCard` receipt rows, a `StatusIndicator` pill keyed off raw backend
status strings, travel cards, search receipts). The conversation therefore reads as *a log of
what the machine did*, which is exactly why it feels like a chatbot with debug output.

**The one structural change everything else hangs off:**

> The atomic unit of the conversation is not the message and not the tool call.
> It is the **turn**: the user's request plus *one* living artifact that represents
> everything the agent did in response.

Per turn, the agent gets exactly one "activity strand" that is born the moment the request
is sent, narrates progress in human language while working, and then **collapses into a
single quiet receipt line** above the answer. Individual tool operations never get their own
permanent blocks. This single decision resolves: walls of receipts, debug-output feel,
"every operation equally important," and the missing narrative for multi-step tasks.

Grammar of a completed agent turn, top to bottom:

```
[user bubble, right]
[receipt line — one line, collapsed, tappable]     ← what was done
[assistant prose — the answer]                     ← what matters
[outcome row(s) — only for real-world actions]     ← what changed in the world
[timestamp — group end only]
```

The receipt is subordinate to the answer: smaller, muted, one line. The answer is the star.
The outcome row exists only when the agent changed something outside the conversation
(event created, message sent, order placed) — reading email is *work*, not an *outcome*, and
gets no row.

---

## 1. Visual system (Section 10 of the brief, moved first because everything cites it)

Retain the existing token set. Add the missing semantic layer for agent lifecycle. All
values are fixed dark values; Dynamic Type stays on.

### 1.1 Color roles (existing tokens, clarified duties)

| Token | Value | Duty in chat |
|---|---|---|
| `appBackground` | #0D0E12 | The canvas. Assistant prose sits directly on it. |
| `appSurface` | #17191F | Composer field, receipt expansion, confirm card fill. |
| `appSurface2` | #1F222A | Pressed states, secondary buttons. |
| `appHairline` | white 10% | Separation. Never structure on its own. |
| `appInk` | #F4F5F7 | All primary text. |
| `appMuted` | white 72% | Secondary text floor. Nothing dimmer, ever (DESIGN.md P1). |
| `appAccent` | #E3B35B | **Only:** primary confirm button, the working shimmer, list markers, selected tab, times/figures in answers. Never decorative body text, never receipt glyphs. |
| `appSuccess` | green | Outcome checkmark only. |
| `appWarning` | amber | Partial results, degraded states. |
| `appDanger` | coral | Recording stop, destructive confirm, hard failure glyph. |

**New tokens (add to AppTheme):**

| Token | Value | Duty |
|---|---|---|
| `appWorking` | `appAccent` at 85% | The animated dot/shimmer while the agent works. Gold = "I am acting for you" — this is the accent's single most meaningful use in the product. |
| `appReceipt` | white 72% (alias of `appMuted`) | Receipt line text. An alias so receipts can be tuned independently later. |

### 1.2 Typography roles (`Font.app*`, existing families)

| Role | Spec | Used for |
|---|---|---|
| `chatLead` | body 17 regular, line spacing 6 | The first paragraph of an assistant answer (the conclusion). |
| `chatBody` | body 15.5 regular, line spacing 5.5 | All following answer prose. (Current size, kept.) |
| `chatHeading` | body 15 semibold | In-answer section headings. |
| `chatReceipt` | body 13 regular | Receipt line, working line, outcome detail. |
| `chatOutcome` | body 13.5 medium | Outcome row headline. |
| `chatMicro` | body 11 regular, monospaced digits | Timestamps, durations. |
| `confirmTitle` | title (SF rounded) 20 semibold | Confirm card headline only. |

Nothing in chat uses `appMono` except numeric readouts inside handoff cards (existing rule).

### 1.3 Spacing & radii

- Chat margin: 16pt both sides (existing `AppSpacing.chatMargin`).
- Intra-turn spacing (user bubble → receipt → answer → outcome): **8pt**.
- Between turns: **20pt** (up from 12 — the turn must read as a paragraph of the conversation).
- Radii: user bubble `AppRadius.bubble`; confirm card & receipt expansion `AppRadius.md`
  (continuous); composer field `AppRadius.xl`. No new radii.
- Answer prose max width: full width minus margins (no bubble). User bubble keeps 48pt
  leading spacer.

### 1.4 Icon weight

SF Symbols, `.regular` weight at ≤13pt sizes, `.semibold` only inside filled buttons.
Receipt/outcome glyphs are 12pt. No filled circles behind glyphs except the confirm card icon.

### 1.5 Motion

Existing curves only (`appFast` 0.15 / `appStandard` 0.22 / `appRelax` 0.4 / `appSpring` 0.28).
Every animation below has a reduced-motion fallback: crossfade at `appFast`.

Signature transitions (the "interaction language"):

1. **Settle** — working line → receipt line: the line's text crossfades, the gold working dot
   shrinks into the muted glyph, height animates if the phrase length changes. `appStandard`.
2. **Morph** — confirm card → outcome row: card height collapses to the 40pt row, fill fades
   from `appSurface` to transparent, the checkmark draws (trim 0→1, 0.3s, `appRelax`).
   The card is *replaced in place* — nothing new is appended to the transcript.
3. **Rise** — new turn entrance: existing opacity + 8pt bottom offset, `appSpring`. Kept.

No orchestrated page-load choreography (product register rule).

---

## 2. Component inventory (Deliverable A)

New/changed SwiftUI components. Names are implementation-ready.

| Component | Replaces | One-line contract |
|---|---|---|
| `TurnActivityView` | `StatusIndicator`, `OxyThinkingIndicator` usage in chat | The living strand: `.thinking`, `.working(phrase:)`, states rotate human phrases; renders the gold working dot + one line of `chatReceipt` text. |
| `TurnReceiptRow` | all non-handoff `ActionCard` receipts, search receipts, email/calendar count cards | Collapsed: glyph + one summarized line ("Looked through your inbox and tomorrow's calendar"). Tap → expands inline to a step list (see 5.3). |
| `OutcomeRow` | `ActionCard` success rows for world-changing actions | Glyph + headline + human detail + optional trailing affordance (`Open`, `Undo`, `View`). 40pt min height, hairline top rule, no box. |
| `ConfirmCard` | `ActionReviewSheet` **and** `ActionCard.pendingCard` (two paths become one) | Inline bordered card at transcript tail. Title, one human sentence, primary accent capsule + quiet cancel. `holdToConfirm: Bool` for money. |
| `RecoveryRow` | `ErrorBanner` for turn-scoped failures | Inline failure line on the failed turn: amber/coral glyph, specific sentence, `Try again` (re-runs in place, no duplicate messages). |
| `AssistantProse` | `AssistantAnswerView` (refined, not rewritten) | Adds `chatLead` treatment for first paragraph + `Details` fold for source material (see 5.4). |
| `Composer` | `ChatInputBar` (restructured) | One-row pill: plus • field • mic/send. Voice states morph the field in place (kept concept, refined states in §5.10). |
| `EmptyChatView` | `WelcomeCard` (refined) | Time-aware greeting + 3 hairline starter rows anchored *above the composer*, not floating mid-void. |
| `ChatHeader` | `AppHeaderView` usage in chat (slimmed) | Leading menu/back, trailing new-chat. Nothing else. No title. 44pt. |
| `HandoffCard` | `UberHandoffCard`, `TravelResultCard`, `DirectionsLink` (kept, restyled) | The only boxed cards allowed in the stream: native handoffs and rich results the prose can't carry. |

Unchanged: `MessageSourceChips`, `MessageComposeSheet`, attachment strip, photo/file pickers,
`PendantOverlay`, haptics modifier.

---

## 3. State model (Deliverable B)

One enum drives the whole turn lifecycle. The view model already has the raw signals
(`isSending`, `statusLabel`, streaming flags, `ActionResult.pending/success`); this formalizes
them.

```swift
enum TurnPhase: Equatable {
    case composing                     // user typing / recording
    case sent                          // request in flight, no signal yet
    case thinking                      // model reasoning, no tool activity
    case working(step: WorkStep)       // tool activity, human phrase + ordinal
    case awaitingConfirmation(Action)  // agent paused for the user
    case executing(Action)             // confirmed, action running
    case streamingAnswer               // prose arriving
    case settled(Receipt?, [Outcome])  // done
    case failed(Failure, retryable: Bool)
    case partial(Receipt, Failure)     // some steps succeeded, one didn't
}

struct WorkStep { let phrase: String; let index: Int; let total: Int? }
```

### Phase → UI mapping

| Phase | Visible component | Composer | Notes |
|---|---|---|---|
| `composing` | — | active | mic states in §5.10 |
| `sent` | `TurnActivityView(.thinking)` after 300ms grace | dimmed, send disabled | <300ms replies never show a spinner |
| `thinking` | `TurnActivityView` — gold dot pulse + "Thinking" | dimmed | |
| `working` | `TurnActivityView` — dot + rotating phrase ("Reading your email…") | dimmed | phrases from the **server-sent step vocabulary** (§5.3), never raw tool names |
| `awaitingConfirmation` | `ConfirmCard` inline at tail | replaced by card (composer hides) | §5.6 |
| `executing` | `ConfirmCard` buttons → progress state in place | hidden | |
| `streamingAnswer` | activity settles → receipt; prose streams below | dimmed | receipt appears *before* prose finishes |
| `settled` | `TurnReceiptRow` + `AssistantProse` + `OutcomeRow`s | active | |
| `failed` | `RecoveryRow` on the turn | active | §5.9 |
| `partial` | receipt + amber `RecoveryRow` for the failed step | active | |

Rule: **at most one `TurnActivityView` exists on screen ever**, and it always belongs to the
last turn.

---

## 4. Information architecture verdicts

- **The header has no purpose today → give it none.** A 44pt strip with menu/back leading and
  new-chat trailing, glass buttons on the canvas (current treatment kept). No wordmark, no
  title, no status. History/incognito move behind the menu. The conversation is the header.
- **Kill the double confirm path.** Today a pending action renders an inline `pendingCard`
  *and* triggers `ActionReviewSheet`. One inline `ConfirmCard`, always. Sheets are for
  system composers (MFMessageCompose) only.
- **Kill the banner stack.** Offline/network/voice error banners at the top compete and push
  content. Offline becomes a 28pt quiet strip under the header (only true global state).
  Turn-scoped failures move into the turn (`RecoveryRow`). Voice failures live in the
  composer (§5.10).
- **Tab bar behavior is already right** (system glass `TabView`, hide-on-scroll in chat);
  the composer is the part that pays rent (§5.11).

---

## 5. Screen-by-screen specification (Deliverable C)

### 5.1 Empty chat

**Structure, top to bottom:**
1. `ChatHeader` (menu · new-chat).
2. Flexible space.
3. Greeting block, leading-aligned at chat margin, sitting in the **lower third** just above
   the starters — not floating at the top with a void beneath (current bug).
   - Line 1: time-aware greeting, `title 27 semibold`, `appInk`: "Good evening." /
     "Morning." (no name repetition — the product is nameless in-app).
   - Line 2: capability invitation, `chatBody`, `appMuted`, one line max:
     "Ask me, or ask me to *do* something."
4. Three starter rows (existing hairline-row pattern, kept): icon 14pt `appMuted` + label
   `body 15.5 medium` `appInk` + ↗ 9pt. 56pt rows, hairlines above/below, context-menu
   replacement kept. **Starters must be verbs that prove agency** and, when connectors are
   known, personalized: "Summarise my inbox", "What's tomorrow look like?", "Book me a ride".
5. `Composer`, focused affordance visible but keyboard *not* auto-raised.

**Behavior:** greeting fades/rises once per visit (existing stagger, ≤3 elements). Starter
tap = send immediately. When the user starts typing, greeting + starters fade out at
`appFast` (they never coexist with a conversation).

**Edge cases:** returning to an empty *new* chat mid-day shows the same state, no "welcome
back" copy. If starters can't personalize (no connectors), show the generic three and add a
fourth quiet row: "Connect your email and calendar" → routes to connectors.

### 5.2 Normal conversation

- **User message:** compact bubble, `appUserBubble` (accent 18% tint), right-aligned,
  16pt/10pt padding. Kept exactly.
- **Assistant answer:** plain on canvas, full width. First paragraph in `chatLead` (17pt),
  the rest in `chatBody`. That two-point step is the entire "hierarchy" for short answers —
  no cards, no boxes.
- **Follow-up questions from the agent** are just prose; if the agent offers discrete
  choices, they render as up to 3 quiet capsule chips under the answer (hairline border,
  `appMuted` text, tap = sends the choice). Chips disappear once the user replies.
- **Timestamps:** current logic kept (group-end, >5min gaps), `chatMicro` at
  `appMuted` 72%.
- **Grouping:** 20pt between turns, 8pt within a turn.

### 5.3 Agent actively working (the most important state)

**What appears:** the instant the request sends, a `TurnActivityView` slides in under the
user bubble (Rise transition):

```
● Reading your email…
```

- The dot: 7pt circle, `appWorking` gold, gentle scale pulse 0.85→1.15 at 1.2s ease-in-out
  (reduced motion: static dot at 70% opacity).
- The phrase: `chatReceipt` 13pt `appMuted`. Phrases are **human progress language**, mapped
  server-side or in `progressLabel`-style client mapping, in this voice:
  "Thinking" → "Reading your email…" → "Checking tomorrow's calendar…" →
  "Putting it together…". Never "get_calendar_events", never "Tool: web_search".
- Phrase changes crossfade at `appStandard`; the line never grows taller than one line.
- For tasks with a known step count, a whisper-quiet ordinal trails the phrase:
  "Checking tomorrow's calendar · 2 of 3" (`chatMicro`).

**What does NOT appear:** no per-tool blocks accumulating, no pill with border floating in
the transcript (current `StatusIndicator` box is removed), no spinner.

**When the answer starts streaming:** the activity line **settles** (transition §1.5.1) into
the collapsed `TurnReceiptRow` and prose begins beneath it. The user watches work become a
receipt become an answer — that's the visual narrative.

**Long tasks (>8s):** the phrase keeps rotating; after 20s append "Still working — you can
keep typing" and re-enable the composer (queued follow-ups are legitimate).
**Cancel:** while working, the composer's send button becomes a stop glyph (■, `appMuted`);
tap = graceful cancel, activity line settles to "Stopped" receipt.

### 5.4 Multi-tool task complete (result synthesis)

Example: "Check my emails for anything important today, then check my calendar for tomorrow."

```
                                        [user bubble]
✓ Looked through 14 emails and tomorrow's calendar        ← TurnReceiptRow, 1 line
Two things need you today, and tomorrow is busier         ← chatLead
than usual.

**Needs a reply**                                          ← chatHeading
• Sarah moved the board review to Thursday — she's        ← existing list rows,
  waiting on your slot confirmation.                        gold markers kept
• BA flight change: your Thursday flight is now 9:40.

**Tomorrow**
• 9:00 Design review — the Figma link is in Marco's
  email; worth a skim tonight.
• 12:30 Lunch with Priya (booked — Luca, Clerkenwell).

Want me to confirm Thursday with Sarah?                    ← next step as prose
```

**Hierarchy rules:**
- The conclusion is *always* the first sentence, in `chatLead`. The model contract is
  "lead with what matters"; the UI enforces it typographically.
- `TurnReceiptRow` collapsed: 12pt ✓ glyph in `appMuted` (NOT green — green is reserved for
  world-changing outcomes), one line, `chatReceipt`. Tap → expands inline (`appStandard`) to
  the step list: each step is glyph + phrase + nothing else ("✓ Read 14 emails from today",
  "✓ Checked Wednesday's calendar"). A second tap collapses. Chevron 10pt at trailing edge.
- Supporting source material (full email quotes, raw lists) does not render inline. If the
  model returns more than ~14 prose blocks, blocks beyond the fold render behind a quiet
  `Details` row (hairline, `appMuted`, chevron) that expands in place. The answer is a
  synthesis; the fold holds the evidence.
- `MessageSourceChips` kept, unchanged, below the prose for web-grounded answers.

### 5.5 Long structured answer (no tools)

Same as 5.4 minus receipt. `chatLead` first paragraph; headings `chatHeading` with 12pt top
spacing; bullets/numbered rows with gold markers (existing `AssistantListRow`, kept). Body
line spacing 5.5. Never a box around prose. The `Details` fold applies past ~14 blocks.

### 5.6 Confirmation required

Example: "Add dentist to my calendar tomorrow at 3pm."

**Replace the bottom sheet.** A sheet detaches the decision from the conversation and covers
it with a system-modal gesture surface — that's why it feels technical. The decision belongs
in the transcript, where its context (the user's own words) is one glance up.

**`ConfirmCard`, inline at the transcript tail:**

- Container: `appSurface` fill, `AppRadius.md` continuous, 0.75pt border `appAccent` 28%.
  The **only** bordered gold-tinted container in the entire chat = unambiguous "I need you."
- Anatomy (16pt padding, 12pt stacks):
  1. Icon 16pt in a 36pt `appAccent`-15% circle (calendar.badge.plus etc.) + title
     `confirmTitle`: **"Add to your calendar?"** — always a question, always plain.
  2. The human sentence, `chatBody` `appInk`:
     **"Dentist — tomorrow (Wed 8 Jul), 3:00 to 4:00 PM."**
     Formatting contract: relative day + weekday+date in parentheses, 12-hour times, no ISO
     strings, no "Title:/Start:/End:" labels (delete the `cleanDetail` regex approach — the
     backend must send display-ready fields; the regex is a symptom).
  3. Buttons: primary accent capsule "Add it" (`appOnAccent` text, 48pt) + plain-text
     "Not now" in `appMuted` beneath/beside. Labels are verbs specific to the action:
     "Add it" / "Send it" / "Book it" — never bare "Confirm".
- Composer hides while a `ConfirmCard` is active (the card *is* the input). Typing intent
  = "Not now" is still reachable; card also dismisses if the user sends a new message
  (counts as cancel, agent acknowledges in prose).
- **Money variant** (`holdToConfirm: true`): payments/orders keep the same card + one
  quiet line above the buttons ("Uses your saved payment method on the site.",
  `chatReceipt`), and the primary button becomes **hold-to-confirm**: press and hold 0.8s,
  capsule fills left→right in `appAccent`, haptic ramp, release-early cancels. Deliberate
  ≠ heavy: still one gesture, still two seconds.
- **Reversibility statement:** if the action is reversible, the card says nothing (undo
  appears after, §5.7); if irreversible (sending a message, placing an order), the sentence
  itself carries it: "This sends immediately."

**Under two seconds test:** Title = what will happen. Sentence = when/what. Button = the verb.

### 5.7 Action successful

The `ConfirmCard` (or, for unconfirmed low-stakes actions, the activity line) **morphs in
place** into an `OutcomeRow` (§1.5.2). Nothing new is appended; the transcript never shows
both the question and a separate receipt.

**`OutcomeRow` anatomy:** 40pt min height, hairline top rule, no box:

```
✓  Added to your calendar        Dentist · tomorrow 3 PM      Undo
```

- ✓ 12pt `appSuccess`, drawn with trim animation on arrival + soft haptic
  (existing settle haptic reused).
- Headline `chatOutcome` `appInk`; detail `chatReceipt` `appMuted`, one line, truncating.
- Trailing affordance, `appTitanium`: `Undo` (reversible, visible for 30s, then swaps to
  `View`), `Open` (deep link), or nothing.
- Undo tapped → row crossfades to "Removed — want a different time?" as agent prose. Undo is
  a real agent command, not a client trick.
- Multiple outcomes in one turn stack as rows (each hairline-separated); they share one ✓
  moment, not three celebrations.

This is the reusable completion pattern for calendar/email/message/booking/reminder/order.

### 5.8 No results

Zero-result work is neither success nor failure. Receipt glyph = neutral 6pt muted dot
(existing soft-miss treatment, kept). Receipt: "Searched your inbox". Prose carries the
answer *and* an offer: "Nothing from Amex this week. I can watch for it and let you know."
No red, no empty-state illustration, no apology.

### 5.9 Failure and recovery

**Taxonomy → treatment:**

| Failure | Treatment |
|---|---|
| Network / offline | Global strip under header ("Offline — I'll keep your message", `appWarning` glyph, `appMuted` text on `appSurface`). Unsent message stays in a queued bubble at 60% opacity with "Waiting for connection"; auto-sends on reconnect. No modal, no red. |
| Whole-turn tool failure | Activity line settles to `RecoveryRow`: `!` 12pt `appDanger` glyph + specific sentence + `Try again` in `appTitanium`. "I couldn't reach your calendar just now." Retry re-runs the same turn **in place** — the row returns to `TurnActivityView`; no duplicate user message ever enters the transcript. |
| Permission missing | `RecoveryRow` with a routed fix: "I don't have access to your calendar yet." + `Connect` → connectors screen; on return, turn auto-retries. |
| Partial multi-step | Receipt renders normally for completed steps; expanded step list marks the failed one with amber `!`; prose answers with what it *did* get: "Here's your email summary — the calendar didn't answer, so tomorrow's view is missing. Try again?" `Try again` re-runs only the failed step. |
| Voice transcription failure | Composer-local: field shows "Didn't catch that" `appMuted` + mic pulses once; auto-clears in 2.5s. Never a banner. |
| Failed confirm/execution | ConfirmCard's progress state settles back to buttons + one line: "That didn't go through — nothing was booked." Retry = same card. |

Principle: the *specific* recovery verb (`Try again`, `Connect`, `Check connection`) is
always the trailing affordance; "Something went wrong" is banned copy.

### 5.10 Voice

Voice stays **inside the composer** — the current in-place morph is the right model; the
states get sharpened:

| State | Composer appearance |
|---|---|
| Idle | mic glyph in the trailing 34pt circle (hairline outline). |
| Recording | Field morphs (`appStandard`): leading ✕ cancel (28pt), live 5-bar waveform driven by input level (reuse `PendantWaveform`, bars in `appInk`), elapsed `chatMicro` timer. Border `appDanger` 22%. Trailing button = ■ stop, `appDanger` fill. Haptic on start/stop. |
| Transcribing | Waveform freezes → shimmer sweep; label "…" only, ≤600ms target. |
| Review beat | **New:** transcript lands in the field as *editable text*, selected-appearance for 900ms with the send button already gold. Doing nothing = auto-sends. Tapping the text = cancels auto-send, becomes a normal draft. Pendant/Siri paths keep today's direct injection (screen may be pocketed); on-screen mic gets the review beat because mistranscription in front of your eyes deserves one. |
| Sending/processing | Normal turn flow (§5.3). |
| Failure | §5.9 voice row. |

`PendantOverlay` glass capsule kept as-is for wearable sessions.

### 5.11 Composer and navigation (keyboard open)

- **One row, always:** `[ + ] [ field ……… ] [ mic/send ]` — 34pt controls, field pill
  `appSurface` + hairline, 8pt gaps, 14pt side margins, 8pt vertical padding. This exists;
  the change is what surrounds it.
- **Tab bar:** system glass `TabView` kept, accent tint kept, hide-on-scroll kept. Two
  additions: (1) the tab bar hides whenever the keyboard is up or a `ConfirmCard`/recording
  is active (single vertical stack rule: conversation + one input surface, never
  conversation + composer + tab bar + keyboard); (2) it returns on scroll-to-bottom rest or
  keyboard dismiss, `appStandard`.
- **Keyboard transitions:** interactive dismiss kept. On focus, the composer rides the
  keyboard with no re-layout of message content (bottom inset animation only); focus ring =
  existing accent-12% border, kept.
- Composer never exceeds 6 lines (existing); attachment strip renders above the row
  (existing, kept).

---

## 6. Implementation sequence (Deliverable D)

Ordered so each step ships alone and improves the product without a rewrite. Backend
coordination flagged.

1. **Turn receipt collapse** (biggest win, pure client): build `TurnReceiptRow`; fold all
   non-handoff `ActionCard`s for a settled turn into one line + expandable steps. Map
   existing `ActionResult`s to step phrases client-side initially (the `progressLabel`
   table generalizes). Delete search-receipt/email-count cards.
2. **`TurnActivityView`**: replace `StatusIndicator` + the boxed pill; borderless dot+phrase
   line, settle transition into the receipt from step 1. Add composer stop-glyph cancel.
3. **Confirmation unification**: build `ConfirmCard`; delete `ActionReviewSheet` and
   `pendingCard`; composer hides while active. *Backend:* display-ready `title/sentence/
   verb/reversible` fields on pending actions (removes `cleanDetail` regexes).
4. **`OutcomeRow` + morph + Undo**: success pattern, 30s undo. *Backend:* undo commands for
   reversible actions (calendar delete exists; wire it).
5. **Failure system**: `RecoveryRow`, in-place retry (view-model rerun of last turn without
   appending), offline strip + queued-message state; remove `ErrorBanner` from chat.
6. **Answer typography**: `chatLead` first paragraph, `Details` fold, follow-up chips.
7. **Empty state + header slim + voice review beat + tab-bar/keyboard rules**: polish tier.
8. **Server step vocabulary** (parallel track): agent orchestrator emits
   `{phrase, index, total}` progress events so client mapping tables retire.

Each step keeps `npm test` green (steps are iOS-only until 3/4/8's API additions).

## 7. Preserve / refine / replace / remove (Deliverable E)

**Preserve** — user bubble treatment; assistant prose plain on canvas (July 4 decision);
list rows with gold markers; source chips; timestamp cadence; hide-on-scroll tab bar;
in-composer voice morph; `PendantOverlay`; Uber/travel handoff cards (as the only boxed
cards); haptics; attachment flow; dark-only pin; all `app*` tokens.

**Refine** — `AssistantAnswerView` (lead paragraph, Details fold); `WelcomeCard`
(lower-third greeting, verb starters, fade-on-type); composer focus/disabled states; voice
recording visuals (real waveform, timer, review beat); soft-miss neutral state (kept, now
inside receipt); `progressLabel` phrases (become the working vocabulary).

**Replace** — `StatusIndicator` boxed pill → `TurnActivityView`; per-tool `ActionCard`
receipts → `TurnReceiptRow` + `OutcomeRow`; `ActionReviewSheet` + `pendingCard` →
`ConfirmCard`; `ErrorBanner`-in-chat → `RecoveryRow` + offline strip.

**Remove** — the double confirm path; top banner stacking; `cleanDetail` ISO-date regex
massaging (backend contract instead); per-search receipt rows; green checkmarks on
read-only work (green = outcomes only); any exposure of tool names, counts-as-cards, or
raw status strings in the transcript.

# Real Buy Flow (Native Step UI, Real Data) — Design

Date: 2026-07-18
Status: approved, ready for planning

## Problem

`AgenticHomeView`'s composer routes certain phrasings ("buy a pair of jeans", "book us a table",
"get me an uber", "order food") into `AgentPlanGenerator.generate(for:)` — a fully client-side
keyword scaffold (`Models/AgentTaskSession.swift`) that fabricates a scripted three-step native UI
with **zero backend involvement**: no real search, no real price, no real photo. The most visible
symptom: `ProductDetailStepView` always shows a fixed set of five generic device-finish swatches
("Silver", "Graphite", "Slate", "Chalk", "Sand") regardless of what the user is buying — including
jeans, which obviously don't come in "Graphite."

The exact same user intent, depending on trivial wording ("buy X" vs. "order me X"), can land on
this fake flow or on the real one (chat → agentic loop → `run_browser_task`, which does genuine
Playwright-driven search/cart/checkout and, as of this session, extracts real product photos).
That inconsistency is what surfaced the bug.

The native step-flow's *visual pattern* (a working/searching animation → an item detail screen →
a payment confirmation) is good UX and worth keeping — the fix is making it real, not removing it.

## Goal

"Buy a pair of jeans" (or any similar shopping intent) drives the same native step screens, but
every field on them — name, price, photo, color options if genuinely detected, and the checkout
total — comes from the real backend. Dinner/ride/order-food keyword matches, which are not being
rebuilt as real native flows in this pass, stop hitting the fake scaffold and fall through to real
chat instead (today's normal fallback for anything unmatched).

Flights, hotels, and restaurants as native flows are **explicitly out of scope** for this spec —
noted as a natural future application of the same pattern, not built here.

## Architecture

The native flow gets its data by sending the exact same message through the exact same backend
pipeline chat already uses (`ChatService.sendMessage` → SSE → agentic loop → `run_browser_task`),
just without rendering a chat transcript. A new lightweight client-side consumer reads the same
`.status` / `.actions` / `.text` SSE events `ChatViewModel` already knows how to handle, and feeds
them into the native step UI instead of message bubbles.

Checkout ("Review & confirm") calls the existing `confirm_browser_payment` action through that same
hidden pipeline. **No new payment code path is introduced.** Every existing safety gate — the
concierge spend cap, the `ready_for_payment` → review-required stop before any charge — stays
exactly as it is today, because nothing new touches money; the native screens are a different
*view* onto the same real actions and results chat already produces.

## Backend changes (`api/services/browser-task.js`)

The model already inspects the page visually at every step. Extend the `"done"` and
`"ready_for_payment"` decision JSON shapes to also ask for:

- `productName` (string) — the actual item name as shown on the page
- `price` (string, as displayed) — already partially present as `total` on `ready_for_payment`;
  make it consistently available on `done` too when there's a visible price
- `colorOptions` (array of strings, optional) — populated **only** when the model observes
  distinct selectable color/size options on the page (e.g. `["Black", "Indigo", "Light Wash"]`);
  omitted entirely otherwise. Never fabricated as a fallback — an item with no detected options
  gets no swatch picker, full stop.

`extractProductImageUrls` (already built this session) continues to supply the photo unchanged.

These new fields are additive to the existing `run_browser_task` action result shape
(`text`, `imageUrls`, `total`, `summary` already exist) — no breaking changes to the chat-visible
path, which can simply ignore the new fields.

## Client changes

### `Models/AgentTaskSession.swift`

- `AgentTaskSession.steps` becomes append-only/mutable instead of a fixed array built entirely
  up front by `buySession(prompt:)` — the real outcome isn't known until the backend responds, so
  steps are added as results arrive: start with just the working-hero step; append the product
  detail step once real data returns; append the payment-confirm step (or a plain done-state, if
  the turn was a pure lookup rather than an order) once checkout data returns.
- `ProductDetails`/`ProductSwatch` gain fields matching the new backend response
  (real name/price/photo URL/optional swatches) instead of being constructed from hardcoded
  literals.
- `buySession`, `dinnerSession`, `rideSession`, `orderSession` and `AgentPlanGenerator.generate`'s
  keyword matching for dinner/ride/order-food are removed. Only the buy path remains, and it now
  builds its initial (working-only) step from a real intent instead of a scripted plan.

### `Views/Home/AgentStepViews.swift`

- `WorkingHeroStepView`'s status text is driven by the real `onStep` progress events
  (thinking / action-start / action-complete) from the hidden pipeline, reusing the exact
  progress-streaming work already shipped this session for chat — not a fixed/fake status string.
- `ProductDetailStepView`'s hero renders the real photo (`AsyncImage`, same fade-in pattern as
  `MessageBubble`'s `ProductImageRow`) when `imageUrls` is present, falling back to the existing
  honest placeholder plate only when it's genuinely empty. The swatch section only renders when
  `colorOptions` came back non-empty.
- `RideConfirmStepView`, `PlacePickerStepView`, `TimePickerStepView`, `PersonPickerStepView`,
  `PlanBoardStepView` are removed (dead code once their only callers — dinner/ride/order sessions
  — are gone). `StepTitleBlock`, `SelectableGlassRow`, `PaymentConfirmStepView`,
  `WorkingHeroStepView`, `ProductDetailStepView`, `SessionDoneStepView` are kept/reused.
- No `project.pbxproj` changes needed — these are edits within existing files, not file
  deletions/additions.

### `Views/Home/AgenticHomeView.swift`

- `handleIntent` no longer branches on `AgentPlanGenerator.generate` matching dinner/ride/
  order-food keywords — only a genuine buy match opens the native session; everything else
  (including former dinner/ride/order-food phrasings) goes to `openChat`, same as any unmatched
  message today.
- The buy path now opens `activeSession` immediately with just the working-hero step, kicks off
  the hidden pipeline call, and appends subsequent steps as real data arrives (see above).

## Error handling

- Hidden-pipeline failure (network error, backend error) surfaces as a plain error state in the
  native flow (reusing `ErrorBanner`'s tone) with a retry, not a silent fallback to fake data.
- If `run_browser_task` returns `awaiting_more` (multi-turn continuation) or `ask` (needs
  clarification), the native flow's honest option is to hand off to real chat with the same
  in-progress context rather than trying to represent an open-ended clarifying question as a fixed
  native step — reuses the existing `onOpenChat` handoff `AgentTaskSessionView` already has.

## Testing

- Verify with a real device/simulator run of "buy a pair of jeans" end to end: working step shows
  real progressing status text, detail step shows a real name/price/photo (and swatches only if
  the site actually exposed color options), checkout total matches what `ready_for_payment`
  reports, and `confirm_browser_payment` is the same call chat's checkout already uses.
- Verify "book us a table" / "get me an uber" / "order food" now open real chat instead of the
  native scaffold.
- Verify the money-safety gate is unchanged: a `ready_for_payment` outcome still requires an
  explicit "Review & confirm" tap before `confirm_browser_payment` fires, and the spend-cap guard
  in `guardConciergeSpend` still runs exactly as it does for the chat path (it's the same code).

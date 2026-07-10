# iOS card-linking UI + SCA re-auth banner — design

Date: 2026-07-10
Status: approved, ready for implementation plan

## Context

The backend half of real Stripe payments for the concierge account shipped and deployed
2026-07-10 (commit fbfe3fc, plus a same-day follow-up commit cf76a7b for location-aware
currency and cleanup). See `docs/superpowers/specs/2026-07-10-concierge-real-payments-design.md`
for the backend design. None of it is reachable from the iOS app yet — no client calls
`/connectors/stripe/setup-intent`, renders a card-linking screen, or shows a re-auth prompt
for a charge stuck in `requires_action`. This spec covers that iOS-facing work only.

Out of scope, staying out of scope: refunds/disputes handling, multiple cards / choosing
between them, Stripe Connect (payouts *to* someone), and a balance top-up UI (top-up already
works as an agent action via chat; no need to duplicate it here).

## Architecture

Two independent surfaces:

1. **Payments screen** — a new standalone screen reachable from the More tab, alongside
   Pendant and Connections. Owns: linked-card display, link/replace/remove via Stripe's
   Payment Sheet (SetupIntent mode), and a read-only concierge balance display.
2. **SCA re-auth banner** — a small banner at the top of the Today screen, shown only when a
   charge is stuck in `requires_action`. Tapping it drives Stripe's native 3DS challenge
   in-app via `STPPaymentHandler`.

These are placed separately rather than combined because they answer different questions at
different times: "do I have a card linked" (checked once, rarely) vs. "does something need my
attention right now" (checked on every app open, alongside the rest of Today's proactive
surface).

### Why a new screen instead of extending the Connections/Stripe row

`ConnectorsView` already lists Stripe as a connector for payout/payment-link actions, and its
whole row model is a simple enabled/disabled toggle plus an OAuth-style connect flow. Card
linking is a different interaction entirely — a full Payment Sheet presentation, a persisted
card summary, an unlink action — and folding that into one list row would overload it compared
to every other row on that screen. A standalone Payments screen keeps money-specific UI
separate from the generic connector toggle list.

## Backend additions

Four small additions needed before the iOS work can proceed. All follow existing patterns
already in `api/services/stripe-cards.js` and `api/index.js`.

1. **`unlinkCard(supabase, userId)`** in `api/services/stripe-cards.js`. Clears
   `default_payment_method_id`, `card_brand`, `card_last4` from the stored tokens and sets
   `enabled: false` via the existing `writeStripeTokens` helper. Deliberately **keeps**
   `stripe_customer_id` so a subsequent relink reuses the same Stripe customer instead of
   creating a duplicate.
2. **`GET /connectors/stripe/card`** — wraps the existing `getLinkedCard`. Returns
   `{ card }` (or `{ card: null }`). Needed because today the only place card info comes back
   to any caller is the response of `POST /connectors/stripe/confirm`, right after linking —
   there's no way to check "is a card linked" on screen load.
3. **`DELETE /connectors/stripe/card`** — calls `unlinkCard`, returns `{ linked: false }`.
4. **`GET /connectors/stripe/payment-action`** — wraps the existing
   `getPaymentActionRequired`. Returns the pending SCA record
   (`{ paymentIntentId, clientSecret, amountCents, description }`) or `null`. Drives the Today
   banner's visibility and gives it the `clientSecret` to challenge.
5. **`GET /concierge/balance`** — returns `{ balance }` by reading the same
   `concierge_account.balance` preference the existing `check_concierge_balance` agent action
   already reads. Needed because that balance is currently only reachable by simulating a chat
   turn through the agent-action path; the Payments screen needs a direct read.

All four/five routes require `requireSessionAuth`, same as the existing two Stripe routes.
No changes to the charge or webhook path — `chargeLinkedCard`, `setPaymentActionRequired`, and
the webhook's atomic claim-and-clear already do the right thing; the client is just now able to
*observe* that state instead of being blind to it.

## iOS: Payments screen

New entry in `MainTabView.MoreDestination` (`case payments`), added to the "Milgrain" menu
group next to Pendant and Connections:
`AppRow(title: "Payments", subtitle: <dynamic status>)` — subtitle shows "Visa •••• 4242" when
linked, "No card linked" otherwise (same convention as the Connections row's capability
caption).

New `PaymentsView.swift`, structurally mirroring `ConnectorsView.swift` (`.task` load,
`.refreshable`, `errorMessage` banner on failure):

- **Balance** — fetched via `GET /concierge/balance`, displayed as a plain formatted number
  (e.g. "128.50"), **not** currency-symbol-formatted. Reasoning: the concierge balance is a
  virtual running ledger, not itself a currency-denominated Stripe object — it isn't tied to
  one location/currency the way an individual charge is. Only real charges (in the SCA banner
  and any future charge-history UI) get currency-symbol formatting.
- **Card row** — brand + last4 + "Linked"/"Not linked" status text, same visual language as a
  `ConnectorsView` connector row (icon, title, status, trailing control).
- **Link / Replace button** — calls `POST /connectors/stripe/setup-intent` for
  `clientSecret` + `publishableKey`, presents `PaymentSheet` configured for SetupIntent mode,
  and on `.completed` calls `POST /connectors/stripe/confirm` with the `setupIntentId` to
  persist the card server-side, then refreshes the card row from the response.
- **Remove card button** — shown only when a card is linked. Confirms via a native alert
  ("Remove linked card? You'll need to link a new one before the agent can charge you
  directly."), then calls `DELETE /connectors/stripe/card` and refreshes the row.

## iOS: SCA re-auth banner

New `PaymentActionBanner.swift`, a small standalone view inserted at the top of
`ProactiveView`'s scroll content, in the same slot as the existing `ErrorBanner` (i.e. above
the card grid, not as a new `TodayCardKind` — it's a transient system notice, not a
user-configurable board card).

**Visibility:** checked via `GET /connectors/stripe/payment-action` on `.task` (screen load)
and again whenever `scenePhase` becomes `.active` — the same polling trigger `ConnectorsView`
already uses for OAuth connect status. Shown only when the endpoint returns a non-null record.

**Copy:** "Confirm your card for the {currency-formatted amount} charge for {description}"
with a "Confirm" button. This is the one place amounts get real currency-symbol formatting
(via `NumberFormatter` with `.currency` style and the currency code the backend charged in —
threaded back from `chargeLinkedCard`'s `currency` param through to whatever the
`payment-action` record stores; if the stored record doesn't already carry the currency code,
add it to `setPaymentActionRequired`'s payload as part of this work).

**Tapping "Confirm":**
1. Calls `STPPaymentHandler.shared().handleNextAction(forPayment: clientSecret, with: authContext, returnURL: nil)` — Stripe's native 3DS challenge sheet.
2. `authContext` is a minimal `STPAuthenticationContext` conformer (new small helper,
   ~15 lines) that returns the app's key window's root view controller — the standard pattern
   for wiring Stripe's UIKit-based challenge presentation into a SwiftUI app.
3. On completion (success, failure, or user cancel), re-fetch `payment-action` after a short
   delay (~1.5s). The actual balance deduction and clearing of the pending record happens
   asynchronously via the existing webhook, not synchronously from this call, so the banner may
   take a moment to disappear. If it's still present after a few seconds, leave it as-is
   (user can tap Confirm again) rather than polling indefinitely.

## Stripe iOS SDK dependency

First Swift Package Manager dependency in `OxyApp.xcodeproj` (currently has none). Added via
Xcode's own File → Add Package Dependencies UI pointing at `stripe-ios`
(`https://github.com/stripe/stripe-ios`), selecting the `StripePaymentSheet` product — it
transitively includes `StripeCore`, `StripePayments`, and `StripePaymentsUI`, covering both the
Payment Sheet (linking) and `STPPaymentHandler` (re-auth) needs. This is a manual step done in
Xcode rather than hand-editing `project.pbxproj` package references, which is fragile to do by
hand.

## Testing plan

- **Backend:** `node:test` cases for the new additions — `unlinkCard` (clears card fields,
  keeps `stripe_customer_id`), and the new routes (auth-required 401, happy path, no-card/
  not-found cases), following the existing style in `test/smoke/stripe-cards.test.js` and
  neighboring Stripe test files.
- **iOS:** no unit-test harness exists for this app's services today; verification is manual —
  build in Xcode, run in Simulator, exercise link → confirm → balance/card display → remove,
  using Stripe's test cards (`4242 4242 4242 4242` for a clean link/charge, `4000 0025 0000
  3155` to force `requires_action` and exercise the banner + 3DS challenge path).
- `npm test` must stay green before any commit, per project convention.

## How to resume

Next: invoke the writing-plans skill to turn this into a step-by-step implementation plan,
starting with the backend additions (small, testable in isolation) before the iOS work (which
needs the SDK added in Xcode first).

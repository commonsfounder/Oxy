# Concierge account: Open Banking top-up + ledger-first spend — design

Date: 2026-07-10
Status: approved, ready for implementation plan

## Context

The concierge account (`stripe_charge`, `spend_from_concierge_account`,
`spend_from_concierge_via_stripe`) currently charges the user's linked card in real time for
every single spend action, via `chargeLinkedCard` (`api/services/stripe-cards.js`). Every one of
those charges incurs Stripe's standard card-processing fee (~1.5-3% + ~20p), eaten entirely by
the business — the charge is for the literal requested amount, no markup, by explicit design
(the user must never pay more than sticker price for what's being bought). That's correct and
stays correct. But it means a flat subscription can't scale against unbounded, variable
per-transaction fee exposure: a single £500 concierge charge on a UK card costs ~£7.70 in fees
alone — 38.5% of an entire £20/month subscription eaten by one transaction.

**Confirmed while diagnosing this:** nothing in this codebase currently forwards concierge-spend
money to any real external merchant or person — `spend_from_concierge_account`/`stripe_charge`
only charge the user's own card and update an internal `concierge_account.balance` preference.
Whatever the agent "spent it on" is handled through a completely separate channel (most likely
the browser-automation ordering loop, `api/services/browser-task.js`, which never touches
payment fields at all — it pauses at `ready_for_payment` for the human to enter their own card
on the retailer's own checkout, so the retailer eats its own fee there, unrelated to any of this).

This means making concierge spend a ledger-only operation (once pre-funded) removes no real
capability — there wasn't an external payout to remove.

## Scope

- **UK only.** Both Stripe products this design uses (Pay by Bank, the existing card flow) are
  well-supported in the UK; other currently-supported regions (EUR/USD/CAD/AUD via
  `resolveCurrencyForLocation`) keep the existing all-card behavior unchanged, untouched by this
  work.
- **Additive, not a replacement.** The existing linked-card flow (`chargeLinkedCard`,
  `getLinkedCard`, `saveLinkedCard`, `unlinkCard`, the SCA/webhook machinery) stays exactly as
  built. This adds a second, cheaper funding rail and a balance-first check before spend falls
  back to that existing card flow. The in-progress iOS card-linking plan
  (`docs/superpowers/plans/2026-07-10-ios-card-linking-ui.md`, Tasks 1-5 done, Tasks 6-8 not yet
  built) is **not superseded** by this work and should resume independently once the Stripe iOS
  SDK is added in Xcode — this design's top-up UI sits alongside Tasks 6-8's card-link/remove/SCA
  UI on the same Payments screen, not instead of it.
- **Two-phase reality, this spec covers Phase 1 only.** The deeper ambition — giving the agent a
  real, usable payment instrument to autonomously pay retailers directly (via Stripe Issuing) —
  is a separate, larger initiative blocked on Stripe approving Issuing access (not yet
  requested). See [[concierge-fee-free-rail-plan]] (memory) for that Phase 2 note. This spec is
  Phase 1: a cheaper funding rail plus a ledger-first spend check, buildable now with no external
  approval dependency.

## Architecture

The concierge balance becomes the single source of truth for "can this spend happen right now."
Two funding rails feed it — the existing card charge (unchanged) and a new Open Banking transfer
via Stripe's "Pay by Bank" product — and one spend path drains it: check the balance first, and
only fall back to a real-time card charge when the balance can't cover the request.

### Why Pay by Bank specifically

Verified against Stripe's current docs and UK pricing (not assumed from training data):
Pay by Bank is a real, live Stripe product (`payment_method_types: ['pay_by_bank']` on a
PaymentIntent) available in the UK today, for amounts between £0.50 and £10,000. Its UK fee is
**0.5% + 20p, capped at £5** — roughly a third of a domestic card's 1.5% + 20p. It is single-use
only (cannot be saved for reuse or recurring charges — no equivalent of a SetupIntent for it),
which is exactly right for an explicit "top up now" action; it isn't meant to replace the linked
card for the "off-session" spend-time charges the existing fallback still needs.

The flow: the customer selects their bank, is redirected to their bank's own app/web portal,
authorizes there, and returns to the merchant. This requires a `return_url` and, on iOS, a
registered URL scheme for the app to receive that return — **the app has none registered
today** (checked `Info.plist`; no `CFBundleURLTypes` exists). This work adds one (e.g.
`milgrain://stripe-return`), wired to `StripeAPI.handleURLCallback` in `AppDelegate` — a standard
Stripe SDK integration step for any redirect-based payment method, not something specific to
this design.

## Backend additions

### 1. Card top-up (reuses existing machinery entirely)

New route: `POST /connectors/stripe/topup/card`. Calls the existing `chargeLinkedCard` exactly as
`stripe_charge` does today (off-session, against the already-linked card), with description
"Concierge top-up," and on `succeeded` credits `concierge_account.balance` by the amount. No new
Stripe primitives — this is a thin wrapper reusing `chargeLinkedCard`, `setPaymentActionRequired`,
and the existing SCA webhook path unchanged (a card top-up can still require 3DS re-auth exactly
like a spend charge does today).

### 2. Bank top-up (new: Pay by Bank)

New route: `POST /connectors/stripe/topup/bank`. Creates a PaymentIntent with
`payment_method_types: ['pay_by_bank']`, `currency: 'gbp'`, `metadata: { oxy_user_id, purpose:
'concierge_topup' }`, and a `return_url`. Before returning the client secret, stores a pending-topup
record — mirroring the existing `setPaymentActionRequired`/`getPaymentActionRequired`/
`claimPaymentActionRequired` compare-and-delete pattern in `api/services/stripe-cards.js`, under a
new preference key (e.g. `concierge_account.pending_topup`) — so a redelivered webhook event
cannot double-credit the balance. This is the same proven idempotency mechanism already built
and tested for SCA re-auth, applied to a second use case, not a new invention.

### 3. Webhook: credit balance on Pay by Bank success

Extend `api/services/stripe-webhook.js`'s `handleStripeWebhookEvent` to recognize
`payment_intent.succeeded` events where `metadata.purpose === 'concierge_topup'`. On such an
event: atomically claim the matching pending-topup record (same claim-by-payment-intent-id
pattern as `claimPaymentActionRequired`); only the caller whose claim actually removes the row
credits `concierge_account.balance` by the topped-up amount. A redelivered/duplicate webhook for
the same PaymentIntent finds the record already gone and is a no-op.

### 4. Spend-side: balance-first check

In `api/index.js`'s `spend_from_concierge_account` and `stripe_charge` case blocks, and in
`connectors/stripe.js`'s `spend_from_concierge_via_stripe` branch: **before** calling
`chargeLinkedCard`, read the current `concierge_account.balance`. If it covers the requested
amount, deduct it directly (a plain preference update, identical to the existing "no Stripe key
configured" virtual-only branches these case blocks already have) and return success — no Stripe
call happens at all. Only when the balance is insufficient does execution fall through to
exactly today's behavior: real-time `chargeLinkedCard`, SCA handling, and balance updates from
the charge outcome, completely unchanged.

## iOS

On the Payments screen (already built, Tasks 1-5 of the card-linking plan): a "Top up" action
presents an amount-entry sheet with two options:
- **Card** — instant, silently uses the already-linked card (calls
  `POST /connectors/stripe/topup/card`), no `PaymentSheet` needed since it's an off-session
  charge against a saved payment method, identical in shape to how spend charges work today.
- **Bank** — calls `POST /connectors/stripe/topup/bank` for a client secret, presents
  `PaymentSheet` configured for the PaymentIntent (not a SetupIntent, since Pay by Bank can't be
  saved), which redirects out to the user's banking app and back via the new URL scheme.

This is additive UI on the same screen as Tasks 6-8's card-link/remove/SCA-banner work — both
funding rails and the existing card management coexist; neither replaces the other.

## Testing plan

- **Backend:** `node:test` coverage for: the balance-first spend check (sufficient balance →
  ledger-only deduction, `chargeLinkedCard` never called; insufficient balance → falls through
  to the existing charge path, unchanged); the pending-topup claim/credit logic (redelivered
  webhook events must not double-credit — same style of race/duplicate test already used for
  `claimPaymentActionRequired` in `test/smoke/stripe-cards.test.js`).
- **iOS:** manual verification in the Simulator, same convention as the rest of this project's
  iOS work (no automated iOS test harness exists). Pay by Bank has no dedicated Simulator test
  card the way `4242...` does for cards — verify against Stripe's documented test-mode behavior
  for Pay by Bank redirects (Stripe's test mode simulates the bank-auth step without a real bank).
- `npm test` must stay green before any commit, per project convention.

## Explicitly out of scope (this spec)

- Stripe Issuing / giving the agent its own real spendable card for retailer checkouts — Phase 2,
  blocked on Stripe approving Issuing access, tracked separately in
  [[concierge-fee-free-rail-plan]] (memory), not this spec.
- Any region other than UK (Pay by Bank is not available in the app's other supported currencies
  today).
- Auto top-up / recurring funding — Pay by Bank is single-use only; a "top up automatically when
  balance is low" feature would need a different, reusable rail (e.g. Bacs Direct Debit) and is
  not part of this work.
- Refunding a top-up back out of the concierge balance — not requested, not designed here.

## How to resume

Next: invoke the writing-plans skill to turn this into a step-by-step implementation plan. The
backend pieces (routes, webhook extension, spend-side check) are independently testable and
should land first, same sequencing as the original concierge-payments and card-linking-UI plans.
The iOS top-up UI depends on the same Stripe iOS SDK addition (`StripePaymentSheet`) that Tasks
6-8 of the card-linking plan are already waiting on — one SDK addition unblocks both.

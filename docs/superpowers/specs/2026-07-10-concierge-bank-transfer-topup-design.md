# Concierge account: bank-transfer top-up + ledger-first spend — design

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

- **UK only.** The manual bank-transfer top-up below only makes sense against a UK business bank
  account; other currently-supported regions (EUR/USD/CAD/AUD via `resolveCurrencyForLocation`)
  keep the existing all-card behavior unchanged, untouched by this work.
- **Genuinely zero fee, by design, at the cost of being manual.** Every automated option
  (Stripe Pay by Bank, TrueLayer/Yapily/Plaid-style read-only bank-feed APIs) either has a real
  per-transaction fee or an unpublished/sales-gated production cost — verified by checking
  Stripe's actual UK pricing and each provider's public pricing pages, not assumed. The only
  genuinely-£0 option is a plain Faster Payments bank transfer with manual reconciliation: no
  processor, no signup, no third party, at the cost of not being instant or automatic. That's the
  deliberate tradeoff here.
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
Two funding rails feed it — the existing card charge (unchanged) and a new manual bank-transfer
top-up (this design) — and one spend path drains it: check the balance first, and only fall back
to a real-time card charge when the balance can't cover the request.

### Why manual bank transfer, not an automated bank-payment product

Checked against real, current pricing rather than assumed: Stripe's "Pay by Bank" is real and
live in the UK, but charges 0.5% + 20p (capped at £5) — not zero. Read-only bank-feed providers
(TrueLayer, Yapily, Plaid) that could auto-detect incoming transfers don't publish production
pricing at all — it's sales-gated, and these products commonly carry a flat monthly
platform/connection fee regardless of transaction volume. Neither is "zero fee anywhere," which
is the explicit goal here. A plain Faster Payments transfer between the user's own bank and
Oxy's business bank account has no fee to either party — because no processor sits in the
middle at all. The cost of that: no automatic detection or instant confirmation. Someone (you,
or a lightweight internal tool) has to notice the transfer landed and credit the right user.

### How matching works without automation

Each user gets a stable, unique reference code (e.g. derived from their user id, like
`OXY-<short-id>`) to put in the payment reference field when they transfer money — the same
mechanic landlords, clubs, and small UK businesses already use to identify who paid what in a
shared account. The user is shown Oxy's business bank account sort code + account number and
their own reference code on the Payments screen. When a transfer lands, whoever is reconciling
(you, initially) looks at the business account's incoming transactions, reads the reference,
and credits that amount to the matching user's `concierge_account.balance` via a new internal
route (see below) — not by editing the database by hand, but through a real, auditable action.

## Backend additions

### 1. Card top-up (reuses existing machinery entirely)

New route: `POST /connectors/stripe/topup/card`. Calls the existing `chargeLinkedCard` exactly as
`stripe_charge` does today (off-session, against the already-linked card), with description
"Concierge top-up," and on `succeeded` credits `concierge_account.balance` by the amount. No new
Stripe primitives — this is a thin wrapper reusing `chargeLinkedCard`, `setPaymentActionRequired`,
and the existing SCA webhook path unchanged (a card top-up can still require 3DS re-auth exactly
like a spend charge does today).

### 2. Bank-transfer reference code

New helper (e.g. `api/services/concierge-bank-transfer.js`): a deterministic, stable reference
code per user (e.g. `OXY-` + a short hash of the user id — deterministic so it doesn't need its
own storage/migration, just computed on read). New route `GET /concierge/bank-transfer-details`
returns `{ accountName, sortCode, accountNumber, reference }` — the business account details
(from env vars, e.g. `OXY_BANK_SORT_CODE`/`OXY_BANK_ACCOUNT_NUMBER`, not hardcoded) plus that
user's computed reference code, for display on the Payments screen.

### 3. Manual credit route (the reconciliation action)

New route: `POST /concierge/credit-transfer` (admin/internal — gated behind a shared-secret
header, same pattern as the existing `proactiveSweepAuthorization`/`OXY_PROACTIVE_SWEEP_SECRET`
gate for other internal-only endpoints, not open to end users). Body: `{ reference, amountPounds
}`. Looks up the user by reference code, credits `concierge_account.balance` by the amount, and
records the credit (e.g. appended to a `concierge_account.last_receive`-style preference, mirroring
the existing pattern in `api/index.js`'s `receive_to_concierge_account` case) so there's an audit
trail of manual credits. This is the "someone reconciling the bank statement" action — callable
via a simple authenticated request (curl, or a small internal script), not a public API.

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
presents two options:
- **Card** — instant, silently uses the already-linked card (calls
  `POST /connectors/stripe/topup/card`), no `PaymentSheet` needed since it's an off-session
  charge against a saved payment method, identical in shape to how spend charges work today.
- **Bank transfer** — no Stripe SDK involved at all. Fetches
  `GET /concierge/bank-transfer-details` and displays the account name, sort code, account
  number, and the user's personal reference code, with a copy-to-clipboard affordance for each —
  plus a short explainer that crediting isn't instant. The balance updates once the transfer is
  reconciled server-side (Task 3 above); the Payments screen already polls/refreshes balance on
  `.refreshable` (Task 5 of the card-linking plan), so no new client-side polling is needed.

This is additive UI on the same screen as Tasks 6-8's card-link/remove/SCA-banner work — both
funding rails and the existing card management coexist; neither replaces the other.

## Testing plan

- **Backend:** `node:test` coverage for: the balance-first spend check (sufficient balance →
  ledger-only deduction, `chargeLinkedCard` never called; insufficient balance → falls through
  to the existing charge path, unchanged); the reference-code generation (deterministic, stable
  per user); the manual-credit route (correct user credited, auth-gated, rejects unknown
  reference codes).
- **iOS:** manual verification in the Simulator, same convention as the rest of this project's
  iOS work (no automated iOS test harness exists) — confirm the bank details + reference code
  display correctly and the balance updates after a manual credit is posted server-side.
- `npm test` must stay green before any commit, per project convention.

## Explicitly out of scope (this spec)

- Stripe Issuing / giving the agent its own real spendable card for retailer checkouts — Phase 2,
  blocked on Stripe approving Issuing access, tracked separately in
  [[concierge-fee-free-rail-plan]] (memory), not this spec.
- Automated bank-feed detection (Stripe Pay by Bank, TrueLayer/Yapily/Plaid-style AISP
  integrations) — deliberately not used here since neither is genuinely fee-free; may be
  revisited later once volume justifies whatever their real cost turns out to be.
- Any region other than UK.
- Refunding a top-up back out of the concierge balance — not requested, not designed here.

## How to resume

Next: invoke the writing-plans skill to turn this into a step-by-step implementation plan. The
backend pieces (reference codes, manual-credit route, spend-side balance check) are
independently testable, need no Stripe SDK changes, and should land first. The iOS card top-up
option depends on the same Stripe iOS SDK addition (`StripePaymentSheet`) that Tasks 6-8 of the
card-linking plan are already waiting on; the bank-transfer display does not — it can ship
without waiting on that SDK addition at all.

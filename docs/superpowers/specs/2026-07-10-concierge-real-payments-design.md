# Concierge real payments (Stripe) — design

Status: approved, not yet implemented.

## Context

The concierge account (`concierge_account.balance`) is currently a simulated/tracked
budget. Real spend caps and human-review gating already exist and are solid
(`api/services/concierge-spend-guard.js`, `api/services/money-guard.js`). No real
money can move today for two independent reasons:

1. `STRIPE_SECRET_KEY` is not documented anywhere (`.env.example`,
   `cloudrun.env.example.yaml`) and is almost certainly unset.
2. Even with a key set, there is zero Stripe SDK in the iOS app, no card-linking UI
   anywhere, and the existing server code (`api/index.js:2409`-2430, `2480`-2523)
   fires a PaymentIntent but never confirms it client-side — it would sit unconfirmed
   forever.

The review-gate already makes a human approve every spend before execution, so the
target model is: **link a card once, then agent-approved spends charge it directly**
(Stripe's off-session charge pattern) — not confirm-payment-every-time, which would
duplicate an approval that already happened.

## A. Data model — card linking storage

Reuse the existing `connectors` table (`user_id`, `connector_id`, `enabled`, `tokens
JSONB`) exactly like the Google/Monzo connectors. A row with `connector_id='stripe'`,
`enabled=true`, and `tokens` holding:

```json
{
  "stripe_customer_id": "cus_...",
  "default_payment_method_id": "pm_...",
  "card_brand": "visa",
  "card_last4": "4242"
}
```

No new table. The `stripe` entry already exists in the connector catalog
(`api/index.js:4072`, marked `implemented: true`) — it becomes actually true.

## B. Card linking flow

- New backend endpoint, e.g. `POST /connectors/stripe/setup-intent`: creates a Stripe
  Customer for the user if none exists yet, then a `SetupIntent` for that customer,
  returns its `client_secret`.
- iOS: add the Stripe iOS SDK via Swift Package Manager (first SPM dependency in the
  project — `OxyApp.xcodeproj` currently has none). Build a "Link a card" screen using
  `PaymentSheet` in setup mode. Stripe's SDK collects card details directly, so raw
  PANs never touch the server — keeps the app out of PCI scope.
- On success, write `stripe_customer_id` + `payment_method_id` + card brand/last4 into
  `connectors.tokens` (via the SetupIntent webhook, see D, or a confirm endpoint called
  right after `PaymentSheet` succeeds).
- Entry point: a "Payments" row in account settings, plus a contextual prompt the first
  time the concierge tries to spend and no card is linked — the review card itself
  says "link a card to continue" instead of showing an approve button.

## C. Charge execution

Rewrite `stripe_charge` / `spend_from_concierge_via_stripe`
(`api/index.js:2480`-2523, `2409`-2430) to:

- Look up the linked `stripe_customer_id` + `payment_method_id` from `connectors`.
- Create the PaymentIntent with `customer`, `payment_method`, `off_session: true`,
  `confirm: true`.
- Idempotency key: reuse the existing `pendingKey` already computed for confirm-lock
  dedup (`userId:createdAt:type:input`, `api/index.js:5656`) — hash it into Stripe's
  `Idempotency-Key` header. It's already a stable unique identifier for one approved
  action; no new concept needed. A retried request against the same approval can't
  double-charge.
- Because the review-gate already gets human approval before this runs, there is no
  separate "confirm payment" step for the normal path — only the SCA fallback (D)
  needs an explicit second confirmation.

## D. SCA / 3D Secure handling

UK product, so SCA is not optional — an off-session charge can come back
`requires_action` instead of succeeding.

- On `requires_action`: write a `payment_action_required` flag (with the PaymentIntent
  `client_secret`) instead of treating it as a hard failure.
- Add a Stripe webhook endpoint (`POST /webhooks/stripe`) registered with
  `express.raw()` **before** the global `express.json()` middleware (currently
  `api/index.js:211`) — Stripe requires the raw body for signature verification, so
  this route must be mounted ahead of that line or excluded from it. Verify
  `STRIPE_WEBHOOK_SECRET`; listen for `payment_intent.succeeded` /
  `payment_intent.payment_failed`; clear or update the `payment_action_required` flag.
- Surfacing (push is blocked until a paid Apple Developer account exists, see
  push-apns-blocked memory): a persistent item on the Today card dashboard plus a
  banner the next time the app is opened, until the user taps through and completes
  re-auth via `PaymentSheet.confirm(clientSecret)`.

## E. Balance/ledger semantics change

The card replaces the balance as the thing actually charged. `concierge_account.balance`
and the spend-cap machinery in `concierge-spend-guard.js` / `money-guard.js` do not
change — caps still gate every spend the same way. What changes is only what happens
after approval: instead of decrementing a virtual balance, it charges the card, and
`balance`/the spend ledger becomes a running record of what's actually been charged
rather than a prepaid pot. No migration of existing balance data — this is a
display/behavior change, not a schema change.

## F. Review-card UX copy

Once a card is linked, the review/approval card swaps its copy from the generic
"spend $X from concierge account" framing to "charge your card ending in 4242 $X" —
pulling `card_last4` from `connectors.tokens`.

## G. Config

`STRIPE_SECRET_KEY` and a new `STRIPE_WEBHOOK_SECRET` need documenting in
`.env.example` / `cloudrun.env.example.yaml` (currently entirely undocumented) and
setting in Cloud Run. Test-mode keys are sufficient for all build/design work;
switching to live keys is a config flip at the end, not a code change.

## Out of scope for v1

- Refunds/disputes handling.
- Multiple linked cards / choosing between them.
- Stripe Connect (only needed if the agent should ever pay *out* to someone, not just
  spend).

## Apple Developer Program impact

Does not block building this. Stripe SDK, Stripe account creation, and Payment Sheet
all work in the simulator without a paid Apple account. The $99/yr program only
matters for: shipping to real users via TestFlight/App Store (already a known
blocker, unrelated to this work); Apple Pay as an optional Payment Sheet method
(skippable — plain card entry works without it); and push-notifying for SCA re-auth
(same APNs wall — worked around by surfacing in-app on next open instead, per D).

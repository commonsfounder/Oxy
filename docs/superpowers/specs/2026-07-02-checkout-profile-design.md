# Checkout Profile Design

**Date:** 2026-07-02  
**Status:** Approved for implementation (session 7)  
**Context:** Session 6 (`70e592c`) fixed false reauth by clicking guest-checkout links. John Lewis, M&S, and Wickes now reach a genuine `user_gate` — guest-checkout email asks. There is still no stored checkout identity in the codebase.

## Problem

The ordering loop correctly stops at checkout identity gates (email, address, login) but asks the human every turn. Guest checkout on UK retailers most often asks for **email first**. Re-asking on every order is friction the concierge should absorb once the user opts in.

## Design decisions

### 1. Whose identity?

**Decision: Option (c) — ask once, store with consent, reuse.**

| Option | Verdict |
|--------|---------|
| (a) Real user profile from iOS/auth | No delivery email or address exists in `OxyApp/Views/Auth/` (only `userId` + password). Nothing to pull. |
| (b) Concierge-owned inbox/address | Useful later for order-confirmation forwarding; out of scope for v1. |
| **(c) User-provided, stored, reused** | **Ship first.** Matches user expectation; minimal surprise. |

### 2. Where is it stored?

**Decision: `preferences` key-value store** (same pattern as `concierge_account.balance` in `api/index.js`).

| Key | Value |
|-----|-------|
| `checkout_profile.email` | Normalised email string |
| `checkout_profile.email_consent` | `"true"` only after explicit opt-in |

No new table for v1. Address fields (`checkout_profile.address_line1`, etc.) are reserved for a follow-up; not in this session.

### 3. How does `browser-task.js` consume it?

Before returning `{ type: 'ask', question }` on an **order** goal (`session.isOrder`):

1. Classify the ask with a **conservative** matcher (`classifyCheckoutAsk`) — email only when the question clearly asks for email.
2. If field is `email` and `checkout_profile.email` + `email_consent` are set → find an email input in extracted elements → **fill** via the existing fill execution path (same `evaluateHandle` + `locator.fill` as vision `fill`).
3. If field is `email` but no stored value → return ask with consent copy; do not silently store.
4. **Never** auto-fill payment/card/CVV asks — hard stop remains `ask` (existing payment guardrail unchanged).

When the user replies on a continuation turn with an email in the goal text:

- Parse email from goal; optionally persist if user said "save my email".
- Set `session.pendingCheckoutFill` and auto-fill on the next extraction cycle.

### 4. Consent

- First email ask includes: *"Say 'save my email' if you'd like me to remember it for future orders."*
- Storage only when `checkout_profile.email_consent` is set to `"true"` (via "save my email" in the user's reply or explicit future settings UI).
- No silent PII harvest.

### 5. Scope

- **Order goals only** (`session.isOrder` / `isOrderGoal`) — not passive price lookups.
- Email field only in v1 (most common `user_gate` in JL/M&S/Wickes traces).
- Does **not** bypass money guardrails (`money-guard.js` spend caps and `executionMode: 'review'` on payment actions remain unchanged).

## Architecture

```
api/services/checkout-profile.js   ← pure classify/parse + preference load/save
api/services/browser-task.js       ← hook before ask return; continuation parse; fill execution
preferences table                  ← checkout_profile.* keys per user_id
```

## Out of scope (this session)

- Address/postcode/name auto-fill
- iOS settings screen for checkout profile (API/preferences sufficient for v1)
- Concierge-owned identity (option b)
- Connect-a-site login capture (`docs/superpowers/specs/2026-07-01-connect-site-login-design.md`)
- Tier-0 no-browser JSON-LD price lookup (still higher leverage for cost/latency)

## Testing

- Unit: `test/smoke/checkout-profile.test.js` — classify, parse, find element, consent
- Integration: existing `test/dev/browser-task-e2e.js` on JL/M&S/Wickes with stored email pref stubbed in harness
- Regression: `test/smoke/*.test.js` (287+ pass)
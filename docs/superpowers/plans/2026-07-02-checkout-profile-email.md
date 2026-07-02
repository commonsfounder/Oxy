# Checkout Profile (Email) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan step-by-task.

**Goal:** Auto-fill guest-checkout email asks on order goals when the user has opted in and stored an email in preferences.

**Architecture:** Pure `checkout-profile.js` for classify/parse/storage; `browser-task.js` intercepts `ask` outcomes and continuation goals, reusing the existing fill execution path.

**Tech Stack:** Node.js, Supabase `preferences` table, existing Playwright fill path in `browser-task.js`.

## Global Constraints

- Order goals only (`session.isOrder`)
- Email field only — conservative match, never payment/card fields
- Consent required before persisting (`checkout_profile.email_consent === "true"`)
- Do not relax payment guardrail or money spend caps

---

### Task 1: checkout-profile module

**Files:**
- Create: `api/services/checkout-profile.js`
- Test: `test/smoke/checkout-profile.test.js`

- [ ] **Step 1:** Write failing tests for `classifyCheckoutAsk`, `findEmailInputElement`, `parseEmailFromUserText`, `wantsSaveEmailConsent`
- [ ] **Step 2:** Implement pure functions
- [ ] **Step 3:** Implement `loadCheckoutProfile` / `saveCheckoutEmail` using supabase preferences
- [ ] **Step 4:** Run `node --test test/smoke/checkout-profile.test.js`

### Task 2: browser-task integration

**Files:**
- Modify: `api/services/browser-task.js` (~ask handler, ~goal continuation, exports)

- [ ] **Step 1:** Import checkout-profile helpers
- [ ] **Step 2:** On continuation with email in goal → parse, optional save, set `session.pendingCheckoutFill`
- [ ] **Step 3:** After `extractClickableElements`, if pending fill or stored email on email-ask → auto-fill and `continue`
- [ ] **Step 4:** Before `return { type: 'ask' }`, try stored email auto-fill; else append consent copy for first email ask

### Task 3: Verify

- [ ] Run `node --test test/smoke/*.test.js`
- [ ] E2E: stub preferences in harness, run Wickes/M&S/JL with stored email
- [ ] Commit + push to origin/main
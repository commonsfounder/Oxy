# Oxy — Software Ship-Readiness Gap Overview

What stands between the **current working software stack** and a **consumer-ready, shippable** product. Software only — hardware/manufacturing is out of scope here.

This complements (does not repeat) the existing docs:
- `OXY_HARDENING_RUNBOOK.md` — quality/eval/release QA process
- `PRIVACY_SUPPORT_CHECKLIST.md` — privacy/support content
- `ONBOARDING_PERMISSION_MATRIX.md` — first-run permissions

**Severity:** `P0` hard blocker for any consumer launch · `P1` needed for a credible launch · `P2` post-launch hardening.
**Status tags:** `present` · `partial` · `missing` · `verify` (capability seen but completeness not confirmed from a read-only pass).

---

## 0. Already solid — do NOT rebuild

These exist in the repo and are working or near-working:
- Per-user auth with `password_hash` + `token_version` (revocation) + `OXY_SESSION_SECRET`.
- Rate limiting (`createRateLimiter`, `audioRateLimit`) — basic abuse protection.
- Connector-token encryption — AES-256-GCM (`api/services/token-crypto.js`), used by `google.js`, `telegram.js`.
- DB migrations for auth, indexes, and **row-level security** (`supabase-migration-*.sql`).
- Review-gated high-risk actions + connector-health recovery (`action-runner.js`, `connector-health.js`, `pending-review.js`).
- Observability primitives: Sentry, `/version`, `/health`, `X-Oxy-Commit`, structured request logging (per runbook §3).
- Data export endpoint (`oxy-data-export.json`) and a "Delete Account" flow (completeness to verify — see #2/#10).
- StoreKit referenced in iOS (`NativeIntegrationManager.swift`) — subscription scaffolding started.
- Smoke + brain-eval tests; `npm run release:check`; APNs/push wired; proactive job; Cloud Run auto-deploy.

---

## P0 — Hard blockers for a consumer launch

### 1. Monetization / subscription enforcement — `partial`
- **Have:** StoreKit referenced on iOS; no server-side entitlement gate found.
- **Missing:** working StoreKit 2 purchase + **server-side App Store receipt/JWS validation**; per-user entitlement record; **server enforcement** that gates assistant usage behind an active subscription/trial; restore-purchases; App Store Server Notifications webhook (renew/cancel/refund/billing-retry); free-trial logic.
- **Why it blocks:** no revenue, and Apple requires IAP for digital subscriptions — external payment will be rejected.

### 2. App Store compliance bundle — `missing/verify`
- **Missing:** confirm **in-app account deletion** fully erases server-side data (Apple-mandated); App Privacy "nutrition label"; audit of all permission usage-description strings; **AI-output content-moderation + safety disclosure** (Apple scrutinizes generative AI); age rating; background-mode justifications; Sign in with Apple (if any social login is added).
- **Why it blocks:** these are hard gates in App Store review.

### 3. Published legal + privacy pages — `missing` (drafts only)
- **Have:** drafts in `docs/` + runbook §8.
- **Missing:** publicly hosted **privacy policy, terms, support contact, data-deletion URL, data-processing disclosure**, linked from the app and the App Store listing.
- **Why it blocks:** App Store + UK-GDPR/GDPR requirement; can't collect personal data lawfully without it.

### 4. Secret & token hardening (operational) — `partial`
- **Have:** encryption capability, but it **silently falls back to plaintext** if `OXY_TOKEN_ENCRYPTION_KEY` is unset.
- **Missing:** **fail-closed** enforcement of the key in prod; **migrate existing plaintext connector tokens** to encrypted; move all secrets to Cloud Run **Secret Manager** (not env/repo); key-rotation plan.
- **Why it blocks:** connector tokens grant access to users' Gmail/Telegram/etc.; plaintext storage is a breach waiting to happen.

---

## P1 — Needed for a credible launch

### 5. CI test gate before deploy — `missing`
- **Have:** auto-deploy from GitHub → Cloud Run. **No `.github/workflows`.**
- **Missing:** CI that runs `npm run release:check` (+ iOS build) on every PR and **blocks deploy on failure**.
- **Why:** today a bad commit to `main` auto-ships straight to production with no test gate.

### 6. Observability, alerting & cost control — `partial`
- **Have:** Sentry + logs + health endpoints.
- **Missing:** error **alerting/paging**, uptime monitoring, latency dashboards/SLOs, and **per-user + global Gemini/TTS spend monitoring** with budget alerts and **per-user spend caps**.
- **Why:** without cost telemetry, a few heavy users (or an abuse loop) can blow the model budget unnoticed.

### 7. Voice latency engineering — `missing`
- **Missing:** end-to-end latency measurement, **Cloud Run min-instances** (kill cold starts), streaming/path optimization, regional routing.
- **Why:** voice round-trip latency is the product's make-or-break UX; it must be measured and defended, not assumed.

### 8. AI safety & abuse at scale — `partial`
- **Have:** rate limiting + review-gated money/message actions.
- **Missing:** **output moderation** (Apple expects it for generative AI), **prompt-injection defenses on connector-returned data** (e.g. malicious email content steering actions), per-tier usage quotas, jailbreak/abuse handling.
- **Why:** consumer scale + agentic actions = real blast radius.

### 9. Connector reliability policy — `partial`
- **Have:** good connector-health recovery; the fragile Uber Eats scraper was just removed.
- **Missing:** explicit **"supported vs best-effort" labeling** in the UI, monitoring of per-connector failure rates, a deprecation policy for deep-link/scraped connectors, and an OAuth token-refresh robustness audit.
- **Why:** the Uber Eats episode showed fragile connectors erode trust; users need honest expectations.

### 10. Account lifecycle completeness — `verify`
- **Have:** export endpoint + a delete flow.
- **Missing/verify:** email verification, password reset, **full server-side erasure** (Supabase rows + connector tokens + Gemini context caches) on delete, session-revocation UX, re-auth on sensitive changes.

### 11. Onboarding + permission flow (implementation) — `partial`
- **Have:** scoped in runbook §7 + permission matrix.
- **Missing:** the **implemented** first-run flow with graceful permission-denial handling and Settings recovery paths; connector-connect polish.

### 12. Forced-upgrade / version skew — `partial`
- **Have:** `X-Oxy-Commit` + Settings diagnostics.
- **Missing:** min-supported-app-version enforcement + graceful upgrade prompt; backend/app API-contract versioning.

---

## P2 — Post-launch hardening

13. **Push/proactive reliability** — quiet hours, opt-in granularity, delivery retries, robust Cloud Run Job scheduling.
14. **Backups & data ops** — DB backup/restore policy, migration safety, periodic RLS re-verification, PII retention policy.
15. **Offline/degraded UX** — implement the no-network / slow-network / signed-out / stale-deploy states the runbook's device matrix tests for.
16. **BLE / pendant phone-side** — pairing UX, reconnection, firmware-update path, audio-path decision. (Only if the pendant ships this cycle; otherwise defer — app-only launch is viable.)
17. **Localization / i18n** — currently UK-centric (£, `Europe/London`, UK-first connectors). Needed before non-UK markets.

---

## Suggested sequencing for Fable

- **Wave 1 — unblock a paid iOS launch:** #1 billing · #2 App Store bundle · #3 legal pages · #4 secrets.
- **Wave 2 — trust the launch:** #5 CI gate · #6 observability/cost · #7 latency · #10 account lifecycle.
- **Wave 3 — quality at scale:** #8 safety · #9 connector policy · #11 onboarding · #12 versioning.
- **Wave 4 — hardening:** the P2 set.

For each item, start from the referenced files; treat `verify` tags as "read the code first, the capability may already be partly there."

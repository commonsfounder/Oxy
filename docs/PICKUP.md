# Browser-task pickup (2026-07-03)

All changes below are **committed and pushed** to `origin/main` (commits below).

---

## What's been done (sessions 1–7 + checkout identity v2)

| Commit | What |
|--------|------|
| `3be9685` | Sessions 1–5: reliability foundation, bot-wall detection, managed-browser routing, Tier-0 price lookups |
| `70e592c` | Session-6a: guest-checkout path (skip false sign-in ask on M&S/Wickes/JL) |
| `70fdcb4` | Session-6b: checkout profile v1 — email ask-once-store-reuse |
| `08e4e5d` | Connector scrub (removed deeplink-only ubereats/deliveroo/netflix) |
| `e944fc4` | Session-7: retailer-name resolver, generic recipe selection, faster settle, DOM guest-click |
| *(this)* | Checkout identity v2 — name/phone/address, consolidated consent, forget path |

---

## Repo orientation

- `api/services/browser-task.js` — the main ordering loop (`runOrderingTurn`), all session state
- `api/services/checkout-profile.js` — pure identity functions + Supabase KV persistence
- `api/services/browser-recipes.js` — Tier-2 deterministic recipe steps (JL, M&S, Wickes)
- `api/services/retailer-sites.js` — retailer name → URL resolver (UK + US)
- `api/services/browser-price-parser.js` — Tier-0 HTTP price extraction (JSON-LD / og:price)
- `api/services/browser-fastpaths.js` — self-learning search-URL templates
- `test/dev/reliability-benchmark.js` — cross-site benchmark (19 UK sites)
- `test/dev/browser-task-e2e.js` — single-site E2E debugger

## Running things

```bash
node --test test/smoke/*.test.js                          # 333 pass
node test/dev/browser-task-e2e.js "goal" "url" 3         # single-shot debug
node test/dev/reliability-benchmark.js                   # full basket (~4 min)
node test/dev/reliability-benchmark.js marksandspencer   # filter by site
```

---

## Checkout identity state (v2 shipped)

Guest checkout flow now handles:
1. **Guest fork** — DOM click on "checkout as guest" (Wickes-style login-or-guest page)
2. **Email** — auto-filled from `checkout_profile.email` when consent; else asks once with "save my details" opt-in
3. **Name / phone / address** — auto-filled via `autoFillCheckoutDetails` DOM enumeration from `checkout_profile.{name,phone,address}`; else asks once for all missing fields together
4. **Payment** — always a hard human ask; never auto-filled; untouched by this feature

Preferences keys: `checkout_profile.email`, `.name`, `.phone`, `.address` (JSON), `.consent`

User can clear with: "forget my checkout details" → `forget_memory(query:'checkout details')`

---

## NEXT (recommended order)

1. **Delivery cart-commit fix** — Uber Eats/Deliveroo reach cart but stall on the pay button. No delivery-specific recipe yet; likely needs a modal-dismiss + pay-button recipe step.
2. **Generic recipe breadth** — the foundation (session-7) is in; now lift step conventions (`data-testid`/aria/button-text) so the deterministic tail covers more sites.
3. **Managed-browser E2E** — code is wired, unverified. Once a Bright Data/Browserbase key exists: `BROWSER_REMOTE_ENDPOINT=… node test/dev/reliability-benchmark.js next argos just-eat` (expect botwall→pass).
4. **Country selects / non-UK address** — v2 skips `<select>` tags (too site-specific); per-site recipe or smarter label-match strategy needed later.

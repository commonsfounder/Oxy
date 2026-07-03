# Browser-task pickup (2026-07-01)

Everything below is committed and pushed (`3be9685` on `origin/main`).

---

## Browser-task reliability — pickup context

**Repo:** `/Users/chizigamonyewuchi/Documents/Oxy` · branch `main` (feature work commits directly to main here)

**Where we are:** `run_browser_task` orders/looks-up on real retail sites. John Lewis is proven E2E; this session added a **cross-site benchmark** and measured a **baseline of 63% overall / 71% loop pass (12/17 sites)**. Failures are mostly datacenter-IP bot-walls (infra), not loop bugs.

### Read these first
- `docs/BROWSER_TASK_SESSION_HANDOFF.md` — **UPDATE (d)** at the bottom is this session; full narrative + roadmap.
- `api/services/browser-task.js` — the main loop (`runOrderingTurn`), bot-wall detection, browser routing.
- `api/services/browser-recipes.js` — Tier-2 deterministic recipes (host-keyed, only John Lewis today).
- `api/services/browser-fastpaths.js` — self-learning search-URL templates.
- `test/dev/reliability-benchmark.js` + `reliability-fixtures.js` + `reliability-classify.js` — the benchmark.

### Run the benchmark (needs `.env` GEMINI_API_KEY + local Chromium, from repo root)
```
node test/dev/reliability-benchmark.js            # full 19-site basket (~4 min)
node test/dev/reliability-benchmark.js grocery    # filter by tag or site
node test/dev/browser-task-e2e.js "<goal>" "<url>" 3   # single-shot debug
node --test test/smoke/*.test.js                  # 243 pass
```

### NEXT TASK (top priority) — no-browser "Tier-0" price lookups
For **info goals (price/availability), not orders**, skip the browser entirely. Most retailers server-render `schema.org/Product` JSON-LD, so 2 plain HTTP GETs get the price with no browser/model/proxy, <1s. **Proven in a probe:** John Lewis (£39.99) and Screwfix work; ASOS/Currys/Argos bot-wall the fetch too and must fall through to the existing browser loop.

Build:
1. A **pure, unit-testable parser**: given HTML → price from JSON-LD `offers.price`, then `og:price:amount` meta, then microdata fallbacks.
2. A **fetch tier before `openNewSession`** for non-order goals: derive search URL (reuse `deriveSearchTerm`/`directSearchUrl` in `browser-task.js`) → GET search → extract first product URL → GET product → parse. Confident price → return; else fall through to the browser loop unchanged.
3. Gate it so orders never take this path (`isOrderGoal`).

### Then, in order
2. **Generic pattern-recipes** — lift `RECIPES[host]` in `browser-recipes.js` from host-keyed to convention-keyed (`data-testid`/aria/button-text for size→add→cart→checkout) so the deterministic tail works across many sites, not just John Lewis. Vision loop stays the per-step fallback.
3. **Delivery cart-commit fix** — Uber Eats / Deliveroo get deep then stall on the pay button (named loop bug).
4. **Managed browser E2E** — `shouldUseRemoteForHost` routing is wired + unit-tested but **unverified against a live provider**. Once a Bright Data/Browserbase key exists, set `BROWSER_REMOTE_ENDPOINT` and run `node test/dev/reliability-benchmark.js next argos just-eat` (should flip `botwall`→`pass`).

### Cost (thousands of users, for reference)
~$0.03–0.05 per end-to-end task blended; ~$1–2/user/mo at 50 tasks. 85% of cost is residential proxy on the ⅓ of walled tasks — Tier-0 lookups + shrinking the walled fraction is the lever. Model (Gemini 3 Flash Preview) is ~1.5¢/task, negligible.

---

**Status after Tier-0:** Implemented + unit tests + live probe (John Lewis info goal returns `done` with price via 2x HTTP, no browser). Orders gated. Falls back cleanly. Full smoke 252 pass.

Want me to drop this into a file like `docs/PICKUP.md` so it's in the repo, or is the paste enough?

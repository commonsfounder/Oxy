# Browser-task reliability — session handoff (2026-06-30)

Continuation note so a fresh session can pick up `run_browser_task` work without re-deriving
context. All code changes below are **already in the working tree (uncommitted)** — a new
session in this repo sees them. This doc captures the parts that aren't in the diff.

## What triggered this
User screenshots: asking for "john lewis" returned a Tesco, and a "find me a pair" browser
task paused at "1 step in" then failed with "Browser Task Failed" suggesting Deliveroo/Just
Eat for a clothing search. Claim: the browser task **has never once succeeded**.

## Outcome
The real John Lewis "find joggers + price" task now **completes end-to-end in one ~30s turn**:
> "The adidas Essential Three Stripes Fleece Jogging Trousers are priced at £27.00."

## Root causes found & fixed (each verified against the real browser, not theorised)
All in `api/services/browser-task.js` unless noted:
1. **Place search lied** (`api/geocoding.js`): when a named place had no nearby match it
   returned the nearest *unrelated* place (John Lewis → Tesco). Fixed: return empty match →
   fail honestly. Regression test in `test/smoke/geocoding.test.js`.
2. **"find" labelled as "order"** + **food-only failure copy** (Deliveroo for joggers):
   made copy conditional on `session.isOrder`.
3. **Element-id hallucination**: model (flash-lite) returned `elementId 640` when only 0–59
   exist, looped 3× → STUCK. Fixed: validate id range + thread a `pendingCorrection` into the
   next prompt so it self-corrects. `buildDecisionPrompt`/`decideNextAction` take a `correction`.
4. **JSON parse failures**: switched loop to the primary reasoning model (`BROWSER_MODEL`,
   default `gemini-3-flash-preview`, env `OXY_BROWSER_MODEL`), which wraps JSON in prose/fences
   and is a *thinking* model. Fixed: hardened `parseModelDecision` (strip fences, extract first
   `{...}`) + raised `maxOutputTokens` 300→2048 so the JSON isn't truncated.
5. **Infinite `wait` soft-lock**: `wait` reset the bad-decision counter, so the model could wait
   forever. Added a consecutive-wait cap (nudge at 3, stuck at 6).
6. **Cookie/consent wall stayed up**: it's injected *late* and the old dismissal ran once at
   open and only scanned the first 40 buttons (John Lewis's "Allow all" is deeper in DOM).
   Rewrote `dismissConsent` to use role+name across all frames, and call it each step until
   gone. This was the silent killer — search ran *behind* the modal so results never showed.
7. **Timing**: `settle()` waited for `networkidle` which never fires on these SPAs → full
   timeout every step (5s open + 2.5s/step). Replaced with `domcontentloaded` + short fixed
   beat. Budget `MAX_DURATION_MS` 18s→30s, `MAX_STEPS` 15→20.
8. **One action error killed the whole turn**: per-action try/catch now records + nudges +
   re-perceives. Added a `fill` fallback (nested input / focus+keyboard) for when the model
   targets a search *wrapper* instead of the `<input>`.

Tests: `node --test test/smoke/*.test.js` → **173 pass**.

## How to reproduce / measure (needs `.env` with GEMINI_API_KEY + local Chromium)
- End-to-end (drives the real loop, simulates auto-continue):
  `node test/dev/browser-task-e2e.js "<goal>" "<url>" <maxTurns>`
  Env: `OXY_DEBUG_RAW=1` logs raw model JSON; `OXY_DEBUG_SCREENSHOT_DIR=<dir>` dumps per-step PNGs.
- Per-phase browser timing (no model tokens): `node test/dev/browser-timing.js <url> [url2 …]`
- Both must run from the repo root so `node_modules` resolves. They are dev-only, not in CI.

## Measured latency (laptop, cold browser)
30s total = ~4s browser open + 5 model-driven steps × ~5s. **~70% of each step is the Gemini
vision call**; browser ops are now small (settle ~0.6s, extract ~1s, screenshot ~0.06s).

## UPDATE 2026-07-01 — Tier 1 latency landed (~30s → ~9s on John Lewis)
Design: `docs/superpowers/specs/2026-07-01-browser-task-latency-design.md`. All three Tier-1
levers shipped in `api/services/browser-task.js` (+ `server.js` boot hook), each env-gated:
1. **Slim model input** — screenshot now JPEG q55 at a 1024×768 viewport (was full-res PNG);
   `MAX_ELEMENTS` 60→40; thinking budget capped via `OXY_BROWSER_THINKING_BUDGET` (default 256,
   `-1` disables). Knobs: `OXY_BROWSER_VIEWPORT_W/H`, `OXY_BROWSER_SCREENSHOT_QUALITY`, `OXY_BROWSER_MAX_ELEMENTS`.
2. **Warm browser pool** — singleton spare launched on server boot (`primeWarmBrowser()` in
   `server.js`) and after each claim, killing the ~4s cold open for real turns. Local-launch
   only; `OXY_BROWSER_WARM_POOL=false` to disable.
3. **Direct-search fast-path** — `SEARCH_SITES` registry + `deriveSearchTerm`/`directSearchUrl`
   jump straight to a results page on known sites (John Lewis seeded), skipping the
   type→submit steps. Conservative goal→term heuristic; falls back to a normal open if unsure.
Then profiled the warm-pool path (`OXY_BROWSER_TIMING=1` logs per-phase ms) and cut two more
chunks that were a third of a fast turn:
4. **Trimmed fixed settle beats** — open hydrate 1500→800, post-consent 400→250, per-step
   600→350 (`OXY_BROWSER_OPEN_HYDRATE_MS`/`OXY_BROWSER_OPEN_POST_CONSENT_MS`/`OXY_BROWSER_STEP_SETTLE_MS`).
   goto already waits for domcontentloaded, so the beat is just paint-insurance; the model's
   "wait" action is the net if a page isn't ready.
5. **Batched element extraction into one `page.evaluate`** — the old per-element loop did ~6
   CDP calls × 40 elements ≈ **798ms**; one evaluate makes it **~4ms**. `locatorIndex` contract
   (index into `querySelectorAll(CLICKABLE_SELECTOR)`) preserved, so clicks/fills unchanged.

Measured E2E (`browser-task-e2e.js`, John Lewis joggers), warm-pool prod path profiled:
**~30s baseline → 9.1s → 5.7s** (full turn). Phase split now: goto ~1.9s (network) + model
decide ~1.9s + settles ~1.4s + extract 4ms + screenshot 40ms. The two ~1.9s chunks (real page
download, model call) are the floor without a reliability tradeoff. Cold harness run also ~5.1s.
Fixed a latent bug: `test/dev/browser-task-e2e.js` had `require('./runtime')` paths broken by
its move into `test/dev/` — now `../../`.
Smoke: `node --test test/smoke/*.test.js` → **188 pass** (added `test/smoke/browser-latency.test.js`).
Next: the only remaining big controllable lever is the model call — A/B `OXY_BROWSER_THINKING_BUDGET`
lower (256→128/0), but that's the reliability-critical knob, so gate hard on E2E. Add more sites
to `SEARCH_SITES` (Argos is bot-walled → needs `BROWSER_REMOTE_ENDPOINT`, not a registry entry).

## UPDATE 2026-07-01 (b) — cross-site reliability
Validated more sites with `browser-task-e2e.js` and fixed general loop weaknesses:
- **Selfridges**: works; added fast-path (`/GB/en/cat/?freeText=…&srch=Y`) → ~4.5s, 1 step.
- **Uber Eats**: NOT bot-walled. Address → restaurant → in-store search → open item → item
  modal all work now. Two general fixes came out of it:
  - **Modal-scoped perception** (`extractClickableElements`): when a `[role=dialog]`/`[aria-modal]`
    larger than 15% of the viewport is open, only extract elements *inside* it. Previously badges
    were drawn over the menu behind the modal, mis-aligned, and the model re-clicked the tile
    behind the dialog forever. `locatorIndex` still = full-document order, so clicks are unchanged.
  - **Repeat-action guard**: a click on a *valid* element "succeeds" even when nothing changes,
    so the bad-decision guard never tripped on an infinite re-click. Now nudge after 3 identical
    actions, trip "stuck" after more.
  - **Model-call timeout + 1 retry** (`decideNextAction`): a transient Gemini "fetch failed" was
    hanging the SDK 60–130s and blowing the turn watchdog. Bounded to `OXY_BROWSER_MODEL_TIMEOUT_MS`
    (20s) with one retry, degrading to a recoverable "invalid" instead of killing the turn.
  - **STILL FLAKY on Uber Eats**: the *final cart-commit* doesn't always register (cart stays 0
    after "Add to order"/"Save") and the model can act on a half-loaded results page. Needs more
    diagnostic runs — likely a required-option gate or force-click not firing Uber's handler, plus
    a "wait until the store page actually has products" check. Argos remains bot-walled.

## UPDATE 2026-07-01 (c) — Tier 2 deterministic recipes landed (John Lewis tail)
Spec `docs/superpowers/specs/2026-07-01-browser-task-tier2-recipes-design.md`, plan
`docs/superpowers/plans/2026-07-01-browser-task-tier2-recipes.md`. New module
`api/services/browser-recipes.js`: a host-keyed recipe registry + a generic executor
`nextRecipeMove(page, session, recipe)` that serves the *mechanical* order tail from durable
selectors, skipping the vision call on those steps. `browser-task.js` calls it once per step
before the vision path; a `null` return falls through to today's all-vision loop. Kill-switch
`OXY_BROWSER_RECIPES=false`. Per-`(host,step)` in-memory health self-disables a chronically
missing step → graceful degrade to vision. The model still makes the judgment calls (which
product, which size when the goal didn't say); the recipe never guesses a size (asks instead).

**E2E (real browser, John Lewis adidas joggers PDP, size in goal):** the recipe drove
`size → add-to-basket → go-to-basket → checkout` as **4 deterministic steps, 0 vision calls**
(history steps 1–4 all `[recipe:…]`), in ~1s of clicking. The same tail with
`OXY_BROWSER_RECIPES=false` took the model **7 steps to reach "Continue to checkout"** (incl. a
hallucinated-elementId retry + 2 "wait" detours) at ~1.2–1.9s each ≈ ~10s of model latency. Both
then hit John Lewis's **guest-vs-sign-in checkout wall** — a genuine user-data fork (email/
address), out of recipe scope and *before* the pay guardrail, so neither reaches
`ready_for_payment` without account/guest details. Reaching a real pay button needs those.

Selectors were finalized against the live DOM (Task 6): John Lewis exposes stable `data-testid`s
— sizes `<a data-testid="size:option:button">` (href-based `?size=`), add `[data-testid="basket:add"]`,
header `[data-testid="basket-anchor"]`/`basket-amount`. Two design fixes came out of E2E: (1)
Playwright `:has-text()` candidates THROW under native `document.querySelector`, so the executor
now supports a `text=<exact>` candidate (exact, case-insensitive) instead; (2) `readCtx` detects
a chosen size via the `?size=` URL param and reads the basket count so `add` doesn't re-fire once
the item is in the basket. Smoke: `node --test test/smoke/*.test.js` → **221 pass**.
Next for Tier 2: the checkout *auth/delivery* steps (guest email, saved address) are the real
remaining latency, but they're user-data-specific — recipe-able only with stored profile data.
Add more sites to the registry as data (the executor is generic).

## NEXT (original) — latency roadmap
Equation: `latency ≈ browser_open + (n_steps × model_latency)`. Three levers:
- **Tier 1 → ~8–12s (no model change):** warm browser pool (kills ~4s cold open); slim the
  model input (downscale/JPEG/crop screenshot, fewer elements); cap thinking budget; add
  direct-search URL fast-paths (John Lewis `?search_term=`) to cut steps.
- **Tier 2 → ~2–5s (faster than human):** hybrid — hand-written deterministic recipes for the
  top ~20 sites (consent, address, search) run in ms; LLM only for the 1–2 real choices.
- **Floor:** ~1–2s per *genuine* decision while a vision LLM is in the loop. Beat humans by
  removing LLM calls from predictable parts, not by making each call instant.
Proposed first change set: warm-pool the browser + slim the screenshot/prompt + a John Lewis
direct-search fast-path, then re-measure with `test/dev/browser-task-e2e.js`.

## Open decisions for the user
- **Commit?** Nothing is committed yet. ~291 lines across `browser-task.js`, `geocoding.js`,
  and two smoke tests, plus `test/dev/` harnesses + this doc.
- **Cost:** the loop now uses the primary reasoning model (more $ than flash-lite). Revert via
  `OXY_BROWSER_MODEL=gemini-3.1-flash-lite` if not worth it.
- **Bot-walled delivery sites** (Just Eat returned a 2-element shell) are still blocked — needs
  a managed residential browser via `BROWSER_REMOTE_ENDPOINT` (Browserbase/Bright Data). Cloud
  Run's datacenter IP makes this worse. One-env-var flip once an account exists.
- Only John Lewis is proven E2E. Validate a Deliveroo order (with managed browser) + an Argos
  search before calling it broadly solid.

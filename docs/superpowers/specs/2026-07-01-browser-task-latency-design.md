# Browser-task latency — design (2026-07-01)

Continuation of `docs/BROWSER_TASK_SESSION_HANDOFF.md`. That work made `run_browser_task`
reliable (John Lewis completes E2E). This work makes it **fast**. Target: cut the ~30s turn.

## Equation
`latency ≈ browser_open + (n_steps × model_latency)`
Measured: ~4s cold browser open + ~5 steps × ~5s, where **~70% of each step is the Gemini
vision call**. So the leverage is: fewer/cheaper model calls, and kill the cold open.

All changes in `api/services/browser-task.js` unless noted. Every lever has an env kill-switch
so a regression can be reverted with no redeploy. Each lever is validated by re-running the E2E
harness on the proven John Lewis goal (`node test/dev/browser-task-e2e.js "<goal>" "<url>" <maxTurns>`)
before/after — comparing wall time + step count and confirming it still completes.

## Lever 1 — Slim the model input (biggest)
- **Screenshot → JPEG + downscale.** `captureMarkedScreenshot`: `type:'jpeg', quality≈55`;
  run the context at a smaller viewport (`1024×768`, env `OXY_BROWSER_VIEWPORT_W/H`). `inlineData`
  mime → `image/jpeg`. Smaller upload + fewer pixels = lower model latency; badges stay legible.
- **Fewer elements.** `MAX_ELEMENTS` 60 → 40 (env `OXY_BROWSER_MAX_ELEMENTS`). Cleaner image +
  shorter element list = fewer input tokens.
- **Cap thinking budget.** `OXY_BROWSER_THINKING_BUDGET` (default 256; `-1` disables the field
  entirely) spread into `decideNextAction`'s `generationConfig`, mirroring the existing
  `latencyThinkingConfig()` in `api/index.js`. **Regression-risk lever** — thinking is what
  recovers from hallucinated element ids — so default low-but-nonzero and tune via E2E.

## Lever 2 — Warm browser pool (kills ~4s cold open)
- Module-level **singleton spare** browser, launched ahead of demand. `getWarmBrowser()` returns
  the spare (after an `isConnected()` health check) and kicks off launching its replacement in the
  background; falls back to a synchronous launch when no healthy spare is ready.
- **Local launch only.** When `BROWSER_REMOTE_ENDPOINT` is set, connect per-task as today (CDP
  connect semantics differ). Kill-switch `OXY_BROWSER_WARM_POOL=false`.
- Cloud Run: the spare lives within an instance's lifetime; scale-to-zero still pays one cold
  start, which is acceptable.

## Lever 3 — Direct-search URL fast-paths (removes whole steps)
- Registry `hostname → searchUrl(term)`, seeded with John Lewis
  (`/search?search-term=…`).
- Derive the search term from the goal with a **conservative heuristic** (strip lead verbs
  find/buy/order/get/search-for, trailing fluff like "and tell me the price"). If extraction is
  empty/too short, **skip the fast-path and open normally** — worst case is today's behavior.
- When it applies, `openNewSession` navigates straight to the results URL, removing the
  find-box → fill → submit steps (~2–3 model calls saved).

## Verification
- E2E re-measure after each lever (above).
- Smoke tests for the pure pieces: term-extraction heuristic, registry lookup, warm-pool
  replacement logic. `node --test test/smoke/*.test.js` must stay green.

## Out of scope (later tiers)
Hybrid deterministic site recipes (Tier 2), managed residential browser for bot-walled delivery
sites (`BROWSER_REMOTE_ENDPOINT`). See the handoff doc's roadmap.

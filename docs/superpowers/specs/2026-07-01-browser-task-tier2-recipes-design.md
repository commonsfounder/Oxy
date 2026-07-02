# Browser-task Tier-2 — deterministic recipes (2026-07-01)

Continuation of `docs/superpowers/specs/2026-07-01-browser-task-latency-design.md` and
`docs/BROWSER_TASK_SESSION_HANDOFF.md`. Tier-1 made the loop reliable and cut the cold open +
per-step cost, and added direct-search fast-paths that skip the type→submit steps. Tier-2 attacks
the remaining floor: **the vision model is still called on every step of the order tail** (pick
size → add to basket → go to checkout), where the moves are mechanical and predictable. This work
serves those stable steps from **hand-written deterministic recipes** — selector-driven, run in
milliseconds — and keeps the vision model only for the 1–2 genuine choices (which product to open,
which size when the goal didn't say). Starting site: John Lewis, proven end-to-end.

## Equation (why this is the next lever)
`latency ≈ browser_open + (n_steps × model_latency)`. Tier-1 killed `browser_open` (warm pool) and
removed the search steps (fast-paths). The residual cost is `n_steps × model_latency` on the tail:
open-product → size → add-to-basket → basket → checkout is ~4 model calls × ~1.9s. Those steps have
**stable, durable selectors** — a vision call to find an "Add to basket" button is waste. Serve them
deterministically and only the real decisions pay the model tax.

## Division of labor (the seam)
The **model** makes judgment calls; the **recipe** does the mechanics.

| Step | Owner | Why |
| --- | --- | --- |
| Open a product from search results | **Model** | Which product matches the goal is a genuine choice. |
| Select size | **Recipe if known, else ask** | Size from goal → deterministic chip click. Not in goal → `ask` (never guess). |
| Add to basket | **Recipe** | One durable control; pure mechanics. |
| Go to basket / proceed to checkout | **Recipe** | Stable navigation; pure mechanics. |
| Pay | **Neither** — existing payment guardrail | Loop already stops at `ready_for_payment`; recipes inherit it. |

The recipe engages **only after a product page is open** (i.e. after the model's product click).
The first recipe move never fires on a search-results or category page.

## Architecture

### New module: `api/services/browser-recipes.js`
A pure module (no live-browser state of its own) holding two things:
1. **The recipe registry** — data, keyed by host (mirrors `SEARCH_SITES` in `browser-task.js`).
2. **The generic executor** — `nextRecipeMove(page, session, recipe)` and its helpers.

`browser-task.js` imports it and gains exactly one new branch in the step loop. No per-site control
flow leaks into the loop; new sites are new data.

### Recipe shape — declarative steps with a per-step escape hatch
A recipe is an ordered list of `steps`. Each step is gated by `phase` (which page it applies to) and
an optional `when(ctx)` predicate, and produces a move either **declaratively** (a prioritized
selector list + an action) or via a **`resolve()` escape hatch** (a pure function returning a move or
`null`) for a move that data can't express. One control flow, one representation — the escape hatch is
scoped to a single step, not a parallel per-site engine. (If a future site needs so many `resolve`
steps that it's really all code, *that* is the signal to introduce a full per-site module — not before.)

```js
// browser-recipes.js — registry excerpt (selectors are best-guess; confirmed against
// the live DOM during E2E — correcting them there is expected, not a gap).
const RECIPES = {
  'johnlewis.com': {
    // URL-pattern phase detection (see phaseOf below).
    phases: {
      product: (u) => /\/p\d|\/p\//i.test(u.pathname),
      basket:  (u) => /\/basket/i.test(u.pathname),
      checkout:(u) => /\/checkout/i.test(u.pathname),
    },
    steps: [
      { phase: 'product', name: 'size',
        when: (ctx) => ctx.hasUnsatisfiedSize,
        // Escape hatch: size chips vary (chips vs native <select>), and the value comes
        // from the goal, so this is a function not a static selector.
        resolve: (page, session, ctx) => resolveSizeMove(page, session, ctx) },

      { phase: 'product', name: 'add',
        // Durable attributes first, visible text last.
        selectorAny: [
          '[data-test*="add-to-basket" i]',
          'button[aria-label*="add to basket" i]',
          'button:has-text("Add to basket")',
          'button:has-text("Add to bag")',
        ],
        action: 'click' },

      { phase: 'product', name: 'go-to-basket',
        // After add-to-basket JL shows a mini-basket / "View basket" affordance.
        selectorAny: [
          '[data-test*="view-basket" i]',
          'a[href*="/basket" i]',
          'a:has-text("View basket")',
          'a:has-text("Basket")',
        ],
        action: 'click' },

      { phase: 'basket', name: 'checkout',
        selectorAny: [
          '[data-test*="checkout" i]',
          'a[href*="checkout" i]',
          'button:has-text("Checkout")',
          'a:has-text("Checkout")',
        ],
        action: 'click' },
    ],
  },
};
```

### Executor contract
`nextRecipeMove(page, session, recipe)` → a **move** or **`null`**.

A move is one of:
```js
{ action: 'click', locatorIndex, _recipe: { host, step } }
{ action: 'fill',  locatorIndex, value, _recipe: {...} }
{ action: 'ask',   question, _recipe: {...} }
```
The executor:
1. Computes the current `phase` via `phaseOf(page, recipe)` (URL-pattern first; a DOM probe backstop
   only if a site ever needs it — JL is pure URL).
2. Builds a lightweight `ctx` (e.g. `hasUnsatisfiedSize` — a size selector exists and none is
   selected) with cheap DOM probes.
3. Picks the **first** step whose `phase` matches and whose `when(ctx)` is true (or absent).
4. Runs the step:
   - `resolve(page, session, ctx)` if present → returns its move (may be `ask`) or `null`.
   - else resolves `selectorAny` in order to the **first visible, enabled** element and maps it to a
     `locatorIndex` **consistent with `extractClickableElements`' contract** (index into
     `querySelectorAll(CLICKABLE_SELECTOR)`), so the loop's existing click/fill path is byte-for-byte
     unchanged.
5. Returns `null` if no step applies or nothing resolves → **vision fallback for that step**.

The executor **never navigates or clicks** — it only *returns a move*. The loop executes it through
its existing action switch, inheriting scroll-into-view, force-click, the payment guardrail, history,
and `persistStorage`.

### Integration point in `browser-task.js`
In `runOrderingTurn`'s step loop, after `extractClickableElements` and the reauth/blocked-shell
checks, **before** `captureMarkedScreenshot` + `decideNextAction`:

```
const recipe = RECIPES[session.site];
let decision = null, viaRecipe = false;
if (RECIPES_ENABLED && recipe) {
  // Per-step self-disable lives INSIDE nextRecipeMove (a disabled step is skipped, so a
  // move only comes back for still-healthy steps). No session-level flag to keep in sync.
  const move = await nextRecipeMove(session.page, session, recipe); // cheap; no model call
  if (move) { decision = move; viaRecipe = true; }
}
if (!decision) {
  const screenshot = await captureMarkedScreenshot(...);   // today's vision path, unchanged
  decision = await decideNextAction(...);
}
```
When a recipe move is used we **skip the screenshot capture and the model call entirely** — that is
the latency win. The already-extracted `elements` array is reused for the `locatorIndex` → click/fill.
A recipe `click` whose target text matches `PAYMENT_KEYWORD_PATTERN` still routes to
`ready_for_payment` (guardrail is applied to the resolved element's text, same as a vision click).

## Size sourcing
`parseSizeFromGoal(goal, history)` — pure, unit-tested. Recognizes:
- `size 10`, `size M`, `size UK 9`
- standalone garment sizes `S | M | L | XL | XXL` (word-boundary, case-insensitive)
- `small | medium | large | extra large`
- `UK <n>` / `EU <n>` shoe sizes

Precedence in `resolveSizeMove`:
1. **Size selector present and unsatisfied** (`ctx.hasUnsatisfiedSize`) — otherwise the step is
   skipped (a product with no size, e.g. a kettle, goes straight to add-to-basket).
2. **Size parsed from goal/history** → click the chip whose label matches (normalized compare). If the
   parsed size isn't among the chips (out of stock / not offered) → return `null` (vision-or-ask
   fallback) rather than clicking the wrong one.
3. **No size in goal** → `{ action: 'ask', question: 'What size would you like?' }`. This uses the
   loop's existing `ask` path, which keeps the session alive so the user's reply resumes the same
   recipe mid-flight — the cart is not lost.

Out of scope (flagged, not built): consulting a stored user-profile default size before asking. Only
wired in if such a store already exists; otherwise "ask when unknown" is the whole rule (YAGNI).

## Self-heal + kill-switch
- **Kill-switch:** `OXY_BROWSER_RECIPES=false` disables the whole layer — a config flip, no redeploy.
  With it off, behavior is exactly today's (all-vision).
- **Per-step self-disable:** an in-memory miss counter keyed by `(host, step.name)`. A step whose
  selectors miss (resolve to nothing) repeatedly self-disables → permanent vision fallback for *that
  step*, so a John Lewis redesign degrades gracefully to today's behavior instead of stalling. Mirrors
  the fast-path `recordOutcome`/`FAIL_DISABLE_THRESHOLD` pattern. In-memory only — no DB, no migration
  (YAGNI until it needs to persist across restarts).
- A step that resolves fine but the *click* fails is handled by the loop's existing per-action
  try/catch (records, nudges, re-perceives) — recipes inherit it for free.

## Testing / verification

### Smoke (no browser) — added to `test/smoke/*.test.js`, must stay green
- `parseSizeFromGoal`: hits and misses across the recognized forms.
- Step selection: given a mock `ctx`/phase, `nextRecipeMove` picks the expected step and returns
  `null` when nothing matches.
- Selector-candidate ordering: durable-attribute candidate chosen before visible-text.
- Miss-counter self-disable: N misses on a step flips it to disabled.
- Payment guardrail on a recipe move: a resolved "checkout"→pay element routes to `ready_for_payment`.
- `phaseOf`: JL URLs → correct phase.

### E2E (real browser) — dev harness, not CI
Needs `.env` (`GEMINI_API_KEY`) + local Chromium. Run from repo root:
```
OXY_BROWSER_TIMING=1 node test/dev/browser-task-e2e.js \
  "add the adidas 3-stripe joggers in size M to my basket and check out" \
  "https://www.johnlewis.com" 8
```
Pass bar:
1. The loop reaches **`ready_for_payment`** (basket built, at checkout, pay button detected) — an
   actual charge is never placed; the guardrail stop is the success state.
2. The **size / add-to-basket / go-to-basket / checkout** steps are served by the recipe — **zero
   vision calls** on those (verify via timing logs / a per-step `viaRecipe` marker).
3. Record **step count + wall time** with recipes ON vs. `OXY_BROWSER_RECIPES=false`, to quantify the
   Tier-2 saving on the tail.
Selectors in the JL recipe are finalized here against the live DOM.

## Out of scope (later)
- Additional site recipes beyond John Lewis (the registry is built to take them as data).
- Recipe-driven *product selection* / *address entry* (product pick stays with the model per the seam;
  address entry is a delivery-site concern, not John Lewis).
- Persisting the miss-counter across restarts.
- Managed residential browser for bot-walled sites (`BROWSER_REMOTE_ENDPOINT`) — orthogonal lever.

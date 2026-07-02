# Browser-task Tier-2 Deterministic Recipes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the mechanical tail of a John Lewis order (select size → add to basket → go to basket → checkout) from hand-written deterministic selector recipes, skipping the vision-model call on those stable steps, so the order tail runs at human speed.

**Architecture:** A new pure module `api/services/browser-recipes.js` holds a host-keyed recipe registry (data) plus a generic executor. Most logic is split into pure functions (size parsing, chip matching, URL→phase, step selection, per-step health) that are unit-tested without a browser; a thin `nextRecipeMove(page, session, recipe)` wrapper does the DOM I/O and is verified by the real-browser E2E. `browser-task.js` gains exactly one new branch in its step loop: if a recipe returns a move, execute it through the existing action switch and skip the screenshot + model call; otherwise fall through to today's vision path unchanged.

**Tech Stack:** Node.js (CommonJS), Playwright (`playwright-extra` + stealth), `node:test` + `node:assert/strict` for smoke tests, Gemini via `runtime.createGeminiServiceClient` (unchanged, only bypassed).

## Global Constraints

- Every latency/behavior lever has an **env kill-switch**; a regression must be a config flip, not a redeploy. This layer's switch is `OXY_BROWSER_RECIPES` (default on; `=false` disables the whole layer → behavior is exactly today's all-vision loop).
- The recipe layer **never fails a turn**: any step that can't resolve returns `null` → the loop's existing vision path handles that step. Worst case is today's latency on that step.
- Recipes target **durable attributes first** (`data-test`/`data-testid`, `aria-label`, `role`+name); visible text is the **last** candidate, never the first.
- The recipe **never navigates or clicks** — it only returns a move; `browser-task.js` executes it through its existing click/fill path (inheriting scroll-into-view, force-click, the `PAYMENT_KEYWORD_PATTERN` guardrail, history, and `persistStorage`).
- The recipe **never guesses a size**: size comes from the goal/history, else the loop's existing `ask` action.
- `locatorIndex` is the index into `document.querySelectorAll(CLICKABLE_SELECTOR)` (matches `extractClickableElements` and Playwright's `.nth()` order). Any move that targets an element MUST carry a `locatorIndex` computed against that exact selector, so the loop's click/fill path is byte-for-byte unchanged. `CLICKABLE_SELECTOR` is the constant already defined in `browser-task.js:353`.
- Smoke tests must stay green: `node --test test/smoke/*.test.js`.
- The E2E success bar: on a real John Lewis product goal, the loop reaches `ready_for_payment`, the size/add/basket/checkout steps are served by the recipe (zero vision calls on those), and wall-time on the tail drops vs. `OXY_BROWSER_RECIPES=false`.

---

### Task 1: Size parsing and chip matching (pure)

**Files:**
- Create: `api/services/browser-recipes.js`
- Test: `test/smoke/browser-recipes.test.js`

**Interfaces:**
- Produces:
  - `parseSizeFromGoal(text: string): string | null` — the normalized size token found in the goal/history text, or `null`. Normalized = lowercased, single-spaced (e.g. `"M"`→`"m"`, `"UK 9"`→`"uk 9"`, `"Medium"`→`"medium"`).
  - `matchSizeChip(parsedSize: string, chipLabels: string[]): number | null` — index into `chipLabels` of the chip that matches `parsedSize`, or `null` if none.

- [ ] **Step 1: Write the failing test**

Create `test/smoke/browser-recipes.test.js`:

```javascript
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSizeFromGoal, matchSizeChip } = require('../../api/services/browser-recipes');

test('parseSizeFromGoal pulls an explicit "size X"', () => {
  assert.equal(parseSizeFromGoal('add the joggers in size M to my basket'), 'm');
  assert.equal(parseSizeFromGoal('order size 10 please'), '10');
  assert.equal(parseSizeFromGoal('buy the trainers size UK 9'), 'uk 9');
});

test('parseSizeFromGoal recognises standalone garment sizes and words', () => {
  assert.equal(parseSizeFromGoal('the medium fleece'), 'medium');
  assert.equal(parseSizeFromGoal('get me a large one'), 'large');
  assert.equal(parseSizeFromGoal('joggers, XL'), 'xl');
});

test('parseSizeFromGoal returns null when no size is present', () => {
  assert.equal(parseSizeFromGoal('add the adidas joggers to my basket'), null);
  assert.equal(parseSizeFromGoal('what is the price of the kettle'), null);
  assert.equal(parseSizeFromGoal(''), null);
  // "small" as part of another word must not false-match
  assert.equal(parseSizeFromGoal('a smallish bag'), null);
});

test('matchSizeChip matches normalized labels, exact before contains', () => {
  assert.equal(matchSizeChip('m', ['XS', 'S', 'M', 'L']), 2);
  assert.equal(matchSizeChip('uk 9', ['UK 8', 'UK 9', 'UK 10']), 1);
  assert.equal(matchSizeChip('medium', ['Small', 'Medium', 'Large']), 1);
  assert.equal(matchSizeChip('10', ['Size 8', 'Size 10', 'Size 12']), 1); // contains fallback
});

test('matchSizeChip returns null when no chip matches', () => {
  assert.equal(matchSizeChip('xxl', ['S', 'M', 'L']), null);
  assert.equal(matchSizeChip('m', []), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-recipes.test.js`
Expected: FAIL — `Cannot find module '../../api/services/browser-recipes'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `api/services/browser-recipes.js`:

```javascript
'use strict';
// Tier-2 deterministic recipes. See docs/superpowers/specs/2026-07-01-browser-task-tier2-recipes-design.md
// Pure helpers first (unit-tested); the DOM-touching executor lives lower down.

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Pull a size the user has already specified out of the goal/history text. Conservative:
// only recognised shapes, word-boundary anchored so "small" doesn't match "smallish".
// Returns a normalized token, or null when the user didn't say a size (→ the loop asks).
function parseSizeFromGoal(text) {
  const t = norm(text);
  if (!t) return null;
  // "size 10", "size m", "size uk 9"
  let m = t.match(/\bsize\s+((?:uk|eu)\s+)?([a-z0-9]{1,4})\b/);
  if (m) return norm(`${m[1] || ''}${m[2]}`);
  // "uk 9" / "eu 42" shoe sizes without the word "size"
  m = t.match(/\b(uk|eu)\s+(\d{1,2})\b/);
  if (m) return `${m[1]} ${m[2]}`;
  // spelled-out garment words
  m = t.match(/\b(extra small|extra large|small|medium|large)\b/);
  if (m) return m[1];
  // standalone letter sizes: xs s m l xl xxl (must be a lone token, not inside a word)
  m = t.match(/\b(xxl|xl|xs|s|m|l)\b/);
  if (m) return m[1];
  return null;
}

// Given the size the user asked for and the labels of the size chips on the page, return
// the index of the chip to click, or null. Exact (normalized) match wins; a contains match
// (e.g. "10" inside "Size 10") is the fallback.
function matchSizeChip(parsedSize, chipLabels) {
  const want = norm(parsedSize);
  if (!want) return null;
  const labels = (chipLabels || []).map(norm);
  const exact = labels.indexOf(want);
  if (exact !== -1) return exact;
  const contains = labels.findIndex((l) => l.split(/\s+/).includes(want) || l === `size ${want}`);
  return contains === -1 ? null : contains;
}

module.exports = { parseSizeFromGoal, matchSizeChip };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/browser-recipes.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-recipes.js test/smoke/browser-recipes.test.js
git commit -m "feat(browser-recipes): size parsing + chip matching (pure)"
```

---

### Task 2: Recipe registry + URL→phase (pure)

**Files:**
- Modify: `api/services/browser-recipes.js`
- Test: `test/smoke/browser-recipes.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `RECIPES: Record<string, Recipe>` — host-keyed registry. A `Recipe` has `phases: Record<phaseName, (url: URL) => boolean>`, `size: { container: string[], chip: string[], selected: string[] }`, and `steps: Step[]`. A `Step` has `{ phase: string, name: string, when?: (ctx) => boolean, selectorAny?: string[], action?: 'click'|'fill', resolve?: (args) => move|null }`.
  - `phaseFromUrl(recipe: Recipe, url: string): string | null` — the name of the first matching phase, or `null`.

- [ ] **Step 1: Write the failing test**

Append to `test/smoke/browser-recipes.test.js`:

```javascript
const { RECIPES, phaseFromUrl } = require('../../api/services/browser-recipes');

test('John Lewis recipe is registered with the expected phases and steps', () => {
  const jl = RECIPES['johnlewis.com'];
  assert.ok(jl, 'johnlewis.com recipe exists');
  assert.deepEqual(jl.steps.map((s) => s.name), ['size', 'add', 'go-to-basket', 'checkout']);
  // durable attribute candidate comes before the visible-text candidate
  const add = jl.steps.find((s) => s.name === 'add');
  const dataTestIdx = add.selectorAny.findIndex((s) => /data-test/i.test(s));
  const textIdx = add.selectorAny.findIndex((s) => /has-text/i.test(s));
  assert.ok(dataTestIdx !== -1 && textIdx !== -1 && dataTestIdx < textIdx, 'durable selector before text');
});

test('phaseFromUrl classifies John Lewis product / basket / checkout urls', () => {
  const jl = RECIPES['johnlewis.com'];
  assert.equal(phaseFromUrl(jl, 'https://www.johnlewis.com/adidas-joggers/p6543210'), 'product');
  assert.equal(phaseFromUrl(jl, 'https://www.johnlewis.com/basket'), 'basket');
  assert.equal(phaseFromUrl(jl, 'https://www.johnlewis.com/checkout/delivery'), 'checkout');
  assert.equal(phaseFromUrl(jl, 'https://www.johnlewis.com/search?search-term=joggers'), null);
  assert.equal(phaseFromUrl(jl, 'not a url'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-recipes.test.js`
Expected: FAIL — `RECIPES` and `phaseFromUrl` are `undefined` (not exported yet).

- [ ] **Step 3: Write minimal implementation**

In `api/services/browser-recipes.js`, add above `module.exports`. Selectors are best-guess and get confirmed against the live DOM in Task 6 (E2E); the recipe *shape* is what's under test here.

```javascript
// Host-keyed registry. Selectors prefer durable attributes; visible text is last.
// NOTE: John Lewis product-page URLs end in `/pNNNNNN`; basket is `/basket`; checkout `/checkout`.
const RECIPES = {
  'johnlewis.com': {
    phases: {
      product:  (u) => /\/p\d+(?:\b|\/|$)/i.test(u.pathname),
      basket:   (u) => /\/basket(?:\b|\/|$)/i.test(u.pathname),
      checkout: (u) => /\/checkout(?:\b|\/|$)/i.test(u.pathname),
    },
    // Site-specific probes the generic size step uses (confirmed at E2E).
    size: {
      container: ['[data-test*="size" i]', '[class*="size" i] [role="listbox"]', 'select[name*="size" i]'],
      chip:      ['[data-test*="size" i] button', '[role="radio"]', 'select[name*="size" i] option'],
      selected:  ['[aria-checked="true"]', '[aria-selected="true"]', 'option:checked'],
    },
    steps: [
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: null /* set in Task 4 */ },
      { phase: 'product', name: 'add', action: 'click', selectorAny: [
        '[data-test*="add-to-basket" i]',
        'button[aria-label*="add to basket" i]',
        'button:has-text("Add to basket")',
        'button:has-text("Add to bag")',
      ] },
      { phase: 'product', name: 'go-to-basket', action: 'click', selectorAny: [
        '[data-test*="view-basket" i]',
        'a[href*="/basket" i]',
        'a:has-text("View basket")',
        'a:has-text("Basket")',
      ] },
      { phase: 'basket', name: 'checkout', action: 'click', selectorAny: [
        '[data-test*="checkout" i]',
        'a[href*="checkout" i]',
        'button:has-text("Checkout")',
        'a:has-text("Checkout")',
      ] },
    ],
  },
};

// First phase whose predicate matches the url, or null. Never throws on a bad url.
function phaseFromUrl(recipe, url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  for (const [name, pred] of Object.entries(recipe.phases)) {
    if (pred(u)) return name;
  }
  return null;
}
```

Extend `module.exports` to include `RECIPES` and `phaseFromUrl`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/browser-recipes.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-recipes.js test/smoke/browser-recipes.test.js
git commit -m "feat(browser-recipes): John Lewis registry + url→phase"
```

---

### Task 3: Step selection + per-step health (pure)

**Files:**
- Modify: `api/services/browser-recipes.js`
- Test: `test/smoke/browser-recipes.test.js`

**Interfaces:**
- Consumes: `RECIPES`, `phaseFromUrl` (Task 2).
- Produces:
  - `createRecipeHealth(threshold?: number)` → `{ isDisabled(host, step): boolean, recordMiss(host, step): void, recordHit(host, step): void }`. In-memory per-`(host, step)` miss counter; a step disables after `threshold` consecutive misses (default 3), and a hit resets its streak.
  - `selectStep(recipe: Recipe, phase: string, ctx: object, health, host: string): Step | null` — the first step whose `phase` matches, whose `when(ctx)` is true (or absent), and which is not health-disabled; else `null`.

- [ ] **Step 1: Write the failing test**

Append to `test/smoke/browser-recipes.test.js`:

```javascript
const { createRecipeHealth, selectStep } = require('../../api/services/browser-recipes');

test('selectStep picks the first matching, enabled step for the phase', () => {
  const jl = RECIPES['johnlewis.com'];
  const health = createRecipeHealth();
  // On product page, size still needed → the size step.
  assert.equal(selectStep(jl, 'product', { hasUnsatisfiedSize: true }, health, 'johnlewis.com').name, 'size');
  // Size satisfied → skip to add.
  assert.equal(selectStep(jl, 'product', { hasUnsatisfiedSize: false }, health, 'johnlewis.com').name, 'add');
  // Basket phase → checkout.
  assert.equal(selectStep(jl, 'basket', {}, health, 'johnlewis.com').name, 'checkout');
  // No step for a phase the recipe doesn't cover.
  assert.equal(selectStep(jl, 'search', {}, health, 'johnlewis.com'), null);
});

test('selectStep skips a step that health has disabled', () => {
  const jl = RECIPES['johnlewis.com'];
  const health = createRecipeHealth(2);
  health.recordMiss('johnlewis.com', 'add');
  health.recordMiss('johnlewis.com', 'add'); // disabled at threshold 2
  // size not needed, add disabled → fall to go-to-basket
  assert.equal(selectStep(jl, 'product', { hasUnsatisfiedSize: false }, health, 'johnlewis.com').name, 'go-to-basket');
});

test('recipe health disables after N misses and a hit resets the streak', () => {
  const health = createRecipeHealth(3);
  health.recordMiss('h', 's'); health.recordMiss('h', 's');
  assert.equal(health.isDisabled('h', 's'), false);
  health.recordMiss('h', 's');
  assert.equal(health.isDisabled('h', 's'), true);
  health.recordHit('h', 's'); // one success re-enables
  assert.equal(health.isDisabled('h', 's'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-recipes.test.js`
Expected: FAIL — `createRecipeHealth`/`selectStep` undefined.

- [ ] **Step 3: Write minimal implementation**

Add to `api/services/browser-recipes.js`:

```javascript
const RECIPE_FAIL_DISABLE_THRESHOLD = 3;

// In-memory per-(host,step) health. A step whose selectors keep missing self-disables so a
// site redesign degrades to the vision loop instead of stalling. Not persisted (YAGNI).
function createRecipeHealth(threshold = RECIPE_FAIL_DISABLE_THRESHOLD) {
  const misses = new Map(); // `${host}:${step}` -> consecutive miss count
  const key = (host, step) => `${host}:${step}`;
  return {
    isDisabled: (host, step) => (misses.get(key(host, step)) || 0) >= threshold,
    recordMiss: (host, step) => { const k = key(host, step); misses.set(k, (misses.get(k) || 0) + 1); },
    recordHit:  (host, step) => { misses.set(key(host, step), 0); },
  };
}

// First step for this phase whose gate (when) passes and which isn't health-disabled.
function selectStep(recipe, phase, ctx, health, host) {
  for (const step of recipe.steps) {
    if (step.phase !== phase) continue;
    if (step.when && !step.when(ctx)) continue;
    if (health && health.isDisabled(host, step.name)) continue;
    return step;
  }
  return null;
}
```

Extend `module.exports` with `createRecipeHealth`, `selectStep`, `RECIPE_FAIL_DISABLE_THRESHOLD`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/browser-recipes.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-recipes.js test/smoke/browser-recipes.test.js
git commit -m "feat(browser-recipes): step selection + per-step health"
```

---

### Task 4: DOM executor `nextRecipeMove` (I/O wrapper)

**Files:**
- Modify: `api/services/browser-recipes.js`
- Test: `test/smoke/browser-recipes.test.js` (fake-page unit tests for the pure branches)

**Interfaces:**
- Consumes: `RECIPES`, `phaseFromUrl`, `selectStep`, `createRecipeHealth`, `parseSizeFromGoal`, `matchSizeChip`.
- Produces:
  - `nextRecipeMove(page, session, recipe, health): Promise<Move | null>` where `Move` is one of
    `{ action:'click', locatorIndex, text, stepName }`, `{ action:'fill', locatorIndex, value, text, stepName }`,
    `{ action:'ask', question, stepName }`. Returns `null` when no step applies or nothing resolves.
    A click/fill move carries `text` (the resolved element's label) so the loop can apply the
    payment guardrail and write history without re-reading the DOM — recipe moves use `locatorIndex`
    directly and never carry an `elementId`.
  - A module-level default `recipeHealth` instance (so `browser-task.js` doesn't manage it).
- Contract details:
  - `page` must expose `url(): string` and `evaluate(fn, arg): Promise<any>` (Playwright Page; a stub in tests).
  - The size step's `resolve` is wired here (the `resolve: null` placeholder in the registry is replaced by attaching a shared `resolveSizeMove`).
  - On a resolved `click`/`fill`, `recordHit` the step; when `selectStep` returned a step but nothing resolved, `recordMiss` it and return `null`.

- [ ] **Step 1: Write the failing test**

Append to `test/smoke/browser-recipes.test.js`. These use a fake `page` so no browser is needed — they cover the phase→step→resolve wiring and the miss path; the *real* selector resolution is verified by the E2E in Task 6.

```javascript
const { nextRecipeMove, resolveSizeMove } = require('../../api/services/browser-recipes');

// A fake page: url() returns the given url; evaluate(fn, arg) runs fn against a scripted
// "DOM answer" table keyed by a tag we pass in arg.probe, so tests stay declarative.
function fakePage(url, answers = {}) {
  return {
    url: () => url,
    evaluate: async (_fn, arg) => (arg && arg.probe in answers ? answers[arg.probe] : null),
  };
}

test('nextRecipeMove returns null off any recipe phase (e.g. search page)', async () => {
  const jl = RECIPES['johnlewis.com'];
  const move = await nextRecipeMove(
    fakePage('https://www.johnlewis.com/search?search-term=joggers'),
    { goal: 'joggers size m', history: [] }, jl, createRecipeHealth());
  assert.equal(move, null);
});

test('nextRecipeMove asks for a size when the goal has none and a size is needed', async () => {
  const jl = RECIPES['johnlewis.com'];
  const page = fakePage('https://www.johnlewis.com/x/p6543210', {
    ctx: { hasUnsatisfiedSize: true },
    sizeChips: [], // no chips fetched because we ask before matching
  });
  const move = await nextRecipeMove(page, { goal: 'add the joggers to my basket', history: [] }, jl, createRecipeHealth());
  assert.equal(move.action, 'ask');
  assert.match(move.question, /size/i);
});

test('nextRecipeMove returns a click for add-to-basket once size is satisfied', async () => {
  const jl = RECIPES['johnlewis.com'];
  const page = fakePage('https://www.johnlewis.com/x/p6543210', {
    ctx: { hasUnsatisfiedSize: false },
    'resolve:add': { locatorIndex: 17, text: 'Add to basket' }, // scripted resolution
  });
  const move = await nextRecipeMove(page, { goal: 'add the joggers to my basket', history: [] }, jl, createRecipeHealth());
  assert.deepEqual(move, { action: 'click', locatorIndex: 17, text: 'Add to basket', stepName: 'add' });
});

test('nextRecipeMove records a miss and returns null when the step resolves to nothing', async () => {
  const jl = RECIPES['johnlewis.com'];
  const health = createRecipeHealth(1);
  const page = fakePage('https://www.johnlewis.com/x/p6543210', { ctx: { hasUnsatisfiedSize: false }, 'resolve:add': null });
  const move = await nextRecipeMove(page, { goal: 'add joggers', history: [] }, jl, health);
  assert.equal(move, null);
  assert.equal(health.isDisabled('johnlewis.com', 'add'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-recipes.test.js`
Expected: FAIL — `nextRecipeMove`/`resolveSizeMove` undefined.

- [ ] **Step 3: Write minimal implementation**

First, wire the size step's escape hatch in the registry: change the John Lewis `size` step's `resolve: null /* set in Task 4 */` (added in Task 2) to reference the resolver defined below. `resolveSizeMove` is hoisted (function declaration), so the forward reference inside the arrow is safe:

```javascript
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
```

Then add to `api/services/browser-recipes.js`. The DOM reads are funnelled through small `page.evaluate` calls tagged by `arg.probe` so the fake page in tests can script them; in production these run the real selector queries.

```javascript
// --- DOM probes (real in prod; scripted by the fake page in unit tests) -------------------
// Build the ctx the step gates read. Only `hasUnsatisfiedSize` for now: a size container is
// present AND nothing in it is selected yet.
async function readCtx(page, recipe) {
  const ctx = await page.evaluate(({ probe, size }) => {
    void probe;
    const hasAny = (sels) => sels.some((s) => { try { return !!document.querySelector(s); } catch { return false; } });
    const container = hasAny(size.container);
    const selected = hasAny(size.selected);
    return { hasUnsatisfiedSize: container && !selected };
  }, { probe: 'ctx', size: recipe.size });
  return ctx || { hasUnsatisfiedSize: false };
}

// Resolve a step's selectorAny to a { locatorIndex, text }, choosing the first candidate that
// maps to a VISIBLE, ENABLED element (locatorIndex = index into querySelectorAll(CLICKABLE_SELECTOR)).
// null if none match. `text` lets the loop apply the payment guardrail + write history without a
// re-read. CLICKABLE_SELECTOR must match browser-task.js's constant — passed in so there's one source.
async function resolveSelectorIndex(page, selectorAny, clickableSelector, tag) {
  return page.evaluate(({ probe, selectorAny, clickableSelector }) => {
    void probe;
    const all = Array.from(document.querySelectorAll(clickableSelector));
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const sel of selectorAny) {
      let match;
      try { match = document.querySelector(sel); } catch { continue; }
      if (!match || !visible(match)) continue;
      const node = match.closest(clickableSelector) || match;
      const idx = all.indexOf(node);
      if (idx !== -1) {
        const text = (node.innerText || node.getAttribute('aria-label') || node.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        return { locatorIndex: idx, text };
      }
    }
    return null;
  }, { probe: tag, selectorAny, clickableSelector });
}

// The size step's resolve — the per-step escape hatch from the design. Size is a genuine
// choice, so we NEVER guess: if the goal names a size, click the matching chip; if it doesn't,
// ask. Reads chip labels from the page and maps the chosen one to a locatorIndex. Takes the
// single args bag the executor hands every resolve fn: { page, session, recipe, ctx, clickable }.
async function resolveSizeMove({ page, session, recipe, clickable }) {
  const want = parseSizeFromGoal(`${session.goal || ''} ${(session.history || []).join(' ')}`);
  if (!want) return { action: 'ask', question: 'What size would you like?', stepName: 'size' };
  const chips = await page.evaluate(({ probe, chipSel, clickableSelector }) => {
    void probe;
    const all = Array.from(document.querySelectorAll(clickableSelector));
    const out = [];
    for (const sel of chipSel) {
      for (const el of document.querySelectorAll(sel)) {
        const label = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim();
        const idx = all.indexOf(el.closest(clickableSelector) || el);
        if (label && idx !== -1) out.push({ label, idx });
      }
      if (out.length) break; // first selector that yields chips wins
    }
    return out;
  }, { probe: 'sizeChips', chipSel: recipe.size.chip, clickableSelector: clickable });
  const pick = matchSizeChip(want, chips.map((c) => c.label));
  if (pick == null) return null; // asked-for size not offered → vision/ask fallback
  return { action: 'click', locatorIndex: chips[pick].idx, text: chips[pick].label, stepName: 'size' };
}

// CLICKABLE_SELECTOR is owned by browser-task.js; keep one copy here that MUST equal it.
// (Task 5 asserts they're identical so a future edit to one can't silently diverge.)
const CLICKABLE_SELECTOR = 'button, a, input, textarea, [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="combobox"]';

const recipeHealth = createRecipeHealth();

// The executor. Returns a move for the loop to execute, or null → vision fallback.
async function nextRecipeMove(page, session, recipe, health = recipeHealth) {
  const host = hostOfRecipe(recipe);
  const phase = phaseFromUrl(recipe, page.url());
  if (!phase) return null;
  const ctx = await readCtx(page, recipe);
  const step = selectStep(recipe, phase, ctx, health, host);
  if (!step) return null;

  if (step.resolve) {
    // Escape hatch: the step supplies its own move (may be an "ask", which is a real move,
    // not a miss). Only a null return — the step couldn't resolve — counts as a miss.
    const move = await step.resolve({ page, session, recipe, ctx, clickable: CLICKABLE_SELECTOR });
    if (move) { health.recordHit(host, step.name); return move; }
  } else if (step.selectorAny) {
    const hit = await resolveSelectorIndex(page, step.selectorAny, CLICKABLE_SELECTOR, `resolve:${step.name}`);
    if (hit) { health.recordHit(host, step.name); return { action: step.action, locatorIndex: hit.locatorIndex, text: hit.text, stepName: step.name }; }
  }
  health.recordMiss(host, step.name);
  return null;
}

// Find the host key a recipe is registered under (so callers can pass the recipe object alone).
function hostOfRecipe(recipe) {
  for (const [host, r] of Object.entries(RECIPES)) if (r === recipe) return host;
  return 'unknown';
}
```

Extend `module.exports` with `nextRecipeMove`, `resolveSizeMove`, `recipeHealth`, `CLICKABLE_SELECTOR`.

> Note on the fake page: `readCtx`/`resolveSelectorIndex`/`resolveSizeMove` each call `page.evaluate(fn, arg)`. The test's `fakePage` ignores `fn` and returns `answers[arg.probe]`, so `arg.probe` values (`'ctx'`, `'resolve:add'`, `'sizeChips'`) are the seams the scripted answers key on. Keep those tags stable.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/browser-recipes.test.js`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-recipes.js test/smoke/browser-recipes.test.js
git commit -m "feat(browser-recipes): nextRecipeMove executor + size resolve"
```

---

### Task 5: Wire the recipe layer into the step loop

**Files:**
- Modify: `api/services/browser-task.js` (import near line 4; new branch in `runOrderingTurn`'s step loop, between the blocked-shell check ~line 830 and `captureMarkedScreenshot` ~line 832)
- Test: `test/smoke/browser-recipes.test.js` (guard test that the two `CLICKABLE_SELECTOR` copies match)

**Interfaces:**
- Consumes: `nextRecipeMove`, `RECIPES`, `recipeHealth`, `CLICKABLE_SELECTOR` (Task 4).
- Produces: recipe-driven moves executed through the loop's existing click/fill/ask/ready_for_payment handling; a history marker `Step N: [recipe:<name>] …` so the E2E can count recipe vs. vision steps.

- [ ] **Step 1: Write the failing test (drift guard)**

Append to `test/smoke/browser-recipes.test.js`:

```javascript
test('recipe CLICKABLE_SELECTOR equals the one browser-task uses', () => {
  const recipes = require('../../api/services/browser-recipes');
  // browser-task.js keeps CLICKABLE_SELECTOR private; it re-exports it for this guard in Task 5.
  const bt = require('../../api/services/browser-task');
  assert.equal(recipes.CLICKABLE_SELECTOR, bt.CLICKABLE_SELECTOR,
    'the two clickable-selector copies must stay identical');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-recipes.test.js`
Expected: FAIL — `bt.CLICKABLE_SELECTOR` is `undefined` (not exported yet).

- [ ] **Step 3: Write minimal implementation**

In `api/services/browser-task.js`:

1. Add the import after line 4 (`const { learnTemplateFromUrl, createFastpathStore } = ...`):

```javascript
const { nextRecipeMove, RECIPES, recipeHealth } = require('./browser-recipes');
// Whole-layer kill-switch: OXY_BROWSER_RECIPES=false → the loop is exactly today's all-vision path.
const RECIPES_ENABLED = process.env.OXY_BROWSER_RECIPES !== 'false';
```

2. Export `CLICKABLE_SELECTOR` (add to the `module.exports` object at the end):

```javascript
  CLICKABLE_SELECTOR,
```

3. In `runOrderingTurn`, immediately BEFORE the line `const screenshot = await timed('step.screenshot', ...)` (~line 832), insert the recipe branch. It reuses the already-extracted `elements` for the click/fill (no re-perceive) and skips the screenshot + model entirely on a hit:

```javascript
      // Tier-2 deterministic recipe: on stable steps (size → add → basket → checkout) a
      // hand-written selector move replaces the vision call. Cheap; falls through to the
      // model whenever it can't confidently resolve (returns null). See browser-recipes.js.
      let decision, recipeStepName = null;
      const recipe = RECIPES_ENABLED ? RECIPES[session.site] : null;
      const recipeMove = recipe ? await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null) : null;
      if (recipeMove) {
        decision = recipeMove;
        recipeStepName = recipeMove.stepName;
      } else {
        const screenshot = await timed('step.screenshot', () => captureMarkedScreenshot(session.page, elements).catch(() => null));
        if (screenshot && process.env.OXY_DEBUG_SCREENSHOT_DIR) {
          require('fs').writeFile(`${process.env.OXY_DEBUG_SCREENSHOT_DIR}/step-${steps}.jpg`, Buffer.from(screenshot, 'base64'), () => {});
        }
        decision = await timed('step.decide', () => decideNextAction(session.goal, session.history, elements, screenshot, pendingCorrection));
        pendingCorrection = '';
      }
```

   Then DELETE the now-duplicated original three lines that this replaces — the existing:
   `const screenshot = await timed('step.screenshot', ...)`, the `if (screenshot && OXY_DEBUG_SCREENSHOT_DIR)` block, and `const decision = await timed('step.decide', ...)` plus its `pendingCorrection = '';` — so the block above is the single source. (The original `const decision` becomes the `let decision` declared above.)

4. Make the click/fill target resolution accept a recipe `locatorIndex`. Recipe moves carry no `elementId` (they resolve against the full DOM), so the existing `elements.find(el => el.id === decision.elementId)` block must be skipped for them. Replace the target-resolution block (~lines 917-926, from `const lastId = elements.length ? ...` through the `if (!target) { ... continue; }` block) with:

```javascript
      // A recipe move already carries a full-DOM locatorIndex + the element's text, so it
      // bypasses the elementId→element lookup the vision path uses. A vision move still maps
      // its badge elementId (0..lastId) to the extracted element; a miss there is a hallucination.
      let target;
      if (recipeStepName) {
        target = { id: -1, text: decision.text || '', locatorIndex: decision.locatorIndex };
      } else {
        const lastId = elements.length ? elements.length - 1 : 0;
        const idIsValid = Number.isInteger(decision.elementId) && decision.elementId >= 0 && decision.elementId <= lastId;
        target = idIsValid ? elements.find(el => el.id === decision.elementId) : null;
        if (!target) {
          consecutiveBadDecisions += 1;
          pendingCorrection = `Your last reply used elementId ${decision.elementId}, which is NOT on this page. Valid element ids are 0 to ${lastId}. Look at the numbered badges in the screenshot and choose one of those — do not use any other number.`;
          session.history.push(`Step ${steps}: model chose elementId ${decision.elementId}, which is not on the page (valid 0-${lastId}); asked it to pick a real one`);
          if (consecutiveBadDecisions >= 3) return STUCK;
          continue;
        }
      }
```

   The `matchesPaymentKeyword(target.text)` guardrail immediately below this block is unchanged and now also covers recipe clicks (a recipe move that lands on a pay-labelled control still pauses for confirmation).

5. Tag recipe steps in history so the E2E can distinguish them. In the `click` branch (after `session.history.push(\`Step ${steps}: clicked "${target.text}"\`)`, ~line 945) and the `fill` branch (~line 965), prefix with the recipe marker when set. Replace those two `push` calls with:

```javascript
          session.history.push(`Step ${steps}: ${recipeStepName ? `[recipe:${recipeStepName}] ` : ''}clicked "${target.text}"`);
```
```javascript
          session.history.push(`Step ${steps}: ${recipeStepName ? `[recipe:${recipeStepName}] ` : ''}filled "${target.text}" with "${value}"`);
```

   (`recipeStepName` is in scope — declared at the top of the loop body per step 3.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/smoke/*.test.js`
Expected: PASS — all suites green, including the new drift guard (the two selectors are identical strings).

Also sanity-check the module loads and the loop wiring parses:
Run: `node -e "require('./api/services/browser-task'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-task.js test/smoke/browser-recipes.test.js
git commit -m "feat(browser-task): run Tier-2 recipes before the vision path"
```

---

### Task 6: Real-browser E2E verification + finalize John Lewis selectors

**Files:**
- Modify: `api/services/browser-recipes.js` (correct the John Lewis `phases`/`size`/`selectorAny` against the live DOM as needed)
- Modify: `docs/BROWSER_TASK_SESSION_HANDOFF.md` (append a Tier-2 result note)

**Interfaces:**
- Consumes: everything above. No new exports.

This task has no unit test — it is the real-browser verification the whole plan exists to satisfy. Requires `.env` with `GEMINI_API_KEY` and local Chromium, run from repo root.

- [ ] **Step 1: Baseline run with recipes OFF (measure today's tail)**

Run:
```bash
OXY_BROWSER_RECIPES=false OXY_BROWSER_TIMING=1 node test/dev/browser-task-e2e.js \
  "add the adidas 3-stripe joggers in size M to my basket and check out" \
  "https://www.johnlewis.com" 8
```
Record: total turns, total steps (final `history (N steps)`), wall time per turn, and the outcome type. This is the control.

- [ ] **Step 2: Run with recipes ON**

Run:
```bash
OXY_BROWSER_TIMING=1 node test/dev/browser-task-e2e.js \
  "add the adidas 3-stripe joggers in size M to my basket and check out" \
  "https://www.johnlewis.com" 8
```

- [ ] **Step 3: Inspect and finalize selectors**

Expected: outcome reaches `ready_for_payment` ("✅ REACHED PAYMENT"). In the printed history, the size/add/go-to-basket/checkout steps show the `[recipe:<name>]` marker (served deterministically, no model call).

If a recipe step is NOT taken (it fell through to a vision click, or the run stalls), the selector is wrong for the live DOM. Diagnose with a headed run and the screenshot dump:
```bash
BROWSER_HEADLESS=false OXY_DEBUG_SCREENSHOT_DIR=/private/tmp/claude-501/-Users-chizigamonyewuchi-Documents-Oxy/42e9af99-5244-4ac5-a3ba-71e4b14cb438/scratchpad \
OXY_BROWSER_TIMING=1 node test/dev/browser-task-e2e.js \
  "add the adidas 3-stripe joggers in size M to my basket and check out" \
  "https://www.johnlewis.com" 8
```
Watch which page the recipe misses on, read the real element's attributes (headed devtools or the dumped screenshot), and correct the corresponding `selectorAny`/`size`/`phases` entry in `browser-recipes.js`. Re-run Step 2 until every tail step carries the `[recipe:...]` marker and the outcome is `ready_for_payment`. Do NOT weaken the payment guardrail or let the recipe click a pay button — reaching the guardrail IS success.

- [ ] **Step 4: Confirm the fallback still works (kill-switch + no-size-in-goal)**

Run (no size in the goal → the recipe must `ask`, not guess):
```bash
node test/dev/browser-task-e2e.js \
  "add the adidas 3-stripe joggers to my basket" \
  "https://www.johnlewis.com" 8
```
Expected: the harness stops at `⏸️ ASKED USER: "What size would you like?"` (proves the never-guess rule). Then re-run the Step 2 command once more to confirm the full green path is stable (not a fluke).

- [ ] **Step 5: Record the result and commit**

Append a dated "Tier-2 result" section to `docs/BROWSER_TASK_SESSION_HANDOFF.md` with: the two measurements (recipes off vs on — turns, steps, wall time), which JL selectors were corrected from the plan's guesses, and any follow-ups. Then:
```bash
git add api/services/browser-recipes.js docs/BROWSER_TASK_SESSION_HANDOFF.md
git commit -m "feat(browser-recipes): finalize John Lewis selectors, verified E2E"
```

- [ ] **Step 6: Full smoke sweep**

Run: `node --test test/smoke/*.test.js`
Expected: all suites PASS (the ~188 existing + the new `browser-recipes.test.js` cases). Report the count.

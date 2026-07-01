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
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
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

module.exports = { parseSizeFromGoal, matchSizeChip, RECIPES, phaseFromUrl, createRecipeHealth, selectStep, RECIPE_FAIL_DISABLE_THRESHOLD, nextRecipeMove, resolveSizeMove, recipeHealth, CLICKABLE_SELECTOR };

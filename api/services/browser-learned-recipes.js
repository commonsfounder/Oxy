'use strict';
// Self-learning checkout recipes, where browser-recipes.js's per-site steps are hand-authored
// and browser-fastpaths.js only learns the search URL.
//
// Narrow on purpose: only the "add to basket" click, the step CONVENTION most often guesses
// wrong on an unknown host. A click followed by the basket count actually incrementing is proof
// of what works there, remembered as the same text=<...> selector idiom the authored recipes use.
//
// No self-heal of its own: a learned selector is injected into a CONVENTION-shaped recipe and
// flows through the existing recipeHealth pipeline, which disables it back to vision if the site
// changes.

const { CONVENTION } = require('./browser-recipes');

const ADD_TEXT_PATTERN = /^add to (basket|bag|cart|trolley)\b/i;
// A learned selector must be specific enough to trust unattended. Overly generic captured
// text ("Add", "Buy") would just relearn CONVENTION's own guesses with false confidence.
const MIN_TEXT_LENGTH = 8;
const MAX_TEXT_LENGTH = 60;

// Playwright's text= engine takes the raw string, no CSS-escaping needed — but a literal "
// inside the text would break the selector string itself if naively embedded, so this only
// learns text with no quote characters (site copy essentially never has one here anyway).
function synthesizeAddSelector(clickedText) {
  const text = String(clickedText || '').trim();
  if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) return null;
  if (text.includes('"')) return null;
  if (!ADD_TEXT_PATTERN.test(text)) return null;
  return `text=${text}`;
}

// Builds the CONVENTION-shaped recipe a host gets once a selector is learned: identical to
// CONVENTION except the 'add' step tries the learned selector first, before CONVENTION's own
// generic guesses (so a proven-working selector always wins over a blind guess, but the
// generic fallback is still there if the learned one ever stops matching and gets disabled).
function buildLearnedRecipe(selector) {
  return {
    ...CONVENTION,
    steps: CONVENTION.steps.map((step) => {
      if (step.name !== 'add' || !step.selectorAny) return step;
      return { ...step, selectorAny: [selector, ...step.selectorAny] };
    }),
  };
}

function createLearnedRecipeStore({ loadRows, saveRow } = {}) {
  const map = new Map(); // host -> { selector, learnedAt }

  async function load() {
    if (!loadRows) return;
    try {
      const rows = await loadRows();
      for (const r of rows || []) {
        if (r.host && r.selector) map.set(r.host, { selector: r.selector, learnedAt: r.learned_at || null });
      }
    } catch { /* boot-time load is best-effort; the loop works without it */ }
  }

  function persist(host) {
    if (!saveRow) return;
    const e = map.get(host);
    if (!e) return;
    Promise.resolve(saveRow({ host, selector: e.selector, learned_at: e.learnedAt })).catch(() => {});
  }

  // Never overrides an already-learned selector for the same host — the first thing proven
  // to work stays authoritative; recipeHealth (not this store) is what decides when a
  // selector has gone stale and should fall back to vision.
  function learn(host, clickedText) {
    if (map.has(host)) return false;
    const selector = synthesizeAddSelector(clickedText);
    if (!selector) return false;
    map.set(host, { selector, learnedAt: new Date().toISOString() });
    persist(host);
    return true;
  }

  function getLearnedRecipe(host) {
    const e = map.get(host);
    if (!e) return null;
    return buildLearnedRecipe(e.selector);
  }

  function forget(host) {
    map.delete(host);
  }

  return { load, learn, getLearnedRecipe, forget, _map: map };
}

module.exports = { synthesizeAddSelector, buildLearnedRecipe, createLearnedRecipeStore, ADD_TEXT_PATTERN };

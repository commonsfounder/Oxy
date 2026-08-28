'use strict';
// Everything known about acting on a particular host, behind one question. The hand-written
// tables, the learned search URLs and selectors, the curated recipes and the platform detection
// all still live where they are; this is the one place to ask and the one place to record how it
// went, which is what makes site knowledge data the runtime consults rather than architecture it
// is built from. Nothing here executes anything — it returns facts.

const retailers = require('./retailer-sites');
const recipes = require('./browser-recipes');
const { createFastpathStore, learnTemplateFromUrl } = require('./browser-fastpaths');
const { createLearnedRecipeStore, ADD_TEXT_PATTERN } = require('./browser-learned-recipes');
const platformCommerce = require('./browser-platform-commerce');
const wooCommerce = require('./browser-platform-woocommerce');

/** Platform tiers, most specific first. A host matches at most one. */
const PLATFORM_TIERS = [
  { id: 'shopify', detect: platformCommerce.detectShopify, add: platformCommerce.resolveAndAddToCart },
  { id: 'woocommerce', detect: wooCommerce.detectWooCommerce, add: wooCommerce.resolveAndAddToCart },
];

function hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

/**
 * One store over whatever persistence the caller provides. Both learned stores share a lifecycle
 * — load at boot, record outcomes as they happen — so they are primed and queried together.
 */
function createSiteKnowledge({ fastpaths, learnedRecipes } = {}) {
  const fastpathStore = fastpaths || createFastpathStore({});
  const learnedStore = learnedRecipes || createLearnedRecipeStore({});

  async function prime() {
    await Promise.all([
      Promise.resolve(fastpathStore.load?.()).catch(() => {}),
      Promise.resolve(learnedStore.load?.()).catch(() => {}),
    ]);
  }

  /**
   * What is known about a host. Every field is optional — an unknown host returns a record
   * with nulls, which is a normal, fully-workable case: the agent then uses its primitives.
   *
   * @param {string} hostOrUrl
   * @param {{ term?: string }} [opts] a search term, when asking for an entry point
   */
  function forHost(hostOrUrl, { term = '' } = {}) {
    const host = hostOrUrl?.includes('://') ? hostFromUrl(hostOrUrl) : String(hostOrUrl || '').replace(/^www\./, '');
    if (!host) return emptyRecord(null);

    const entry = retailers.RETAILERS?.[host] || null;
    const authoredSearch = term && entry?.searchUrl ? entry.searchUrl(term) : null;
    const learnedSearch = term ? fastpathStore.getLearnedSearchUrl(host, term) : null;
    // selectRecipeForHost always returns SOMETHING (a host recipe, the delivery recipe, or
    // the generic convention). Report which, so "known" means genuine host-specific
    // knowledge rather than "the generic fallback exists", which is true of every host.
    const authoredSteps = recipes.RECIPES?.[host] || null;
    const steps = recipes.selectRecipeForHost ? recipes.selectRecipeForHost(host) : null;
    const stepsSource = authoredSteps ? 'authored'
      : (retailers.isDeliveryHost?.(host) ? 'delivery-convention' : 'generic-convention');
    const learnedRecipe = learnedStore.getLearnedRecipe ? learnedStore.getLearnedRecipe(host) : null;

    return {
      host,
      known: Boolean(entry || authoredSteps || learnedSearch || learnedRecipe),
      entryPoints: {
        home: entry?.homeUrl || null,
        // Authored beats learned: a hand-written search URL is verified, a learned one is
        // inferred and self-heals when it stops working.
        search: authoredSearch || learnedSearch || null,
        searchSource: authoredSearch ? 'authored' : (learnedSearch ? 'learned' : null),
      },
      steps,
      stepsSource,
      // A learned "add" step is the same shape as an authored one, so a caller consumes
      // either without knowing which it got.
      learnedSteps: learnedRecipe,
      selectors: { addSource: learnedRecipe ? 'learned' : null },
      kind: entry?.kind || null,
      region: entry?.region || null,
      isDelivery: retailers.isDeliveryHost ? retailers.isDeliveryHost(host) : false,
    };
  }

  /**
   * The curated steps for a host as plain-language hints for the reasoning layer to act on with
   * its ordinary primitives: told what usually works here, still deciding for itself.
   */
  function hintsFor(hostOrUrl) {
    const record = forHost(hostOrUrl);
    // Only genuine host-specific knowledge. The generic fallback recipe is commerce-shaped,
    // and offering "Add to basket" as a hint on a council portal is worse than saying nothing.
    if (record.stepsSource !== 'authored') return [];
    const steps = record.steps?.steps || [];
    if (!steps.length) return [];
    const label = (step) => {
      const texts = (step.selectorAny || [])
        .filter(sel => sel.startsWith('text='))
        .map(sel => `"${sel.slice(5)}"`);
      if (!texts.length) return null;
      return `${step.name.replace(/-/g, ' ')}: usually a control labelled ${texts.slice(0, 4).join(' or ')}`;
    };
    return steps.map(label).filter(Boolean).slice(0, 8);
  }

  function emptyRecord(host) {
    return {
      host,
      known: false,
      entryPoints: { home: null, search: null, searchSource: null },
      steps: null,
      stepsSource: null,
      learnedSteps: null,
      selectors: { addSource: null },
      kind: null, region: null, isDelivery: false,
    };
  }

  /**
   * Does this host expose a real JSON API for search + cart? Detected at runtime, cached by
   * the underlying tier modules. Returns the tier id and its add function, or null.
   */
  async function platformTier(origin) {
    for (const tier of PLATFORM_TIERS) {
      try {
        const detected = await tier.detect(origin);
        if (detected) return { id: tier.id, detected, add: tier.add };
      } catch { /* a tier that cannot answer is simply not this one */ }
    }
    return null;
  }

  /**
   * Record how acting on a host actually went. One entry point for both learned stores, so a
   * caller never has to know which mechanism is learning what.
   */
  function record(host, outcome = {}) {
    if (!host) return;
    if (outcome.searchUrl && outcome.searchTerm) {
      const learned = learnTemplateFromUrl(outcome.searchUrl, outcome.searchTerm);
      if (learned) fastpathStore.learn(host, learned.param, learned.template);
    }
    if (typeof outcome.searchWorked === 'boolean') fastpathStore.recordOutcome(host, outcome.searchWorked);
    if (outcome.addClickText && ADD_TEXT_PATTERN.test(outcome.addClickText)) {
      learnedStore.learn?.(host, outcome.addClickText);
    }
  }

  return { prime, forHost, hintsFor, platformTier, record, _fastpathStore: fastpathStore, _learnedStore: learnedStore };
}

module.exports = {
  createSiteKnowledge,
  hostFromUrl,
  PLATFORM_TIERS,
  // Re-exported so callers have one import for site knowledge rather than five.
  resolveRetailerFromGoal: retailers.resolveRetailerFromGoal,
  resolveRailTicketProvider: retailers.resolveRailTicketProvider,
  resolveSearchSite: retailers.resolveSearchSite,
  isDeliveryHost: retailers.isDeliveryHost,
  allRetailerAliases: retailers.allRetailerAliases,
  RETAILERS: retailers.RETAILERS,
  RECIPES: recipes.RECIPES,
};

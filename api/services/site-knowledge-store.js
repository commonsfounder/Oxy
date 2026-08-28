'use strict';
// The process-wide site-knowledge store, wired to its persistence.
//
// Separate from site-knowledge.js so that module stays a pure library (constructible with
// fakes in tests) while this one owns the single live instance and its database wiring.

const { createSiteKnowledge } = require('./site-knowledge');
const { createFastpathStore } = require('./browser-fastpaths');
const { createLearnedRecipeStore } = require('./browser-learned-recipes');
const { getSupabase } = require('./browser-session');

// Both learned stores are best-effort: a database hiccup must never block a browser step.
const fastpaths = createFastpathStore({
  loadRows: async () => {
    const { data } = await getSupabase()
      .from('browser_fastpaths').select('host,url_template,param,fail_count');
    return data || [];
  },
  saveRow: async (row) => {
    await getSupabase().from('browser_fastpaths').upsert(row, { onConflict: 'host' });
  },
});

const learnedRecipes = createLearnedRecipeStore({
  loadRows: async () => {
    const { data } = await getSupabase()
      .from('browser_learned_recipes').select('host,selector,learned_at');
    return data || [];
  },
  saveRow: async (row) => {
    await getSupabase().from('browser_learned_recipes').upsert(row, { onConflict: 'host' });
  },
});

module.exports = createSiteKnowledge({ fastpaths, learnedRecipes });

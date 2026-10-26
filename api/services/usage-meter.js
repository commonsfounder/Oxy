'use strict';

// Counts what every model call used and what it should have cost, per turn and since the server
// started. Prices are per million tokens and are the list prices at the time of writing; override
// with OXY_MODEL_PRICES='{"model":{"in":0.1,"cached":0.01,"out":0.5}}'. A model with no price is
// counted in tokens but left out of the dollar figure (and flagged), never guessed.

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

// Standard-tier list prices in USD per million tokens, from the vendors' own pricing pages
// (OpenAI, Anthropic, Google) as read on 2026-10-25. Claude Haiku 5.5 is $0.50/$2.50 above 100k
// prompt tokens and Gemini 4 Argon doubles on 2026-12-01; neither is modelled here.
const DEFAULT_PRICES = {
  'gpt-6-luna': { in: 0.10, cached: 0.01, out: 0.50 },
  'gpt-6-sol': { in: 2.00, cached: 0.20, out: 10.00 },
  'gpt-6.1-sol': { in: 2.00, cached: 0.10, out: 10.00 },
  'gpt-6-astra': { in: 10.00, cached: 1.00, out: 50.00 },
  'claude-haiku-5-5': { in: 0.10, cached: 0.01, out: 0.50 },
  'claude-sonnet-5-5': { in: 2.00, cached: 0.10, out: 10.00 },
  'claude-opus-5-5': { in: 4.00, cached: 0.20, out: 20.00 },
  'claude-fable-5-1': { in: 10.00, cached: 0.25, out: 50.00 },
  'gemini-4-argon': { in: 2.00, cached: 0.10, out: 10.00 },
  'gemini-3.8-flash': { in: 0.75, cached: 0.075, out: 3.75 },
};
// Web search is billed per call on top of tokens: $10 per 1,000 on OpenAI and on Anthropic.
const WEB_SEARCH_USD = 0.01;

function prices(env = process.env) {
  let extra = {};
  try { extra = JSON.parse(env.OXY_MODEL_PRICES || '{}'); } catch { extra = {}; }
  return { ...DEFAULT_PRICES, ...extra };
}

function emptyTotals() {
  return { calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearches: 0, estimatedUsd: 0, unpricedCalls: 0, byModel: {} };
}

function normaliseUsage(raw = {}) {
  let input = Number(raw.input_tokens ?? raw.prompt_tokens ?? 0) || 0;
  // Anthropic reports cache reads and writes outside input_tokens.
  if ('cache_read_input_tokens' in raw || 'cache_creation_input_tokens' in raw) {
    input += (Number(raw.cache_read_input_tokens) || 0) + (Number(raw.cache_creation_input_tokens) || 0);
  }
  const output = Number(raw.output_tokens ?? raw.completion_tokens ?? 0) || 0;
  const cached = Number(raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? 0) || 0;
  const reasoning = Number(raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
  return { input, output, cached, reasoning };
}

function costOf(model, { input, output, cached }, table = prices()) {
  const price = table[model];
  if (!price) return null;
  const fresh = Math.max(0, input - cached);
  return (fresh * price.in + cached * (price.cached ?? price.in * 0.1) + output * price.out) / 1e6;
}

function add(totals, model, usage, webSearches, table) {
  const cost = costOf(model, usage, table);
  totals.calls += 1;
  totals.inputTokens += usage.input;
  totals.cachedTokens += usage.cached;
  totals.outputTokens += usage.output;
  totals.reasoningTokens += usage.reasoning;
  totals.webSearches += webSearches;
  if (cost === null) totals.unpricedCalls += 1; else totals.estimatedUsd += cost;
  totals.estimatedUsd += webSearches * WEB_SEARCH_USD;
  const entry = totals.byModel[model] || { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  entry.calls += 1; entry.inputTokens += usage.input; entry.outputTokens += usage.output; entry.reasoningTokens += usage.reasoning;
  totals.byModel[model] = entry;
}

const lifetime = emptyTotals();
const startedAt = new Date().toISOString();

// Called from every model call with the provider's raw usage object.
function record(model, rawUsage, { webSearches = 0 } = {}) {
  const usage = normaliseUsage(rawUsage);
  if (!usage.input && !usage.output && !webSearches) return;
  const table = prices();
  add(lifetime, model || 'unknown', usage, webSearches, table);
  const turn = als.getStore();
  if (turn) add(turn, model || 'unknown', usage, webSearches, table);
  if (process.env.OXY_USAGE_LOG !== 'off') {
    const cost = costOf(model, usage, table);
    console.log(`[usage] ${model} in=${usage.input} cached=${usage.cached} out=${usage.output} reasoning=${usage.reasoning}${webSearches ? ` web=${webSearches}` : ''} ~$${cost === null ? 'unpriced' : cost.toFixed(5)}`);
  }
}

// A cost that is not a model call (a search service's own fee), added to the dollar total.
function recordCost(label, usd) {
  const amount = Number(usd) || 0;
  lifetime.estimatedUsd += amount;
  lifetime.externalUsd = (lifetime.externalUsd || 0) + amount;
  const turn = als.getStore();
  if (turn) { turn.estimatedUsd += amount; turn.externalUsd = (turn.externalUsd || 0) + amount; }
  if (process.env.OXY_USAGE_LOG !== 'off') console.log(`[usage] ${label} ~$${amount.toFixed(5)}`);
}

// Runs `fn` with a fresh per-turn meter; everything recorded inside lands in it.
function runWithMeter(fn) {
  const turn = emptyTotals();
  return als.run(turn, () => fn(turn));
}

function summarise(totals) {
  return {
    calls: totals.calls,
    inputTokens: totals.inputTokens,
    cachedTokens: totals.cachedTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    webSearches: totals.webSearches,
    estimatedUsd: Number(totals.estimatedUsd.toFixed(5)),
    unpricedCalls: totals.unpricedCalls,
    models: Object.keys(totals.byModel),
  };
}

function lifetimeReport() {
  return { since: startedAt, ...summarise(lifetime), byModel: lifetime.byModel };
}

module.exports = { record, recordCost, runWithMeter, summarise, lifetimeReport, normaliseUsage, costOf, prices, DEFAULT_PRICES };

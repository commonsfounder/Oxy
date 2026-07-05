'use strict';
// Milgrain lookup latency benchmark — runs info/price goals through runOrderingTurn,
// logs per-case latency and tier-0 vs browser path.
//
//   node test/dev/milgrain-benchmark.js
//   node test/dev/milgrain-benchmark.js grocery fashion   # filter by category tag
//   OXY_MILGRAIN_LIMIT=5 node test/dev/milgrain-benchmark.js
//   OXY_MILGRAIN_JSON=1 node test/dev/milgrain-benchmark.js
const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const runtime = require('../../runtime');
const chainable = new Proxy(function () {}, {
  get: (_t, prop) => {
    if (prop === 'then') return undefined;
    if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: null });
    if (prop === 'upsert' || prop === 'insert' || prop === 'update') return async () => ({ data: null, error: null });
    return () => chainable;
  },
  apply: () => chainable
});
runtime.createSupabaseServiceClient = () => chainable;

const { runOrderingTurn, getSession, closeSession } = require('../../api/services/browser-task');
const { classifyOutcome } = require('./reliability-classify');
const FIXTURES = require('./milgrain-benchmark-fixtures');

const MAX_TURNS = Number(process.env.OXY_MILGRAIN_TURNS || 1);
const LIMIT = Number(process.env.OXY_MILGRAIN_LIMIT || 0);
const filters = process.argv.slice(2).map((s) => s.toLowerCase());

function selected(c) {
  if (!filters.length) return true;
  return filters.some((f) => c.category === f || (c.tags || []).includes(f) || c.site.includes(f));
}

let cases = FIXTURES.filter(selected);
if (LIMIT > 0) cases = cases.slice(0, LIMIT);

const stamp = () => new Date().toISOString().slice(11, 19);

async function runCase(c) {
  const user = `milgrain-${c.id}`;
  const t0 = Date.now();
  let outcome;
  try {
    outcome = await runOrderingTurn(user, { url: c.url, goal: c.goal, onProgress: () => {} });
  } catch (e) {
    outcome = { type: 'threw', error: e.message.split('\n')[0] };
  }
  const sess = getSession(user);
  const usedTier0 = !sess && outcome?.type === 'done';
  const usedBrowser = !!sess || (outcome?.type === 'done' && sess);
  await closeSession(user).catch(() => {});
  const ms = Date.now() - t0;
  const bucket = classifyOutcome(c.expect, outcome);
  const snippet = String(outcome?.text || outcome?.error || outcome?.question || outcome?.summary || outcome?.type || '')
    .replace(/\s+/g, ' ').slice(0, 72);
  return { ...c, outcome, ms, bucket, usedTier0, snippet };
}

function pct(n, d) { return d ? `${Math.round((100 * n) / d)}%` : 'n/a'; }

(async () => {
  console.log(`\nMILGRAIN LOOKUP BENCHMARK — ${cases.length} case(s), ${MAX_TURNS} turn(s) each\n`);
  const results = [];

  for (const c of cases) {
    process.stdout.write(`  [${stamp()}] #${String(c.id).padStart(2)} ${c.site.padEnd(20)} … `);
    const r = await runCase(c);
    results.push(r);
    const mark = r.bucket === 'pass' ? '✅' : '❌';
    const path = r.usedTier0 ? 'tier0' : 'browser';
    console.log(`${mark} ${(r.ms + 'ms').padStart(7)} ${path.padEnd(7)} ${r.snippet}`);
  }

  const passes = results.filter((r) => r.bucket === 'pass');
  const tier0 = results.filter((r) => r.usedTier0);
  const browser = results.filter((r) => !r.usedTier0 && r.bucket === 'pass');
  const ms = results.map((r) => r.ms);
  const median = ms.length ? ms.slice().sort((a, b) => a - b)[Math.floor(ms.length / 2)] : 0;
  const tier0Ms = tier0.map((r) => r.ms);
  const tier0Med = tier0Ms.length ? tier0Ms.slice().sort((a, b) => a - b)[Math.floor(tier0Ms.length / 2)] : 0;

  console.log('\n' + '─'.repeat(72));
  console.log(`PASS: ${passes.length}/${results.length} (${pct(passes.length, results.length)})`);
  console.log(`Tier-0: ${tier0.length} cases, median ${tier0Med}ms`);
  console.log(`Browser wins: ${browser.length} cases`);
  console.log(`Overall median latency: ${median}ms`);

  const byCat = {};
  for (const r of results) {
    byCat[r.category] = byCat[r.category] || { n: 0, pass: 0, ms: [] };
    byCat[r.category].n += 1;
    if (r.bucket === 'pass') byCat[r.category].pass += 1;
    byCat[r.category].ms.push(r.ms);
  }
  console.log('\nBy category:');
  for (const [cat, v] of Object.entries(byCat)) {
    const med = v.ms.slice().sort((a, b) => a - b)[Math.floor(v.ms.length / 2)];
    console.log(`  ${cat.padEnd(12)} ${v.pass}/${v.n} pass, median ${med}ms`);
  }

  const outPath = path.join(__dirname, `milgrain-benchmark-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results.map((r) => ({
    id: r.id, category: r.category, site: r.site, goal: r.goal,
    ms: r.ms, bucket: r.bucket, tier0: r.usedTier0, snippet: r.snippet,
  })), null, 2));
  console.log(`\nWrote ${outPath}`);

  if (process.env.OXY_MILGRAIN_JSON === '1') {
    console.log('\nJSON:\n' + JSON.stringify(results, null, 2));
  }

  console.log('\n--- milgrain benchmark done ---');
  process.exit(0);
})();
'use strict';
// Latency benchmark for price/info lookup tasks across 46 UK retail sites.
// Drives the REAL runOrderingTurn loop (real Gemini + real stealth Chromium).
// All cases are `expect: 'answer'` — pure lookups, no ordering, no user data.
//
// Usage (from repo root, needs .env with GEMINI_API_KEY + local Chromium):
//   node test/dev/price-lookup-benchmark.js              # all 46 cases
//   node test/dev/price-lookup-benchmark.js fashion      # cases tagged 'fashion'
//   node test/dev/price-lookup-benchmark.js johnlewis    # substring match on site name
//   OXY_BENCH_TURNS=6   cap auto-continue turns per case (default 6)
//   OXY_BENCH_JSON=1    dump raw JSON at end
//   OXY_BENCH_START=20  start at case index N (for resuming a run)
//   OXY_BENCH_END=40    stop at case index N (exclusive)
const fs = require('fs');

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
  apply: () => chainable,
});
runtime.createSupabaseServiceClient = () => chainable;

const { runOrderingTurn, getSession, closeSession } = require('../../api/services/browser-task');
const { classifyOutcome, INFRA_BUCKETS } = require('./reliability-classify');

const MAX_TURNS = Number(process.env.OXY_BENCH_TURNS || 6);
const START_IDX = Number(process.env.OXY_BENCH_START || 0);
const END_IDX   = Number(process.env.OXY_BENCH_END   || Infinity);
const filters   = process.argv.slice(2).map(s => s.toLowerCase());

// ── fixture list ──────────────────────────────────────────────────────────────
// Every task is a pure price/info lookup; no add-to-basket, no user data needed.
// `site` is used for display + filtering; `url` is the homepage the browser opens.
const FIXTURES = [
  // E-commerce & Shopping
  { n: 1,  cat: 'e-commerce', site: 'johnlewis.com',      url: 'https://www.johnlewis.com',      goal: 'find "Sony WH-CH720N headphones" and tell me the current price' },
  { n: 2,  cat: 'e-commerce', site: 'currys.co.uk',       url: 'https://www.currys.co.uk',       goal: 'search for the latest iPad Air and tell me the price and availability' },
  { n: 3,  cat: 'e-commerce', site: 'amazon.co.uk',       url: 'https://www.amazon.co.uk',       goal: 'look up the Dyson V15 cordless vacuum and tell me the price and how many customer reviews it has' },
  { n: 4,  cat: 'e-commerce', site: 'argos.co.uk',        url: 'https://www.argos.co.uk',        goal: 'find the Nintendo Switch OLED and tell me the price and stock status' },
  { n: 5,  cat: 'e-commerce', site: 'selfridges.com',     url: 'https://www.selfridges.com',     goal: 'search for Yves Saint Laurent Libre perfume and tell me the price' },
  { n: 6,  cat: 'e-commerce', site: 'harveynichols.com',  url: 'https://www.harveynichols.com',  goal: 'find Balenciaga sneakers and tell me the price' },
  { n: 7,  cat: 'e-commerce', site: 'boots.com',          url: 'https://www.boots.com',          goal: 'look up Olay Regenerist serum and tell me the price and customer star rating' },
  { n: 8,  cat: 'e-commerce', site: 'spacenk.com',        url: 'https://www.spacenk.com',        goal: 'search for MAC Fix+ setting spray and tell me the price' },

  // Tech & Gadgets
  { n: 9,  cat: 'tech',       site: 'apple.com',          url: 'https://www.apple.com/uk',       goal: 'find the iPhone 15 Pro Max starting price in the UK store' },
  { n: 10, cat: 'tech',       site: 'samsung.com',        url: 'https://www.samsung.com/uk',     goal: 'look up the Galaxy S24 Ultra specs and price' },
  { n: 11, cat: 'tech',       site: 'scan.co.uk',         url: 'https://www.scan.co.uk',         goal: 'search for RTX 4090 graphics card and tell me if any are in stock and the cheapest price' },
  { n: 12, cat: 'tech',       site: 'box.co.uk',          url: 'https://www.box.co.uk',          goal: 'find the DJI Mini 4 Pro drone price' },
  { n: 13, cat: 'tech',       site: 'overclockers.co.uk', url: 'https://www.overclockers.co.uk', goal: 'look up the Intel Core i9-14900KS price' },
  { n: 14, cat: 'tech',       site: 'cclcomputers.com',   url: 'https://www.cclcomputers.com',   goal: 'search for the Dell XPS 15 laptop and tell me the price' },

  // Fashion & Clothing
  { n: 15, cat: 'fashion',    site: 'asos.com',           url: 'https://www.asos.com',           goal: 'find Nike Air Force 1 white trainers in size 8 and tell me the price' },
  { n: 16, cat: 'fashion',    site: 'zara.com',           url: 'https://www.zara.com/uk',        goal: 'look up a linen shirt and tell me the price' },
  { n: 17, cat: 'fashion',    site: 'hm.com',             url: 'https://www2.hm.com/en_gb',      goal: 'search for an oversized blazer and tell me what colours are available and the price' },
  { n: 18, cat: 'fashion',    site: 'uniqlo.com',         url: 'https://www.uniqlo.com/uk',      goal: 'find heattech thermal leggings and tell me the price' },
  { n: 19, cat: 'fashion',    site: 'topshop.com',        url: 'https://www.topshop.com',        goal: 'look up mom jeans and tell me the price' },

  // Home & Garden
  { n: 20, cat: 'home',       site: 'dunelm.com',         url: 'https://www.dunelm.com',         goal: 'find a grey corner sofa and tell me the price and dimensions' },
  { n: 21, cat: 'home',       site: 'made.com',           url: 'https://www.made.com',           goal: 'look up a wooden dining table and tell me the price' },
  { n: 22, cat: 'home',       site: 'next.co.uk',         url: 'https://www.next.co.uk',         goal: 'search for a king size bedding set and tell me the price' },
  { n: 23, cat: 'home',       site: 'wayfair.co.uk',      url: 'https://www.wayfair.co.uk',      goal: 'find a standing desk and tell me the price range available' },
  { n: 24, cat: 'home',       site: 'johnlewis.com',      url: 'https://www.johnlewis.com',      goal: 'look up the Le Creuset Dutch oven and tell me the price' },

  // Books & Media
  { n: 25, cat: 'books',      site: 'waterstones.com',    url: 'https://www.waterstones.com',    goal: 'search for "Lessons in Chemistry" by Bonnie Garmus and tell me the paperback price' },
  { n: 26, cat: 'books',      site: 'amazon.co.uk',       url: 'https://www.amazon.co.uk',       goal: 'find "The Thursday Murder Club" hardback by Richard Osman and tell me the price' },
  { n: 27, cat: 'books',      site: 'bookdepository.com', url: 'https://www.bookdepository.com', goal: 'look up "Fourth Wing" by Rebecca Yarros and tell me if it is available and the price' },
  { n: 28, cat: 'books',      site: 'foyles.co.uk',       url: 'https://www.foyles.co.uk',       goal: 'search for "Educated" by Tara Westover and tell me the price' },

  // Food & Groceries
  { n: 29, cat: 'grocery',    site: 'tesco.com',          url: 'https://www.tesco.com',          goal: 'find Lurpak butter 250g and tell me the current price' },
  { n: 30, cat: 'grocery',    site: 'sainsburys.co.uk',   url: 'https://www.sainsburys.co.uk',   goal: 'search for Coca-Cola 2L and tell me the price' },
  { n: 31, cat: 'grocery',    site: 'waitrose.com',       url: 'https://www.waitrose.com',       goal: 'look up Cote d\'Or chocolate and tell me the price' },
  { n: 32, cat: 'grocery',    site: 'iceland.co.uk',      url: 'https://www.iceland.co.uk',      goal: 'find frozen fish fillets and tell me the price' },
  { n: 33, cat: 'grocery',    site: 'ocado.com',          url: 'https://www.ocado.com',          goal: 'search for organic free-range eggs and tell me the price' },

  // Sports & Outdoor
  { n: 34, cat: 'sport',      site: 'jdsports.co.uk',     url: 'https://www.jdsports.co.uk',     goal: 'find Adidas Ultraboost 23 running shoes and tell me the price' },
  { n: 35, cat: 'sport',      site: 'decathlon.co.uk',    url: 'https://www.decathlon.co.uk',    goal: 'look up a yoga mat and tell me the price' },
  { n: 36, cat: 'sport',      site: 'sportsdirect.com',   url: 'https://www.sportsdirect.com',   goal: 'search for football boots and tell me the cheapest price available' },
  { n: 37, cat: 'sport',      site: 'wiggle.com',         url: 'https://www.wiggle.com',         goal: 'find a road bike helmet and tell me the price' },
  { n: 38, cat: 'sport',      site: 'gooutdoors.co.uk',   url: 'https://www.gooutdoors.co.uk',   goal: 'look up a 2-person tent and tell me the price' },

  // Beauty & Personal Care
  { n: 39, cat: 'beauty',     site: 'sephora.co.uk',      url: 'https://www.sephora.co.uk',      goal: 'find Charlotte Tilbury Red Carpet Red lipstick and tell me the price' },
  { n: 40, cat: 'beauty',     site: 'cultbeauty.co.uk',   url: 'https://www.cultbeauty.co.uk',   goal: 'search for La Roche-Posay thermal spring water and tell me the price' },
  { n: 41, cat: 'beauty',     site: 'beautylish.com',     url: 'https://www.beautylish.com',     goal: 'look up the Dyson Supersonic hair dryer and tell me the price' },
  { n: 42, cat: 'beauty',     site: 'spacenk.com',        url: 'https://www.spacenk.com',        goal: 'find Augustinus Bader The Rich Cream face cream and tell me the price' },

  // Edge Cases
  { n: 43, cat: 'edge',       site: 'currys.co.uk',       url: 'https://www.currys.co.uk',       goal: 'find a Samsung 65-inch QLED TV and tell me the price' },
  { n: 44, cat: 'edge',       site: 'amazon.co.uk',       url: 'https://www.amazon.co.uk',       goal: 'find a Samsung 65-inch QLED TV and tell me the price' },
  { n: 45, cat: 'edge',       site: 'johnlewis.com',      url: 'https://www.johnlewis.com',      goal: 'find a Samsung 65-inch QLED TV and tell me the price' },
  { n: 46, cat: 'edge',       site: 'argos.co.uk',        url: 'https://www.argos.co.uk',        goal: 'check if the PlayStation 5 is in stock and tell me the price' },
];

function selected(c) {
  if (!filters.length) return true;
  return filters.some(f => c.cat === f || c.site.toLowerCase().includes(f));
}

let cases = FIXTURES.filter(selected).slice(START_IDX, END_IDX === Infinity ? undefined : END_IDX);
const stamp = () => new Date().toISOString().slice(11, 19);

async function runCase(c) {
  const user = `bench-lookup-${c.n}`;
  let outcome, turns = 0, threw = null;
  const t0 = Date.now();
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    turns = turn;
    const args = turn === 1
      ? { url: c.url, goal: c.goal, onProgress: () => {} }
      : { url: null, goal: '', onProgress: () => {} };
    try {
      outcome = await runOrderingTurn(user, args);
    } catch (e) {
      threw = e.message.split('\n')[0];
      break;
    }
    if (['done', 'ready_for_payment', 'ask', 'error', 'reauth'].includes(outcome.type)) break;
  }
  const sess = getSession(user);
  const trace = sess ? sess.history.slice(-3) : [];
  await closeSession(user).catch(() => {});
  const finalOutcome = threw ? { type: 'threw', error: threw } : outcome;
  const usedTier0 = !sess && outcome && outcome.type === 'done';
  return { case: c, outcome: finalOutcome, turns, ms: Date.now() - t0, trace, usedTier0 };
}

function resultSnippet(r) {
  const o = r.outcome || {};
  const raw = o.summary || o.text || o.error || o.question || o.type || '';
  return String(raw).replace(/\s+/g, ' ').slice(0, 80);
}

function bar(ms) {
  // Simple ASCII latency bar: each █ = 2s, capped at 20 blocks (40s).
  const blocks = Math.min(20, Math.round(ms / 2000));
  return '█'.repeat(blocks) + '░'.repeat(20 - blocks);
}

(async () => {
  console.log(`\nPRICE LOOKUP BENCHMARK — ${cases.length} case(s), up to ${MAX_TURNS} turns each`);
  if (filters.length) console.log(`filter: ${filters.join(', ')}`);
  if (START_IDX || END_IDX !== Infinity) console.log(`range: [${START_IDX}, ${END_IDX})`);
  console.log('');
  console.log('  #   site                   latency   turns  tier   outcome');
  console.log('  ' + '─'.repeat(78));

  const results = [];
  for (const c of cases) {
    process.stdout.write(`  ${String(c.n).padStart(2)}  ${c.site.padEnd(22)} …`);
    const r = await runCase(c);
    r.bucket = classifyOutcome('answer', r.outcome);
    results.push(r);

    const mark   = r.bucket === 'pass' ? '✅' : INFRA_BUCKETS.has(r.bucket) ? '⛔' : '❌';
    const tier   = r.usedTier0 ? '⚡T0' : '🌐T1';
    const secs   = (r.ms / 1000).toFixed(1);
    console.log(` ${(secs + 's').padStart(6)}  ${String(r.turns) + 't'}  ${tier}  ${mark} ${r.bucket.padEnd(10)} ${resultSnippet(r)}`);
  }

  // ── per-category summary ──────────────────────────────────────────────────
  const cats = [...new Set(results.map(r => r.case.cat))];
  console.log('\n' + '═'.repeat(80));
  console.log('LATENCY SUMMARY BY CATEGORY');
  console.log('─'.repeat(80));
  console.log('  category      count   p50    p95    avg    fastest  slowest');
  console.log('  ' + '─'.repeat(78));

  for (const cat of cats) {
    const rows = results.filter(r => r.case.cat === cat);
    const times = rows.map(r => r.ms).sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)] || 0;
    const p95 = times[Math.floor(times.length * 0.95)] || times[times.length - 1] || 0;
    const avg = times.reduce((s, v) => s + v, 0) / (times.length || 1);
    const fmt = ms => `${(ms / 1000).toFixed(1)}s`;
    console.log(`  ${cat.padEnd(13)} ${String(rows.length).padStart(3)}    ${fmt(p50).padStart(6)} ${fmt(p95).padStart(6)} ${fmt(avg).padStart(6)} ${fmt(times[0]).padStart(7)}  ${fmt(times[times.length - 1])}`);
  }

  // ── latency distribution (ASCII) ─────────────────────────────────────────
  console.log('\n' + '─'.repeat(80));
  console.log('LATENCY DISTRIBUTION  (each █ ≈ 2s, scale 0–40s)');
  console.log('─'.repeat(80));
  for (const r of results) {
    const secs = (r.ms / 1000).toFixed(1);
    const mark = r.bucket === 'pass' ? '✅' : INFRA_BUCKETS.has(r.bucket) ? '⛔' : '❌';
    const tier = r.usedTier0 ? '⚡' : '  ';
    console.log(`  ${String(r.case.n).padStart(2)} ${tier}${r.case.site.padEnd(22)} [${bar(r.ms)}] ${secs.padStart(5)}s ${mark}`);
  }

  // ── tier breakdown ────────────────────────────────────────────────────────
  const tier0 = results.filter(r => r.usedTier0);
  const tier1 = results.filter(r => !r.usedTier0);
  const avgMs = arr => arr.length ? arr.reduce((s, r) => s + r.ms, 0) / arr.length : 0;

  console.log('\n' + '─'.repeat(80));
  console.log('TIER BREAKDOWN');
  console.log(`  ⚡ Tier-0 (no browser opened): ${tier0.length} tasks — avg ${(avgMs(tier0) / 1000).toFixed(1)}s`);
  console.log(`  🌐 Tier-1 (browser session):   ${tier1.length} tasks — avg ${(avgMs(tier1) / 1000).toFixed(1)}s`);

  // ── scorecard ─────────────────────────────────────────────────────────────
  const total   = results.length;
  const passes  = results.filter(r => r.bucket === 'pass').length;
  const infra   = results.filter(r => INFRA_BUCKETS.has(r.bucket)).length;
  const scorable = total - infra;

  console.log('\n' + '─'.repeat(80));
  console.log('SCORECARD');
  console.log(`  overall pass:   ${passes}/${total}  (${pct(passes, total)})`);
  console.log(`  LOOP pass:      ${passes}/${scorable}  (${pct(passes, scorable)})   ← excludes ${infra} infra ceiling(s)`);
  console.log('');
  console.log('  failures:');
  for (const r of results) {
    if (r.bucket === 'pass') continue;
    const tag = INFRA_BUCKETS.has(r.bucket) ? 'ceiling' : 'FAIL';
    console.log(`    [${tag}] #${String(r.case.n).padStart(2)} ${r.case.site.padEnd(22)} ${r.bucket.padEnd(10)} — ${resultSnippet(r)}`);
  }

  if (process.env.OXY_BENCH_JSON === '1') {
    const rows = results.map(r => ({
      n: r.case.n, cat: r.case.cat, site: r.case.site, bucket: r.bucket,
      type: r.outcome && r.outcome.type, turns: r.turns, ms: r.ms,
      tier: r.usedTier0 ? 0 : 1, result: resultSnippet(r),
    }));
    console.log('\nJSON:\n' + JSON.stringify(rows, null, 2));
  }

  console.log('\n--- benchmark done ---');
  process.exit(0);
})();

function pct(n, d) { return d ? `${Math.round((100 * n) / d)}%` : 'n/a'; }

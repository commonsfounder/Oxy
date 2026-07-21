'use strict';
// Batch reliability benchmark. Runs the REAL runOrderingTurn loop (real Gemini + real
// stealth Chromium) across the whole reliability-fixtures basket, one case at a time,
// simulating the client's auto-continue chain per case, and prints a scorecard:
//   - overall pass rate
//   - LOOP pass rate (excluding infra/bot-wall/reauth ceilings — the number we can move)
//   - a per-case table with the bucket + a one-line reason
//   - failure breakdown so you see WHERE it breaks, not just that it does.
//
// This is the denominator for "reliability across 90% of sites". Single-shot debugging is
// still test/dev/browser-task-e2e.js; this is the aggregate.
//
// Usage (from repo root, needs .env with GEMINI_API_KEY + local Chromium):
//   node test/dev/reliability-benchmark.js                 # whole basket
//   node test/dev/reliability-benchmark.js grocery          # only cases tagged 'grocery'
//   node test/dev/reliability-benchmark.js johnlewis argos  # only cases whose site matches
//   OXY_BENCH_TURNS=8   cap auto-continue turns per case (default 8)
//   OXY_BENCH_JSON=1    also dump the raw results array as JSON at the end
const fs = require('fs');

// --- load .env into process.env (GEMINI_API_KEY etc.) ---
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

// --- stub Supabase with checkout profile so cart cases reach ready_for_payment ---
const runtime = require('../../runtime');
const { createCheckoutProfileSupabase } = require('./checkout-profile-stub');
const BENCH_EMAIL = process.env.OXY_BENCH_CHECKOUT_EMAIL || process.env.OXY_E2E_CHECKOUT_EMAIL || 'guest@oxy-test.example';
process.env.OXY_BENCH_CHECKOUT_EMAIL = BENCH_EMAIL;
runtime.createSupabaseServiceClient = () => createCheckoutProfileSupabase();

const { runOrderingTurn, getSession, closeSession } = require('../../api/services/browser-task');
const { classifyOutcome, LOOP_FAILURE_BUCKETS, INFRA_BUCKETS } = require('./reliability-classify');
const FIXTURES = require('./reliability-fixtures');

// Auto-reply for asks a live user would just answer, so the scorecard measures whether the
// LOOP can complete the task, not whether the harness withheld data. Anything else (a
// genuinely unexpected ask, e.g. the payment-button-not-found fallback) is left alone —
// that's a real loop failure to see, not something to paper over.
const DELIVERY_ASK_PAT = /delivered to your address|collected from a nearby|delivery or collection/i;
const USER_DATA_ASK_PAT = /\b(e-?mail|delivery address|shipping address|postcode|post code|zip code|phone number|mobile number|card (?:number|details)|payment details|(?:full |your )?name|sign in|log ?in|create an account)\b/i;
const BENCH_NAME = process.env.OXY_BENCH_CHECKOUT_NAME || 'John Doe';
const BENCH_PHONE = process.env.OXY_BENCH_CHECKOUT_PHONE || '07700900123';
const BENCH_ADDRESS = process.env.OXY_BENCH_CHECKOUT_ADDRESS || '12 High Street, London, SW1A 1AA';

function autoReplyForAsk(c, question) {
  const q = String(question || '');
  if (DELIVERY_ASK_PAT.test(q)) return 'deliver it to my address, save my details';
  if (c.expect === 'cart' && USER_DATA_ASK_PAT.test(q)) {
    return `${BENCH_NAME}, ${BENCH_ADDRESS}, ${BENCH_PHONE}, ${BENCH_EMAIL}, save my details`;
  }
  return null;
}

const MAX_TURNS = Number(process.env.OXY_BENCH_TURNS || 8);
const MAX_CASE_MS = Number(process.env.OXY_BENCH_MAX_MS || 10 * 60 * 1000);
const filters = process.argv.slice(2).map(s => s.toLowerCase());
const excludeTags = (process.env.OXY_BENCH_EXCLUDE || 'known-botwall')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// A case matches a filter if the filter is one of its tags OR a substring of its site.
function selected(c) {
  if (excludeTags.some((t) => (c.tags || []).includes(t))) return false;
  if (!filters.length) return true;
  return filters.some(f => (c.tags || []).includes(f) || c.site.toLowerCase().includes(f));
}

const cases = FIXTURES.filter(selected);
const stamp = () => new Date().toISOString().slice(11, 19);

// Run one case: the auto-continue chain, capped at MAX_TURNS, returning the final outcome +
// a compact trace tail. A per-case try/catch so one thrown case never aborts the batch.
async function runCase(c) {
  const user = `bench-${c.site}`;
  let outcome, turns = 0, threw = null;
  let pendingReply = null;
  const t0 = Date.now();
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (Date.now() - t0 > MAX_CASE_MS) {
      outcome = { type: 'error', error: `benchmark case timeout (${MAX_CASE_MS}ms)` };
      break;
    }
    turns = turn;
    let goal = turn === 1 ? c.goal : '';
    if (pendingReply) {
      goal = pendingReply;
      pendingReply = null;
    }
    const args = turn === 1
      ? { url: c.url, goal, onProgress: () => {} }
      : { url: null, goal, onProgress: () => {} };
    try {
      outcome = await runOrderingTurn(user, args);
    } catch (e) {
      threw = e.message.split('\n')[0];
      break;
    }
    if (outcome.type === 'ask') {
      const reply = autoReplyForAsk(c, outcome.question);
      if (reply) { pendingReply = reply; continue; }
    }
    if (['done', 'ready_for_payment', 'ask', 'error', 'reauth'].includes(outcome.type)) break;
    // awaiting_more → auto-continue
  }
  const sess = getSession(user);
  const trace = sess ? sess.history.slice(-3) : [];
  await closeSession(user).catch(() => {});
  const finalOutcome = threw ? { type: 'threw', error: threw } : outcome;
  // Detect Tier-0 wins (no browser session left open + quick done on an info goal)
  const usedTier0 = !sess && outcome && outcome.type === 'done' && c.expect === 'answer';
  return { case: c, outcome: finalOutcome, turns, ms: Date.now() - t0, trace, usedTier0 };
}

// A short human reason for the scorecard row.
function reasonOf(r) {
  const o = r.outcome || {};
  const raw = o.error || o.question || o.text || o.summary || o.type || '';
  return String(raw).replace(/\s+/g, ' ').slice(0, 70);
}

(async () => {
  console.log(`\nRELIABILITY BENCHMARK — ${cases.length} case(s), up to ${MAX_TURNS} turns each`);
  if (filters.length) console.log(`filter: ${filters.join(', ')}`);
  console.log('');

  const results = [];
  for (const c of cases) {
    process.stdout.write(`  [${stamp()}] ${c.site.padEnd(22)} … `);
    const r = await runCase(c);
    r.bucket = classifyOutcome(c.expect, r.outcome);
    results.push(r);
    const mark = r.bucket === 'pass' ? '✅' : INFRA_BUCKETS.has(r.bucket) ? '⛔' : '❌';
    const tier0 = r.usedTier0 ? ' ⚡tier0' : '';
    console.log(`${mark} ${r.bucket.padEnd(10)} (${r.turns}t, ${(r.ms / 1000).toFixed(1)}s)${tier0}`);
  }

  // --- scorecard ---
  const by = (b) => results.filter(r => r.bucket === b);
  const total = results.length;
  const passes = by('pass').length;
  const infra = results.filter(r => INFRA_BUCKETS.has(r.bucket)).length;
  const loopFails = results.filter(r => LOOP_FAILURE_BUCKETS.has(r.bucket)).length;
  const scorable = total - infra; // cases where the loop actually got a fair shot

  console.log('\n' + '─'.repeat(72));
  console.log('SCORECARD');
  console.log('─'.repeat(72));
  console.log(`  overall pass:      ${passes}/${total}  (${pct(passes, total)})`);
  console.log(`  LOOP pass:         ${passes}/${scorable}  (${pct(passes, scorable)})   ← excludes ${infra} infra/bot-wall case(s)`);
  console.log('');
  console.log('  buckets:');
  for (const b of ['pass', 'botwall', 'reauth', 'user_gate', 'stuck', 'wrong', 'incomplete', 'threw']) {
    const n = by(b).length;
    if (n) console.log(`    ${b.padEnd(11)} ${n}`);
  }

  console.log('\n  failures & ceilings:');
  for (const r of results) {
    if (r.bucket === 'pass') continue;
    const tag = INFRA_BUCKETS.has(r.bucket) ? 'ceiling' : 'FAIL';
    console.log(`    [${tag}] ${r.case.site.padEnd(22)} ${r.bucket.padEnd(10)} — ${reasonOf(r)}`);
    if (LOOP_FAILURE_BUCKETS.has(r.bucket) && r.trace.length) {
      r.trace.forEach(t => console.log(`             · ${t}`));
    }
  }

  if (process.env.OXY_BENCH_JSON === '1') {
    console.log('\nJSON:\n' + JSON.stringify(results.map(r => ({
      site: r.case.site, expect: r.case.expect, bucket: r.bucket,
      type: r.outcome && r.outcome.type, turns: r.turns, ms: r.ms, reason: reasonOf(r)
    })), null, 2));
  }

  console.log('\n--- benchmark done ---');
  process.exit(0);
})();

function pct(n, d) { return d ? `${Math.round((100 * n) / d)}%` : 'n/a'; }

'use strict';
// Prod reliability benchmark — the same fixtures, auto-replies, and classifier as
// test/dev/reliability-benchmark.js, but driving the DEPLOYED API over HTTP instead of
// running runOrderingTurn in-process.
//
// Why this exists: the local benchmark measures the loop and the model. It cannot see
// Fly's Chromium launch, its memory ceiling, the platform request timeout, or cold
// starts — and that is exactly where the failures have historically lived. On 2026-07-12
// the agent turned out to have NEVER worked in prod while every local run was green, and
// on 2026-08-01 prod was configured for a provider the deployed code couldn't serve. Both
// were invisible to the local benchmark. Prod numbers are the ones that count; the local
// run is the diagnostic that tells you WHICH layer a prod failure came from.
//
// Usage (from repo root):
//   OXY_BENCH_USER_ID=... OXY_BENCH_SESSION_TOKEN=... node test/dev/prod-reliability-benchmark.js
//   ... asos wickes            # optional site/tag filters, same semantics as the local bench
//
// Env:
//   OXY_BENCH_API_URL        deployed base URL (default: the production Fly.io app)
//   OXY_BENCH_USER_ID        user the chat requests run as (must match the token)
//   OXY_BENCH_SESSION_TOKEN  Bearer token; if unset, one is signed locally from
//                            OXY_SESSION_SECRET (only works if that matches the server's)
//   OXY_BENCH_TURNS          cap on auto-continue turns per case (default 8)
//   OXY_BENCH_MAX_MS         wall-clock cap per case (default 10min)
//   OXY_BENCH_EXCLUDE        comma-separated tags to skip (default 'known-botwall';
//                            pass a non-empty sentinel like __none__ to skip nothing —
//                            an empty string is falsy and falls back to the default)
//   OXY_BENCH_JSON=1         dump the raw results array as JSON at the end
const fs = require('fs');
const path = require('path');

// --- load .env (OXY_SESSION_SECRET etc.) without clobbering anything already exported ---
const ENV_PATH = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { classifyOutcome, LOOP_FAILURE_BUCKETS, INFRA_BUCKETS } = require('./reliability-classify');
const { autoReplyForAsk } = require('./reliability-auto-reply');
const FIXTURES = require('./reliability-fixtures');

const API_URL = (process.env.OXY_BENCH_API_URL || 'https://milgrain-live-2026.fly.dev').replace(/\/+$/, '');
const USER_ID = process.env.OXY_BENCH_USER_ID || '';
const MAX_TURNS = Number(process.env.OXY_BENCH_TURNS || 8);
const MAX_CASE_MS = Number(process.env.OXY_BENCH_MAX_MS || 10 * 60 * 1000);
// The platform request timeout is finite; give each HTTP turn a little less so a hung turn
// surfaces as our own timeout with a useful message rather than a bare socket hangup.
const TURN_TIMEOUT_MS = Number(process.env.OXY_BENCH_TURN_TIMEOUT_MS || 290 * 1000);

const filters = process.argv.slice(2).map((s) => s.toLowerCase());
const excludeTags = (process.env.OXY_BENCH_EXCLUDE || 'known-botwall')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function selected(c) {
  if (excludeTags.some((t) => (c.tags || []).includes(t))) return false;
  if (!filters.length) return true;
  return filters.some((f) => (c.tags || []).includes(f) || c.site.toLowerCase().includes(f));
}

// Token: prefer one handed in via env (minted wherever the user normally gets one). Falling
// back to signing locally only works when OXY_SESSION_SECRET matches the deployed secret —
// it won't for prod unless you've deliberately shared it, hence the explicit warning.
function resolveToken() {
  if (process.env.OXY_BENCH_SESSION_TOKEN) return process.env.OXY_BENCH_SESSION_TOKEN;
  try {
    const { createSessionToken } = require('../../auth');
    const token = createSessionToken(USER_ID);
    console.log('  note: no OXY_BENCH_SESSION_TOKEN set — signed one locally from OXY_SESSION_SECRET.');
    console.log('        This only authenticates if that secret matches the deployed one.\n');
    return token;
  } catch (e) {
    return '';
  }
}

async function postChat(token, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, userId: USER_ID }),
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) return { httpError: `${res.status}: ${body.slice(0, 200)}` };
    try { return JSON.parse(body); } catch { return { httpError: `unparseable body: ${body.slice(0, 200)}` }; }
  } catch (e) {
    const aborted = e.name === 'AbortError';
    return { httpError: aborted ? `turn timeout after ${TURN_TIMEOUT_MS}ms` : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// Pull the browser-task outcome back out of the chat response. /chat returns
// { text, actions, tasks } where each action spreads the raw { action, result } entry, so
// result is the runOrderingTurn outcome ({type, question, text, error, ...}) untouched.
function browserOutcomeFrom(reply) {
  const actions = Array.isArray(reply && reply.actions) ? reply.actions : [];
  const browser = actions.filter((a) => String(a.action || '').includes('browser'));
  if (!browser.length) return null;
  const result = browser[browser.length - 1].result;
  return result && typeof result === 'object' ? result : null;
}

async function runCase(c, token) {
  const t0 = Date.now();
  let outcome = null;
  let turns = 0;
  let noBrowserCall = false;

  // Turn 1 states the site explicitly so the agent routes to run_browser_task against the
  // fixture's site rather than picking its own — otherwise we'd be benchmarking retailer
  // choice, not the loop.
  let message = `On ${c.site}: ${c.goal}`;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (Date.now() - t0 > MAX_CASE_MS) {
      outcome = { type: 'error', error: `benchmark case timeout (${MAX_CASE_MS}ms)` };
      break;
    }
    turns = turn;

    const reply = await postChat(token, message);
    if (reply.httpError) {
      outcome = { type: 'error', error: reply.httpError };
      break;
    }

    const browserOutcome = browserOutcomeFrom(reply);
    if (!browserOutcome) {
      // The agent answered without driving the browser at all. On an ordering goal that's
      // a failure of the tool-routing layer, and worth seeing distinctly from a loop failure.
      noBrowserCall = true;
      outcome = { type: 'error', error: `no run_browser_task call; replied: ${String(reply.text || '').slice(0, 120)}` };
      break;
    }

    outcome = browserOutcome;

    if (outcome.type === 'ask') {
      const reply2 = autoReplyForAsk(c, outcome.question);
      if (reply2) { message = reply2; continue; }
      break;
    }
    if (['done', 'ready_for_payment', 'error', 'reauth'].includes(outcome.type)) break;
    // awaiting_more → auto-continue, same as the client's resume chain
    message = 'continue';
  }

  return { case: c, outcome, turns, ms: Date.now() - t0, noBrowserCall };
}

function reasonOf(r) {
  const o = r.outcome || {};
  const raw = o.error || o.question || o.text || o.summary || o.type || '';
  return String(raw).replace(/\s+/g, ' ').slice(0, 70);
}

(async () => {
  if (!USER_ID) {
    console.error('\nOXY_BENCH_USER_ID is required (the user the chat requests run as).\n');
    process.exit(1);
  }
  const token = resolveToken();
  if (!token) {
    console.error('\nNo session token: set OXY_BENCH_SESSION_TOKEN (or OXY_SESSION_SECRET to sign one).\n');
    process.exit(1);
  }

  const cases = FIXTURES.filter(selected);
  const stamp = () => new Date().toISOString().slice(11, 19);

  console.log(`\nPROD RELIABILITY BENCHMARK — ${cases.length} case(s), up to ${MAX_TURNS} turns each`);
  console.log(`target: ${API_URL}`);
  if (filters.length) console.log(`filter: ${filters.join(', ')}`);

  // Record what prod is actually running, so a scorecard is never ambiguous about which
  // build/revision produced it.
  try {
    const v = await (await fetch(`${API_URL}/version`)).json();
    console.log(`build:  ${v.deployId || v.deployId || 'unknown'} (built ${v.buildTime || '?'})`);
  } catch { console.log('build:  (could not read /version)'); }
  console.log('');

  const results = [];
  for (const c of cases) {
    process.stdout.write(`  [${stamp()}] ${c.site.padEnd(22)} … `);
    let r;
    try {
      r = await runCase(c, token);
    } catch (e) {
      r = { case: c, outcome: { type: 'threw', error: String(e.message || e).split('\n')[0] }, turns: 0, ms: 0 };
    }
    r.bucket = classifyOutcome(c.expect, r.outcome);
    results.push(r);
    const mark = r.bucket === 'pass' ? '✅' : INFRA_BUCKETS.has(r.bucket) ? '⛔' : '❌';
    console.log(`${mark} ${r.bucket.padEnd(10)} (${r.turns}t, ${(r.ms / 1000).toFixed(1)}s)`);
  }

  const pass = results.filter((r) => r.bucket === 'pass');
  const infra = results.filter((r) => INFRA_BUCKETS.has(r.bucket));
  const loopEligible = results.filter((r) => !INFRA_BUCKETS.has(r.bucket));

  console.log('\n' + '-'.repeat(72));
  console.log('SCORECARD');
  console.log('-'.repeat(72));
  for (const r of results) {
    const mark = r.bucket === 'pass' ? '✅' : INFRA_BUCKETS.has(r.bucket) ? '⛔' : '❌';
    console.log(`  ${mark} ${r.case.site.padEnd(22)} ${r.bucket.padEnd(12)} ${reasonOf(r)}`);
  }

  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : 'n/a');
  console.log('-'.repeat(72));
  console.log(`  overall pass : ${pass.length}/${results.length}  (${pct(pass.length, results.length)})`);
  console.log(`  LOOP pass    : ${pass.length}/${loopEligible.length}  (${pct(pass.length, loopEligible.length)})   [excludes ${infra.length} infra/bot-wall ceiling(s)]`);

  const breakdown = {};
  for (const r of results) if (r.bucket !== 'pass') breakdown[r.bucket] = (breakdown[r.bucket] || 0) + 1;
  if (Object.keys(breakdown).length) {
    console.log('  failures     : ' + Object.entries(breakdown).map(([k, v]) => `${k}=${v}`).join(', '));
  }
  const noCall = results.filter((r) => r.noBrowserCall);
  if (noCall.length) {
    console.log(`  NOTE: ${noCall.length} case(s) never triggered run_browser_task — tool routing, not the loop.`);
  }
  console.log('');

  if (process.env.OXY_BENCH_JSON === '1') {
    console.log(JSON.stringify(results.map((r) => ({ site: r.case.site, bucket: r.bucket, turns: r.turns, ms: r.ms, reason: reasonOf(r) })), null, 2));
  }

  process.exit(0);
})();

'use strict';
// Multi-site e2e ordering benchmark.
// Pass = ready_for_payment. Anything else is a failure.
//
// Usage:
//   node test/dev/e2e-payment-benchmark.js [max_turns] [tag_filter]
//   node test/dev/e2e-payment-benchmark.js 15
//   node test/dev/e2e-payment-benchmark.js 15 fashion
//   node test/dev/e2e-payment-benchmark.js 15 has-recipe

const fs   = require('fs');
const path = require('path');

// Load .env
for (const line of fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

// Force local browser — no managed/Browserbase
delete process.env.BROWSERBASE_API_KEY;
delete process.env.BROWSER_REMOTE_ENDPOINT;

const MAX_TURNS    = Number(process.argv[2] || 15);
const TAG_FILTER   = process.argv[3] || null;
const SITE_TIMEOUT = 120_000; // 2 min max per site regardless of turns

const PROFILE = {
  email:   'Chizigamonyewuchi@gmail.com',
  name:    'Chizigam Onyewuchi',
  phone:   '07448413463',
  address: {
    line1:    '51 Wellsford Avenue',
    city:     'Solihull',
    postcode: 'B26 1DR',
  },
  consent: true,
};

// Stub Supabase — fresh sessions, real checkout profile
const runtime = require('../../runtime');
const makeBuilder = () => {
  const ctx = { table: null, op: null };
  const resolve = async () => {
    if (ctx.table === 'preferences' && ctx.op === 'select') {
      return {
        data: [
          { key: 'checkout_profile.email',   value: PROFILE.email },
          { key: 'checkout_profile.name',    value: PROFILE.name },
          { key: 'checkout_profile.phone',   value: PROFILE.phone },
          { key: 'checkout_profile.address', value: JSON.stringify(PROFILE.address) },
          { key: 'checkout_profile.consent', value: 'true' },
        ],
        error: null,
      };
    }
    return { data: null, error: null };
  };
  return {
    from(t) { ctx.table = t; return this; },
    select() { ctx.op = 'select'; return this; },
    eq()  { return this; },
    in()  { return this; },
    like(){ return this; },
    order(){ return this; },
    limit(){ return this; },
    delete: async () => ({ data: null, error: null }),
    maybeSingle: resolve,
    single: resolve,
    upsert: async () => ({ data: null, error: null }),
    insert: async () => ({ data: null, error: null }),
    update: async () => ({ data: null, error: null }),
    then(ok, fail) { return resolve().then(ok, fail); },
  };
};
runtime.createSupabaseServiceClient = () => makeBuilder();

const { runOrderingTurn, getSession, closeSession } = require('../../api/services/browser-task');

const FIXTURES = require('./reliability-fixtures').filter((f) => {
  if (f.expect !== 'cart') return false;
  if (TAG_FILTER && !(f.tags || []).includes(TAG_FILTER)) return false;
  return true;
});

const RUN_DIR = path.join(__dirname, `e2e-run-${Date.now()}`);
fs.mkdirSync(RUN_DIR, { recursive: true });

const stamp = () => new Date().toISOString().slice(11, 19);
const pad   = (s, n) => String(s).padEnd(n);

// ─── per-site runner ──────────────────────────────────────────────────────────

async function runSite(fixture, idx, total) {
  const { site, url, goal } = fixture;
  const userId = `e2e-bench-${site}-${Date.now()}`;
  const shotDir = path.join(RUN_DIR, site.replace(/\./g, '_'));
  fs.mkdirSync(shotDir, { recursive: true });

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`[${idx}/${total}] ${site}`);
  console.log(`  goal: ${goal}`);
  console.log(`  url:  ${url}`);

  const siteStart = Date.now();
  let outcome = null;
  let turnCount = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    turnCount = turn;
    const t0 = Date.now();

    if (Date.now() - siteStart > SITE_TIMEOUT) {
      outcome = { type: 'timeout' };
      console.log(`  TURN ${turn}: TIMEOUT — exceeded ${SITE_TIMEOUT / 1000}s`);
      break;
    }

    const args = turn === 1
      ? { url, goal, onProgress: (msg) => process.stdout.write(`    · [${stamp()}] ${msg}\n`) }
      : { url: null, goal: '', onProgress: (msg) => process.stdout.write(`    · [${stamp()}] ${msg}\n`) };

    try {
      outcome = await runOrderingTurn(userId, args);
    } catch (e) {
      outcome = { type: 'threw', error: e.message.split('\n')[0] };
      console.log(`  TURN ${turn}: THREW — ${outcome.error}`);
      break;
    }

    const ms = Date.now() - t0;
    const sess = getSession(userId);
    console.log(`  TURN ${turn} (${ms}ms) → ${outcome.type}`);
    if (outcome.summary)  console.log(`    summary: ${outcome.summary}`);
    if (outcome.question) console.log(`    ask:     ${outcome.question}`);
    if (outcome.error)    console.log(`    error:   ${outcome.error}`);
    if (sess?.history?.length) {
      console.log(`    history (last 4):`);
      sess.history.slice(-4).forEach((h) => console.log(`      - ${h}`));
    }

    // Screenshot
    if (sess?.page) {
      const shot = path.join(shotDir, `turn-${String(turn).padStart(2, '0')}.png`);
      await sess.page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    }

    const done = ['ready_for_payment', 'done', 'ask', 'reauth', 'error', 'threw', 'timeout'].includes(outcome.type);
    if (done) break;
  }

  await closeSession(userId).catch(() => {});
  const elapsed = ((Date.now() - siteStart) / 1000).toFixed(1);
  const pass = outcome?.type === 'ready_for_payment';
  console.log(`  → ${pass ? '✅ PASS' : '❌ FAIL'} (${outcome?.type}) in ${elapsed}s over ${turnCount} turn(s)`);

  return { site, goal, outcome: outcome?.type || 'no-outcome', elapsed: Number(elapsed), turns: turnCount, pass };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`E2E PAYMENT BENCHMARK`);
  console.log(`Sites:   ${FIXTURES.length}${TAG_FILTER ? ` (tag: ${TAG_FILTER})` : ''}`);
  console.log(`Turns:   up to ${MAX_TURNS} per site`);
  console.log(`Profile: ${PROFILE.name} <${PROFILE.email}>`);
  console.log(`         ${PROFILE.address.line1}, ${PROFILE.address.city} ${PROFILE.address.postcode}`);
  console.log(`Output:  ${RUN_DIR}`);
  console.log(`Pass:    ready_for_payment only`);
  console.log(`${'═'.repeat(70)}`);

  const results = [];
  for (let i = 0; i < FIXTURES.length; i++) {
    const r = await runSite(FIXTURES[i], i + 1, FIXTURES.length);
    results.push(r);
  }

  // ── Scorecard ──────────────────────────────────────────────────────────────
  const pass   = results.filter((r) => r.pass);
  const fail   = results.filter((r) => !r.pass);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`SCORECARD  ${pass.length}/${results.length} PASS\n`);
  console.log(`${pad('SITE', 28)} ${pad('OUTCOME', 20)} ${pad('TIME', 8)} TURNS`);
  console.log('─'.repeat(70));
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`${icon} ${pad(r.site, 26)} ${pad(r.outcome, 20)} ${pad(r.elapsed + 's', 8)} ${r.turns}`);
  }
  console.log('─'.repeat(70));
  if (fail.length) {
    console.log(`\nFAILED (${fail.length}):`);
    fail.forEach((r) => console.log(`  ${r.site} → ${r.outcome} (${r.elapsed}s)`));
  }
  console.log(`\nOverall: ${pass.length}/${results.length} (${Math.round(100 * pass.length / results.length)}%)`);
  console.log(`${'═'.repeat(70)}\n`);

  // Write JSON summary
  const summaryPath = path.join(RUN_DIR, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ profile: PROFILE.email, maxTurns: MAX_TURNS, results }, null, 2));
  console.log(`Full results: ${summaryPath}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

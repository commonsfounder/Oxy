// End-to-end harness: drives the REAL runOrderingTurn loop with the REAL Gemini model
// and REAL stealth Chromium, exactly as production would, simulating the client's
// auto-continue chain. Supabase is stubbed so we don't touch the prod browser_sessions
// table. This answers the only question that matters: does a real task COMPLETE?
const fs = require('fs');

// --- load .env into process.env (GEMINI_API_KEY etc.) ---
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

// --- stub Supabase BEFORE browser-task captures it via destructure ---
const runtime = require('../../runtime');
const E2E_CHECKOUT_EMAIL = process.env.OXY_E2E_CHECKOUT_EMAIL || '';
const E2E_CHECKOUT_CONSENT = process.env.OXY_E2E_CHECKOUT_CONSENT !== 'false';
const E2E_CHECKOUT_NAME = process.env.OXY_E2E_CHECKOUT_NAME || 'Test User';
const E2E_CHECKOUT_PHONE = process.env.OXY_E2E_CHECKOUT_PHONE || '07700900123';
const E2E_CHECKOUT_ADDRESS = process.env.OXY_E2E_CHECKOUT_ADDRESS || '12 High Street, London, SW1A 1AA';

function createE2eSupabase() {
  const ctx = { table: null, op: null };
  const resolve = async () => {
    if (ctx.table === 'preferences' && ctx.op === 'select' && E2E_CHECKOUT_EMAIL) {
      const addrParts = E2E_CHECKOUT_ADDRESS.split(',').map((s) => s.trim());
      const address = {
        line1: addrParts[0] || E2E_CHECKOUT_ADDRESS,
        city: addrParts.length > 2 ? addrParts[addrParts.length - 2] : 'London',
        postcode: addrParts[addrParts.length - 1] || 'SW1A 1AA',
      };
      return {
        data: [
          { key: 'checkout_profile.email', value: E2E_CHECKOUT_EMAIL },
          { key: 'checkout_profile.name', value: E2E_CHECKOUT_NAME },
          { key: 'checkout_profile.phone', value: E2E_CHECKOUT_PHONE },
          { key: 'checkout_profile.address', value: JSON.stringify(address) },
          ...(E2E_CHECKOUT_CONSENT ? [
            { key: 'checkout_profile.email_consent', value: 'true' },
            { key: 'checkout_profile.consent', value: 'true' },
          ] : [])
        ],
        error: null
      };
    }
    return { data: null, error: null };
  };
  const builder = {
    from(t) { ctx.table = t; return builder; },
    select() { ctx.op = 'select'; return builder; },
    eq() { return builder; },
    in() { return builder; },
    like() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    delete: async () => ({ data: null, error: null }),
    maybeSingle: resolve,
    single: resolve,
    upsert: async () => ({ data: null, error: null }),
    insert: async () => ({ data: null, error: null }),
    update: async () => ({ data: null, error: null }),
    then(onFulfilled, onRejected) { return resolve().then(onFulfilled, onRejected); }
  };
  return builder;
}
runtime.createSupabaseServiceClient = () => createE2eSupabase();

const { runOrderingTurn, getSession, closeSession } = require('../../api/services/browser-task');

const USER = 'e2e-test-user';
const GOAL = process.argv[2] || 'find a pair of men\'s joggers and tell me the exact price shown';
const URL = process.argv[3] || 'https://www.johnlewis.com';
const MAX_TURNS = Number(process.argv[4] || 10);

const stamp = () => new Date().toISOString().slice(11, 19);
const onProgress = label => console.log(`        · [${stamp()}] ${label}`);

(async () => {
  console.log(`GOAL: ${GOAL}`);
  console.log(`URL:  ${URL}`);
  console.log(`Simulating up to ${MAX_TURNS} auto-continue turns (client watchdog is 45s/turn)\n`);

  let outcome;
  let pendingUserReply = null;
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const t0 = Date.now();
    // Turn 1 carries the url+goal; subsequent turns are silent continuations (empty goal),
    // exactly like the BROWSER_TASK_CONTINUE sentinel from the client.
    let goal = turn === 1 ? GOAL : '';
    if (pendingUserReply) {
      goal = pendingUserReply;
      pendingUserReply = null;
      console.log(`        · [${stamp()}] Simulating user checkout reply…`);
    }
    const args = turn === 1 ? { url: URL, goal, onProgress } : { url: null, goal, onProgress };
    try {
      outcome = await runOrderingTurn(USER, args);
    } catch (e) {
      console.log(`\nTURN ${turn}: THREW — ${e.message.split('\n')[0]}`);
      break;
    }
    const dur = Date.now() - t0;
    const sess = getSession(USER);
    const steps = sess ? sess.history.length : '(session gone)';
    console.log(`\n── TURN ${turn} (${dur}ms, ${dur > 45000 ? 'OVER 45s WATCHDOG' : 'within watchdog'}) → ${outcome.type}`);
    console.log(`   ${JSON.stringify({ ...outcome, summary: outcome.summary, text: outcome.text, error: outcome.error, question: outcome.question }).slice(0, 300)}`);
    console.log(`   history (${steps} steps):`);
    if (sess) sess.history.slice(-6).forEach(h => console.log(`     - ${h}`));

    if (outcome.type === 'done') { console.log('\n✅ TASK COMPLETED'); break; }
    if (outcome.type === 'ready_for_payment') { console.log('\n✅ REACHED PAYMENT (cart built)'); break; }
    if (outcome.type === 'ask') {
      if (E2E_CHECKOUT_EMAIL && /email/i.test(outcome.question || '')) {
        console.log(`\n⏸️  ASKED USER (email) — auto-replying next turn with OXY_E2E_CHECKOUT_EMAIL`);
        pendingUserReply = `${E2E_CHECKOUT_EMAIL} save my details`;
        continue;
      }
      if (E2E_CHECKOUT_EMAIL && /(address|name|phone|postcode|title|surname)/i.test(outcome.question || '') && !/delivery date/i.test(outcome.question || '')) {
        console.log(`\n⏸️  ASKED USER (delivery details) — auto-replying next turn with stub profile`);
        pendingUserReply = `${E2E_CHECKOUT_NAME}, ${E2E_CHECKOUT_ADDRESS}, ${E2E_CHECKOUT_PHONE} save my details`;
        continue;
      }
      console.log(`\n⏸️  ASKED USER: "${outcome.question}" — would need a human reply, stopping harness`);
      break;
    }
    if (outcome.type === 'error') { console.log(`\n❌ ERROR: ${outcome.error}`); break; }
    // awaiting_more → loop again (auto-continue)
  }
  await closeSession(USER).catch(() => {});
  console.log('\n--- harness done ---');
  process.exit(0);
})();

'use strict';
// Quick e2e runner: order on John Lewis as guest, no login, no Browserbase, no env vars for profile.
// Usage: node test/dev/jl-order-e2e.js [goal] [max_turns]
//   node test/dev/jl-order-e2e.js "order me an iPhone 17 256GB" 15

const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

// Force local browser only
delete process.env.BROWSERBASE_API_KEY;
delete process.env.BROWSER_REMOTE_ENDPOINT;

const GOAL = process.argv[2] || 'order me an iPhone 17 256GB from John Lewis';
const MAX_TURNS = Number(process.argv[3] || 15);
const USER = 'jl-e2e-guest';

// Checkout profile — override via env vars so real PII never lands in this tracked file.
// JL_E2E_EMAIL / JL_E2E_NAME / JL_E2E_PHONE / JL_E2E_ADDR_LINE1 / JL_E2E_ADDR_CITY / JL_E2E_ADDR_POSTCODE
const PROFILE = {
  email: process.env.JL_E2E_EMAIL || 'test@example.com',
  name: process.env.JL_E2E_NAME || 'Alex Smith',
  phone: process.env.JL_E2E_PHONE || '07700900123',
  address: {
    line1: process.env.JL_E2E_ADDR_LINE1 || '10 Downing Street',
    city: process.env.JL_E2E_ADDR_CITY || 'London',
    postcode: process.env.JL_E2E_ADDR_POSTCODE || 'SW1A 2AA',
  },
  consent: true,
};

// Stub Supabase — returns empty sessions (fresh start) + checkout profile on preferences query
const runtime = require('../../runtime');
const ctx = { table: null, op: null };
const resolve = async () => {
  if (ctx.table === 'preferences' && ctx.op === 'select') {
    return {
      data: [
        { key: 'checkout_profile.email', value: PROFILE.email },
        { key: 'checkout_profile.name', value: PROFILE.name },
        { key: 'checkout_profile.phone', value: PROFILE.phone },
        { key: 'checkout_profile.address', value: JSON.stringify(PROFILE.address) },
        { key: 'checkout_profile.consent', value: 'true' },
      ],
      error: null,
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
  then(onFulfilled, onRejected) { return resolve().then(onFulfilled, onRejected); },
};
runtime.createSupabaseServiceClient = () => builder;

const { runOrderingTurn, getSession, closeSession } = require('../../api/services/browser-task');

const SHOTS_DIR = path.join(__dirname, 'jl-e2e-shots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const stamp = () => new Date().toISOString().slice(11, 19);
const onProgress = (label) => process.stdout.write(`  · [${stamp()}] ${label}\n`);

async function snapshot(sess, turn) {
  if (!sess?.page) return;
  try {
    const url = sess.page.url();
    const shot = path.join(SHOTS_DIR, `turn-${String(turn).padStart(2,'0')}.png`);
    await sess.page.screenshot({ path: shot, fullPage: false }).catch(() => {});

    // Dump email inputs visible on page
    const inputs = await sess.page.evaluate(() =>
      [...document.querySelectorAll('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return {
            id: el.id, name: el.name, type: el.type,
            placeholder: el.placeholder,
            visible: s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0,
            value: el.value,
            sectionText: el.closest('section,div[class*="guest" i],div[class*="sign" i],fieldset')?.querySelector('h2,h3,legend,label')?.textContent?.trim()?.slice(0,40) || '',
          };
        })
    ).catch(() => []);
    console.log(`   url: ${url}`);
    console.log(`   screenshot: ${shot}`);
    if (inputs.length) {
      console.log(`   email inputs (${inputs.length}):`);
      inputs.forEach((inp) => console.log(`     · visible=${inp.visible} id="${inp.id}" name="${inp.name}" placeholder="${inp.placeholder}" value="${inp.value}" section="${inp.sectionText}"`));
    } else {
      console.log(`   email inputs: none found`);
    }
  } catch { /* non-fatal */ }
}

// Network instrumentation: log the actual basket/cart API calls so we can see whether
// John Lewis's server genuinely rejects the add (bot detection, 4xx/5xx) or returns 200
// while the UI silently fails to reflect it (client-side/hydration issue on our end).
let networkWired = false;
function wireNetworkLogging(page) {
  if (networkWired || !page) return;
  networkWired = true;
  // Only John Lewis's own hosts, and only in the path (not query params) — third-party
  // telemetry beacons (New Relic etc.) embed the page URL in a `ref=` param and false-match
  // a naive substring check on the whole URL.
  const isJLHost = (u) => /(^|\.)johnlewis\.com$/i.test(u.hostname);
  const interestingPath = /basket|cart|bag/i;
  page.on('request', (req) => {
    const method = req.method();
    if (method === 'GET') return; // only mutating calls matter here
    let u; try { u = new URL(req.url()); } catch { return; }
    if (!isJLHost(u) || !interestingPath.test(u.pathname)) return;
    console.log(`  >> [net] ${method} ${u.href}`);
    const body = req.postData();
    if (body) console.log(`     body: ${body.slice(0, 300)}`);
  });
  page.on('response', async (res) => {
    if (res.request().method() === 'GET') return;
    let u; try { u = new URL(res.url()); } catch { return; }
    if (!isJLHost(u) || !interestingPath.test(u.pathname)) return;
    let bodySnippet = '';
    try { bodySnippet = (await res.text()).slice(0, 400); } catch { /* non-text or consumed */ }
    console.log(`  << [net] ${res.status()} ${u.href}`);
    if (bodySnippet) console.log(`     resp: ${bodySnippet}`);
  });
}

async function main() {
  console.log(`\nJL GUEST CHECKOUT E2E`);
  console.log(`GOAL: ${GOAL}`);
  console.log(`MAX TURNS: ${MAX_TURNS}`);
  console.log(`PROFILE: ${PROFILE.name} <${PROFILE.email}> ${PROFILE.address.line1}, ${PROFILE.address.city} ${PROFILE.address.postcode}`);
  console.log(`BROWSER: local (no Browserbase)\n`);
  console.log(`Screenshots: ${SHOTS_DIR}\n`);

  let outcome;
  let pendingReply = ''; // auto-answer for the delivery/collection ask, see below
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const t0 = Date.now();
    const START_URL = process.argv[4] || 'https://www.johnlewis.com';
    const args = turn === 1
      ? { url: START_URL, goal: GOAL, onProgress }
      : { url: null, goal: pendingReply, onProgress };
    pendingReply = '';

    try {
      outcome = await runOrderingTurn(USER, args);
    } catch (e) {
      console.log(`\nTURN ${turn}: THREW — ${e.message.split('\n')[0]}`);
      console.log(e.stack?.split('\n').slice(1, 4).join('\n'));
      break;
    }
    wireNetworkLogging(getSession(USER)?.page);

    const ms = Date.now() - t0;
    const sess = getSession(USER);
    const steps = sess?.history?.length ?? '?';
    console.log(`\n── TURN ${turn} (${ms}ms) → ${outcome.type}`);
    if (outcome.summary) console.log(`   summary: ${outcome.summary}`);
    if (outcome.text)    console.log(`   text:    ${String(outcome.text).slice(0, 200)}`);
    if (outcome.error)   console.log(`   error:   ${outcome.error}`);
    if (outcome.question) console.log(`   ask:     ${outcome.question}`);
    if (sess?.history?.length) {
      console.log(`   history (last 6 of ${steps}):`);
      sess.history.slice(-6).forEach((h) => console.log(`     - ${h}`));
    }
    await snapshot(sess, turn);

    if (outcome.type === 'ready_for_payment') { console.log('\n✅  REACHED PAYMENT — stopping (not confirming)'); break; }
    if (outcome.type === 'done')              { console.log('\n✅  DONE'); break; }
    if (outcome.type === 'ask') {
      // Auto-answer only the delivery-vs-collection ask so this script can verify the full
      // flow end-to-end in one run; any other question still stops the script as before.
      if (/delivered to your address on file|collected from a nearby store/i.test(outcome.question)) {
        console.log(`\n⏸️  NEEDS INPUT (auto-answering "deliver it to my address"): ${outcome.question}`);
        pendingReply = 'deliver it to my address';
        continue;
      }
      console.log(`\n⏸️   NEEDS INPUT: ${outcome.question}`);
      break;
    }
    if (outcome.type === 'reauth')            { console.log(`\n🔐  REAUTH: ${outcome.site}`); break; }
    if (outcome.type === 'error')             { console.log(`\n❌  ERROR: ${outcome.error}`); break; }
  }

  await closeSession(USER).catch(() => {});
  console.log('\n─── done ───\n');
}

main().catch((e) => { console.error(e); process.exit(1); });

'use strict';

// Manual login + order E2E for John Lewis.
//
// Flow:
// 1. Opens a headed browser on John Lewis.
// 2. User logs in manually. No password is read, printed, or stored by this script.
// 3. Press Enter in this process to capture storageState.
// 4. The real runOrderingTurn loop reuses that storageState and runs until payment/ask/error.

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

for (const line of fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const USER = process.env.OXY_E2E_USER || 'johnlewis-login-e2e-user';
const SITE = 'johnlewis.com';
const LOGIN_URL = process.env.OXY_JL_LOGIN_URL || 'https://www.johnlewis.com';
const GOAL = process.argv[2] || 'order me a blue iPhone 17 256GB from John Lewis';
const URL = process.argv[3] || 'https://www.johnlewis.com';
const MAX_TURNS = Number(process.argv[4] || 12);
const USE_BROWSERBASE_LOGIN = process.env.OXY_LOGIN_LOCAL !== 'true' && !!process.env.BROWSERBASE_API_KEY;

function checkoutProfileRows() {
  const email = process.env.OXY_E2E_CHECKOUT_EMAIL || '';
  const name = process.env.OXY_E2E_CHECKOUT_NAME || '';
  const phone = process.env.OXY_E2E_CHECKOUT_PHONE || '';
  const addressRaw = process.env.OXY_E2E_CHECKOUT_ADDRESS || '';
  const consent = process.env.OXY_E2E_CHECKOUT_CONSENT !== 'false';
  if (!email && !name && !phone && !addressRaw) return [];

  const addrParts = addressRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const address = {
    line1: addrParts[0] || addressRaw,
    city: addrParts.length > 2 ? addrParts[addrParts.length - 2] : (addrParts[1] || ''),
    postcode: addrParts[addrParts.length - 1] || '',
  };

  return [
    ...(email ? [{ key: 'checkout_profile.email', value: email }] : []),
    ...(name ? [{ key: 'checkout_profile.name', value: name }] : []),
    ...(phone ? [{ key: 'checkout_profile.phone', value: phone }] : []),
    ...(addressRaw ? [{ key: 'checkout_profile.address', value: JSON.stringify(address) }] : []),
    ...(consent ? [
      { key: 'checkout_profile.email_consent', value: 'true' },
      { key: 'checkout_profile.consent', value: 'true' },
    ] : []),
  ];
}

function createSupabaseStub(storageState) {
  const ctx = { table: null, op: null };
  const resolve = async () => {
    if (ctx.table === 'browser_sessions' && ctx.op === 'select') {
      return { data: { storage_state: storageState, last_url: null, goal: null, history: [], site: SITE }, error: null };
    }
    if (ctx.table === 'preferences' && ctx.op === 'select') {
      return { data: checkoutProfileRows(), error: null };
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
  return builder;
}

const stamp = () => new Date().toISOString().slice(11, 19);
const onProgress = (label) => console.log(`        · [${stamp()}] ${label}`);

async function captureLoginState() {
  console.log(`\nOpening John Lewis in a ${USE_BROWSERBASE_LOGIN ? 'Browserbase' : 'visible local'} browser.`);
  console.log('Log in manually in that browser. This script never receives your password.');
  console.log('When you are fully logged in, come back here and press Enter.\n');

  let browser;
  let context;
  if (USE_BROWSERBASE_LOGIN) {
    const session = await createBrowserbaseSession();
    browser = await chromium.connectOverCDP(session.connectUrl);
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const dbg = await getBrowserbaseDebugUrl(session.id);
    if (dbg) {
      console.log('Open this Browserbase debug URL to log in:');
      console.log(dbg);
      console.log('');
    } else {
      console.log('Could not fetch a Browserbase debug URL, but the remote session is running.');
    }
  } else {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  }
  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  const rl = readline.createInterface({ input, output });
  await rl.question('Press Enter after login is complete...');
  rl.close();
  const storageState = await context.storageState();
  await browser.close().catch(() => {});
  console.log(`Captured ${storageState.cookies?.length || 0} cookies for ${SITE}; no credentials captured.\n`);
  return storageState;
}

async function createBrowserbaseSession() {
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: {
      'x-bb-api-key': process.env.BROWSERBASE_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Browserbase session create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getBrowserbaseDebugUrl(sessionId) {
  const res = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/debug`, {
    headers: { 'x-bb-api-key': process.env.BROWSERBASE_API_KEY },
  });
  if (!res.ok) return '';
  const data = await res.json();
  return data.debuggerFullscreenUrl || data.debuggerUrl || '';
}

async function main() {
  const storageState = await captureLoginState();

  const runtime = require('../../runtime');
  runtime.createSupabaseServiceClient = () => createSupabaseStub(storageState);

  const { runOrderingTurn, getSession, closeSession } = require('../../api/services/browser-task');

  console.log(`GOAL: ${GOAL}`);
  console.log(`URL:  ${URL}`);
  console.log(`Using captured John Lewis session state for user ${USER}.`);
  console.log(`Simulating up to ${MAX_TURNS} auto-continue turns; stopping at payment.\n`);

  let outcome;
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const t0 = Date.now();
    const args = turn === 1
      ? { url: URL, goal: GOAL, onProgress }
      : { url: null, goal: '', onProgress };
    try {
      outcome = await runOrderingTurn(USER, args);
    } catch (e) {
      console.log(`\nTURN ${turn}: THREW - ${e.message.split('\n')[0]}`);
      break;
    }
    const dur = Date.now() - t0;
    const sess = getSession(USER);
    const steps = sess ? sess.history.length : '(session gone)';
    console.log(`\n-- TURN ${turn} (${dur}ms, ${dur > 45000 ? 'OVER 45s WATCHDOG' : 'within watchdog'}) -> ${outcome.type}`);
    console.log(`   ${JSON.stringify({ ...outcome, summary: outcome.summary, text: outcome.text, error: outcome.error, question: outcome.question }).slice(0, 300)}`);
    console.log(`   history (${steps} steps):`);
    if (sess) sess.history.slice(-8).forEach((h) => console.log(`     - ${h}`));

    if (outcome.type === 'ready_for_payment') { console.log('\n✅ REACHED PAYMENT'); break; }
    if (outcome.type === 'done') { console.log('\n✅ TASK COMPLETED'); break; }
    if (outcome.type === 'ask' || outcome.type === 'reauth') { console.log(`\n⏸️  NEEDS USER: ${outcome.question || outcome.site || ''}`); break; }
    if (outcome.type === 'error') { console.log(`\n❌ ERROR: ${outcome.error}`); break; }
  }

  await closeSession(USER).catch(() => {});
  console.log('\n--- manual login harness done ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

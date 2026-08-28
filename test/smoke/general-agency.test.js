// What Adam must be able to do, stated as capabilities rather than as features.
//
// These tests exist because the architecture used to answer "can you do X?" with "is there a
// branch for X?". Each one names a thing a person would ask for, and asserts that the general
// runtime can reach it — not that some specific handler for that task exists. A new domain
// should pass these without a new branch anywhere.

const assert = require('node:assert/strict');
const test = require('node:test');

// index.js and the connector modules build real clients at load; give them harmless values.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const { inferDeterministicAction } = require('../../api/intent-router');
const { ACTION_CONTRACTS, getActionContract, buildToolsForGemini } = require('../../api/action-contracts');
const { handlerFor } = require('../../api/actions');
const { createActionExecution } = require('../../api/services/action-execution');
const { shouldUseAgenticLoopForMessage } = require('../../api/index');
const { playbooksFor } = require('../../api/services/playbooks');

// A cross-section of ordinary requests, deliberately spanning unrelated domains. None of them
// has, or should have, a dedicated subsystem.
const REAL_TASKS = [
  'Cancel my Netflix subscription',
  'Renew my passport',
  'Apply for this tenancy — the form is on the letting agent site',
  'Dispute this parking fine',
  'Change my delivery address on my Amazon order',
  'Turn off my morning briefing',
  'Return the jeans I bought last week',
  'Unsubscribe me from all these marketing emails',
  'Top up my Oyster card',
  'Add my new card to my council tax account',
  'Book me a table at Padella for Friday',
  'Buy me some toothpaste',
];

// ── Reaching the runtime at all ───────────────────────────────────────────────────────────

test('every ordinary request reaches the agent loop, whatever verb it happens to use', () => {
  for (const message of REAL_TASKS) {
    assert.equal(
      shouldUseAgenticLoopForMessage({ message, quickTurn: false, autonomyLevel: 'Active', pendingAction: null }),
      true,
      `"${message}" must be able to act, not just reply`
    );
  }
});

test('a plain question is still answered by talking, not by starting a work session', () => {
  for (const message of ["what's the weather in London this weekend", 'what does this message mean', 'who wrote Bleak House']) {
    assert.equal(
      shouldUseAgenticLoopForMessage({ message, quickTurn: false, autonomyLevel: 'Active', pendingAction: null }),
      false,
      message
    );
  }
});

test('no request is pre-classified into a domain workflow before the model sees it', () => {
  // The deterministic router may still shortcut a SINGLE tool call with extracted parameters
  // (directions, a place lookup). What it must never do again is decide that a request
  // belongs to "shopping" and hand the whole goal to one subsystem.
  for (const message of REAL_TASKS) {
    const routed = inferDeterministicAction(message);
    assert.notEqual(routed?.actions?.[0]?.type, 'run_browser_task', `"${message}" was pre-routed into the ordering loop`);
  }
});

// ── The browser is a general environment ──────────────────────────────────────────────────

test('the browser is exposed as primitives the loop composes, not as one opaque task', () => {
  for (const type of ['browser_open', 'browser_observe', 'browser_act', 'browser_close']) {
    assert.ok(getActionContract(type), `${type} must be a declared capability`);
    assert.ok(handlerFor(type), `${type} must have a handler`);
  }
  const act = getActionContract('browser_act');
  for (const primitive of ['click', 'type', 'select', 'scroll', 'back', 'navigate', 'wait']) {
    assert.match(act.paramHints.action, new RegExp(`\\b${primitive}\\b`), `browser_act must offer "${primitive}"`);
  }
});

test('the browser primitives describe a page, not a shop', () => {
  // The architectural test from the brief: reading these capabilities should not reveal what
  // the user is buying, because they do not know.
  const decls = buildToolsForGemini(false)[0].functionDeclarations;
  const browserDecls = decls.filter(d => d.name.startsWith('browser_'));
  assert.ok(browserDecls.length >= 4);
  for (const decl of browserDecls) {
    assert.doesNotMatch(decl.description, /\b(basket|cart|product|retailer|checkout page|add to bag)\b/i,
      `${decl.name} must not be described in commerce terms`);
  }
});

test('the same primitives are what a non-shopping task would use', () => {
  // Nothing about opening a page, reading it, clicking, typing and verifying is specific to
  // buying. This is the whole point: a tenancy form, a cancellation and a purchase are the
  // same six calls in a different order.
  const open = getActionContract('browser_open');
  assert.match(open.guidance, /cancel/i);
  assert.match(open.guidance, /form|application/i);
  assert.match(open.guidance, /account settings/i);
});

test('verification is a capability of its own, not something a task decides for itself', () => {
  const observe = getActionContract('browser_observe');
  assert.match(observe.guidance, /VERIFY/);
  const act = getActionContract('browser_act');
  assert.match(act.guidance, /changed/);
});

test('filling a form from what is already known is a general capability, not a checkout step', async () => {
  const { identityValuesFrom, observeFormFields } = require('../../api/services/browser-environment');
  assert.equal(typeof observeFormFields, 'function');

  // The stored facts are portable categories about the person — nothing about buying.
  const values = identityValuesFrom({
    email: 'a@example.com',
    name: 'Ada Lovelace',
    phone: '07700900000',
    address: { line1: '12 Dean St', city: 'London', postcode: 'W1D 3RP' },
  });
  assert.equal(values.first_name, 'Ada');
  assert.equal(values.last_name, 'Lovelace');
  assert.equal(values.postcode, 'W1D 3RP');

  const contract = getActionContract('browser_fill_known_details');
  assert.ok(contract, 'browser_fill_known_details must be a declared capability');
  assert.ok(handlerFor('browser_fill_known_details'));
  // Explicitly usable beyond a checkout, and explicitly not a card-filler.
  assert.match(contract.guidance, /application|claim|registration/i);
  assert.match(contract.guidance, /never touches payment card fields/i);
  assert.match(contract.guidance, /never invent a value/i);
});

// ── Ordering intent no longer leaks onto unrelated tasks ──────────────────────────────────

test('nothing classifies a goal as "an order" any more — there is no ordering mode to enter', () => {
  // This used to be a real predicate (isOrderGoal) that armed product search and
  // add-to-basket behaviour, and it returned true for "add my new card to my council tax
  // account". The regression is now fixed structurally rather than by tuning a regex: the
  // ordering loop it gated is gone, so there is no mode for a goal to be misfiled into.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'api');
  const offenders = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && /\bisOrderGoal\b|shouldUseOrderingAutomation/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
    }
  })(dir);
  assert.deepEqual(offenders, [], 'no ordering-mode gate may exist');
});

test('shopping guidance is offered for a purchase and withheld from account admin', () => {
  // The playbook is the only thing that still distinguishes these, and it is guidance the
  // model may ignore — not a branch that changes which code runs.
  for (const goal of [
    'Add my new card to my council tax account',
    'Change my delivery address on my Amazon order',
    'Cancel my Netflix subscription',
    'Return the jeans I bought last week',
  ]) {
    assert.ok(!playbooksFor(goal).includes('purchasing'), `${goal} must not get purchase guidance`);
  }
  for (const goal of ['buy me a kettle from currys', 'order me a pizza from dominos']) {
    assert.ok(playbooksFor(goal).includes('purchasing'), goal);
  }
});

// ── Authority stays deterministic ─────────────────────────────────────────────────────────

test('committing a payment goes through the contract gate like any other money action', async () => {
  let executed = false;
  const parked = [];
  const executeActions = createActionExecution({
    invokeAdapter: async () => { executed = true; return { success: true }; },
    setPendingAction: async (userId, action) => { parked.push(action); },
    logAction: async () => {},
    invalidateUserContextCache: () => {},
  });

  const result = await executeActions('user-1', [{ type: 'transaction_authorize', input: {} }], {
    userMessage: 'go ahead and pay',
    autonomy: 'Autonomous',
  });

  assert.equal(executed, false, 'a payment must not commit without a human yes');
  assert.equal(parked.length, 1);
  assert.equal(result[0].result.pending, true);
});

test('browsing itself is not gated — only spending is', async () => {
  const invoked = [];
  const executeActions = createActionExecution({
    invokeAdapter: async ({ type }) => { invoked.push(type); return { success: true }; },
    setPendingAction: async () => { throw new Error('browsing must not require approval'); },
    logAction: async () => {},
    invalidateUserContextCache: () => {},
  });
  await executeActions('user-1', [{ type: 'browser_open', input: { url: 'https://example.com' } }], {});
  await executeActions('user-1', [{ type: 'browser_act', input: { action: 'click', elementId: 0 } }], {});
  assert.deepEqual(invoked, ['browser_open', 'browser_act']);
});

test('payment authority reads the amount off the page rather than trusting a summary', () => {
  // browser-task.confirmPayment takes an authorizeAmount callback and calls it with a total
  // parsed from the live checkout (order-total.js), before any pay button is pressed.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../../api/services/transaction.js'), 'utf8');
  // The amount comes from a parser reading the live page, at the moment of commit.
  assert.match(src, /async function readAmount\(page\)/);
  assert.match(src, /const raw = readOrderTotal\(text\)/);
  assert.match(src, /const money = await readAmount\(page\);/);
  // And the module itself never decides whether an amount is allowed.
  assert.match(src, /const verdict = await authorize\(money\);/);

  const handlerSrc = fs.readFileSync(require.resolve('../../api/actions/browser.js'), 'utf8');
  // No readable total means no charge, rather than a charge against a stale number.
  assert.match(handlerSrc, /if \(!raw \|\| !amount\)/);
  assert.match(handlerSrc, /Nothing was charged/);
});

test('a completed charge consumes the daily spend cap', () => {
  // confirmPayment closes the session on success, so the amount has to ride out on the
  // result. Asking for it afterwards read a session that no longer existed, and the daily
  // cap was silently never consumed on any successful order.
  const fs = require('node:fs');
  // The parser-read commit total wins over anything recorded earlier.
  const txn = fs.readFileSync(require.resolve('../../api/services/transaction.js'), 'utf8');
  assert.match(txn, /function chargedAmount\(session\)/);
  assert.match(txn, /session\?\.committedTotal \|\| session\?\.pendingPaymentTotal/);

  const handler = fs.readFileSync(require.resolve('../../api/actions/browser.js'), 'utf8');
  assert.match(handler, /transaction\.chargedAmount\(session\)/);
  assert.match(handler, /await guardConciergeSpend\(userId, charged\.total/);
});

test('signing in with a stored credential is gated by a user grant, every time', () => {
  const contract = getActionContract('browser_sign_in');
  assert.equal(contract.executionMode, 'review', 'using someone\'s password is an authority decision');
  assert.equal(contract.confirmation, 'review_required');

  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../../api/services/browser-access.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function signInWithStoredCredential'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // The grant is consulted before the credential is even fetched...
  assert.ok(body.indexOf('authorizeCredentialUse') < body.indexOf('getVaultCredential'),
    'authorisation must come before the credential is read');
  // ...a refusal is reported rather than worked around...
  assert.match(body, /type: 'not_authorized'/);
  // ...and a credential is never filled into a page that is not the granted site.
  assert.match(body, /if \(!siteInScope\(pageSite, \[site\]\)\)/);
});

// ── One execution path for background work ────────────────────────────────────────────────

test('a scheduled task and a saved routine run through the same background machinery', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');

  // Two user-facing concepts ("watch this for me", "here is a routine I re-run"), one way of
  // actually running them. The routine copy had drifted: no durable task, no runtime session,
  // no model routing — so a routine run was invisible in the work surfaces and always used
  // the default model.
  const callers = [...src.matchAll(/await runSavedGoal\(/g)];
  assert.ok(callers.length >= 2, 'the scheduler and the routine sweep must share one runner');

  // And nothing may quietly grow a second dispatch: runAgenticLoop is called from the shared
  // runner and the request-scoped surfaces, never from a new background sweep of its own.
  const runnerStart = src.indexOf('async function runSavedGoal(');
  const runner = src.slice(runnerStart, src.indexOf('\n}\n', runnerStart));
  assert.match(runner, /runAgenticLoop\(/, 'the shared runner is the one that drives the loop');
});

// ── Adam can act on itself ────────────────────────────────────────────────────────────────

test('Adam has capabilities for inspecting and changing its own state', () => {
  // "Turn off my morning briefing" and "remember that I prefer aisle seats" are ordinary
  // tasks, not settings screens the model has to talk the user through.
  for (const type of ['set_notification_preference', 'forget_memory', 'list_scheduled_tasks', 'cancel_scheduled_task']) {
    assert.ok(ACTION_CONTRACTS[type], `${type} must exist so Adam can manage itself`);
  }
});

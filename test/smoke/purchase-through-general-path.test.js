// A purchase, executed with nothing but the general runtime.
//
// This is the test the whole refactor exists to pass. "Buy this product" runs as:
//
//     main agent loop → browser primitives → optional shopping playbook
//                     → deterministic transaction approval → verification
//
// and NOT as: main agent → run_browser_task → a second shopping agent loop.
//
// The same primitives, in a different order, are then shown completing a cancellation and a
// form submission — because if a purchase needed anything the others do not, it would still
// be a special case wearing general clothes.

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const { handlerFor } = require('../../api/actions');
const { getActionContract, ACTION_CONTRACTS } = require('../../api/action-contracts');
const { createActionExecution } = require('../../api/services/action-execution');
const browserEnvironment = require('../../api/services/browser-environment');
const browserAccess = require('../../api/services/browser-access');
const transaction = require('../../api/services/transaction');
const { playbooksFor } = require('../../api/services/playbooks');

// ── A fake page the primitives can actually be driven against ─────────────────────────────
//
// Deliberately a script of page states rather than a live browser: the point is which
// CAPABILITIES the flow needs and in what order, not whether Playwright works.

function scriptedRun(steps) {
  const calls = [];
  let cursor = 0;
  const observation = (state) => ({
    success: true,
    url: state.url,
    elements: state.elements || [],
    text: state.text || '',
    pageTitle: state.title || '',
  });
  return {
    calls,
    async run(capability, input = {}) {
      calls.push(capability);
      const step = steps[cursor++];
      assert.ok(step, `no scripted state left for ${capability}`);
      assert.equal(step.expect, capability, `expected ${step.expect}, flow called ${capability}`);
      return step.result ?? observation(step);
    },
  };
}

// ── The purchase ──────────────────────────────────────────────────────────────────────────

test('buying something runs entirely on general capabilities, in the general loop', async () => {
  // Every capability the flow uses must be a declared, model-visible tool with a handler —
  // i.e. something the MAIN loop can choose, not an internal step of a private loop.
  const used = [
    'browser_open',            // find the shop and its search results
    'browser_act',             // open the product, choose a size, add it
    'browser_observe',         // check the basket really changed
    'browser_continue_without_account', // get past the sign-in wall
    'browser_fill_known_details',       // name / address / email already on file
    'transaction_prepare',     // read the amount with a parser
    'transaction_authorize',   // the deterministic approval gate
    'transaction_status',      // verify it actually went through
  ];
  for (const capability of used) {
    const contract = getActionContract(capability);
    assert.ok(contract, `${capability} must be a declared capability`);
    assert.notEqual(contract.modelVisible, false, `${capability} must be reachable by the main loop`);
    assert.ok(handlerFor(capability), `${capability} must have a handler`);
  }

  // And there must be no second loop left to fall back into.
  for (const gone of ['run_browser_task', 'confirm_browser_payment', 'confirm_credential_use']) {
    assert.equal(ACTION_CONTRACTS[gone], undefined, `${gone} must not exist`);
  }
});

test('the purchase flow is a sequence of primitives, and the money step is the only gated one', async () => {
  const parked = [];
  const invoked = [];
  const executeActions = createActionExecution({
    invokeAdapter: async ({ type }) => { invoked.push(type); return { success: true }; },
    setPendingAction: async (userId, action) => { parked.push(action.type); },
    logAction: async () => {},
    invalidateUserContextCache: () => {},
  });

  // The whole flow, as the main agent loop would issue it.
  const flow = [
    { type: 'browser_open', input: { site: 'john lewis', searchFor: 'wool socks' } },
    { type: 'browser_act', input: { action: 'click', elementId: 3 } },
    { type: 'browser_act', input: { action: 'select', elementId: 8, value: 'Medium' } },
    { type: 'browser_act', input: { action: 'click', elementId: 12 } },
    { type: 'browser_observe', input: {} },
    { type: 'browser_act', input: { action: 'click', elementId: 2 } },
    { type: 'browser_continue_without_account', input: {} },
    { type: 'browser_fill_known_details', input: {} },
    { type: 'transaction_prepare', input: {} },
  ];
  for (const action of flow) await executeActions('u1', [action], {});

  assert.deepEqual(parked, [], 'nothing up to and including reading the price needs approval');
  assert.equal(invoked.length, flow.length, 'every step executed directly');

  // The commit is the one thing that stops.
  const result = await executeActions('u1', [{ type: 'transaction_authorize', input: {} }], {});
  assert.deepEqual(parked, ['transaction_authorize'], 'paying is the only gated step');
  assert.equal(result[0].result.pending, true);
  assert.equal(invoked.length, flow.length, 'the charge did not execute before approval');
});

test('the same primitives complete a cancellation and a form, in a different order', async () => {
  const invoked = [];
  const parked = [];
  const executeActions = createActionExecution({
    invokeAdapter: async ({ type }) => { invoked.push(type); return { success: true }; },
    setPendingAction: async (_u, a) => { parked.push(a.type); },
    logAction: async () => {},
    invalidateUserContextCache: () => {},
  });

  // Cancel a subscription: open, sign in, navigate the account area, confirm, verify.
  const cancellation = [
    { type: 'browser_open', input: { url: 'https://example.com/account' } },
    { type: 'browser_act', input: { action: 'click', elementId: 4 } },
    { type: 'browser_act', input: { action: 'click', elementId: 9 } },
    { type: 'browser_observe', input: {} },
  ];
  // A tenancy application: open, fill what is known, upload a document, submit, verify.
  const application = [
    { type: 'browser_open', input: { url: 'https://letting.example/apply' } },
    { type: 'browser_fill_known_details', input: {} },
    { type: 'browser_upload', input: { documentId: 'doc-1' } },
    { type: 'browser_act', input: { action: 'click', elementId: 21 } },
    { type: 'browser_observe', input: {} },
  ];
  for (const action of [...cancellation, ...application]) await executeActions('u1', [action], {});

  assert.equal(invoked.length, cancellation.length + application.length);
  assert.deepEqual(parked, [], 'neither needs a money gate, because neither spends money');
  // The decisive point: the capability set is identical to the purchase's.
  const purchaseCapabilities = new Set(['browser_open', 'browser_act', 'browser_observe', 'browser_fill_known_details']);
  for (const type of invoked) {
    assert.ok(purchaseCapabilities.has(type) || type === 'browser_upload',
      `${type} should be a capability a purchase also uses`);
  }
});

// ── The playbook is guidance, not machinery ───────────────────────────────────────────────

test('deleting the shopping playbook would not remove the ability to buy', () => {
  // Every capability the purchase flow uses is declared independently of any playbook, so
  // removing the guidance leaves the flow executable — just less well judged.
  const playbookFile = require('node:fs').readFileSync(require.resolve('../../api/services/playbooks.js'), 'utf8');
  for (const capability of ['browser_open', 'browser_act', 'transaction_prepare', 'transaction_authorize']) {
    assert.ok(getActionContract(capability), `${capability} must exist`);
    assert.ok(!playbookFile.includes(`'${capability}'`),
      `${capability} must not be defined or gated by the playbook file`);
  }
  // And the playbook is text: nothing in the runtime branches on which playbook matched.
  assert.ok(playbooksFor('buy me a kettle').includes('purchasing'));
  assert.deepEqual(playbooksFor('read the water hardness for my postcode'), []);
});

// ── The capabilities the legacy loop used to own still exist ──────────────────────────────

test('every behaviour the ordering loop owned now lives in a general layer', () => {
  // Guest checkout — was a shopping-agent feature, is generic account-wall navigation.
  assert.equal(typeof browserAccess.continueWithoutAccount, 'function');
  assert.equal(typeof browserAccess.detectAccessWall, 'function');
  // Waiting for a page transition and telling whether a step advanced — general verification.
  assert.equal(typeof browserAccess.waitForSettled, 'function');
  assert.equal(typeof browserAccess.stepAdvanced, 'function');
  assert.equal(typeof browserAccess.snapshot, 'function');
  // Recovering from a page that changed under us — general execution.
  assert.equal(typeof browserAccess.assessProgress, 'function');
  assert.equal(typeof browserAccess.computeProgressSignature, 'function');
  // 3DS / payment completion — a general transaction abstraction.
  assert.equal(typeof transaction.prepare, 'function');
  assert.equal(typeof transaction.commit, 'function');
  assert.equal(typeof transaction.watch, 'function');
  assert.equal(typeof transaction.classifyPaymentOutcome, 'function');
  // Signing in with a stored credential — general, and grant-gated.
  assert.equal(typeof browserAccess.signInWithStoredCredential, 'function');
  // Perception and the primitives themselves.
  for (const fn of ['open', 'observe', 'act', 'close', 'fillKnownDetails']) {
    assert.equal(typeof browserEnvironment[fn], 'function', `browser environment must provide ${fn}`);
  }
});

test('site-specific knowledge is data the runtime consults, not machinery it is built from', () => {
  const { createSiteKnowledge } = require('../../api/services/site-knowledge');
  const store = createSiteKnowledge({});

  // A known host offers an entry point...
  const known = store.forHost('johnlewis.com', { term: 'wool socks' });
  assert.equal(known.known, true);
  assert.match(known.entryPoints.search, /johnlewis\.com/);
  assert.equal(known.entryPoints.searchSource, 'authored');

  // ...and an unknown one simply has nothing to say, which must remain workable.
  const unknown = store.forHost('some-shop.invalid', { term: 'wool socks' });
  assert.equal(unknown.known, false);
  assert.equal(unknown.entryPoints.search, null);

  // The store returns facts and executes nothing.
  const source = require('node:fs').readFileSync(require.resolve('../../api/services/site-knowledge.js'), 'utf8');
  assert.doesNotMatch(source, /page\.(click|fill|goto)/, 'site knowledge must not drive a page');
});

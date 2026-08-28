// Paying for something through the general runtime.
//
// These behaviours were built against the legacy ordering loop and must survive its removal
// unchanged: a durable approval the user's bare "yes" can resolve deterministically, a spend
// cap consumed only by a real charge, a bank challenge treated as a pause rather than a
// failure, and a decline reported honestly. They now run on transaction_prepare /
// transaction_authorize / transaction_status, which are not shopping-specific.

const assert = require('node:assert/strict');
const test = require('node:test');

const browserActions = require('../../api/actions/browser');
const transaction = require('../../api/services/transaction');
const browserSession = require('../../api/services/browser-session');
const browserEnvironment = require('../../api/services/browser-environment');
const { getActionContract } = require('../../api/action-contracts');

const handlers = browserActions.handlers;

function fakeSupabase() {
  const chain = {
    from() { return chain; },
    select() { return chain; },
    eq() { return chain; },
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return chain;
}

function fakeDeps(overrides = {}) {
  return {
    supabase: fakeSupabase(),
    guardConciergeSpend: async () => ({ ok: true }),
    setPendingAction: async () => {},
    ...overrides,
  };
}

// Stand in for a live browser session so the handlers can be driven without Chromium.
function withFakeSession(userId, fields = {}) {
  const session = {
    userId,
    site: 'shop.example',
    goal: 'buy a kettle',
    page: { url: () => 'https://shop.example/checkout' },
    ...fields,
  };
  browserSession._liveSessions.set(userId, { ...session, lastActivityAt: Date.now() });
  return () => browserSession._liveSessions.delete(userId);
}

// ── The gate ──────────────────────────────────────────────────────────────────────────────

test('committing money is review-gated by the contract, not by the code that does the paying', () => {
  const authorize = getActionContract('transaction_authorize');
  assert.equal(authorize.executionMode, 'review');
  assert.equal(authorize.confirmation, 'review_required');

  // Preparing and checking are not spending, so they must not need approval — otherwise the
  // agent cannot even find out what something costs without interrupting the person.
  assert.equal(getActionContract('transaction_prepare').executionMode, 'direct');
  assert.equal(getActionContract('transaction_status').executionMode, 'direct');
});

test('the legacy ordering action and its payment follow-ups are gone', () => {
  for (const gone of [
    'run_browser_task', 'confirm_browser_payment', 'cancel_browser_payment',
    'confirm_credential_use', 'cancel_credential_use',
  ]) {
    assert.equal(getActionContract(gone), null, `${gone} must no longer be a capability`);
    assert.equal(handlers[gone], undefined, `${gone} must no longer have a handler`);
  }
});

// ── prepare: read the amount, never commit ────────────────────────────────────────────────

test('preparing a payment reports the parsed amount and never charges', async () => {
  const original = transaction.prepare;
  let committed = false;
  const originalCommit = transaction.commit;
  transaction.commit = async () => { committed = true; return { state: 'confirmed' }; };
  transaction.prepare = async () => ({
    ok: true, ready: true, commitLabel: 'Pay now', raw: '£48.75', amount: 48.75, currency: 'GBP', filledCard: 4,
  });
  try {
    const result = await handlers.transaction_prepare({ userId: 'u1', deps: fakeDeps() });
    assert.equal(result.success, true);
    assert.equal(committed, false, 'preparing must never commit');
    assert.equal(result.subject.amount, '£48.75');
    assert.match(result.text, /£48\.75/);
  } finally {
    transaction.prepare = original;
    transaction.commit = originalCommit;
  }
});

test('an unreadable total refuses to ask for approval rather than approving a guess', async () => {
  const original = transaction.prepare;
  transaction.prepare = async () => ({ ok: true, ready: true, commitLabel: 'Pay now', raw: null, amount: null, currency: null });
  try {
    const result = await handlers.transaction_prepare({ userId: 'u1', deps: fakeDeps() });
    assert.equal(result.success, false);
    assert.match(result.error, /could not read a total/i);
    assert.match(result.error, /Nothing was charged/);
  } finally {
    transaction.prepare = original;
  }
});

test('a failed spend-cap check stops before the person is ever asked to approve', async () => {
  const original = transaction.prepare;
  transaction.prepare = async () => ({ ok: true, ready: true, commitLabel: 'Pay now', raw: '£900.00', amount: 900, currency: 'GBP' });
  try {
    const result = await handlers.transaction_prepare({
      userId: 'u1',
      deps: fakeDeps({ guardConciergeSpend: async () => ({ ok: false, error: 'Over your per-transaction limit.' }) }),
    });
    assert.equal(result.success, false);
    assert.match(result.error, /Over your per-transaction limit/);
  } finally {
    transaction.prepare = original;
  }
});

test('a page that is not at the payment step yet is reported as incomplete, not failed', async () => {
  const original = transaction.prepare;
  transaction.prepare = async () => ({ ok: true, ready: false, advanceLabel: 'Continue to payment', raw: null });
  try {
    const result = await handlers.transaction_prepare({ userId: 'u1', deps: fakeDeps() });
    assert.equal(result.outcome, 'incomplete');
    assert.match(result.text, /Continue to payment/);
  } finally {
    transaction.prepare = original;
  }
});

// ── authorize: the amount is re-read at commit ────────────────────────────────────────────

test('authorising re-reads the amount at commit and refuses one that is now over the cap', async () => {
  const original = transaction.commit;
  let seenAuthorize = null;
  transaction.commit = async (userId, { authorize }) => {
    seenAuthorize = authorize;
    // The page now says a different, larger figure than the one that was approved.
    const verdict = await authorize({ raw: '£900.00', amount: 900, currency: 'GBP' });
    return verdict.ok ? { state: 'confirmed' } : { state: 'refused', error: verdict.error };
  };
  try {
    const result = await handlers.transaction_authorize({
      userId: 'u1',
      context: {},
      deps: fakeDeps({
        guardConciergeSpend: async (_u, amount) => (amount > 100 ? { ok: false, error: 'Over your limit.' } : { ok: true }),
      }),
    });
    assert.ok(seenAuthorize, 'commit must be given an authorize callback');
    assert.equal(result.success, false);
    assert.match(result.error, /Over your limit/);
  } finally {
    transaction.commit = original;
  }
});

test('an amount that cannot be read at commit refuses the charge', async () => {
  const original = transaction.commit;
  transaction.commit = async (userId, { authorize }) => {
    const verdict = await authorize({ raw: null, amount: null, currency: null });
    return verdict.ok ? { state: 'confirmed' } : { state: 'refused', error: verdict.error };
  };
  try {
    const result = await handlers.transaction_authorize({ userId: 'u1', context: {}, deps: fakeDeps() });
    assert.equal(result.success, false);
    assert.match(result.error, /could not read the amount/i);
    assert.match(result.error, /Nothing was charged/);
  } finally {
    transaction.commit = original;
  }
});

// ── outcomes ──────────────────────────────────────────────────────────────────────────────

test('a bank challenge is a pause that re-arms a deterministic approval, not a failure', async () => {
  const original = transaction.commit;
  const parked = [];
  let capCharged = false;
  transaction.commit = async () => ({
    state: 'awaiting_authorization',
    text: 'Your bank is asking you to approve this in your banking app.',
  });
  try {
    const result = await handlers.transaction_authorize({
      userId: 'u1',
      context: {},
      deps: fakeDeps({
        setPendingAction: async (_u, action) => { parked.push(action.type); },
        guardConciergeSpend: async (_u, _a, _c, opts) => { if (!opts) capCharged = true; return { ok: true }; },
      }),
    });
    assert.equal(result.outcome, 'awaiting_user');
    assert.equal(result.pending, true);
    assert.equal(result.confirmation, 'review_required');
    assert.match(result.text, /banking app/);
    // The next "check now" must resolve without the model having to remember what to call.
    assert.deepEqual(parked, ['transaction_status'], 'a waiting bank approval re-arms transaction_status');
    assert.equal(capCharged, false, 'a wait must not consume the daily spend cap');
  } finally {
    transaction.commit = original;
  }
});

test('a decline is reported as a real error and never re-armed', async () => {
  const original = transaction.commit;
  const parked = [];
  transaction.commit = async () => ({ state: 'declined', error: 'The payment was declined by the card issuer.' });
  try {
    const result = await handlers.transaction_authorize({
      userId: 'u1', context: {},
      deps: fakeDeps({ setPendingAction: async (_u, a) => { parked.push(a.type); } }),
    });
    assert.equal(result.success, false);
    assert.match(result.error, /declined/i);
    assert.deepEqual(parked, [], 'a decline must not be presented as something to retry with "yes"');
  } finally {
    transaction.commit = original;
  }
});

test('only a confirmed charge consumes the daily spend cap, and it is recorded once', async () => {
  const restore = withFakeSession('u1', { committedTotal: '£48.75' });
  const originalCommit = transaction.commit;
  const originalRecord = transaction.recordConfirmedPurchase;
  const originalRead = browserEnvironment.readPageText;
  const consumed = [];
  const recorded = [];
  transaction.commit = async () => ({ state: 'confirmed', amount: { raw: '£48.75', amount: 48.75, currency: 'GBP' } });
  transaction.recordConfirmedPurchase = async (userId) => { recorded.push(userId); return 'purchase-1'; };
  browserEnvironment.readPageText = async () => 'Thank you for your order. Order number: A-1';
  try {
    const result = await handlers.transaction_authorize({
      userId: 'u1', context: {},
      deps: fakeDeps({
        guardConciergeSpend: async (_u, amount, currency, opts) => {
          if (!opts) consumed.push({ amount, currency });
          return { ok: true };
        },
      }),
    });
    assert.equal(result.success, true);
    assert.match(result.text, /went through/);
    assert.equal(result.purchaseId, 'purchase-1');
    assert.deepEqual(recorded, ['u1'], 'a confirmed charge is recorded exactly once');
    assert.equal(consumed.length, 1, 'the daily cap is consumed exactly once');
    assert.equal(consumed[0].amount, 48.75);
  } finally {
    transaction.commit = originalCommit;
    transaction.recordConfirmedPurchase = originalRecord;
    browserEnvironment.readPageText = originalRead;
    restore();
  }
});

test('checking status after a bank approval reports the real outcome', async () => {
  const restore = withFakeSession('u1', { committedTotal: '£10.00' });
  const originalWatch = transaction.watch;
  const originalRecord = transaction.recordConfirmedPurchase;
  const originalRead = browserEnvironment.readPageText;
  transaction.watch = async () => ({ state: 'confirmed', amount: { raw: '£10.00', amount: 10, currency: 'GBP' } });
  transaction.recordConfirmedPurchase = async () => 'purchase-2';
  browserEnvironment.readPageText = async () => 'Payment successful';
  try {
    const result = await handlers.transaction_status({ userId: 'u1', context: {}, deps: fakeDeps() });
    assert.equal(result.success, true);
    assert.match(result.text, /went through/);
  } finally {
    transaction.watch = originalWatch;
    transaction.recordConfirmedPurchase = originalRecord;
    browserEnvironment.readPageText = originalRead;
    restore();
  }
});

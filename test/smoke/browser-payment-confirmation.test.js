// A bare "yes" to a ready_for_payment prompt must not depend on the model remembering, on
// its own, to call confirm_browser_payment — that's exactly what failed live on 2026-08-26
// (the model replied as if no progress had been made at all, even though the real basket and
// total had just been found). runBrowserTask now registers the same durable approval every
// other review-gated action gets (setPendingAction), so the existing deterministic yes/no
// matching in /chat (getPendingAction) resolves it — not model judgment.

const assert = require('node:assert/strict');
const test = require('node:test');

const browserActions = require('../../api/actions/browser');
const browserTask = require('../../api/services/browser-task');

function fakeSupabase() {
  const chain = {
    from() { return chain; },
    select() { return chain; },
    eq() { return chain; },
    maybeSingle: async () => ({ data: null, error: null })
  };
  return chain;
}

function fakeDeps(overrides = {}) {
  return {
    supabase: fakeSupabase(),
    FAST_MODEL: 'fake-model',
    parsePrice: (v) => Number(String(v).replace(/[^\d.]/g, '')) || null,
    guardConciergeSpend: async () => ({ ok: true }),
    generateBrain: async () => ({}),
    webSearchBrain: async () => ({}),
    setPendingAction: async () => { throw new Error('setPendingAction should have been overridden in this test'); },
    ...overrides
  };
}

test('reaching ready_for_payment registers a durable, deterministic approval', async () => {
  const originalRunOrderingTurn = browserTask.runOrderingTurn;
  browserTask.runOrderingTurn = async () => ({
    type: 'ready_for_payment',
    total: '£48.75',
    summary: 'Checkout — payment step, total £48.75',
    taskId: 'task-1'
  });

  const pendingActionCalls = [];
  const deps = fakeDeps({
    setPendingAction: async (userId, action, context) => {
      pendingActionCalls.push({ userId, action, context });
      return { approvalId: 'approval-1' };
    }
  });

  try {
    const result = await browserActions.handlers.run_browser_task({
      userId: 'user123',
      action: 'run_browser_task',
      params: { goal: 'resume and pay' },
      enrichedParams: {},
      context: { userMessage: 'yes' },
      deps,
      helpers: {}
    });

    assert.equal(pendingActionCalls.length, 1, 'setPendingAction must be called exactly once');
    assert.deepEqual(pendingActionCalls[0].action, { type: 'confirm_browser_payment', input: {} });
    assert.equal(pendingActionCalls[0].userId, 'user123');
    // The SAME context this action call received travels through — same shape
    // action-execution.js's own generic review gate already relies on.
    assert.equal(pendingActionCalls[0].context.userMessage, 'yes');
    assert.equal(result.pending, true);
    assert.equal(result.outcome, 'awaiting_user');
    assert.equal(result.confirmation, 'review_required');
  } finally {
    browserTask.runOrderingTurn = originalRunOrderingTurn;
  }
});

test('a completed order does not register a payment approval — only ready_for_payment does', async () => {
  const originalRunOrderingTurn = browserTask.runOrderingTurn;
  browserTask.runOrderingTurn = async () => ({
    type: 'done',
    text: 'Order placed.'
  });

  const pendingActionCalls = [];
  const deps = fakeDeps({
    setPendingAction: async (userId, action, context) => {
      pendingActionCalls.push({ userId, action, context });
      return { approvalId: 'should-not-happen' };
    }
  });

  try {
    const result = await browserActions.handlers.run_browser_task({
      userId: 'user123',
      action: 'run_browser_task',
      params: { goal: 'resume' },
      enrichedParams: {},
      context: {},
      deps,
      helpers: {}
    });

    assert.equal(pendingActionCalls.length, 0);
    assert.equal(result.success, true);
  } finally {
    browserTask.runOrderingTurn = originalRunOrderingTurn;
  }
});

test('a failed guardConciergeSpend check stops before any approval is registered', async () => {
  const originalRunOrderingTurn = browserTask.runOrderingTurn;
  browserTask.runOrderingTurn = async () => ({
    type: 'ready_for_payment',
    total: '£999.00',
    summary: 'Checkout — payment step, total £999.00',
    taskId: 'task-2'
  });

  const pendingActionCalls = [];
  const deps = fakeDeps({
    guardConciergeSpend: async () => ({ ok: false, error: 'Over the daily spend cap.' }),
    setPendingAction: async (userId, action, context) => {
      pendingActionCalls.push({ userId, action, context });
      return { approvalId: 'should-not-happen' };
    }
  });

  try {
    const result = await browserActions.handlers.run_browser_task({
      userId: 'user123',
      action: 'run_browser_task',
      params: { goal: 'resume and pay' },
      enrichedParams: {},
      context: {},
      deps,
      helpers: {}
    });

    assert.equal(pendingActionCalls.length, 0);
    assert.equal(result.success, false);
    assert.match(result.error, /spend cap/i);
  } finally {
    browserTask.runOrderingTurn = originalRunOrderingTurn;
  }
});

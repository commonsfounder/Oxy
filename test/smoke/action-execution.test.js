const assert = require('node:assert/strict');
const test = require('node:test');

const { createActionExecution } = require('../../api/services/action-execution');

// Local adapter for this file's older `executeAction(userId, type, input, context)` seam.
// The production boundary is createActionExecution; nothing else wraps it.
function createActionRunner(options = {}) {
  const { executeAction, ...rest } = options;
  const invokeAdapter = rest.invokeAdapter || (typeof executeAction === 'function'
    ? ({ userId, type, input, context }) => executeAction(userId, type, input, context)
    : null);
  return createActionExecution({ ...rest, invokeAdapter });
}
const { getActionContract } = require('../../api/action-contracts');
const { adapterForAction } = require('../../api/services/action-catalog');

function syntheticResolver(type) {
  if (type === 'action_a' || type === 'action_b') {
    return { risk: 'low', confirmation: 'none', executionMode: 'direct', modelVisible: true, availability: 'registered', adapter: { kind: 'inline' } };
  }
  return getActionContract(type);
}

function syntheticAdapterResolver(type) {
  return syntheticResolver(type)?.adapter || adapterForAction(type);
}

test('action runner parks high-risk actions for review', async () => {
  const pending = [];
  const logs = [];
  const executeActions = createActionRunner({
    executeAction: async () => {
      throw new Error('should not execute before review');
    },
    setPendingAction: async (userId, action, context) => pending.push({ userId, action, context }),
    logAction: async (userId, action, result) => logs.push({ userId, action, result }),
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'send_email', input: { to: 'josh@example.com', body: 'Can we meet Friday?' } }
  ], { userMessage: 'email Josh saying can we meet Friday' });

  assert.equal(result[0].result.pending, true);
  assert.equal(result[0].result.actionSummary, 'Email ready to send');
  assert.equal(pending.length, 1);
  assert.equal(logs[0].result.pending, true);
});

test('appointment booking waits for an explicit OK before it runs', async () => {
  const pending = [];
  let executed = false;
  const executeActions = createActionRunner({
    executeAction: async () => { executed = true; return { success: true }; },
    setPendingAction: async (userId, action) => pending.push({ userId, action }),
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });
  const result = await executeActions('user-1', [{ type: 'book_appointment', input: {
    task_id: 'appointment-task-1', choice_id: 'slot-1', choice_label: 'Tue 11 Aug, 6:30 pm', service: 'dentist'
  } }], { userMessage: 'book option 1' });
  assert.equal(executed, false);
  assert.equal(pending.length, 1);
  assert.equal(result[0].result.pending, true);
  assert.equal(result[0].result.actionSummary, 'Appointment ready to book');
});

test('action runner parks high-risk actions for review even inside an agent loop iteration', async () => {
  // Regression guard: agentIteration:true routes through the sequential execution
  // path (action-execution.js), which is a separate code path from the parallel one.
  // Money actions must hit the same review gate on both paths.
  const pending = [];
  const executeActions = createActionRunner({
    executeAction: async () => {
      throw new Error('should not execute before review, even in an agent loop');
    },
    setPendingAction: async (userId, action, context) => pending.push({ userId, action, context }),
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'spend_from_concierge_account', input: { amount: 25.5, description: 'book table at restaurant' } }
  ], { userMessage: 'spend $25.50 booking a table', agentIteration: true });

  assert.equal(result[0].result.pending, true);
  assert.equal(pending.length, 1);
});

test('action runner opens Uber directly because payment is confirmed in Uber', async () => {
  let executed = false;
  const executeActions = createActionRunner({
    executeAction: async () => {
      executed = true;
      return { success: true, text: 'Opening Uber.' };
    },
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'book_uber', input: { destination: "the nearest McDonald's" } }
  ], { userMessage: "get me an Uber to the nearest McDonald's" });

  assert.equal(executed, true);
  assert.equal(result[0].result.pending, undefined);
  assert.equal(result[0].result.actionSummary, 'Uber opened');
});

test('action runner executes reviewed action when bypassReview is set', async () => {
  const executed = [];
  const executeActions = createActionRunner({
    executeAction: async (userId, type, input) => {
      executed.push({ userId, type, input });
      return { success: true, text: 'Email sent.' };
    },
    setPendingAction: async () => {
      throw new Error('should not park confirmed action');
    },
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'send_email', input: { to: 'josh@example.com', body: 'Can we meet Friday?' } }
  ], { bypassReview: true });

  assert.equal(executed.length, 1);
  assert.equal(result[0].result.success, true);
  assert.equal(result[0].result.actionSummary, 'Email sent');
});

test('action runner simulates parallel actions without invoking the executor', async () => {
  let executed = 0;
  const executeActions = createActionRunner({
    executeAction: async () => { executed += 1; return { success: true }; },
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'find_place', input: { query: 'coffee' } },
    { type: 'get_weather', input: { city: 'London' } }
  ], { simulate: true });

  assert.equal(executed, 0);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(entry => [entry.result.success, entry.result.outcome]), [
    [false, 'simulated'],
    [false, 'simulated']
  ]);
});

test('action runner validates required fields before execution', async () => {
  let executed = false;
  const executeActions = createActionRunner({
    executeAction: async () => {
      executed = true;
      return { success: true };
    },
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'find_place', input: {} }
  ]);

  assert.equal(executed, false);
  assert.equal(result[0].result.success, false);
  assert.match(result[0].result.error, /query/);
});

test('action runner adds recovery metadata to failed direct actions', async () => {
  const executeActions = createActionRunner({
    executeAction: async () => ({
      success: false,
      error: 'I need your current location to find a nearby gym.'
    }),
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'find_place', input: { query: 'closest gym near me' } }
  ]);

  assert.equal(result[0].result.cardText, "Turn location on and I'll try again.");
  assert.equal(result[0].result.retryable, true);
});

test('action runner adds connector health metadata to connector failures', async () => {
  const executeActions = createActionRunner({
    executeAction: async () => ({
      success: false,
      error: 'Google not connected: token expired. Reconnect Google from Settings.'
    }),
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'get_emails', input: { max_results: 5 } }
  ]);

  assert.equal(result[0].result.connectorId, 'google');
  assert.equal(result[0].result.healthStatus, 'needs_reconnect');
  assert.equal(result[0].result.recoveryAction.connectorId, 'google');
  assert.match(result[0].result.cardText, /Reconnect Google/);
});

test('a later action throwing in a sequential batch does not discard earlier successful results', async () => {
  // Regression guard: sequential (agent-loop) execution runs one executeActions
  // call for the whole batch. If a single action's executeAction throws, only
  // that action should end up marked failed — not every action in the batch,
  // which would misreport an already-completed side effect (e.g. a sent email)
  // as failed and risk a duplicate retry.
  const executeActions = createActionRunner({
    resolveContract: syntheticResolver,
    resolveAdapter: syntheticAdapterResolver,
    executeAction: async (userId, type) => {
      if (type === 'action_a') return { success: true, text: 'Sent.' };
      throw new Error('connector timed out');
    },
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'action_a', input: {} },
    { type: 'action_b', input: {} }
  ], { sequential: true });

  assert.equal(result[0].result.success, true);
  assert.equal(result[0].result.text, 'Sent.');
  assert.equal(result[1].result.success, false);
});

test('action runner looks up the linked card for money actions and passes it into the review card', async () => {
  const pending = [];
  const lookups = [];
  const executeActions = createActionRunner({
    executeAction: async () => { throw new Error('should not execute before review'); },
    setPendingAction: async (userId, action, context) => pending.push({ userId, action, context }),
    getLinkedCardInfo: async (userId) => { lookups.push(userId); return { brand: 'visa', last4: '4242' }; },
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'spend_from_concierge_account', input: { amount: 12, description: 'coffee' } }
  ], { userMessage: 'spend $12 on coffee' });

  assert.deepEqual(lookups, ['user-1']);
  assert.equal(result[0].result.cardText, 'Charge your visa card ending in 4242 $12.00 for coffee.');
});

test('action runner does not look up a linked card for non-money review actions', async () => {
  const lookups = [];
  const executeActions = createActionRunner({
    executeAction: async () => { throw new Error('should not execute before review'); },
    setPendingAction: async () => {},
    getLinkedCardInfo: async (userId) => { lookups.push(userId); return null; },
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  await executeActions('user-1', [
    { type: 'send_email', input: { to: 'josh@example.com', body: 'hi' } }
  ], { userMessage: 'email josh' });

  assert.deepEqual(lookups, []);
});

// ── A logging failure must never fail the action it is logging, or the batch. A PostgREST
// insert is thenable but has no `.catch`, so chaining one throws synchronously and turns a
// whole iteration into a false failure. safeLogAction uses a real try/await/catch instead.
function fakeSupabaseBuilder() {
  // Mimics supabase-js's PostgrestFilterBuilder: thenable, but `.catch` is not an own method.
  return { then(resolve) { resolve(); } };
}

test('a logAction that returns a thenable-without-.catch (Supabase-shaped) does not fail the action, sequential mode, no trace', async () => {
  const executeActions = createActionRunner({
    resolveContract: syntheticResolver,
    resolveAdapter: syntheticAdapterResolver,
    executeAction: async (userId, type) => ({ success: true, text: `ok:${type}` }),
    setPendingAction: async () => {},
    logAction: () => fakeSupabaseBuilder(),
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'calculate', input: { expression: '1+1' } }
  ], { sequential: true }, null);

  assert.equal(result[0].result.success, true);
  assert.equal(result[0].result.text, 'ok:calculate');
});

test('a logAction that returns a thenable-without-.catch does not fail the action, parallel mode, no trace', async () => {
  const executeActions = createActionRunner({
    executeAction: async (userId, type) => ({ success: true, text: `ok:${type}` }),
    setPendingAction: async () => {},
    logAction: () => fakeSupabaseBuilder(),
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'calculate', input: { expression: '1+1' } }
  ], {}, null);

  assert.equal(result[0].result.success, true);
});

test('a logAction that rejects is non-fatal and does not touch the action result, with or without a trace', async () => {
  const executeActions = createActionRunner({
    executeAction: async (userId, type) => ({ success: true, text: `ok:${type}` }),
    setPendingAction: async () => {},
    logAction: async () => { throw new Error('db connection lost'); },
    invalidateUserContextCache: () => {}
  });

  const noTrace = await executeActions('user-1', [{ type: 'calculate', input: { expression: '1+1' } }], { sequential: true }, null);
  assert.equal(noTrace[0].result.success, true);

  const trace = { async run(label, fn) { return fn(); } };
  const withTrace = await executeActions('user-1', [{ type: 'calculate', input: { expression: '1+1' } }], { sequential: true }, trace);
  assert.equal(withTrace[0].result.success, true);
});

test('one action\'s logging failure in a multi-action sequential batch does not poison the other actions\' results', async () => {
  // This is the batch-poisoning shape of the real bug: before the fix, a synchronous throw
  // from the FIRST action's log step escaped executeActions entirely, and the caller
  // (agent-orchestrator.js) mapped the whole batch to failure — including the second action,
  // which never even ran yet, and any action before it that had already succeeded.
  let logCalls = 0;
  const executeActions = createActionRunner({
    resolveContract: syntheticResolver,
    resolveAdapter: syntheticAdapterResolver,
    executeAction: async (userId, type) => ({ success: true, text: `ok:${type}` }),
    setPendingAction: async () => {},
    logAction: () => {
      logCalls += 1;
      if (logCalls === 1) return fakeSupabaseBuilder(); // first action's log is Supabase-shaped
      throw new Error('second log failed for a different reason'); // second fails differently
    },
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'action_a', input: {} },
    { type: 'action_b', input: {} }
  ], { sequential: true }, null);

  assert.equal(result.length, 2);
  assert.equal(result[0].result.success, true, 'first action must not be poisoned by the second action\'s later log failure');
  assert.equal(result[1].result.success, true, 'second action must not be poisoned by its own log failure');
});

test('a logging failure is reported via console.warn, not silently dropped with no trace of it happening', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const executeActions = createActionRunner({
      executeAction: async () => ({ success: true }),
      setPendingAction: async () => {},
      logAction: async () => { throw new Error('db connection lost'); },
      invalidateUserContextCache: () => {}
    });
    await executeActions('user-1', [{ type: 'calculate', input: {} }], { sequential: true }, null);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some(w => w.includes('log failed') && w.includes('db connection lost')));
});

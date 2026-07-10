const assert = require('node:assert/strict');
const test = require('node:test');

const { createActionRunner } = require('../../api/services/action-runner');

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
  assert.equal(result[0].result.actionSummary, 'Review email');
  assert.equal(pending.length, 1);
  assert.equal(logs[0].result.pending, true);
});

test('action runner parks high-risk actions for review even inside an agent loop iteration', async () => {
  // Regression guard: agentIteration:true routes through the sequential execution
  // path (action-runner.js), which is a separate code path from the parallel one.
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

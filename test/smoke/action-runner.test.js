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

  assert.equal(result[0].result.cardText, 'Enable location and try again.');
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

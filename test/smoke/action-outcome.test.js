const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const {
  ACTION_OUTCOMES,
  inferActionOutcome,
  normalizeActionOutcome
} = require('../../api/services/action-outcome');

const brainProvider = require('../../api/services/brain-provider');
const { runAgentLoop, reflectOnResults } = require('../../api/services/agent-orchestrator');
const taskManager = require('../../api/services/task-manager');
const { executeAction, agenticFailurePayload, runAgenticTurn } = require('../../api');

test('action outcomes are bounded and legacy success is a strict completed view', () => {
  assert.deepEqual(ACTION_OUTCOMES, [
    'completed', 'handoff_required', 'awaiting_user', 'simulated',
    'unavailable', 'failed', 'incomplete'
  ]);
  assert.deepEqual(normalizeActionOutcome({ success: true, text: 'sent' }), {
    success: true,
    outcome: 'completed',
    text: 'sent'
  });
  assert.equal(normalizeActionOutcome({ success: true, pending: true }).success, false);
  assert.equal(normalizeActionOutcome({ success: true, pending: true }).outcome, 'awaiting_user');
  assert.equal(normalizeActionOutcome({ success: true, deepLink: 'https://maps.example/place/1' }).success, true);
  assert.equal(normalizeActionOutcome({ success: true, deepLink: 'sms:+1', handoffRequired: true }).success, false);
  assert.equal(normalizeActionOutcome({ success: true, deepLink: 'sms:+1', handoffRequired: true }).outcome, 'handoff_required');
  assert.equal(normalizeActionOutcome({ success: true, simulated: true }).success, false);
  assert.equal(normalizeActionOutcome({ success: true, simulated: true }).outcome, 'simulated');
});

test('existing explicit outcomes win over legacy fields', () => {
  assert.equal(inferActionOutcome({ success: false, outcome: 'completed' }), 'completed');
  assert.equal(normalizeActionOutcome({ success: true, outcome: 'unavailable' }).success, false);
});

function toolResponse(name = 'send_email') {
  const call = { id: 'call-1', name, args: {} };
  return {
    text: 'Done.',
    functionCalls: [call],
    candidates: [{ content: { parts: [{ functionCall: call }], role: 'model' } }]
  };
}

test('missing executor is unavailable and never fabricates an executed action', async (t) => {
  const original = brainProvider.callToolsBrain;
  let modelCalls = 0;
  t.after(() => { brainProvider.callToolsBrain = original; });
  brainProvider.callToolsBrain = async () => { modelCalls += 1; return toolResponse('send_email'); };

  const result = await runAgentLoop({ userId: 'user-1', initialMessage: 'send it', maxIterations: 1 });
  assert.equal(result.actions.length, 0);
  assert.equal(result.agentTrace.status, 'error');
  assert.equal(modelCalls, 0);
  assert.match(result.spoken, /actions are unavailable/i);
});

test('agentic settlement failure preserves receipts and returns bounded retry copy', () => {
  const payload = agenticFailurePayload([
    { action: 'send_email', result: { success: true, text: 'Message sent.', actionSummary: 'Message sent' } }
  ]);
  assert.equal(payload.text, 'The turn stopped after starting. It was not retried.');
  assert.equal(payload.actions.length, 1);
  assert.equal(payload.actions[0].result.outcome, 'completed');
  assert.equal(payload.error, undefined);
});

test('agentic settlement failure preserves its receipt without automatic retry', async () => {
  let effects = 0;
  const turn = await runAgenticTurn({
    runLoop: async () => {
      effects += 1;
      return {
        spoken: 'Message sent.',
        actions: [{ action: 'send_email', result: { success: true, text: 'Message sent.' } }]
      };
    },
    settle: async () => { throw new Error('checkpoint failed'); }
  });
  assert.equal(effects, 1);
  assert.equal(turn.ok, false);
  assert.equal(turn.failure.text, 'The turn stopped after starting. It was not retried.');
  assert.equal(turn.failure.actions.length, 1);
  assert.equal(turn.failure.actions[0].result.outcome, 'completed');
});

test('max iteration exhaustion is incomplete, not completed', async (t) => {
  const original = brainProvider.callToolsBrain;
  t.after(() => { brainProvider.callToolsBrain = original; });
  brainProvider.callToolsBrain = async () => toolResponse('calculate');

  const result = await runAgentLoop({
    userId: 'user-1',
    initialMessage: 'do this',
    maxIterations: 1,
    executeActionsFn: async (_userId, actions) => actions.map(action => ({
      action: action.type,
      result: { success: true, text: 'performed' }
    }))
  });
  assert.equal(result.agentTrace.status, 'incomplete');
  assert.equal(result.spoken, 'The action is incomplete.');
  assert.doesNotMatch(result.spoken, /^done[.!]?$/i);
});

test('reflection parse failure is unknown rather than achieved', async (t) => {
  const original = brainProvider.callToolsBrain;
  t.after(() => { brainProvider.callToolsBrain = original; });
  brainProvider.callToolsBrain = async () => ({ text: 'not json' });

  const result = await reflectOnResults('do this', [], []);
  assert.equal(result.achieved, false);
  assert.equal(result.issues[0], 'reflection_parse_failed');
});

test('calculate failure is reported as failed, never approximate success', async () => {
  const result = await executeAction('user-1', 'calculate', { expression: '(' });
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'failed');
  assert.match(result.error, /could not calculate/i);
});

test('simulation is explicitly simulated even when its history cannot be saved', async (t) => {
  const original = taskManager.recordSimulation;
  t.after(() => { taskManager.recordSimulation = original; });
  taskManager.recordSimulation = async () => { throw new Error('storage unavailable'); };

  const result = await executeAction('user-1', 'simulate_actions', { goal: 'send an email', actions: ['send_email'] });
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'simulated');
  assert.equal(result.simulated, true);
  assert.match(result.text, /could not be saved/i);
});

test('known placeholder capabilities are unavailable rather than claimed complete', async () => {
  for (const [action, input] of [
    ['log_health', { metric: 'steps', value: 10 }],
    ['control_smart_home', { device: 'lights', command: 'on' }],
    ['edit_photo', { brief: 'enhance' }],
    ['analyze_image', { prompt: 'describe it' }],
    ['mcp_tool', { name: 'unknown_tool', arguments: {} }]
  ]) {
    const result = await executeAction('user-1', action, input);
    assert.equal(result.success, false, action);
    assert.equal(result.outcome, 'unavailable', action);
  }
});

test('Notion and concierge money actions stay bounded when no real target or rail exists', async () => {
  const cases = [
    ['save_to_notion', { title: 'Receipt', content: 'A note' }],
    ['check_concierge_balance', {}],
    ['spend_from_concierge_account', { amount: 5, description: 'test' }],
    ['top_up_concierge_account', { amount: 5 }],
    ['receive_to_concierge_account', { amount: 5, description: 'test' }],
    ['fund_opportunity', { amount: 5, opportunity: 'test' }],
    ['stripe_charge', { amount: 500, description: 'test' }]
  ];
  for (const [action, input] of cases) {
    const result = await executeAction('user-without-connectors', action, input);
    assert.equal(result.success, false, action);
    assert.ok(['unavailable', 'failed'].includes(result.outcome), `${action}: ${result.outcome}`);
  }
});

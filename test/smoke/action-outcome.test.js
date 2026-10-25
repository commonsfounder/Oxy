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
  assert.match(result.spoken, /ran out of steps/i);
  assert.doesNotMatch(result.spoken, /^done[.!]?$/i);
});

test('the last allowed step is an answer from what was found, not a generic message', async (t) => {
  const original = brainProvider.callToolsBrain;
  t.after(() => { brainProvider.callToolsBrain = original; });
  let calls = 0;
  const configs = [];
  brainProvider.callToolsBrain = async (...args) => {
    calls += 1;
    configs.push(args);
    return calls < 3 ? toolResponse('calculate') : { text: 'Here is what I found: three hotels.', candidates: [{ content: { parts: [{ text: 'Here is what I found: three hotels.' }], role: 'model' } }] };
  };
  const result = await runAgentLoop({
    userId: 'user-1',
    initialMessage: 'find hotels',
    maxIterations: 3,
    executeActionsFn: async (_userId, actions) => actions.map(action => ({ action: action.type, result: { success: true, text: 'performed' } }))
  });
  assert.match(result.spoken, /three hotels/);
  assert.doesNotMatch(result.spoken, /ran out of steps/i);
});

test('a final reply that only repeats a tool status line is replaced by a real answer', async (t) => {
  const original = brainProvider.callToolsBrain;
  t.after(() => { brainProvider.callToolsBrain = original; });
  const STOCK = 'Walking directions to the gallery are ready.';
  const textOnly = (text) => ({ text, candidates: [{ content: { parts: [{ text }], role: 'model' } }] });
  let calls = 0;
  brainProvider.callToolsBrain = async () => {
    calls += 1;
    if (calls <= 2) return toolResponse('calculate');
    if (calls === 3) return textOnly(STOCK);
    return textOnly('The 08:01 gets in at 09:29, a 1h28 journey, and the walk is about 12 minutes.');
  };
  const result = await runAgentLoop({
    userId: 'user-1',
    initialMessage: 'train and walk',
    maxIterations: 6,
    executeActionsFn: async (_userId, actions) => actions.map(action => ({ action: action.type, result: { success: true, outcome: 'completed', text: STOCK } }))
  });
  assert.match(result.spoken, /09:29/);
  assert.doesNotMatch(result.spoken, /are ready/);
});

test('a genuine answer is never rewritten', async (t) => {
  const { isEchoOfToolText } = require('../../api/services/agent-final-answer');
  const actions = [{ action: 'a', result: { text: 'Walking directions to the gallery are ready.' } }, { action: 'b', result: { text: 'times' } }];
  assert.equal(isEchoOfToolText('The walk is about 12 minutes from Piccadilly, and the 08:01 arrives at 09:29.', actions), false);
  assert.equal(isEchoOfToolText('Walking directions to the gallery are ready.', actions), true);
  assert.equal(isEchoOfToolText('Walking directions to the gallery are ready.', actions.slice(0, 1)), false);
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
    ['edit_photo', { brief: 'enhance' }],
    ['analyze_image', { prompt: 'describe it' }],
    ['mcp_tool', { name: 'unknown_tool', arguments: {} }]
  ]) {
    const result = await executeAction('user-1', action, input);
    assert.equal(result.success, false, action);
    assert.equal(result.outcome, 'unavailable', action);
  }
});

test('smart-home control has a real adapter but stays unavailable without Home Assistant configuration', async () => {
  const url = process.env.HOME_ASSISTANT_URL;
  const token = process.env.HOME_ASSISTANT_TOKEN;
  delete process.env.HOME_ASSISTANT_URL;
  delete process.env.HOME_ASSISTANT_TOKEN;
  try {
    const result = await executeAction('user-1', 'control_smart_home', { device: 'light.living_room', command: 'on' });
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'unavailable');
    assert.match(result.error, /HOME_ASSISTANT_URL/);
  } finally {
    if (url === undefined) delete process.env.HOME_ASSISTANT_URL;
    else process.env.HOME_ASSISTANT_URL = url;
    if (token === undefined) delete process.env.HOME_ASSISTANT_TOKEN;
    else process.env.HOME_ASSISTANT_TOKEN = token;
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

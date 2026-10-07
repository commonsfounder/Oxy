const assert = require('node:assert/strict');
const test = require('node:test');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const { extractToolCalls } = require('../../api/services/agent-orchestrator');

test('extractToolCalls does not double-count a call present in both parts and resp.functionCalls', () => {
  // Shape seen live: @google/genai's resp.functionCalls is a derived view over the same
  // candidates[0].content.parts array, not an independent second call.
  const resp = {
    candidates: [{ content: { parts: [{ functionCall: { name: 'browser_open', args: { url: 'https://shop.example' } } }] } }],
    functionCalls: [{ name: 'browser_open', args: { url: 'https://shop.example' } }]
  };
  const calls = extractToolCalls(resp);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'browser_open');
  assert.deepEqual(calls[0].args, { url: 'https://shop.example' });
});

test('extractToolCalls falls back to parts when resp.functionCalls is absent', () => {
  const resp = {
    candidates: [{ content: { parts: [
      { functionCall: { name: 'get_weather', args: { city: 'London' } } },
      { text: 'checking now' }
    ] } }]
  };
  const calls = extractToolCalls(resp);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'get_weather');
});

test('extractToolCalls returns multiple GENUINELY different calls unchanged', () => {
  const resp = {
    functionCalls: [
      { name: 'send_email', args: { to: 'alice@x.com' } },
      { name: 'send_email', args: { to: 'bob@x.com' } }
    ]
  };
  const calls = extractToolCalls(resp);
  assert.equal(calls.length, 2);
  assert.notDeepEqual(calls[0].args, calls[1].args);
});

test('extractToolCalls returns empty array for a pure-text response', () => {
  const resp = { candidates: [{ content: { parts: [{ text: 'all done' }] } }] };
  assert.deepEqual(extractToolCalls(resp), []);
});

test('extractToolCalls handles a missing/malformed response', () => {
  assert.deepEqual(extractToolCalls(null), []);
  assert.deepEqual(extractToolCalls({}), []);
});

test('only batches made entirely of read-only lookups run side by side', () => {
  const { areIndependentReads } = require('../../api/services/agent-orchestrator');
  const call = (type) => ({ type, input: {} });
  assert.equal(areIndependentReads([call('search_flights'), call('search_hotels'), call('get_weather')]), true);
  assert.equal(areIndependentReads([call('search_flights')]), false, 'a single call has nothing to overlap with');
  assert.equal(areIndependentReads([call('search_flights'), call('send_email')]), false);
  assert.equal(areIndependentReads([call('browser_open'), call('get_weather')]), false, 'the browser keeps its order');
  assert.equal(areIndependentReads([call('get_weather'), call('not_a_real_action')]), false);
  assert.equal(areIndependentReads([]), false);
});

test('a browser that keeps making progress keeps the run going, up to a ceiling; other tools do not', async (t) => {
  const brainProvider = require('../../api/services/brain-provider');
  const { runAgentLoop } = require('../../api/services/agent-orchestrator');
  const real = brainProvider.callToolsBrain;
  t.after(() => { brainProvider.callToolsBrain = real; });
  const call = (name) => async () => ({
    text: '', functionCalls: [{ id: 'c', name, args: {} }],
    candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'c', name, args: {} } }] } }],
  });
  let calls = 0;
  const exec = async (_u, actions) => { calls += 1; return actions.map((a) => ({ action: a.type, result: { success: true, text: 'ok' } })); };
  const counting = call;

  brainProvider.callToolsBrain = counting('browser_act');
  await runAgentLoop({ userId: 'u', initialMessage: 'keep clicking', maxIterations: 2, executeActionsFn: exec });
  assert.equal(calls, 14, 'browser steps extend the run to the ceiling and no further');

  calls = 0;
  brainProvider.callToolsBrain = counting('get_weather');
  await runAgentLoop({ userId: 'u', initialMessage: 'weather again', maxIterations: 2, executeActionsFn: exec });
  assert.equal(calls, 2, 'a non-browser tool keeps the normal cap');
});

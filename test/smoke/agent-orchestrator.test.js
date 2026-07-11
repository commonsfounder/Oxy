const assert = require('node:assert/strict');
const test = require('node:test');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const { extractToolCalls } = require('../../api/services/agent-orchestrator');

test('extractToolCalls does not double-count a call present in both parts and resp.functionCalls', () => {
  // Shape seen live: @google/genai's resp.functionCalls is a derived view over the same
  // candidates[0].content.parts array, not an independent second call.
  const resp = {
    candidates: [{ content: { parts: [{ functionCall: { name: 'run_browser_task', args: { goal: 'buy shoes' } } }] } }],
    functionCalls: [{ name: 'run_browser_task', args: { goal: 'buy shoes' } }]
  };
  const calls = extractToolCalls(resp);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'run_browser_task');
  assert.deepEqual(calls[0].args, { goal: 'buy shoes' });
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

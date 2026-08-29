// A provider rate limit is a transport condition, not a task outcome.
//
// On 2026-08-28 a burst of OpenAI 429s left 33 agent_tasks rows permanently 'failed', with the
// raw provider body as their user-visible reason — `openai 429: { "error": { "message": "Rate
// limit reached for gpt-5.6-luna in organization org-…`. The run had done nothing wrong and its
// checkpoint was intact. These guard both halves: the classification that makes a 429 a
// resumable pause, and the copy that keeps the provider's internals out of the product.

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const brainProvider = require('../../api/services/brain-provider');
const { runAgentLoop, retryWaitMs } = require('../../api/services/agent-orchestrator');
const { stateFromTrace } = require('../../api/services/delegated-run-lifecycle');

function fakeResponse(status, { body = '{"error":{"message":"Rate limit reached"}}', retryAfter = null } = {}) {
  const headers = new Map();
  if (retryAfter !== null) headers.set('retry-after', String(retryAfter));
  return {
    status,
    text: async () => body,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null }
  };
}

test('a provider HTTP failure carries its status and retryability, not just a message', async () => {
  const limited = await brainProvider.providerHttpError('openai', fakeResponse(429, { retryAfter: 2 }));
  assert.equal(limited.status, 429);
  assert.equal(limited.rateLimited, true);
  assert.equal(limited.retryable, true);
  assert.equal(limited.retryAfterMs, 2000);
  // The message is unchanged, so logs and the provider's own wording still read as before.
  assert.match(limited.message, /^openai 429: /);

  const overloaded = await brainProvider.providerHttpError('Anthropic', fakeResponse(529));
  assert.equal(overloaded.rateLimited, false, 'overloaded is retryable but is not a rate limit');
  assert.equal(overloaded.retryable, true);

  const badRequest = await brainProvider.providerHttpError('openai', fakeResponse(400));
  assert.equal(badRequest.rateLimited, false);
  assert.equal(badRequest.retryable, false, 'a 400 is our bug, not something to wait out');
});

test('a Retry-After is honoured but bounded so one turn cannot hang', async () => {
  const hinted = await brainProvider.providerHttpError('openai', fakeResponse(429, { retryAfter: 3 }));
  assert.equal(retryWaitMs(hinted), 3000);

  // The provider is allowed to ask for longer than a turn can wait.
  const long = await brainProvider.providerHttpError('openai', fakeResponse(429, { retryAfter: 120 }));
  assert.equal(long.retryAfterMs, 60000, 'the header itself is capped when parsed');
  assert.equal(retryWaitMs(long), 5000, 'and the in-loop wait is capped tighter still');

  // No header: the historical flat wait, unchanged.
  const unhinted = await brainProvider.providerHttpError('openai', fakeResponse(429));
  assert.equal(unhinted.retryAfterMs, null);
  assert.equal(retryWaitMs(unhinted), 500);
});

test('a rate-limited run pauses as resumable and never shows the provider body', async (t) => {
  const original = brainProvider.callToolsBrain;
  t.after(() => { brainProvider.callToolsBrain = original; });
  brainProvider.callToolsBrain = async () => {
    throw await brainProvider.providerHttpError('openai', fakeResponse(429, {
      body: '{"error":{"message":"Rate limit reached for gpt-5.6-luna in organization org-a6DLOTL71KadXAT01Xyb8BqN on tokens per min (TPM)"}}'
    }));
  };

  const result = await runAgentLoop({
    userId: 'user-1',
    initialMessage: 'order the usual',
    maxIterations: 1,
    executeActionsFn: async () => []
  });

  assert.equal(result.agentTrace.status, 'rate_limited');
  assert.equal(stateFromTrace(result.agentTrace), 'paused', 'a rate limit is not a failed run');

  for (const text of [result.agentTrace.lastError, result.spoken]) {
    assert.doesNotMatch(text, /org-/, 'the provider org id must not reach the user');
    assert.doesNotMatch(text, /gpt-5/, 'nor the internal model name');
    assert.doesNotMatch(text, /429|\{/, 'nor the raw error envelope');
  }
  assert.match(result.spoken, /rate limit/i);
  assert.notEqual(result.spoken, 'Done.', 'a stopped run must never report success');
});

test('a non-rate-limit provider error still fails, with its message intact', async (t) => {
  const original = brainProvider.callToolsBrain;
  t.after(() => { brainProvider.callToolsBrain = original; });
  brainProvider.callToolsBrain = async () => {
    throw await brainProvider.providerHttpError('openai', fakeResponse(400, { body: '{"error":{"message":"bad tool schema"}}' }));
  };

  const result = await runAgentLoop({
    userId: 'user-1',
    initialMessage: 'order the usual',
    maxIterations: 1,
    executeActionsFn: async () => []
  });

  assert.equal(result.agentTrace.status, 'error');
  assert.equal(stateFromTrace(result.agentTrace), 'failed');
  assert.match(result.agentTrace.lastError, /bad tool schema/, 'a real defect keeps its diagnosis');
});

test('the canonical map keeps a rate-limited trace out of failed', () => {
  assert.equal(stateFromTrace({ status: 'rate_limited' }), 'paused');
  assert.equal(stateFromTrace({ status: 'error' }), 'failed');
  assert.equal(stateFromTrace({ status: 'incomplete' }), 'paused');
  assert.equal(stateFromTrace({ status: 'nonsense' }), 'failed', 'an unknown status still fails closed');
});

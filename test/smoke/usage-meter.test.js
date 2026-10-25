const test = require('node:test');
const assert = require('node:assert');
const meter = require('../../api/services/usage-meter');

test('prices a call from its tokens, with cached input cheaper', () => {
  const cost = meter.costOf('gpt-6-luna', { input: 1_000_000, cached: 500_000, output: 100_000 });
  // 0.5M fresh at $0.10 + 0.5M cached at $0.01 + 0.1M out at $0.50
  assert.ok(Math.abs(cost - (0.05 + 0.005 + 0.05)) < 1e-9);
  assert.strictEqual(meter.costOf('some-new-model', { input: 10, cached: 0, output: 10 }), null);
});

test('reads both OpenAI shapes and Anthropic usage', () => {
  assert.deepStrictEqual(meter.normaliseUsage({ input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 }, input_tokens_details: { cached_tokens: 4 } }), { input: 10, output: 5, cached: 4, reasoning: 3 });
  assert.deepStrictEqual(meter.normaliseUsage({ prompt_tokens: 7, completion_tokens: 2 }), { input: 7, output: 2, cached: 0, reasoning: 0 });
});

test('a turn meter collects only what was recorded inside it, and flags unpriced models', () => {
  process.env.OXY_USAGE_LOG = 'off';
  let summary;
  meter.runWithMeter((turn) => {
    meter.record('gpt-6-luna', { input_tokens: 1000, output_tokens: 500, output_tokens_details: { reasoning_tokens: 400 } });
    meter.record('gpt-6-luna', { input_tokens: 2000, output_tokens: 100 }, { webSearches: 1 });
    meter.record('mystery-model', { input_tokens: 10, output_tokens: 10 });
    summary = meter.summarise(turn);
  });
  meter.record('gpt-6-luna', { input_tokens: 99999, output_tokens: 99999 });
  assert.strictEqual(summary.calls, 3);
  assert.strictEqual(summary.inputTokens, 3010);
  assert.strictEqual(summary.reasoningTokens, 400);
  assert.strictEqual(summary.webSearches, 1);
  assert.strictEqual(summary.unpricedCalls, 1);
  assert.ok(summary.estimatedUsd > 0 && summary.estimatedUsd < 0.001);
  assert.ok(meter.lifetimeReport().calls >= 4);
});

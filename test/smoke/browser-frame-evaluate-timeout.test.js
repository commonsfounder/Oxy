// frame.evaluate() takes no timeout of its own, and a .catch() is no protection against a promise
// that never settles — a stuck 3DS iframe hangs the payment-confirmation loop past its own
// budget, which is only checked between iterations.
//
// Set before requiring the module: the timeout env var is read once into a top-level const.
process.env.OXY_BROWSER_FRAME_EVALUATE_TIMEOUT_MS = '50';

const assert = require('node:assert/strict');
const test = require('node:test');

const { safeFrameEvaluate } = require('../../api/services/browser-environment');

test('a frame stuck mid-navigation resolves to the fallback instead of hanging forever', async () => {
  const neverResolves = new Promise(() => {}); // exactly what frame.evaluate() does on a stuck frame
  const stuckFrame = { evaluate: () => neverResolves };
  const start = Date.now();
  const result = await safeFrameEvaluate(stuckFrame, () => 'unreachable', undefined, 'fallback-value');
  assert.equal(result, 'fallback-value');
  assert.ok(Date.now() - start < 2000, 'must resolve via the bounded timeout, not hang for real');
});

test('a normally-responding frame still returns its real value', async () => {
  const fastFrame = { evaluate: async (fn, arg) => fn(arg) };
  const result = await safeFrameEvaluate(fastFrame, (x) => x + 1, 41, 'fallback');
  assert.equal(result, 42);
});

test('a frame that genuinely throws (e.g. detached) also falls back cleanly', async () => {
  const throwingFrame = { evaluate: async () => { throw new Error('detached frame'); } };
  const result = await safeFrameEvaluate(throwingFrame, () => 'x', undefined, 'fallback');
  assert.equal(result, 'fallback');
});

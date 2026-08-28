// Real bug, live 2026-08-26: confirmPayment hung for minutes with zero visibility, well
// past its own explicit CONFIRM_WATCH_BUDGET_MS (45s). Root cause: frame.evaluate() has no
// timeout parameter of its own, and a .catch() is no protection at all against a promise
// that never settles — a stuck/slow-loading iframe (a 3DS/bank-verification frame is the
// realistic case on a real checkout) makes the whole payment-confirmation loop hang forever,
// because the loop's own deadline is only checked BETWEEN iterations, never inside one.
//
// Set before requiring the module — OXY_BROWSER_FRAME_EVALUATE_TIMEOUT_MS is read once at
// module load into a top-level const, so it must be in the environment first.
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

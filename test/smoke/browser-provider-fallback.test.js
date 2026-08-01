'use strict';

// Regression test for the 2026-08-01 prod misconfiguration: OXY_BROWSER_PROVIDER was set to
// a provider whose credentials weren't on the service, the provider branch threw, and nothing
// between there and the step loop caught it — so one bad env var failed every browser task
// outright instead of costing a single step. decideNextAction now falls back to Gemini, and
// the Gemini path's own contract is to degrade to {action:'invalid'} rather than throw.
//
// The assertion that matters is NOT "which model answered" (that needs live keys) but
// "a dead provider never propagates a throw to the step loop".

const test = require('node:test');
const assert = require('node:assert');

// Module-load-time config: no provider credentials at all, and a 1ms model timeout so the
// Gemini fallback's two attempts fail immediately instead of waiting out the real 20s cap.
process.env.OXY_BROWSER_PROVIDER = 'openai';
process.env.OXY_BROWSER_MODEL_TIMEOUT_MS = '1';
delete process.env.OPENAI_API_KEY;
delete process.env.OXY_BROWSER_API_KEY;

const { decideNextAction } = require('../../api/services/browser-task');

const ELEMENTS = [{ text: 'Add to basket', tag: 'button' }];

test('a provider with no credentials degrades to an invalid action instead of throwing', async () => {
  const decision = await decideNextAction('buy towels', [], ELEMENTS, null, '', null, { textOnly: true });

  assert.ok(decision, 'expected a decision object, not undefined');
  assert.strictEqual(decision.action, 'invalid');
  assert.match(String(decision.error), /model call failed/i);
});

test('the fallback is skipped when OXY_BROWSER_PROVIDER_FALLBACK=false', async () => {
  process.env.OXY_BROWSER_PROVIDER_FALLBACK = 'false';
  try {
    await assert.rejects(
      () => decideNextAction('buy towels', [], ELEMENTS, null, '', null, { textOnly: true }),
      /OPENAI_API_KEY/,
      'with the fallback disabled the provider error should surface'
    );
  } finally {
    delete process.env.OXY_BROWSER_PROVIDER_FALLBACK;
  }
});

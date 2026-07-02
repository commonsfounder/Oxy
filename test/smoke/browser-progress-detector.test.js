'use strict';
// The no-progress verdict must not punish NORMAL shopping flows: search → results →
// product → size → add legitimately takes 7-12 steps with an empty basket, and each of
// those steps is a NEW page state. Only frozen pages, revisit-cycles, and a very long
// empty-cart stall may nudge or bail. This pins the thresholds that killed M&S/Currys/
// Wickes/Nike/Deliveroo at exactly 7 steps in the 2026-07-02 benchmark.
const test = require('node:test');
const assert = require('node:assert');

const { assessProgress } = require('../../api/services/browser-task');

const order = { isOrder: true, cartEverNonzero: false };

test('a normal forward flow (all-new states, empty cart, 6 steps) is ok — no nudge, no bail', () => {
  const r = assessProgress({ stepsSinceProgress: 0, stepsSinceNewState: 0, stepsSinceCartProgress: 6 }, order);
  assert.strictEqual(r.verdict, 'ok');
});

test('a long forward flow (12 empty-cart steps but states keep advancing) nudges to commit, never bails', () => {
  const r = assessProgress({ stepsSinceProgress: 0, stepsSinceNewState: 1, stepsSinceCartProgress: 12 }, order);
  assert.strictEqual(r.verdict, 'nudge');
  assert.match(r.correction, /basket|add/i);
});

test('the empty-cart backstop only hard-bails after 16 steps', () => {
  const r15 = assessProgress({ stepsSinceProgress: 0, stepsSinceNewState: 0, stepsSinceCartProgress: 15 }, order);
  assert.notStrictEqual(r15.verdict, 'stuck');
  const r16 = assessProgress({ stepsSinceProgress: 0, stepsSinceNewState: 0, stepsSinceCartProgress: 16 }, order);
  assert.strictEqual(r16.verdict, 'stuck');
});

test('the cart backstop is disabled once the basket has ever been non-empty (badges vanish in checkout)', () => {
  const r = assessProgress(
    { stepsSinceProgress: 0, stepsSinceNewState: 0, stepsSinceCartProgress: 20 },
    { ...order, cartEverNonzero: true }
  );
  assert.strictEqual(r.verdict, 'ok');
});

test('the cart backstop never applies to non-order goals (info lookups have no basket)', () => {
  const r = assessProgress(
    { stepsSinceProgress: 0, stepsSinceNewState: 0, stepsSinceCartProgress: 20 },
    { ...order, isOrder: false }
  );
  assert.strictEqual(r.verdict, 'ok');
});

test('a frozen page (identical signature 7 steps) is stuck', () => {
  const r = assessProgress({ stepsSinceProgress: 7, stepsSinceNewState: 7, stepsSinceCartProgress: 3 }, order);
  assert.strictEqual(r.verdict, 'stuck');
});

test('a revisit cycle (9 steps without any NEW state, sig churning) is stuck', () => {
  const r = assessProgress({ stepsSinceProgress: 1, stepsSinceNewState: 9, stepsSinceCartProgress: 9 }, order);
  assert.strictEqual(r.verdict, 'stuck');
});

test('a short stall (4 identical sigs / 5 no-new-state) nudges with a do-something-different correction', () => {
  const r1 = assessProgress({ stepsSinceProgress: 4, stepsSinceNewState: 4, stepsSinceCartProgress: 4 }, order);
  assert.strictEqual(r1.verdict, 'nudge');
  assert.match(r1.correction, /different/i);
  const r2 = assessProgress({ stepsSinceProgress: 0, stepsSinceNewState: 5, stepsSinceCartProgress: 5 }, order);
  assert.strictEqual(r2.verdict, 'nudge');
});

test('recipe sites get no blanket exemption — a spinning recipe accumulates stall like any spin', () => {
  // Recipe steps that ADVANCE reset the counters at the execution site; a recipe step that
  // re-fires without advancing (Wickes GENERIC checkout ×20, 2026-07-02) must still bail.
  const r = assessProgress(
    { stepsSinceProgress: 9, stepsSinceNewState: 12, stepsSinceCartProgress: 20 },
    order
  );
  assert.strictEqual(r.verdict, 'stuck');
});

// The deterministic watch evaluator (api/services/watches.js). These are the rules that
// decide whether a background check is news, computed from a recorded observation rather
// than from the model asserting that its condition came true.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeState,
  parseNumber,
  buildWatchConfig,
  evaluateObservation,
  findDuplicateWatch,
  tokenOverlap,
  describeWatch,
  summarizeWatches
} = require('../../api/services/watches');

function threshold(value, extra = {}) {
  return { ...buildWatchConfig({ type: 'threshold', threshold: value, source_url: 'https://example.com/room' }), ...extra };
}
function stateWatch(extra = {}) {
  return { ...buildWatchConfig({ type: 'state_change', source_url: 'https://example.com/product' }), ...extra };
}

// ── Threshold ──────────────────────────────────────────────────────────────────────────
test('a price above the threshold is not news', () => {
  const result = evaluateObservation(threshold(500), { value: 620 });
  assert.equal(result.notify, false);
  assert.equal(result.kind, 'unchanged');
  assert.match(result.reason, /has not gone below 500/);
});

test('crossing the threshold fires once, and staying below it does not fire again', () => {
  const first = evaluateObservation(threshold(500), { value: 480 });
  assert.equal(first.notify, true);
  assert.equal(first.kind, 'threshold_met');
  assert.equal(first.terminal, true, 'a "tell me when" threshold is done once it fires');

  // The same watch, still below: the user already knows.
  const second = evaluateObservation(first.state, { value: 470 });
  assert.equal(second.notify, false);
  assert.equal(second.kind, 'still_met');
});

test('an "ongoing" threshold watch keeps reporting, because the user asked it to', () => {
  const first = evaluateObservation(threshold(500, { notifyRule: 'ongoing' }), { value: 480 });
  assert.equal(first.notify, true);
  assert.equal(first.terminal, false);
  const second = evaluateObservation(first.state, { value: 470 });
  assert.equal(second.notify, true);
});

test('a price that goes back above the threshold re-arms the notification', () => {
  const met = evaluateObservation(threshold(500), { value: 480 });
  const back = evaluateObservation(met.state, { value: 540 });
  assert.equal(back.notify, false);
  const again = evaluateObservation(back.state, { value: 490 });
  assert.equal(again.notify, true, 'a genuine second crossing is genuine news');
});

test('an "above" watch is not just the "below" watch with the sign flipped by accident', () => {
  const config = buildWatchConfig({ type: 'threshold', threshold: 30, comparator: 'above' });
  assert.equal(evaluateObservation(config, { value: 35 }).notify, true);
  assert.equal(evaluateObservation(config, { value: 25 }).notify, false);
});

test('a value that is not a number is reported as unreadable, never as "unchanged"', () => {
  const result = evaluateObservation(threshold(500), { value: 'price unavailable' });
  assert.equal(result.notify, false);
  assert.equal(result.kind, 'unreadable');
});

// ── State change ───────────────────────────────────────────────────────────────────────
test('the first run establishes a baseline and never fires on it', () => {
  const result = evaluateObservation(stateWatch(), { state: 'Out of stock' });
  assert.equal(result.notify, false);
  assert.equal(result.kind, 'baseline');
  assert.ok(result.state.baseline, 'the baseline must be stored for the next run to compare against');
});

test('an unchanged state is silent even when the page text is not byte-identical', () => {
  const first = evaluateObservation(stateWatch(), { state: 'Out of stock (checked 13:02)' });
  // Same meaning, different casing/spacing, and the only thing that actually moved is the
  // timestamp — this is the noise case a naive string compare would fire on every cycle.
  const second = evaluateObservation(first.state, { state: 'OUT OF STOCK  (checked 14:32)' });
  assert.equal(second.notify, false);
  assert.equal(second.kind, 'unchanged');
});

test('a real state change fires', () => {
  const first = evaluateObservation(stateWatch(), { state: 'Out of stock' });
  const second = evaluateObservation(first.state, { state: 'In stock' });
  assert.equal(second.notify, true);
  assert.equal(second.kind, 'changed');
  assert.match(second.reason, /changed from "out of stock" to "in stock"/);
});

test('a target state ends the watch; an intermediate change on the way does not fire', () => {
  const config = stateWatch({ targetState: 'in stock' });
  const baseline = evaluateObservation(config, { state: 'Out of stock' });
  const interim = evaluateObservation(baseline.state, { state: 'Coming soon' });
  assert.equal(interim.notify, false, 'the user asked about being back in stock, not about every wording change');
  assert.equal(interim.kind, 'changed_not_target');

  const hit = evaluateObservation(interim.state, { state: 'In stock' });
  assert.equal(hit.notify, true);
  assert.equal(hit.terminal, true);
});

test('an open-ended "keep me updated" watch fires on any change and never terminates', () => {
  const config = stateWatch({ notifyRule: 'every_change' });
  const baseline = evaluateObservation(config, { state: 'In transit' });
  const moved = evaluateObservation(baseline.state, { state: 'At depot' });
  assert.equal(moved.notify, true);
  assert.equal(moved.terminal, false);
});

// ── Recurring reassessment ─────────────────────────────────────────────────────────────
test('a recurring check is always the deliverable — it has no "nothing changed" state', () => {
  const config = buildWatchConfig({ type: 'recurring_check' });
  const result = evaluateObservation(config, { state: '3 threads still need a reply' });
  assert.equal(result.notify, true);
  assert.equal(result.kind, 'reassessment');
  assert.equal(result.terminal, false);
});

// ── Honest degradation ─────────────────────────────────────────────────────────────────
test('a source that could not be read is reported, never recorded as unchanged', () => {
  const first = evaluateObservation(stateWatch(), { state: 'In stock' });
  const blocked = evaluateObservation(first.state, { accessible: false, error: 'the page now requires a login' });
  assert.equal(blocked.notify, true);
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.reason, /requires a login/);
  // Critically, the last real observation is untouched, so a later successful read still
  // compares against a genuine previous state rather than against the failure.
  assert.equal(blocked.state.lastObserved.state, 'in stock');
});

// ── Duplicate avoidance ────────────────────────────────────────────────────────────────
test('asking for the same watch again matches the existing one', () => {
  // The live database really did accumulate four of these, all polling independently.
  const existing = [{
    id: 'w1', active: true,
    title: 'Track Brighton hotel price drops',
    condition: 'the price drops',
    watch_state: { sourceUrl: 'https://example.com/brighton' }
  }];
  assert.equal(findDuplicateWatch(existing, { title: 'Keep track of hotel prices in Brighton and let me know', condition: 'when they drop' })?.id, 'w1');
  assert.equal(findDuplicateWatch(existing, { title: 'anything at all', source_url: 'https://example.com/brighton' })?.id, 'w1');
});

test('a genuinely different watch is not folded into an existing one', () => {
  const existing = [{ id: 'w1', active: true, title: 'Track Brighton hotel price drops', condition: 'the price drops', watch_state: {} }];
  assert.equal(findDuplicateWatch(existing, { title: 'Tell me when the PS5 is back in stock', condition: 'it is in stock' }), null);
  assert.ok(tokenOverlap('Brighton hotel price', 'PS5 stock') < 0.5);
});

test('a cancelled watch does not block creating a new one', () => {
  const existing = [{ id: 'w1', active: false, title: 'Track Brighton hotel price drops', condition: 'the price drops', watch_state: {} }];
  assert.equal(findDuplicateWatch(existing, { title: 'Track Brighton hotel price drops', condition: 'the price drops' }), null);
});

// ── Helpers and description ────────────────────────────────────────────────────────────
test('a price is parsed out of whatever wrapping it arrives in', () => {
  assert.equal(parseNumber('£1,299.00 per night'), 1299);
  assert.equal(parseNumber(92), 92);
  assert.equal(parseNumber('sold out'), null);
});

test('normalisation strips exactly the things that are not state', () => {
  assert.equal(normalizeState('In Stock — updated 14:32'), 'in stock updated');
  assert.equal(normalizeState('In stock https://x.example/a?b=1'), 'in stock');
});

test('"what are you watching?" describes the real state of each watch', () => {
  const text = summarizeWatches([{
    title: 'Brighton hotel price',
    condition: 'the price drops below 90',
    watch_state: {
      type: 'threshold', threshold: 90, comparator: 'below',
      sourceUrl: 'https://example.com/brighton',
      lastObserved: { value: 104 }
    }
  }]);
  assert.match(text, /1 thing I'm watching/);
  assert.match(text, /until it goes below 90/);
  assert.match(text, /last seen: 104/);
});

test('a watch whose last check failed says so instead of looking healthy', () => {
  const text = describeWatch({
    title: 'Applications page',
    watch_state: { type: 'state_change', lastEvaluation: { kind: 'blocked', reason: 'CAPTCHA on the page' } }
  });
  assert.match(text, /last check failed: CAPTCHA on the page/);
});

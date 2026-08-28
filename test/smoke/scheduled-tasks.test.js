const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildScheduledRunInstruction,
  scheduledConditionTriggered,
  cleanScheduledResultText,
  isRecurringCadence
} = require('../../api/services/scheduled-tasks');
const { isScheduledRunNoteworthy } = require('../../api/index');

test('scheduled watches give the agent an explicit evidence marker', () => {
  const instruction = buildScheduledRunInstruction({
    title: 'Flight prices to Turkey',
    instruction: 'Check flight prices to Turkey and tell me when a cheaper option appears',
    condition: 'a cheaper option appears'
  });
  assert.match(instruction, /\[WATCH_TRIGGERED\]/);
  assert.match(instruction, /\[WATCH_PENDING\]/);
});

test('scheduled watches stop after a verified trigger and hide the marker', () => {
  const result = { spoken: '[WATCH_TRIGGERED] I found a cheaper flight at £220.' };
  assert.equal(scheduledConditionTriggered({ condition: 'a cheaper option appears' }, result), true);
  assert.equal(cleanScheduledResultText(result.spoken), 'I found a cheaper flight at £220.');
});

test('scheduled watches stay active when the condition is not met', () => {
  const result = { spoken: '[WATCH_PENDING] Prices are still higher today.' };
  assert.equal(scheduledConditionTriggered({ condition: 'a cheaper option appears' }, result), false);
  assert.equal(cleanScheduledResultText(result.spoken), 'Prices are still higher today.');
});

// ── isScheduledRunNoteworthy: the "don't notify on every poll" gate ────────────────────────
// This is the exact fix for a condition watch that used to post a fresh Home card and chat
// message on every single check cycle, even when nothing had changed — a 30-minute price
// watch would spam ~48 identical "I checked X" cards a day. The gate only ever suppresses
// ONE specific case: a condition watch, checked, condition not yet true, nothing wrong. Every
// other outcome — including a plain scheduled task that has no condition at all — must still
// surface every time, because there's no "checked, nothing new" state to suppress for those.
const CONDITION_TASK = { condition: 'a cheaper option appears' };
const PLAIN_TASK = { condition: null };

test('a condition watch that checked and found nothing is suppressed (the noisy case this fixes)', () => {
  assert.equal(
    isScheduledRunNoteworthy(CONDITION_TASK, { conditionTriggered: false, failed: false, waiting: false }),
    false
  );
});

test('a condition watch that actually triggered is always noteworthy', () => {
  assert.equal(
    isScheduledRunNoteworthy(CONDITION_TASK, { conditionTriggered: true, failed: false, waiting: false }),
    true
  );
});

test('a condition watch that failed is noteworthy — a broken watch must not silently vanish', () => {
  assert.equal(
    isScheduledRunNoteworthy(CONDITION_TASK, { conditionTriggered: false, failed: true, waiting: false }),
    true
  );
});

test('a condition watch that needs approval is noteworthy — it is actionable', () => {
  assert.equal(
    isScheduledRunNoteworthy(CONDITION_TASK, { conditionTriggered: false, failed: false, waiting: true }),
    true
  );
});

test('a plain scheduled task with no condition is always noteworthy — every run IS the deliverable', () => {
  for (const outcome of [
    { conditionTriggered: false, failed: false, waiting: false },
    { conditionTriggered: false, failed: true, waiting: false },
    { conditionTriggered: false, failed: false, waiting: true }
  ]) {
    assert.equal(isScheduledRunNoteworthy(PLAIN_TASK, outcome), true, JSON.stringify(outcome));
  }
});

test('isScheduledRunNoteworthy tolerates a missing/malformed task without throwing', () => {
  assert.equal(isScheduledRunNoteworthy(null, {}), true);
  assert.equal(isScheduledRunNoteworthy(undefined, { conditionTriggered: false }), true);
  assert.equal(isScheduledRunNoteworthy({}, {}), true);
});

// ── isRecurringCadence: a due_date pins the first run and must not downgrade the cadence to
// 'once'. "starting today, check my calendar every morning" legitimately carries both, and
// advanceScheduledTask branches on recurrence — a downgraded task fires once and never again. ─
test('isRecurringCadence recognises daily and weekly as real repeating cadences', () => {
  assert.equal(isRecurringCadence('daily'), true);
  assert.equal(isRecurringCadence('weekly'), true);
});

test('isRecurringCadence treats once, poll, and anything else as not a repeating cadence', () => {
  assert.equal(isRecurringCadence('once'), false);
  assert.equal(isRecurringCadence('poll'), false);
  assert.equal(isRecurringCadence(undefined), false);
  assert.equal(isRecurringCadence(''), false);
  assert.equal(isRecurringCadence('daily '), false, 'must not fuzzy-match — exact cadence values only');
});

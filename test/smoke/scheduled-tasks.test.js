const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildScheduledRunInstruction,
  scheduledConditionTriggered,
  cleanScheduledResultText
} = require('../../api/services/scheduled-tasks');

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

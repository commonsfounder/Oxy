'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ACTION_CONTRACTS } = require('../../api/action-contracts');
const { getExecutableActionCatalog } = require('../../api/services/action-catalog');
const { TASKS, GROUPS, MODES, selectTasks, classify } = require('../../test/dev/real-user-task-matrix');

test('real-user corpus is broad, unique, and points only at executable actions', () => {
  assert.ok(TASKS.length >= 80);
  assert.ok(GROUPS.length >= 8);
  assert.deepEqual(new Set(TASKS.map(task => task.id)).size, TASKS.length);
  assert.ok(MODES.includes('safe'));
  assert.ok(MODES.includes('approval'));
  assert.ok(MODES.includes('browser'));

  const executable = new Set(getExecutableActionCatalog().map(action => action.type));
  for (const task of TASKS) {
    assert.ok(ACTION_CONTRACTS[task.expectedAction], `${task.id} references unknown contract ${task.expectedAction}`);
    if (task.expectedAvailability === 'unavailable') {
      assert.equal(ACTION_CONTRACTS[task.expectedAction].availability, 'unavailable', `${task.id} must point at an explicitly unavailable contract`);
    } else {
      assert.ok(executable.has(task.expectedAction), `${task.id} references non-executable action ${task.expectedAction}`);
    }
    assert.ok(task.message.length >= 20, `${task.id} is not a realistic user request`);
  }
});

test('matrix selection supports group, mode, id, and limit slices', () => {
  assert.ok(selectTasks({ groups: ['public-read'] }).every(task => task.group === 'public-read'));
  assert.ok(selectTasks({ modes: ['approval'] }).every(task => task.mode === 'approval'));
  assert.deepEqual(selectTasks({ ids: ['weather', 'stock'] }).map(task => task.id), ['weather', 'stock']);
  assert.equal(selectTasks({ limit: 3 }).length, 3);
});

test('approval classification accepts a review boundary and rejects an unreviewed effect', () => {
  const task = TASKS.find(candidate => candidate.id === 'email-landlord');
  assert.equal(classify(task, {
    actions: [{ action: 'send_email', result: { success: false, outcome: 'awaiting_user', text: 'Review before sending.' } }]
  }).status, 'approval_boundary');
  assert.equal(classify(task, {
    actions: [{ action: 'send_email', result: { success: true, outcome: 'completed', text: 'Email sent.' } }]
  }).status, 'effect_risk');
});

test('browser task classification treats checkout and signup data asks as safe boundaries', () => {
  const order = TASKS.find(candidate => candidate.id === 'order-john-lewis');
  assert.equal(classify(order, {
    actions: [{ action: 'run_browser_task', result: { type: 'ask', question: 'I need your email before checkout.' } }]
  }).status, 'browser_boundary');

  const signup = TASKS.find(candidate => candidate.id === 'signup-newsletter');
  assert.equal(classify(signup, {
    actions: [{ action: 'run_browser_task', result: { type: 'ask', question: 'What email address should I use to sign you up?' } }]
  }).status, 'browser_boundary');
});

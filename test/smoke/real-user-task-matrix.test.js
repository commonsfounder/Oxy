'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { ACTION_CONTRACTS } = require('../../api/action-contracts');
const { getExecutableActionCatalog } = require('../../api/services/action-catalog');
const {
  TASKS,
  GROUPS,
  MODES,
  LAYERS,
  LAYER_ONE_GATE_TASK_IDS,
  LAYER_ONE_GAUNTLET_TASK_IDS,
  selectTasks,
  classify
} = require('../../test/dev/real-user-task-matrix');

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

test('matrix selection supports group, mode, id, layer, and limit slices', () => {
  assert.ok(selectTasks({ groups: ['public-read'] }).every(task => task.group === 'public-read'));
  assert.ok(selectTasks({ modes: ['approval'] }).every(task => task.mode === 'approval'));
  assert.deepEqual(selectTasks({ ids: ['weather', 'stock'] }).map(task => task.id), ['weather', 'stock']);
  assert.deepEqual(LAYERS, [1, 2, 3]);
  assert.ok(selectTasks({ layers: [1] }).every(task => task.layer === 1));
  assert.equal(selectTasks({ limit: 3 }).length, 3);
});

test('layer one gate covers general agency without claiming household or delight work', () => {
  const layerOne = selectTasks({ layers: [1] });
  const ids = new Set(layerOne.map(task => task.id));

  for (const id of LAYER_ONE_GATE_TASK_IDS) assert.ok(ids.has(id), `${id} must be runnable in the Layer 1 gate`);
  for (const id of ['web-browse', 'email-landlord', 'order-john-lewis', 'signup-service', 'upload-tenancy-document', 'create-doc', 'scheduled-watch', 'create-agent-task']) {
    assert.ok(ids.has(id), `Layer 1 must include ${id}`);
  }
  for (const id of ['daily-brief', 'contextual-reminder', 'smart-light', 'play-trivia', 'playlist']) {
    assert.ok(!ids.has(id), `Layer 1 must not claim ${id}`);
  }
});

test('Layer 1 gauntlet selects every executable foundation task across risk modes', () => {
  const gauntlet = selectTasks({ gauntlet: 'layer1' });
  const ids = new Set(gauntlet.map(task => task.id));

  assert.ok(gauntlet.length >= 50, 'the gauntlet must be harder than the representative gate');
  assert.deepEqual(new Set(gauntlet.map(task => task.id)), new Set(LAYER_ONE_GAUNTLET_TASK_IDS));
  assert.ok(gauntlet.every(task => task.layer === 1 && task.expectedAvailability !== 'unavailable'));
  for (const mode of ['safe', 'state', 'approval', 'browser']) assert.ok(gauntlet.some(task => task.mode === mode), `missing ${mode} coverage`);
  for (const id of ['web-search', 'web-browse', 'order-groceries', 'upload-tenancy-document', 'create-agent-task', 'stripe-charge']) {
    assert.ok(ids.has(id), `gauntlet must include ${id}`);
  }
});

test('corpus listing is available without live credentials', () => {
  const result = spawnSync(process.execPath, ['test/dev/real-user-task-matrix.js', '--list'], {
    cwd: require('node:path').join(__dirname, '..', '..'),
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(listed.layers, [1, 2, 3]);
  assert.ok(listed.tasks.some(task => task.id === 'upload-tenancy-document' && task.layer === 1));
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

test('a digest that declares a connected source unavailable is a setup blocker, not a completed answer', () => {
  const task = TASKS.find(candidate => candidate.id === 'urgent-email');
  assert.equal(classify(task, {
    actions: [{
      action: 'daily_digest',
      result: {
        success: true,
        text: 'Nothing urgent right now. I could not check email (Google is disconnected), so this may be incomplete.'
      }
    }]
  }).status, 'setup_blocked');
});

test('browser task classification treats checkout and signup data asks as safe boundaries', () => {
  const order = TASKS.find(candidate => candidate.id === 'order-john-lewis');
  assert.equal(classify(order, {
    actions: [{ action: 'browser_open', result: { type: 'ask', question: 'I need your email before checkout.' } }]
  }).status, 'browser_boundary');

  const signup = TASKS.find(candidate => candidate.id === 'signup-newsletter');
  assert.equal(classify(signup, {
    actions: [{ action: 'browser_open', result: { type: 'ask', question: 'What email address should I use to sign you up?' } }]
  }).status, 'browser_boundary');
});

test('a completed browser upload is recorded as a completed answer, not merely progress', () => {
  const task = TASKS.find(candidate => candidate.id === 'upload-tenancy-document');
  assert.equal(classify(task, {
    actions: [{ action: 'browser_upload', result: { success: true, text: 'Attached "proof-of-address.pdf".' } }]
  }).status, 'completed');
});

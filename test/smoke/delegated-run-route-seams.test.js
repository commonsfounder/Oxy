const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const app = require('../../api/index');

test('chat identity seam stops before tools when lifecycle start fails', async () => {
  let ensured = false;
  await assert.rejects(() => app.startChatExecutionIdentity({
    userId: 'user-1',
    message: 'check my agenda',
    lifecycle: {
      async list() { return []; },
      async create() { return { id: 'task-1', goal: 'check my agenda', metadata: {} }; },
      async claimStart() { throw new Error('runtime projection unavailable'); }
    },
    ensureRuntime: async () => { ensured = true; },
    updateTaskMetadata: async () => {}
  }), /runtime projection unavailable/);
  assert.equal(ensured, false);
});

test('new chat task with a lost claim stops without creating a second task or runtime', async () => {
  let created = 0;
  let ensured = false;
  const result = await app.startChatExecutionIdentity({
    userId: 'user-1', message: 'new goal',
    lifecycle: {
      async list() { return []; },
      async create() { created += 1; return { id: 'task-1', metadata: {} }; },
      async claimStart() { return null; }
    },
    ensureRuntime: async () => { ensured = true; },
    updateTaskMetadata: async () => {}
  });
  assert.equal(result.error, 'The new delegated run could not be started.');
  assert.equal(created, 1);
  assert.equal(ensured, false);
});

test('chat identity seam creates, claims, attaches runtime, and returns one execution identity', async () => {
  const calls = [];
  const result = await app.startChatExecutionIdentity({
    userId: 'user-1',
    message: 'check my agenda',
    lifecycle: {
      async list() { return []; },
      async create(_userId, goal) { calls.push(['create', goal]); return { id: 'task-1', goal, metadata: {} }; },
      async claimStart(_userId, taskId, options) { calls.push(['claim', taskId, options.runtime.deviceType]); return { id: taskId, goal: 'check my agenda', metadata: {} }; },
      async updateControls(_userId, taskId) { calls.push(['metadata', taskId]); }
    },
    runtime: { deviceType: 'ios_companion' },
    ensureRuntime: async task => ({ id: 'runtime-1', taskId: task.id }),
    updateTaskMetadata: async (task, session) => calls.push(['attach', task.id, session.id])
  });
  assert.equal(result.executionTask.id, 'task-1');
  assert.equal(result.session.id, 'runtime-1');
  assert.deepEqual(calls, [['create', 'check my agenda'], ['claim', 'task-1', 'ios_companion'], ['attach', 'task-1', 'runtime-1']]);
});

test('production index has no direct task lifecycle writes outside the lifecycle adapter', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../api/index.js'), 'utf8');
  assert.doesNotMatch(source, /taskManager\.(createTask|getTask|listTasks|updateTask|claimRun|saveCheckpoint|recoverStaleRuns|saveTrace|appendResultToTask)\s*\(/);
  assert.doesNotMatch(source, /taskManager\.executeRecipe\s*\(/);
  const taskManagerSource = fs.readFileSync(path.join(__dirname, '../../api/services/task-manager.js'), 'utf8');
  assert.doesNotMatch(taskManagerSource, /async function executeRecipe\s*\(/);
  const recipeRoute = source.slice(source.indexOf("app.post('/agent/recipes/:id/execute'"), source.indexOf("app.post('/connectors/stripe/setup-intent'"));
  assert.match(recipeRoute, /delegatedRunLifecycle\.create\s*\(/);
  assert.match(recipeRoute, /created:\s*true,\s*started:\s*false/);
});

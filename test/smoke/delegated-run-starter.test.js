const test = require('node:test');
const assert = require('node:assert/strict');

const { createDelegatedRunStarter, resolveDelegatedGuardMode } = require('../../api/services/delegated-run-starter');

test('delegated child tasks cannot weaken an inherited approval guard', () => {
  assert.equal(resolveDelegatedGuardMode(false, true), true);
  assert.equal(resolveDelegatedGuardMode(true, false), true);
  assert.equal(resolveDelegatedGuardMode(false, false), false);
  assert.equal(resolveDelegatedGuardMode(undefined, undefined), undefined);
});

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    goal: 'Find the best nearby option',
    status: 'pending',
    autonomy: 'Active',
    attempt: 4,
    metadata: { guardMode: true },
    checkpoint: null,
    ...overrides
  };
}

function makeStarter(overrides = {}) {
  const calls = [];
  const task = overrides.task || makeTask();
  const claimed = overrides.claimed || { ...task, status: 'running', attempt: 5 };
  const lifecycle = {
    get: async () => {
      calls.push(['get']);
      return claimed;
    },
    updateControls: async (_userId, taskId, updates) => {
      calls.push(['updateControls', taskId, updates]);
      return claimed;
    },
    interrupt: async (...args) => calls.push(['interrupt', ...args]),
    repairProjection: async (...args) => calls.push(['repairProjection', ...args])
  };
  const routeHandlers = {
    run: async input => {
      calls.push(['claim', input]);
      return overrides.claimResult || { status: 200, body: { started: true, taskId: task.id, resumed: false }, claimed };
    }
  };
  const starter = createDelegatedRunStarter({
    lifecycle,
    routeHandlers,
    ensureRuntime: async (...args) => {
      calls.push(['runtime', ...args]);
      return { id: 'runtime-1' };
    },
    resolveRoute: async (...args) => {
      calls.push(['route', ...args]);
      return { provider: 'openai', model: 'gpt-5.6-luna' };
    },
    buildSystemPrompt: async userId => {
      calls.push(['prompt', userId]);
      return 'background prompt';
    },
    runLoop: async options => {
      calls.push(['loop', options]);
      return { agentTrace: { status: 'completed' } };
    },
    executeActions: async () => [],
    logger: { error() {} }
  });
  return { starter, calls, task, claimed };
}

test('durable task starter claims, provisions, and launches one canonical loop', async () => {
  const { starter, calls, task } = makeStarter();

  const result = await starter.start({
    userId: 'user-1',
    task,
    runtime: { deviceType: 'ios_companion' }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(result, {
    status: 200,
    body: { started: true, queued: false, resumed: false, taskId: 'task-1' }
  });
  assert.equal(calls.filter(call => call[0] === 'claim').length, 1);
  assert.equal(calls.filter(call => call[0] === 'get').length, 0, 'the claimed task must cross the route seam without a second read');
  assert.equal(calls.filter(call => call[0] === 'runtime').length, 1);
  assert.equal(calls.filter(call => call[0] === 'route').length, 1);
  assert.equal(calls.filter(call => call[0] === 'loop').length, 1);

  const claim = calls.find(call => call[0] === 'claim')[1];
  assert.equal(claim.runtime.deviceType, 'ios_companion');
  const loop = calls.find(call => call[0] === 'loop')[1];
  assert.equal(loop.existingTaskId, 'task-1');
  assert.equal(loop.persistTask, true);
  assert.equal(loop.context.guardMode, true);
  assert.equal(loop.dynamicSystemPrompt, 'background prompt');
});

test('starter returns claim conflicts without provisioning or launching work', async () => {
  const { starter, calls, task } = makeStarter({
    claimResult: { status: 409, body: { error: 'Already running', taskId: 'task-1' } }
  });

  const result = await starter.start({ userId: 'user-1', task });

  assert.deepEqual(result, { status: 409, body: { error: 'Already running', taskId: 'task-1' } });
  assert.equal(calls.some(call => call[0] === 'runtime'), false);
  assert.equal(calls.some(call => call[0] === 'loop'), false);
});

test('starter uses the claimed row even when a post-claim read would fail', async () => {
  const task = makeTask();
  const claimed = { ...task, status: 'running', attempt: 5 };
  const calls = [];
  const starter = createDelegatedRunStarter({
    lifecycle: {
      get: async () => { throw new Error('read replica unavailable'); },
      updateControls: async () => {},
      interrupt: async (...args) => calls.push(['interrupt', ...args])
    },
    routeHandlers: { run: async () => ({ status: 200, body: {}, claimed }) },
    ensureRuntime: async () => ({ id: 'runtime-1' }),
    resolveRoute: async () => ({ provider: 'openai', model: 'gpt-5.6-luna' }),
    buildSystemPrompt: async () => 'prompt',
    runLoop: async () => {},
    executeActions: async () => [],
    logger: { error() {} }
  });

  const result = await starter.start({ userId: 'user-1', task });

  assert.equal(result.status, 200);
  assert.equal(calls.length, 0);
});

test('starter does not launch after cancellation wins the owner fence', async () => {
  const task = makeTask();
  const claimed = { ...task, status: 'running', attempt: 5 };
  let loops = 0;
  const starter = createDelegatedRunStarter({
    lifecycle: {
      get: async () => { throw new Error('must not re-read after claim'); },
      updateControls: async () => {},
      assertOwner: async () => null,
      interrupt: async () => {}
    },
    routeHandlers: { run: async () => ({ status: 200, body: {}, claimed }) },
    ensureRuntime: async () => ({ id: 'runtime-1' }),
    resolveRoute: async () => ({ provider: 'openai', model: 'gpt-5.6-luna' }),
    buildSystemPrompt: async () => 'prompt',
    runLoop: async () => { loops += 1; },
    executeActions: async () => [],
    logger: { error() {} }
  });

  const result = await starter.start({ userId: 'user-1', task });

  assert.equal(result.status, 409);
  assert.equal(loops, 0);
});

test('starter interrupts a claimed task when runtime setup fails', async () => {
  const { calls, task } = makeStarter();
  const starter = createDelegatedRunStarter({
    lifecycle: {
      get: async () => ({ ...task, status: 'running', attempt: 5 }),
      updateControls: async () => { throw new Error('route unavailable'); },
      interrupt: async (...args) => calls.push(['interrupt', ...args])
    },
    routeHandlers: { run: async () => ({ status: 200, body: {}, claimed: { ...task, status: 'running', attempt: 5 } }) },
    ensureRuntime: async () => ({ id: 'runtime-1' }),
    resolveRoute: async () => ({ provider: 'openai', model: 'gpt-5.6-luna' }),
    buildSystemPrompt: async () => 'prompt',
    runLoop: async () => {},
    executeActions: async () => [],
    logger: { error() {} }
  });

  const result = await starter.start({ userId: 'user-1', task });

  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'Could not start the work session.');
  assert.equal(calls.some(call => call[0] === 'interrupt'), true);
});

test('starter rejects an approval-paused task without claiming it', async () => {
  const { starter, calls } = makeStarter({
    task: makeTask({ metadata: { awaitingApproval: true } })
  });

  const result = await starter.start({ userId: 'user-1', task: makeTask({ metadata: { awaitingApproval: true } }) });

  assert.equal(result.status, 409);
  assert.equal(result.body.awaitingApproval, true);
  assert.equal(calls.some(call => call[0] === 'claim'), false);
});

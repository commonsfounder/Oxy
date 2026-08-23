const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CANONICAL_STATES,
  TRACE_STATUS_TO_CANONICAL,
  taskStatusForState,
  DelegatedRunLifecycleError,
  createDelegatedRunLifecycle,
  createDelegatedRunRouteHandlers
} = require('../../api/services/delegated-run-lifecycle');

function storeWith(task, { failUpdate = false } = {}) {
  const calls = [];
  let row = { ...task };
  let claimed = false;
  return {
    calls,
    async createTask() { return row; },
    async getTask() { return row; },
    async listTasks() { return [row]; },
    async updateTask(_userId, _taskId, patch) {
      calls.push({ operation: 'updateTask', patch });
      if (failUpdate) throw new Error('task write failed');
      row = { ...row, ...patch };
      return row;
    },
    async updateRun(_userId, _taskId, expectedAttempt, patch) {
      calls.push({ operation: 'updateRun', patch });
      if (row.status !== 'running' || row.attempt !== expectedAttempt) throw new Error('The delegated run no longer owns this task.');
      if (failUpdate) throw new Error('task write failed');
      row = { ...row, ...patch };
      return row;
    },
    async updateTaskCas(_userId, _taskId, expectedStatus, expectedAttempt, patch) {
      calls.push({ operation: 'updateTaskCas', patch });
      if (row.status !== expectedStatus || (expectedAttempt != null && row.attempt !== expectedAttempt)) throw new Error('The delegated run changed before this write completed.');
      if (failUpdate) throw new Error('task write failed');
      row = { ...row, ...patch };
      return row;
    },
    async claimRun() {
      calls.push({ operation: 'claimRun' });
      if (claimed) return null;
      claimed = true;
      row = { ...row, status: 'running', heartbeat_at: '2026-08-22T12:00:00.000Z' };
      return row;
    },
    async saveTrace(_taskId, _userId, _step, type) { calls.push({ operation: 'saveTrace', type }); },
    async recoverStaleRuns() { calls.push({ operation: 'recoverStaleRuns' }); return [row]; },
    trimCheckpoint(value) { return value; }
  };
}

const baseTask = {
  id: 'task-1', user_id: 'user-1', goal: 'show my agenda', status: 'running',
  metadata: {}, checkpoint: { contents: ['turn'] }, heartbeat_at: null,
  completed_at: null, results: [], attempt: 1
};

test('trace mapping is exhaustive and canonical', () => {
  assert.deepEqual(CANONICAL_STATES, ['ready', 'running', 'paused', 'waiting_for_user', 'completed', 'failed', 'cancelled']);
  assert.equal(TRACE_STATUS_TO_CANONICAL.completed, 'completed');
  assert.equal(TRACE_STATUS_TO_CANONICAL.awaiting_approval, 'waiting_for_user');
  assert.equal(TRACE_STATUS_TO_CANONICAL.error, 'failed');
  assert.equal(TRACE_STATUS_TO_CANONICAL.incomplete, 'paused');
  assert.equal(TRACE_STATUS_TO_CANONICAL.cancelled, 'cancelled');
  assert.equal(taskStatusForState('ready'), 'pending');
});

test('settlement enforces task invariants and projects the same state', async () => {
  const store = storeWith(baseTask);
  const projected = [];
  const lifecycle = createDelegatedRunLifecycle({
    taskStore: store,
    runtimeStore: { async project(userId, _task, _state, patch) { projected.push({ userId, patch }); } },
    now: () => new Date('2026-08-22T12:00:00.000Z')
  });

  await lifecycle.waitForApproval('user-1', 'task-1', { ownerAttempt: 1 });
  assert.equal(store.calls.at(-1).patch.status, 'paused');
  assert.equal(store.calls.at(-1).patch.heartbeat_at, null);
  assert.equal(store.calls.at(-1).patch.metadata.awaitingApproval, true);
  assert.equal(projected.at(-1).patch.state, 'waiting_approval');

  await lifecycle.resumeAfterApproval('user-1', 'task-1');
  await lifecycle.settleFromTrace('user-1', 'task-1', { status: 'completed', steps: [] }, { results: [{ ok: true }], ownerAttempt: 1 });
  const patch = store.calls.at(-2).patch; // diagnostic trace write follows the task write
  assert.equal(patch.status, 'completed');
  assert.ok(patch.completed_at);
  assert.equal(patch.heartbeat_at, null);
  assert.equal(patch.checkpoint, null);
  assert.equal(projected.at(-1).patch.state, 'completed');
  assert.ok(projected.at(-1).patch.completedAt);
});

test('claim race has one winner', async () => {
  const store = storeWith({ ...baseTask, status: 'paused' });
  store.updateRun = async (_userId, _taskId, _attempt, patch) => {
    store.calls.push({ operation: 'updateRun', patch });
    return { ...baseTask, status: 'paused', ...patch };
  };
  const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
  const [one, two] = await Promise.all([
    lifecycle.claimStart('user-1', 'task-1'),
    lifecycle.claimStart('user-1', 'task-1')
  ]);
  assert.equal(Boolean(one) + Boolean(two), 1);
});

test('authoritative task failure does not touch runtime', async () => {
  const store = storeWith(baseTask, { failUpdate: true });
  let runtimeWrites = 0;
  const lifecycle = createDelegatedRunLifecycle({
    taskStore: store,
    runtimeStore: { async project() { runtimeWrites += 1; } }
  });
  await assert.rejects(() => lifecycle.cancel('user-1', 'task-1'), DelegatedRunLifecycleError);
  assert.equal(runtimeWrites, 0);
});

test('runtime projection failure is reported as partial persistence', async () => {
  const store = storeWith(baseTask);
  const lifecycle = createDelegatedRunLifecycle({
    taskStore: store,
    runtimeStore: { async project() { throw new Error('runtime unavailable'); } }
  });
  await assert.rejects(() => lifecycle.settleFromTrace('user-1', 'task-1', { status: 'completed' }, { ownerAttempt: 1 }), error => {
    assert.equal(error.partial, true);
    assert.equal(error.authoritativeSaved, true);
    return true;
  });
  assert.equal(store.calls[0].patch.status, 'completed');
});

test('terminal state cannot be downgraded by a late worker', async () => {
  const store = storeWith({ ...baseTask, status: 'completed', completed_at: '2026-08-22T12:00:00.000Z' });
  const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
  const result = await lifecycle.interrupt('user-1', 'task-1', 'late failure');
  assert.equal(result.status, 'completed');
  assert.equal(store.calls.length, 0);
});

test('late settlement and cancellation report the authoritative terminal state', async () => {
  const store = storeWith({ ...baseTask, status: 'cancelled', completed_at: '2026-08-22T12:00:00.000Z' });
  const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
  const settled = await lifecycle.settleFromTrace('user-1', 'task-1', { status: 'completed' }, { ownerAttempt: 1 });
  assert.equal(settled.state, 'cancelled');
  assert.equal(store.calls.at(-1).operation, 'saveTrace');
  assert.equal(store.calls.at(-1).type, 'agent_run_cancelled');

  const routes = createDelegatedRunRouteHandlers({ lifecycle });
  const cancelled = await routes.cancel({ userId: 'user-1', taskId: 'task-1' });
  assert.equal(cancelled.body.cancelled, true);
  assert.equal(cancelled.body.state, 'cancelled');

  const completedStore = storeWith({ ...baseTask, status: 'completed', completed_at: '2026-08-22T12:00:00.000Z' });
  const completedRoutes = createDelegatedRunRouteHandlers({ lifecycle: createDelegatedRunLifecycle({ taskStore: completedStore }) });
  const cancelCompleted = await completedRoutes.cancel({ userId: 'user-1', taskId: 'task-1' });
  assert.equal(cancelCompleted.body.cancelled, false);
  assert.equal(cancelCompleted.body.state, 'completed');
});

test('a failed terminal projection can be repaired without rewriting the task', async () => {
  const store = storeWith(baseTask);
  let projectionAttempts = 0;
  const lifecycle = createDelegatedRunLifecycle({
    taskStore: store,
    runtimeStore: { async project() { projectionAttempts += 1; if (projectionAttempts === 1) throw new Error('offline'); } }
  });
  await assert.rejects(() => lifecycle.settleFromTrace('user-1', 'task-1', { status: 'completed' }, { ownerAttempt: 1 }), /projection/);
  const writesBeforeRepair = store.calls.filter(call => call.patch?.status === 'completed').length;
  const repaired = await lifecycle.repairProjection('user-1', 'task-1');
  assert.equal(repaired.state, 'completed');
  assert.equal(store.calls.filter(call => call.patch?.status === 'completed').length, writesBeforeRepair);
  assert.equal(projectionAttempts, 2);
});

test('claim start carries runtime identity and compensates a failed projection', async () => {
  const store = storeWith({ ...baseTask, status: 'paused' });
  store.updateRun = async (_userId, _taskId, _attempt, patch) => {
    store.calls.push({ operation: 'updateRun', patch });
    return { ...baseTask, status: 'paused', ...patch };
  };
  let runtimeOptions = null;
  const lifecycle = createDelegatedRunLifecycle({
    taskStore: store,
    runtimeStore: {
      async project(_userId, _task, _state, _patch, options) {
        runtimeOptions = options;
        throw new Error('runtime unavailable');
      }
    }
  });
  await assert.rejects(() => lifecycle.claimStart('user-1', 'task-1', {
    runtime: { deviceType: 'ios_companion', deviceId: 'device-1' }
  }), error => error.partial === true && error.authoritativeSaved === true && error.claimCompensated === true);
  assert.deepEqual(runtimeOptions, { deviceType: 'ios_companion', deviceId: 'device-1' });
  assert.equal(store.calls.at(-1).patch.status, 'paused');
  assert.equal(store.calls.at(-1).patch.heartbeat_at, null);
});

test('runtime identity returned by projection is attached to the task', async () => {
  const store = storeWith({ ...baseTask, status: 'paused', attempt: 1 });
  store.updateRun = async (_userId, _taskId, _attempt, patch) => {
    store.calls.push({ operation: 'updateRun', patch });
    return { ...baseTask, status: 'running', attempt: 1, metadata: patch.metadata };
  };
  const lifecycle = createDelegatedRunLifecycle({
    taskStore: store,
    runtimeStore: { async project() { return { sessionId: 'runtime-1' }; } }
  });
  await lifecycle.claimStart('user-1', 'task-1');
  assert.equal(store.calls.at(-1).patch.metadata.runtimeSessionId, 'runtime-1');
});

test('incomplete and stale runs remain resumable with a checkpoint', async () => {
  const store = storeWith(baseTask);
  const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
  await lifecycle.settleFromTrace('user-1', 'task-1', {
    status: 'incomplete', lastError: 'iteration limit', steps: []
  }, { ownerAttempt: 1 });
  assert.equal(store.calls[0].patch.status, 'paused');
  assert.equal(store.calls[0].patch.heartbeat_at, null);
  assert.deepEqual(store.calls[0].patch.checkpoint, baseTask.checkpoint);
  assert.equal(store.calls[0].patch.last_error, 'iteration limit');

  const recovered = await lifecycle.recoverStale(new Date('2026-08-22T12:00:00.000Z'));
  assert.equal(recovered.length, 1);
  assert.equal(store.calls.at(-1).operation, 'recoverStaleRuns');
});

test('an old attempt cannot checkpoint after stale recovery hands the task back', async () => {
  const store = storeWith({ ...baseTask, status: 'running', attempt: 1 });
  let current = { ...baseTask, status: 'running', attempt: 1 };
  store.getTask = async () => current;
  store.recoverStaleRuns = async () => {
    current = { ...current, status: 'paused' };
    return [current];
  };
  store.claimRun = async () => {
    current = { ...current, status: 'running', attempt: 2 };
    return current;
  };
  store.updateRun = async (_userId, _taskId, expectedAttempt) => {
    if (current.status !== 'running' || current.attempt !== expectedAttempt) throw new Error('The delegated run no longer owns this task.');
    return current;
  };
  const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
  await lifecycle.recoverStale(new Date('2026-08-22T12:00:00.000Z'));
  await lifecycle.claimStart('user-1', 'task-1');
  await assert.rejects(() => lifecycle.checkpoint('user-1', 'task-1', { contents: ['old'] }, 1), /could not be saved|no longer owns/);
});

test('stale recovery can attach a runtime identity after the task is paused', async () => {
  const store = storeWith({ ...baseTask, status: 'running', attempt: 1 });
  let attached = null;
  store.updateTaskCas = async (_userId, _taskId, expectedStatus, _attempt, patch) => {
    attached = { expectedStatus, patch };
    return { ...baseTask, status: expectedStatus, metadata: patch.metadata };
  };
  store.recoverStaleRuns = async () => [{ ...baseTask, status: 'paused', attempt: 1, metadata: {} }];
  const lifecycle = createDelegatedRunLifecycle({
    taskStore: store,
    runtimeStore: { async project() { return { sessionId: 'runtime-legacy' }; } }
  });
  await lifecycle.recoverStale(new Date('2026-08-22T12:00:00.000Z'));
  assert.equal(attached.expectedStatus, 'paused');
  assert.equal(attached.patch.metadata.runtimeSessionId, 'runtime-legacy');
});

test('cancel and settle race through one compare-and-set winner', async () => {
  let row = { ...baseTask, status: 'running', attempt: 1 };
  const store = storeWith(row);
  store.getTask = async () => ({ ...row });
  store.updateTaskCas = async (_userId, _taskId, expectedStatus, expectedAttempt, patch) => {
    if (row.status !== expectedStatus || row.attempt !== expectedAttempt) throw new Error('CAS lost');
    row = { ...row, ...patch };
    return row;
  };
  store.updateRun = async (_userId, _taskId, expectedAttempt, patch) => {
    if (row.status !== 'running' || row.attempt !== expectedAttempt) throw new Error('CAS lost');
    row = { ...row, ...patch };
    return row;
  };
  const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
  const results = await Promise.allSettled([
    lifecycle.cancel('user-1', 'task-1', { ownerAttempt: 1 }),
    lifecycle.settleFromTrace('user-1', 'task-1', { status: 'completed' }, { ownerAttempt: 1 })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(['cancelled', 'completed'].includes(row.status));
});

test('settlement uses owned full results and never appendResultToTask', async () => {
  const store = storeWith(baseTask);
  store.appendResultToTask = () => { throw new Error('lost update seam used'); };
  const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
  await lifecycle.settleFromTrace('user-1', 'task-1', { status: 'completed' }, { results: [{ action: 'x' }], ownerAttempt: 1 });
  assert.equal(store.calls[0].patch.results[0].action, 'x');
});

test('route seam returns truthful run, approval, and cancel results', async () => {
  const store = storeWith({ ...baseTask, status: 'paused' });
  const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
  const routes = createDelegatedRunRouteHandlers({ lifecycle });
  const started = await routes.run({ userId: 'user-1', taskId: 'task-1' });
  assert.equal(started.status, 200);
  assert.equal(started.body.started, true);

  const waitingStore = storeWith({ ...baseTask, status: 'paused', metadata: { awaitingApproval: true } });
  const waitingRoutes = createDelegatedRunRouteHandlers({ lifecycle: createDelegatedRunLifecycle({ taskStore: waitingStore }) });
  const waiting = await waitingRoutes.run({ userId: 'user-1', taskId: 'task-1' });
  assert.equal(waiting.status, 409);
  assert.equal(waiting.body.awaitingApproval, true);

  const cancelStore = storeWith({ ...baseTask, status: 'paused', metadata: {} });
  const cancelRoutes = createDelegatedRunRouteHandlers({ lifecycle: createDelegatedRunLifecycle({ taskStore: cancelStore }) });
  const cancelled = await cancelRoutes.cancel({ userId: 'user-1', taskId: 'task-1' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.cancelled, true);
});

test('scheduled and recipe metadata deltas preserve provenance through settlement', async () => {
  for (const metadata of [
    { scheduledTaskId: 'watch-1', scheduledRecurrence: 'daily', scheduledCondition: 'price below 10' },
    { fromRecipe: 'recipe-1' }
  ]) {
    const store = storeWith({ ...baseTask, status: 'paused', metadata });
    const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
    const claimed = await lifecycle.claimStart('user-1', 'task-1');
    const controlled = await lifecycle.updateControls('user-1', 'task-1', {
      metadata: { modelRoute: { provider: 'openai', model: 'gpt-5.6-luna' }, runtimeSessionId: 'runtime-1' }
    });
    assert.deepEqual(controlled.metadata.fromRecipe || controlled.metadata.scheduledTaskId,
      metadata.fromRecipe || metadata.scheduledTaskId);
    await lifecycle.checkpoint('user-1', 'task-1', { contents: ['owned'] }, claimed.attempt);
    const settled = await lifecycle.settleFromTrace('user-1', 'task-1', { status: 'completed' }, {
      ownerAttempt: claimed.attempt,
      metadata: controlled.metadata
    });
    assert.equal(settled.state, 'completed');
    assert.equal(settled.task.metadata.runtimeSessionId, 'runtime-1');
  }
});

test('appointment progress uses fenced canonical states and cannot reopen completion', async () => {
  const store = storeWith({ ...baseTask, status: 'pending', metadata: {} });
  const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
  const paused = await lifecycle.updateAppointmentProgress('user-1', 'task-1', {
    state: 'paused', booking: { phase: 'choosing' }, checkpoint: { phase: 'choosing' }
  });
  assert.equal(paused.status, 'paused');
  const completed = await lifecycle.updateAppointmentProgress('user-1', 'task-1', {
    state: 'completed', booking: { phase: 'completed' }, checkpoint: null
  });
  assert.equal(completed.status, 'completed');
  const completedSnapshot = structuredClone(completed);
  const taskWritesBeforeDuplicate = store.calls.filter(call =>
    call.operation === 'updateTaskCas' || call.operation === 'updateRun'
  ).length;
  const duplicate = await lifecycle.updateAppointmentProgress('user-1', 'task-1', {
    state: 'completed', booking: { phase: 'different-terminal-data' }, results: [{ changed: true }]
  });
  assert.deepEqual(duplicate, completedSnapshot);
  assert.equal(store.calls.filter(call =>
    call.operation === 'updateTaskCas' || call.operation === 'updateRun'
  ).length, taskWritesBeforeDuplicate);
  assert.deepEqual(
    await lifecycle.updateAppointmentProgress('user-1', 'task-1', { state: 'paused' }),
    completedSnapshot
  );
});

test('approval success resumes to completion and failed approval remains resumable', async () => {
  const store = storeWith({ ...baseTask, status: 'running' });
  const lifecycle = createDelegatedRunLifecycle({ taskStore: store });
  await lifecycle.waitForApproval('user-1', 'task-1', { ownerAttempt: 1 });
  const resumed = await lifecycle.resumeAfterApproval('user-1', 'task-1');
  assert.equal(resumed.status, 'running');
  await lifecycle.settleFromTrace('user-1', 'task-1', { status: 'completed' }, { ownerAttempt: resumed.attempt });
  assert.equal(store.calls.at(-1).operation, 'saveTrace');
  assert.equal(store.calls.find(call => call.patch?.status === 'completed').patch.status, 'completed');

  const failureStore = storeWith({ ...baseTask, status: 'running' });
  const failureLifecycle = createDelegatedRunLifecycle({ taskStore: failureStore });
  await failureLifecycle.waitForApproval('user-1', 'task-1', { ownerAttempt: 1 });
  const failureResume = await failureLifecycle.resumeAfterApproval('user-1', 'task-1');
  await failureLifecycle.interrupt('user-1', 'task-1', 'approved action failed', { ownerAttempt: failureResume.attempt });
  const failedPatch = failureStore.calls.find(call => call.patch?.last_error === 'approved action failed').patch;
  assert.equal(failedPatch.status, 'paused');
  assert.equal(failedPatch.heartbeat_at, null);
  assert.equal(failedPatch.checkpoint.contents[0], 'turn');
});

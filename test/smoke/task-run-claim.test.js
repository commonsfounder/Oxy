const assert = require('node:assert/strict');
const test = require('node:test');

const runtime = require('../../runtime');

let task = {
  id: 'task-1',
  user_id: 'user-1',
  goal: 'Send the supplier a quote request',
  status: 'paused',
  attempt: 1,
  metadata: {},
  heartbeat_at: null
};

runtime.createSupabaseServiceClient = () => ({
  from() {
    const query = { filters: {}, isFilters: {}, patch: null };
    const chain = {
      select() { query.select = true; return chain; },
      update(patch) { query.patch = patch; return chain; },
      eq(column, value) { query.filters[column] = value; return chain; },
      is(column, value) { query.isFilters[column] = value; return chain; },
      maybeSingle() {
        if (!query.patch) return Promise.resolve({ data: { ...task }, error: null });
        const statusMatches = task.status === query.filters.status;
        const heartbeatMatches = query.filters.heartbeat_at === undefined
          ? (query.isFilters.heartbeat_at === undefined || task.heartbeat_at === query.isFilters.heartbeat_at)
          : task.heartbeat_at === query.filters.heartbeat_at;
        if (!statusMatches || !heartbeatMatches) return Promise.resolve({ data: null, error: null });
        task = { ...task, ...query.patch };
        return Promise.resolve({ data: { ...task }, error: null });
      }
    };
    return chain;
  }
});

const taskManager = require('../../api/services/task-manager');

test('task run claim is single-flight for two competing callers', async () => {
  task = {
    id: 'task-1', user_id: 'user-1', goal: 'Send the supplier a quote request',
    status: 'paused', attempt: 1, metadata: {}, heartbeat_at: null
  };
  const first = await taskManager.claimRun('user-1', 'task-1');
  const second = await taskManager.claimRun('user-1', 'task-1');
  assert.equal(first.status, 'running');
  assert.equal(second, null);
  assert.equal(task.attempt, 2);
});

test('a task waiting for approval cannot be started from Work', async () => {
  task = {
    id: 'task-1', user_id: 'user-1', goal: 'Send the supplier a quote request',
    status: 'paused', attempt: 1, metadata: { awaitingApproval: true }, heartbeat_at: null
  };
  assert.equal(await taskManager.claimRun('user-1', 'task-1'), null);
  const approvalClaim = await taskManager.claimRun('user-1', 'task-1', { allowAwaitingApproval: true });
  assert.equal(approvalClaim.status, 'running');
});

test('a stale running task can be claimed once using its heartbeat', async () => {
  const now = new Date('2026-08-05T12:00:00Z');
  task = {
    id: 'task-1', user_id: 'user-1', goal: 'Send the supplier a quote request',
    status: 'running', attempt: 1, metadata: {},
    heartbeat_at: new Date(now.getTime() - taskManager.STALE_RUN_MS - 1).toISOString()
  };
  const first = await taskManager.claimRun('user-1', 'task-1', { now });
  const second = await taskManager.claimRun('user-1', 'task-1', { now });
  assert.equal(first.status, 'running');
  assert.equal(second, null);
  assert.equal(task.attempt, 2);
});

test('a running task with a null heartbeat can still be claimed once', async () => {
  const now = new Date('2026-08-05T12:00:00Z');
  task = {
    id: 'task-1', user_id: 'user-1', goal: 'Send the supplier a quote request',
    status: 'running', attempt: 1, metadata: {}, heartbeat_at: null
  };
  const first = await taskManager.claimRun('user-1', 'task-1', { now });
  const second = await taskManager.claimRun('user-1', 'task-1', { now });
  assert.equal(first.status, 'running');
  assert.equal(second, null);
  assert.equal(task.attempt, 2);
});

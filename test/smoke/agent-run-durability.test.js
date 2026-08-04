const assert = require('node:assert/strict');
const test = require('node:test');

// task-manager builds its supabase client lazily, so stubbing the factory before the first
// call lets recoverStaleRuns() be exercised for real without a database.
const runtime = require('../../runtime');
let sweepQuery = null;
runtime.createSupabaseServiceClient = () => ({
  from(table) {
    const q = { table, filters: {} };
    sweepQuery = q;
    const chain = {
      update: (patch) => { q.patch = patch; return chain; },
      eq: (col, val) => { q.filters[col] = val; return chain; },
      lt: (col, val) => { q.filters[`${col}<`] = val; return chain; },
      select: () => Promise.resolve({ data: q.rows || [], error: null })
    };
    chain.rows = [];
    q.rows = [{ id: 'stranded-1', user_id: 'user-1', goal: 'Order a laptop' }];
    return chain;
  }
});

const taskManager = require('../../api/services/task-manager');
const { runAgentLoop } = require('../../api/services/agent-orchestrator');
const brainProvider = require('../../api/services/brain-provider');

/*
 * A run used to live entirely in one instance's memory: `runAgenticLoop(...)` was
 * fire-and-forget, so a recycle mid-run left the task at 'running' forever with no progress
 * saved and no error. Re-running restarted the goal and re-executed everything it had
 * already done.
 *
 * These cover the three parts of the fix: a checkpoint written every iteration, a resume
 * that continues rather than restarts, and a sweep that hands back abandoned runs.
 */

const realCallTools = brainProvider.callToolsBrain;
const realTaskFns = { ...taskManager };
function restore() {
  brainProvider.callToolsBrain = realCallTools;
  Object.assign(taskManager, realTaskFns);
}

/* A model that calls one tool per turn, then finishes. */
function scriptedBrain(turns) {
  let index = 0;
  return async () => {
    const turn = turns[Math.min(index++, turns.length - 1)];
    if (!turn) return { text: 'Done.', functionCalls: [], candidates: [{ content: { parts: [{ text: 'Done.' }], role: 'model' } }] };
    return {
      text: turn.text || '',
      functionCalls: turn.calls || [],
      candidates: [{ content: { parts: [...(turn.text ? [{ text: turn.text }] : []), ...(turn.calls || []).map(fc => ({ functionCall: fc }))], role: 'model' } }]
    };
  };
}

function stubTaskStore(initial = {}) {
  const task = { id: 'task-1', goal: 'Order a laptop', status: 'running', attempt: 1, ...initial };
  const checkpoints = [];
  taskManager.getTask = async () => ({ ...task });
  taskManager.saveCheckpoint = async (_u, _id, checkpoint) => {
    checkpoints.push(realTaskFns.trimCheckpoint(checkpoint));
    return task;
  };
  taskManager.updateTask = async (_u, _id, updates) => { Object.assign(task, updates); return { ...task }; };
  taskManager.saveTrace = async () => {};
  return { task, checkpoints };
}

test('a checkpoint is written for every iteration, not just at the end', async (t) => {
  t.after(restore);
  const { checkpoints } = stubTaskStore();
  brainProvider.callToolsBrain = scriptedBrain([
    { calls: [{ id: 'c1', name: 'web_search', args: { query: 'laptops' } }] },
    { calls: [{ id: 'c2', name: 'web_search', args: { query: 'reviews' } }] },
    { text: 'Done.' }
  ]);

  await runAgentLoop({
    userId: 'user-1',
    initialMessage: 'Order a laptop',
    maxIterations: 4,
    persistTask: true,
    existingTaskId: 'task-1',
    executeActionsFn: async (_u, actions) => actions.map(a => ({ action: a.type, result: { success: true, text: 'ok' } }))
  });

  const iterations = checkpoints.map(c => c.iteration);
  assert.ok(checkpoints.length >= 3, `expected a checkpoint per iteration, got ${checkpoints.length}`);
  assert.equal(iterations[0], -1, 'the run claims a checkpoint before the first model call');
  assert.deepEqual(iterations.slice(1, 3), [0, 1]);
  assert.ok(
    checkpoints[1].executedActions.length > 0,
    'a checkpoint must record what has already been executed, or a resume repeats it'
  );
});

test('resuming continues from the checkpoint instead of restarting the goal', async (t) => {
  t.after(restore);
  const priorContents = [
    { role: 'user', parts: [{ text: 'Order a laptop' }] },
    { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'web_search', args: {} } }] },
    { role: 'function', parts: [{ functionResponse: { id: 'c1', name: 'web_search', response: { result: '{}' } } }] }
  ];
  const { checkpoints } = stubTaskStore({
    checkpoint: {
      iteration: 1,
      contents: priorContents,
      executedActions: [{ action: 'web_search', result: { success: true } }],
      spoken: 'Looking at options.',
      goal: 'Order a laptop'
    }
  });

  const executed = [];
  brainProvider.callToolsBrain = scriptedBrain([{ text: 'Done.' }]);

  const result = await runAgentLoop({
    userId: 'user-1',
    initialMessage: 'Order a laptop',
    maxIterations: 4,
    persistTask: true,
    existingTaskId: 'task-1',
    executeActionsFn: async (_u, actions) => {
      executed.push(...actions.map(a => a.type));
      return actions.map(a => ({ action: a.type, result: { success: true } }));
    }
  });

  assert.equal(executed.length, 0, 'the already-completed search must not run again');
  assert.equal(
    result.actions.length, 1,
    'work recorded before the interruption must be carried forward, not lost'
  );
  assert.equal(checkpoints[0].iteration, 1, 'the resume picks up after the checkpointed iteration');
});

test('an unfinished run is left resumable, a finished one is not', async (t) => {
  t.after(restore);

  const finished = stubTaskStore();
  brainProvider.callToolsBrain = scriptedBrain([{ text: 'Done.' }]);
  await runAgentLoop({
    userId: 'user-1', initialMessage: 'Order a laptop', maxIterations: 3,
    persistTask: true, existingTaskId: 'task-1',
    executeActionsFn: async () => []
  });
  assert.equal(finished.task.status, 'completed');
  assert.equal(finished.task.checkpoint, null, 'a completed goal must not be replayable');
  assert.equal(finished.task.heartbeat_at, null);

  restore();
  const stopped = stubTaskStore();
  brainProvider.callToolsBrain = async () => { throw new Error('provider exploded'); };
  await runAgentLoop({
    userId: 'user-1', initialMessage: 'Order a laptop', maxIterations: 2,
    persistTask: true, existingTaskId: 'task-1',
    executeActionsFn: async () => []
  });
  assert.equal(stopped.task.status, 'paused', 'a stopped run must never be left at running');
  assert.match(stopped.task.last_error, /provider exploded/);
  assert.notEqual(stopped.task.checkpoint, null, 'an unfinished run keeps its checkpoint');
});

/* ── Heartbeat and recovery ──────────────────────────────────────────────── */

test('a live run is active; a quiet or heartbeat-less one is not', () => {
  const now = new Date('2026-08-04T12:00:00Z');
  const fresh = new Date(now.getTime() - 60 * 1000).toISOString();
  const quiet = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  assert.equal(realTaskFns.isRunActive({ status: 'running', heartbeat_at: fresh }, now), true);
  assert.equal(realTaskFns.isRunActive({ status: 'running', heartbeat_at: quiet }, now), false);
  assert.equal(realTaskFns.isRunActive({ status: 'running', heartbeat_at: null }, now), false);
  assert.equal(realTaskFns.isRunActive({ status: 'paused', heartbeat_at: fresh }, now), false);
});

test('a checkpoint is trimmed to stay writable every iteration', () => {
  const huge = { role: 'user', parts: [{ text: 'x'.repeat(200 * 1024) }] };
  const trimmed = realTaskFns.trimCheckpoint({
    iteration: 3,
    contents: [huge, huge, huge, huge],
    executedActions: [],
    spoken: ''
  });
  const bytes = Buffer.byteLength(JSON.stringify(trimmed), 'utf8');
  assert.ok(bytes <= 256 * 1024, `checkpoint still ${bytes} bytes after trimming`);
  assert.equal(trimmed.iteration, 3, 'trimming must not lose the resume position');
  assert.ok(trimmed.contents.length >= 1);
});

test('the sweep hands back abandoned runs as paused, not failed', async () => {
  const now = new Date('2026-08-04T12:00:00Z');
  const recovered = await realTaskFns.recoverStaleRuns(now);

  assert.equal(recovered.length, 1);
  assert.equal(sweepQuery.table, 'agent_tasks');
  assert.equal(sweepQuery.filters.status, 'running', 'only running tasks can be stranded');
  assert.equal(
    sweepQuery.filters['heartbeat_at<'],
    new Date(now.getTime() - realTaskFns.STALE_RUN_MS).toISOString(),
    'the cutoff must follow the stale window, or live runs get reaped'
  );
  assert.equal(
    sweepQuery.patch.status, 'paused',
    'the checkpoint is intact, so this is resumable work — calling it failed throws it away'
  );
  assert.match(sweepQuery.patch.last_error, /interrupted/i);
  assert.equal(sweepQuery.patch.checkpoint, undefined, 'recovery must not clear what makes it resumable');
});

test('trimming drops the oldest turns and keeps the most recent', () => {
  const filler = (tag) => ({ role: 'user', parts: [{ text: tag + 'x'.repeat(100 * 1024) }] });
  const trimmed = realTaskFns.trimCheckpoint({
    iteration: 2,
    contents: [filler('OLDEST'), filler('MIDDLE'), filler('NEWEST')],
    executedActions: []
  });
  const text = JSON.stringify(trimmed);
  assert.ok(text.includes('NEWEST'), 'the newest turn is what the next iteration needs');
  assert.ok(!text.includes('OLDEST'), 'the oldest turn should be dropped first');
});

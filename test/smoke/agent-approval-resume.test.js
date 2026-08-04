const assert = require('node:assert/strict');
const test = require('node:test');

const taskManager = require('../../api/services/task-manager');
const { runAgentLoop } = require('../../api/services/agent-orchestrator');
const brainProvider = require('../../api/services/brain-provider');

/*
 * A review-gated action inside an agent run used to be terminal: the loop kept spending
 * iterations against a result that said "waiting for approval", the run ended, the user
 * confirmed, the action executed on its own — and the goal that asked for it was never
 * picked back up.
 *
 * These cover the park-and-continue behaviour: stop at the approval, keep the checkpoint,
 * and resume from it once the approval lands.
 */

const realCallTools = brainProvider.callToolsBrain;
const realTaskFns = { ...taskManager };
function restore() {
  brainProvider.callToolsBrain = realCallTools;
  Object.assign(taskManager, realTaskFns);
}

function scriptedBrain(turns) {
  let index = 0;
  return async () => {
    const turn = turns[Math.min(index++, turns.length - 1)] || { text: 'Done.' };
    return {
      text: turn.text || '',
      functionCalls: turn.calls || [],
      candidates: [{
        content: {
          parts: [...(turn.text ? [{ text: turn.text }] : []), ...(turn.calls || []).map(fc => ({ functionCall: fc }))],
          role: 'model'
        }
      }]
    };
  };
}

function stubTaskStore(initial = {}) {
  const task = { id: 'task-1', goal: 'Send the supplier a quote request', status: 'running', metadata: { guardMode: true }, ...initial };
  const checkpoints = [];
  taskManager.getTask = async () => ({ ...task });
  taskManager.saveCheckpoint = async (_u, _id, cp) => {
    const trimmed = realTaskFns.trimCheckpoint(cp);
    checkpoints.push(trimmed);
    task.checkpoint = trimmed;
    return task;
  };
  taskManager.updateTask = async (_u, _id, updates) => { Object.assign(task, updates); return { ...task }; };
  taskManager.saveTrace = async () => {};
  return { task, checkpoints };
}

test('a pending approval parks the run instead of burning the remaining iterations', async (t) => {
  t.after(restore);
  const { task } = stubTaskStore();
  let modelCalls = 0;
  brainProvider.callToolsBrain = async (...args) => {
    modelCalls++;
    return scriptedBrain([{ calls: [{ id: 'c1', name: 'send_email', args: { to: 'supplier' } }] }])(...args);
  };

  await runAgentLoop({
    userId: 'user-1',
    initialMessage: 'Send the supplier a quote request',
    maxIterations: 6,
    persistTask: true,
    existingTaskId: 'task-1',
    executeActionsFn: async (_u, actions) => actions.map(a => ({
      action: a.type,
      result: { success: true, pending: true, text: 'Ready for review.', actionSummary: 'Send email' }
    }))
  });

  assert.equal(modelCalls, 1, `the loop must stop at the approval, not keep planning (made ${modelCalls} calls)`);
  assert.equal(task.status, 'paused');
  assert.equal(task.metadata.awaitingApproval, true);
  assert.equal(task.last_error, null, 'waiting on the user is not an error');
  assert.ok(task.checkpoint, 'the approval has nothing to resume without a checkpoint');
});

test('the run carries its task id so the approval knows what to continue', async (t) => {
  t.after(restore);
  stubTaskStore();
  brainProvider.callToolsBrain = scriptedBrain([{ calls: [{ id: 'c1', name: 'send_email', args: {} }] }]);

  let seenContext = null;
  await runAgentLoop({
    userId: 'user-1',
    initialMessage: 'Send the supplier a quote request',
    maxIterations: 3,
    persistTask: true,
    existingTaskId: 'task-1',
    executeActionsFn: async (_u, actions, context) => {
      seenContext = context;
      return actions.map(a => ({ action: a.type, result: { success: true, pending: true } }));
    }
  });

  assert.equal(
    seenContext.persistedTaskId, 'task-1',
    'without this the pending action cannot record which run to resume'
  );
});

test('resuming after approval continues the goal and does not re-ask', async (t) => {
  t.after(restore);
  const { task } = stubTaskStore({
    status: 'paused',
    metadata: { guardMode: true, awaitingApproval: true },
    checkpoint: {
      iteration: 0,
      contents: [
        { role: 'user', parts: [{ text: 'Send the supplier a quote request' }] },
        { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'send_email', args: {} } }] },
        { role: 'function', parts: [{ functionResponse: { id: 'c1', name: 'send_email', response: { result: '{"pending":true}' } } }] }
      ],
      executedActions: [{ action: 'send_email', result: { pending: true } }],
      spoken: '',
      goal: 'Send the supplier a quote request'
    }
  });

  let promptSeen = null;
  brainProvider.callToolsBrain = async (req) => {
    promptSeen = JSON.stringify(req.contents);
    return { text: 'Sent and logged.', functionCalls: [], candidates: [{ content: { parts: [{ text: 'Sent and logged.' }], role: 'model' } }] };
  };

  const result = await runAgentLoop({
    userId: 'user-1',
    initialMessage: 'Send the supplier a quote request',
    maxIterations: 6,
    persistTask: true,
    existingTaskId: 'task-1',
    resumeNote: 'The user approved "send_email" and it has now been executed: Sent. Continue the goal from here; do not ask for that approval again.',
    executeActionsFn: async () => []
  });

  // promptSeen is JSON, so the note's quotes arrive escaped — match on the words.
  assert.match(promptSeen, /the user approved/i, 'the resumed run must be told the approval landed');
  assert.match(promptSeen, /send_email.{0,40}has now been executed/i);
  assert.match(promptSeen, /do not ask for that approval again/i);
  assert.equal(task.status, 'completed');
  assert.equal(task.metadata.awaitingApproval, false, 'the waiting flag must clear on completion');
  assert.equal(task.checkpoint, null, 'a completed goal must not stay replayable');
  assert.equal(result.actions.length, 1, 'work done before the approval is carried forward');
});

test('an approval-parked run is reported as waiting, not as a failure', () => {
  const { safeAgentTaskSummary } = require('../../api');
  const waiting = safeAgentTaskSummary({
    id: 't1', goal: 'Send the supplier a quote request', status: 'paused',
    metadata: { awaitingApproval: true }, checkpoint: { iteration: 0 }, results: []
  });
  assert.equal(waiting.awaiting_approval, true);
  assert.equal(waiting.resumable, true);
  assert.equal(waiting.last_error, null);

  const stalled = safeAgentTaskSummary({
    id: 't2', goal: 'Order a laptop', status: 'paused',
    metadata: {}, last_error: 'provider exploded', results: []
  });
  assert.equal(stalled.awaiting_approval, false);
  assert.equal(stalled.resumable, false);
  assert.match(stalled.last_error, /provider exploded/);
});

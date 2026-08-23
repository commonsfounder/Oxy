'use strict';

/*
 * The durable delegated-run state machine.
 *
 * agent_tasks is the authority. Runtime sessions are an optional projection of
 * that row and are deliberately written second: Supabase does not give these
 * two tables a transaction boundary here, so a projection failure is reported
 * as partial persistence instead of being hidden.
 */

const CANONICAL_STATES = Object.freeze([
  'ready',
  'running',
  'paused',
  'waiting_for_user',
  'completed',
  'failed',
  'cancelled'
]);

const TRACE_STATUS_TO_CANONICAL = Object.freeze({
  pending: 'ready',
  ready: 'ready',
  running: 'running',
  paused: 'paused',
  incomplete: 'paused',
  awaiting_approval: 'waiting_for_user',
  waiting_for_user: 'waiting_for_user',
  completed: 'completed',
  error: 'failed',
  failed: 'failed',
  cancelled: 'cancelled'
});

class DelegatedRunLifecycleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DelegatedRunLifecycleError';
    Object.assign(this, details);
  }
}

function stateFromTrace(traceOrStatus) {
  const status = typeof traceOrStatus === 'string' ? traceOrStatus : traceOrStatus?.status;
  return TRACE_STATUS_TO_CANONICAL[String(status || '').toLowerCase()] || 'failed';
}

function taskStatusForState(state) {
  return state === 'ready' ? 'pending' : state === 'waiting_for_user' ? 'paused' : state;
}

function canonicalStateForTask(task) {
  if (task?.status === 'paused' && task.metadata?.awaitingApproval === true) return 'waiting_for_user';
  if (task?.status === 'pending') return 'ready';
  return CANONICAL_STATES.includes(task?.status) ? task.status : 'paused';
}

const ALLOWED_TRANSITIONS = Object.freeze({
  ready: new Set(['running', 'paused', 'failed', 'cancelled']),
  running: new Set(['paused', 'waiting_for_user', 'completed', 'failed', 'cancelled']),
  paused: new Set(['running', 'waiting_for_user', 'completed', 'failed', 'cancelled']),
  waiting_for_user: new Set(['running', 'cancelled']),
  failed: new Set(['running', 'cancelled']),
  completed: new Set(),
  cancelled: new Set()
});

function runtimeStateForState(state) {
  return state === 'waiting_for_user' ? 'waiting_approval' : state;
}

function boundedError(error, fallback = 'The delegated run could not be saved.') {
  return String(error?.message || error || fallback).slice(0, 500);
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function taskPatch(state, now, options = {}) {
  if (!CANONICAL_STATES.includes(state)) throw new Error(`Unsupported delegated-run state: ${state}`);
  const terminal = state === 'completed' || state === 'cancelled';
  const waiting = state === 'waiting_for_user';
  const running = state === 'running';
  const patch = {
    status: taskStatusForState(state),
    heartbeat_at: running ? iso(now) : null,
    completed_at: terminal ? iso(now) : null,
    last_error: waiting || state === 'completed' || state === 'cancelled'
      ? null
      : (options.lastError || null),
    metadata: options.metadata,
  };
  if (terminal) patch.checkpoint = null;
  else if (Object.prototype.hasOwnProperty.call(options, 'checkpoint')) patch.checkpoint = options.checkpoint;
  if (Object.prototype.hasOwnProperty.call(options, 'results')) patch.results = options.results;
  if (Object.prototype.hasOwnProperty.call(options, 'plan')) patch.plan = options.plan;
  if (waiting) patch.metadata = { ...(options.metadata || {}), awaitingApproval: true };
  else if (options.metadata && Object.prototype.hasOwnProperty.call(options.metadata, 'awaitingApproval')) {
    patch.metadata = { ...options.metadata, awaitingApproval: false };
  }
  if (patch.metadata === undefined) delete patch.metadata;
  return patch;
}

function runtimePatch(state, now) {
  const terminal = state === 'completed' || state === 'cancelled';
  return {
    state: runtimeStateForState(state),
    heartbeatAt: state === 'running' ? iso(now) : null,
    completedAt: terminal ? iso(now) : null
  };
}

function createDelegatedRunLifecycle({
  taskStore,
  runtimeStore = null,
  traceStore = null,
  now = () => new Date(),
  logger = console
} = {}) {
  if (!taskStore) throw new TypeError('createDelegatedRunLifecycle requires taskStore');
  if (typeof taskStore.updateRun !== 'function' || typeof taskStore.updateTaskCas !== 'function') {
    throw new TypeError('taskStore must expose updateRun and updateTaskCas CAS methods');
  }
  if (runtimeStore && typeof runtimeStore.project !== 'function') {
    throw new TypeError('runtimeStore must expose exactly one project(userId, task, state, patch, options) interface');
  }
  const traces = traceStore || taskStore;

  async function projectRuntime(userId, task, state, at, runtimeOptions = {}) {
    if (!runtimeStore) return { projected: false };
    try {
      let projectionResult = null;
      if (runtimeStore.project) {
        projectionResult = await runtimeStore.project(userId, task, state, runtimePatch(state, at), runtimeOptions);
      }
      if (projectionResult?.sessionId && !task.metadata?.runtimeSessionId) {
        const metadata = { ...(task.metadata || {}), runtimeSessionId: projectionResult.sessionId };
        if (task.status === 'running') {
          await taskStore.updateRun(userId, task.id, task.attempt, { metadata });
        } else {
          await taskStore.updateTaskCas(userId, task.id, task.status, null, { metadata });
        }
      }
      return { projected: true };
    } catch (error) {
      logger.error?.('[delegated-run] runtime projection failed:', boundedError(error));
      throw new DelegatedRunLifecycleError('The run state was saved, but its runtime projection was not.', {
        partial: true,
        authoritativeSaved: true,
        state,
        taskId: task.id,
        cause: error
      });
    }
  }

  async function transition(userId, taskId, state, options = {}) {
    const at = options.at || now();
    const existing = options.task || await taskStore.getTask(userId, taskId);
    if (!existing) return null;
    const currentState = canonicalStateForTask(existing);
    if (currentState === 'completed' || currentState === 'cancelled') return existing;
    if (currentState !== state && !ALLOWED_TRANSITIONS[currentState]?.has(state)) {
      throw new DelegatedRunLifecycleError(`Cannot move delegated run from ${currentState} to ${state}.`, { partial: false, state, taskId });
    }
    const patch = taskPatch(state, at, {
      ...options,
      metadata: options.metadata === undefined ? existing.metadata : options.metadata,
      checkpoint: options.checkpoint === undefined ? existing.checkpoint : options.checkpoint
    });
    let saved;
    try {
      const ownerAttempt = options.ownerAttempt;
      if (existing.status === 'running' && ownerAttempt == null) {
        throw new DelegatedRunLifecycleError('A claimed attempt is required for a run-owned write.', {
          partial: false, authoritativeSaved: false, state, taskId
        });
      }
      saved = existing.status === 'running'
        ? await taskStore.updateRun(userId, taskId, ownerAttempt, patch)
        : await taskStore.updateTaskCas(userId, taskId, existing.status, ownerAttempt, patch);
    } catch (error) {
      // No runtime write happens before this point. The task row remains the
      // only authority when its persistence fails.
      throw new DelegatedRunLifecycleError('The delegated run state could not be saved.', {
        partial: false,
        authoritativeSaved: false,
        state,
        taskId,
        cause: error
      });
    }
    await projectRuntime(userId, saved, state, at);
    return saved;
  }

  return {
    CANONICAL_STATES,
    TRACE_STATUS_TO_CANONICAL,
    stateFromTrace,
    taskStatusForState,
    runtimeStateForState,

    async create(userId, goal, options = {}) {
      const task = await taskStore.createTask(userId, goal, options);
      return task;
    },
    async get(userId, taskId) { return taskStore.getTask(userId, taskId); },
    async list(userId, status = null) { return taskStore.listTasks(userId, status); },
    async updateControls(userId, taskId, updates) {
      const allowed = new Set(['autonomy', 'metadata']);
      if (Object.keys(updates || {}).some(key => !allowed.has(key))) {
        throw new DelegatedRunLifecycleError('Only task controls may be changed through this API.', { partial: false });
      }
      if (updates.metadata && (Object.keys(updates.metadata).length > 16 || JSON.stringify(updates.metadata).length > 8000)) {
        throw new DelegatedRunLifecycleError('Task metadata is too large.', { partial: false });
      }
      const task = await taskStore.getTask(userId, taskId);
      if (!task) return null;
      const patch = {
        ...(updates.autonomy !== undefined ? { autonomy: updates.autonomy } : {}),
        ...(updates.metadata ? { metadata: { ...(task.metadata || {}), ...updates.metadata } } : {})
      };
      try {
        return await taskStore.updateTaskCas(
          userId,
          taskId,
          task.status,
          task.status === 'running' ? task.attempt : null,
          patch
        );
      } catch (error) {
        throw new DelegatedRunLifecycleError('The task controls changed while the run was moving.', {
          partial: false, authoritativeSaved: false, taskId, cause: error
        });
      }
    },
    async updateAppointmentProgress(userId, taskId, updates = {}) {
      const task = await taskStore.getTask(userId, taskId);
      if (!task) return null;
      const state = updates.state || 'paused';
      if (!['ready', 'paused', 'completed', 'failed'].includes(state)) {
        throw new DelegatedRunLifecycleError('Unsupported appointment state.', { partial: false });
      }
      const current = canonicalStateForTask(task);
      if (current === 'completed' || current === 'cancelled') return task;
      const allowed = current === 'ready' || current === 'paused' || current === 'failed'
        ? new Set(['paused', 'completed', 'failed'])
        : new Set();
      if (current !== state && !allowed.has(state)) {
        throw new DelegatedRunLifecycleError(`Cannot move appointment work from ${current} to ${state}.`, { partial: false, taskId });
      }
      const at = now();
      const patch = taskPatch(state, at, {
        checkpoint: Object.prototype.hasOwnProperty.call(updates, 'checkpoint') ? updates.checkpoint : task.checkpoint,
        results: updates.results === undefined ? task.results : updates.results,
        lastError: updates.lastError || null,
        metadata: {
          ...(task.metadata || {}),
          appointmentBooking: updates.booking === undefined ? task.metadata?.appointmentBooking : updates.booking
        }
      });
      let saved;
      try {
        saved = task.status === 'running'
          ? await taskStore.updateRun(userId, taskId, task.attempt, patch)
          : await taskStore.updateTaskCas(userId, taskId, task.status, null, patch);
      } catch (error) {
        throw new DelegatedRunLifecycleError('The appointment state changed before it could be saved.', {
          partial: false, authoritativeSaved: false, taskId, cause: error
        });
      }
      await projectRuntime(userId, saved, state, at);
      if (traces.saveTrace) {
        try {
          await traces.saveTrace(taskId, userId, 0, `appointment_${state}`, { phase: updates.booking?.phase || null });
        } catch (error) {
          logger.error?.('[delegated-run] appointment trace persistence failed:', boundedError(error));
        }
      }
      return saved;
    },

    async claimStart(userId, taskId, options = {}) {
      let claimed;
      try {
        claimed = await taskStore.claimRun(userId, taskId, options);
      } catch (error) {
        throw new DelegatedRunLifecycleError('The delegated run could not be claimed.', { cause: error, partial: false });
      }
      if (!claimed) return null;
      try {
        await projectRuntime(userId, claimed, 'running', options.now || now(), options.runtime || {});
      } catch (error) {
        // Claim/start is the one transition where compensating the task back
        // to a resumable state is safe: no work has begun yet. The cleanup is
        // authoritative but deliberately does not pretend the runtime write
        // succeeded.
        try {
          await taskStore.updateRun(userId, taskId, claimed.attempt, {
            status: 'paused', heartbeat_at: null,
            last_error: 'The work session could not be started.'
          });
          error.claimCompensated = true;
        } catch (cleanupError) {
          error.claimCompensationError = cleanupError;
        }
        throw error;
      }
      return claimed;
    },
    async assertOwner(userId, taskId, ownerAttempt) {
      if (ownerAttempt == null) return null;
      const task = await taskStore.getTask(userId, taskId);
      if (!task || task.status !== 'running' || task.attempt !== ownerAttempt) return null;
      // A no-op owner write is the launch fence: cancellation or another claimant
      // winning after the initial claim makes this CAS return no row.
      return taskStore.updateRun(userId, taskId, ownerAttempt, {
        heartbeat_at: task.heartbeat_at || iso(now())
      });
    },

    async checkpoint(userId, taskId, checkpointData, ownerAttempt) {
      const task = await taskStore.getTask(userId, taskId);
      if (!task) return null;
      if (task.status !== 'running') {
        throw new DelegatedRunLifecycleError('A checkpoint can only be saved for a running delegated run.', { partial: false });
      }
      if (ownerAttempt == null) throw new DelegatedRunLifecycleError('A claimed attempt is required for a checkpoint.', { partial: false });
      return transition(userId, taskId, 'running', {
        task,
        ownerAttempt,
        checkpoint: taskStore.trimCheckpoint ? taskStore.trimCheckpoint(checkpointData) : checkpointData
      });
    },
    async heartbeat(userId, taskId, ownerAttempt) { return this.checkpoint(userId, taskId, (await taskStore.getTask(userId, taskId))?.checkpoint || {}, ownerAttempt); },
    async settleFromTrace(userId, taskId, trace, options = {}) {
      const requestedState = stateFromTrace(trace);
      const metadata = options.metadata;
      const saved = await transition(userId, taskId, requestedState, {
        ...options,
        metadata,
        results: options.results,
        plan: options.plan,
        checkpoint: requestedState === 'completed' || requestedState === 'cancelled' ? null : options.checkpoint,
        ownerAttempt: options.ownerAttempt,
        lastError: requestedState === 'failed' || requestedState === 'paused' ? (options.lastError || trace?.lastError || 'Run stopped before the goal was complete.') : null
      });
      const state = canonicalStateForTask(saved);
      let tracePersisted = true;
      if (traces.saveTrace) {
        try {
          await traces.saveTrace(taskId, userId, options.step || trace?.steps?.length || 0, `agent_run_${state}`, options.traceData || trace);
        } catch (error) {
          tracePersisted = false;
          logger.error?.('[delegated-run] diagnostic trace persistence failed:', boundedError(error));
        }
      }
      return { task: saved, state, tracePersisted };
    },
    async repairProjection(userId, taskOrId) {
      const task = typeof taskOrId === 'object' ? taskOrId : await taskStore.getTask(userId, taskOrId);
      if (!task) return null;
      const state = canonicalStateForTask(task);
      await projectRuntime(userId, task, state, now());
      return { task, state, repaired: true };
    },
    async interrupt(userId, taskId, error, options = {}) {
      const state = options.failed === true ? 'failed' : 'paused';
      return transition(userId, taskId, state, { ...options, lastError: boundedError(error, 'Run was interrupted before it finished.') });
    },
    async waitForApproval(userId, taskId, options = {}) {
      return transition(userId, taskId, 'waiting_for_user', options);
    },
    async recordApprovalResult(userId, taskId, { results, checkpoint, metadata, ownerAttempt } = {}) {
      const task = await taskStore.getTask(userId, taskId);
      if (!task) return null;
      if (ownerAttempt == null) throw new DelegatedRunLifecycleError('A claimed attempt is required for approval results.', { partial: false });
      return transition(userId, taskId, 'running', {
        task,
        ownerAttempt,
        results,
        checkpoint,
        metadata: { ...(task.metadata || {}), ...(metadata || {}), awaitingApproval: false },
        lastError: null
      });
    },
    async resumeAfterApproval(userId, taskId, options = {}) {
      return this.claimStart(userId, taskId, { ...options, allowAwaitingApproval: true });
    },
    async cancel(userId, taskId, options = {}) {
      return transition(userId, taskId, 'cancelled', options);
    },
    async recoverStale(nowValue = now(), staleMs) {
      const recovered = await taskStore.recoverStaleRuns(nowValue, staleMs);
      if (runtimeStore) {
        for (const task of recovered || []) {
          await projectRuntime(task.user_id, task, 'paused', nowValue);
        }
      }
      return recovered || [];
    },
  };
}

// Small HTTP-facing seam used by route tests and adapters. Authentication is
// intentionally outside this module; these handlers receive an already
// authenticated user id and return bounded result objects rather than Express
// objects, so the real routes can compose them without a database in tests.
function createDelegatedRunRouteHandlers({ lifecycle }) {
  if (!lifecycle) throw new TypeError('createDelegatedRunRouteHandlers requires lifecycle');
  return {
    async run({ userId, taskId, runtime, task: suppliedTask } = {}) {
      const task = suppliedTask || await lifecycle.get(userId, taskId);
      if (!task) return { status: 404, body: { error: 'Not found' } };
      if (task.metadata?.awaitingApproval === true) {
        return { status: 409, body: { error: 'That task is waiting for your approval.', awaitingApproval: true, taskId } };
      }
      const claimed = await lifecycle.claimStart(userId, taskId, { runtime });
      if (!claimed) return { status: 409, body: { error: 'That task is already running or was claimed by another request.', taskId } };
      return { status: 200, body: { started: true, taskId, resumed: Boolean(task.checkpoint) }, claimed };
    },
    async resumeApproval({ userId, taskId, runtime } = {}) {
      const claimed = await lifecycle.resumeAfterApproval(userId, taskId, { runtime });
      return claimed
        ? { status: 200, body: { resumed: true, taskId } }
        : { status: 409, body: { resumed: false, taskId } };
    },
    async cancel({ userId, taskId } = {}) {
      const task = await lifecycle.get(userId, taskId);
      if (!task) return { status: 404, body: { error: 'Not found' } };
      const saved = await lifecycle.cancel(userId, taskId, { metadata: task.metadata || {}, ownerAttempt: task.status === 'running' ? task.attempt : undefined });
      const state = saved ? canonicalStateForTask(saved) : null;
      return {
        status: state === 'completed' ? 409 : 200,
        body: { cancelled: state === 'cancelled', state, taskId }
      };
    }
  };
}

module.exports = {
  CANONICAL_STATES,
  TRACE_STATUS_TO_CANONICAL,
  DelegatedRunLifecycleError,
  stateFromTrace,
  taskStatusForState,
  runtimeStateForState,
  taskPatch,
  runtimePatch,
  createDelegatedRunLifecycle,
  createDelegatedRunRouteHandlers
};

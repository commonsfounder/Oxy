const { createSupabaseServiceClient } = require('../../runtime');

let supabase;
function getSupabase() {
  if (!supabase) supabase = createSupabaseServiceClient();
  return supabase;
}

let defaultTaskManager;
function getDefaultTaskManager() {
  if (!defaultTaskManager) defaultTaskManager = createTaskManager(getSupabase());
  return defaultTaskManager;
}

async function createTask(...args) { return getDefaultTaskManager().createTask(...args); }
async function getTask(...args) { return getDefaultTaskManager().getTask(...args); }
async function listTasks(...args) { return getDefaultTaskManager().listTasks(...args); }
async function updateTask(...args) { return getDefaultTaskManager().updateTask(...args); }

/*
 * Atomically claim a task for one background run. The old read-then-update shape
 * let two Fly machines observe the same paused task and both replay its
 * checkpoint. The status (and, for stale running rows, heartbeat) is part of the
 * update predicate, so only one caller receives the claimed row.
 */
async function claimRun(...args) { return getDefaultTaskManager().claimRun(...args); }

async function appendResultToTask(userId, taskId, resultEntry) {
  // Compatibility only. This read/modify/write operation is not safe under
  // concurrent delegated runs and is intentionally excluded from lifecycle
  // settlement. New code must write the complete owned result set instead.
  const task = await getTask(userId, taskId);
  if (!task) return null;
  const results = Array.isArray(task.results) ? task.results : [];
  results.push({ ...resultEntry, ts: Date.now() });
  return updateTask(userId, taskId, { results, current_step: (task.current_step || 0) + 1 });
}

async function saveTrace(...args) { return getDefaultTaskManager().saveTrace(...args); }

async function completeTask(userId, taskId, finalStatus = 'completed') {
  return updateTask(userId, taskId, {
    status: finalStatus,
    completed_at: new Date().toISOString(),
    heartbeat_at: null,
    // A finished run has nothing to resume. Leaving the checkpoint behind would let a
    // later resume replay a completed goal.
    checkpoint: null
  });
}

// A run whose heartbeat is older than this is treated as dead. Comfortably longer than the
// slowest single iteration (a browser task can hold one open for minutes) so a busy run is
// never mistaken for a stalled one.
const STALE_RUN_MS = 15 * 60 * 1000;

/*
 * Checkpoints are written after every iteration, so they must stay small enough that the
 * write is never the slow part of the loop. Oldest turns are dropped first: the most recent
 * exchange is what the next iteration actually needs, and the goal is re-stated on resume.
 */
const MAX_CHECKPOINT_BYTES = 256 * 1024;

function trimCheckpoint(checkpoint) {
  const trimmed = { ...checkpoint, contents: [...(checkpoint.contents || [])] };
  while (trimmed.contents.length > 2 && Buffer.byteLength(JSON.stringify(trimmed), 'utf8') > MAX_CHECKPOINT_BYTES) {
    trimmed.contents.shift();
  }
  if (Buffer.byteLength(JSON.stringify(trimmed), 'utf8') > MAX_CHECKPOINT_BYTES) {
    // Even two turns can exceed the cap if a tool returned something huge. Keep the shape
    // valid and resumable rather than failing the write.
    trimmed.contents = trimmed.contents.slice(-1);
    trimmed.truncated = true;
  }
  return trimmed;
}

async function saveCheckpoint(userId, taskId, checkpoint) {
  return updateTask(userId, taskId, {
    checkpoint: trimCheckpoint(checkpoint),
    heartbeat_at: new Date().toISOString()
  });
}

/*
 * Hand back runs abandoned by a dead instance. They become 'paused', not 'failed': the
 * checkpoint is intact, so the work is resumable and calling it a failure would throw away
 * everything already done.
 */
async function recoverStaleRuns(...args) { return getDefaultTaskManager().recoverStaleRuns(...args); }

function isRunActive(task, now = new Date(), staleMs = STALE_RUN_MS) {
  if (task?.status !== 'running') return false;
  if (!task.heartbeat_at) return false;
  return now.getTime() - new Date(task.heartbeat_at).getTime() < staleMs;
}

// Simple simulation store (in-memory fallback + DB)
const simCache = new Map();

async function recordSimulation(userId, goal, simulatedActions, outcomes) {
  const sb = getSupabase();
  const { data } = await sb.from('simulation_runs').insert({
    user_id: userId,
    goal,
    simulated_actions: simulatedActions,
    outcomes
  }).select().single().catch(() => null);
  const key = `${userId}:${Date.now()}`;
  simCache.set(key, { goal, simulatedActions, outcomes });
  return data || { id: key, goal, simulated_actions: simulatedActions, outcomes };
}

async function getRecentSimulations(userId) {
  const sb = getSupabase();
  const { data } = await sb.from('simulation_runs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(10);
  return data || Array.from(simCache.values()).slice(0, 5);
}

// === Recipes: user-defined automations (Poke Kitchen style) ===
async function saveRecipe(userId, name, goalTemplate, steps = [], metadata = {}) {
  const sb = getSupabase();
  const { data, error } = await sb.from('agent_tasks').insert({
    user_id: userId,
    goal: name,
    status: 'recipe',
    plan: { goalTemplate, steps },
    metadata: { type: 'recipe', ...metadata }
  }).select().single();
  if (error) throw error;
  return data;
}

async function listRecipes(userId) {
  const sb = getSupabase();
  const { data } = await sb.from('agent_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'recipe')
    .order('created_at', { ascending: false })
    .limit(50);
  return (data || []).map(r => ({
    id: r.id,
    name: r.goal,
    goalTemplate: r.plan?.goalTemplate || r.goal,
    steps: r.plan?.steps || [],
    metadata: r.metadata || {}
  }));
}

/*
 * Explicit-client store for deep services and tests. The legacy exports below
 * retain their compatibility surface, but new lifecycle code can no longer
 * acquire a hidden Supabase client through this module.
 */
function createTaskManager(client) {
  if (!client) throw new TypeError('createTaskManager requires a Supabase client');
  const sb = client;
  const store = {
    async createTask(userId, goal, options = {}) {
      const { data, error } = await sb.from('agent_tasks').insert({
        user_id: userId,
        goal,
        status: 'pending',
        plan: options.plan || null,
        autonomy: options.autonomy || 'Active',
        metadata: options.metadata || {}
      }).select().single();
      if (error) throw error;
      return data;
    },
    async getTask(userId, taskId) {
      const { data, error } = await sb.from('agent_tasks').select('*')
        .eq('user_id', userId).eq('id', taskId).maybeSingle();
      if (error) throw error;
      return data;
    },
    async listTasks(userId, statusFilter = null) {
      let query = sb.from('agent_tasks').select('*').eq('user_id', userId)
        .order('created_at', { ascending: false }).limit(50);
      if (statusFilter) query = query.eq('status', statusFilter);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    async updateTask(userId, taskId, updates) {
      const { data, error } = await sb.from('agent_tasks').update({ ...updates, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('id', taskId).select().single();
      if (error) throw error;
      return data;
    },
    async updateRun(userId, taskId, attempt, updates) {
      const { data, error } = await sb.from('agent_tasks')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('id', taskId).eq('status', 'running').eq('attempt', attempt)
        .select().maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('The delegated run no longer owns this task.');
      return data;
    },
    async updateTaskCas(userId, taskId, expectedStatus, expectedAttempt, updates) {
      let query = sb.from('agent_tasks').update({ ...updates, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('id', taskId).eq('status', expectedStatus);
      if (expectedAttempt != null) query = query.eq('attempt', expectedAttempt);
      const { data, error } = await query.select().maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('The delegated run changed before this write completed.');
      return data;
    },
    async claimRun(userId, taskId, options = {}) {
      const now = options.now || new Date();
      const task = await store.getTask(userId, taskId);
      if (!task) return null;
      const status = String(task.status || '').toLowerCase();
      const active = isRunActive(task, now);
      const staleRunning = status === 'running' && !active;
      const claimable = ['pending', 'paused', 'failed'].includes(status) || staleRunning;
      if (!claimable || (task.metadata?.awaitingApproval === true && !options.allowAwaitingApproval)) return null;
      let query = sb.from('agent_tasks').update({
        status: 'running', heartbeat_at: now.toISOString(), attempt: (task.attempt || 0) + 1,
        last_error: null, updated_at: now.toISOString()
      }).eq('user_id', userId).eq('id', taskId).eq('status', task.status);
      query = status === 'running'
        ? (task.heartbeat_at === null ? query.is('heartbeat_at', null) : query.eq('heartbeat_at', task.heartbeat_at))
        : query;
      const { data, error } = await query.select().maybeSingle();
      if (error) throw error;
      return data || null;
    },
    async saveTrace(taskId, userId, step, type, data) {
      const { error } = await sb.from('agent_traces').insert({ task_id: taskId, user_id: userId, step, type, data });
      if (error) throw error;
      return { saved: true };
    },
    trimCheckpoint,
    async recoverStaleRuns(now = new Date(), staleMs = STALE_RUN_MS) {
      const cutoff = new Date(now.getTime() - staleMs).toISOString();
      const { data, error } = await sb.from('agent_tasks').update({
        status: 'paused', heartbeat_at: null,
        last_error: 'Run was interrupted before it finished. Resume to continue where it stopped.',
        updated_at: now.toISOString()
      }).eq('status', 'running').lt('heartbeat_at', cutoff).select('id, user_id, goal, metadata, checkpoint, status, attempt');
      if (error) throw error;
      return data || [];
    }
  };
  return store;
}

module.exports = {
  createTaskManager,
  createTask,
  getTask,
  listTasks,
  updateTask,
  claimRun,
  appendResultToTask,
  saveTrace,
  completeTask,
  saveCheckpoint,
  recoverStaleRuns,
  isRunActive,
  trimCheckpoint,
  STALE_RUN_MS,
  recordSimulation,
  getRecentSimulations,
  saveRecipe,
  listRecipes
};

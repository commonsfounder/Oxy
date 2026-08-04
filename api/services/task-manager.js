const { createSupabaseServiceClient } = require('../../runtime');

let supabase;
function getSupabase() {
  if (!supabase) supabase = createSupabaseServiceClient();
  return supabase;
}

async function createTask(userId, goal, options = {}) {
  const sb = getSupabase();
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
}

async function getTask(userId, taskId) {
  const sb = getSupabase();
  const { data } = await sb.from('agent_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('id', taskId)
    .maybeSingle();
  return data;
}

async function listTasks(userId, statusFilter = null) {
  const sb = getSupabase();
  let q = sb.from('agent_tasks').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(50);
  if (statusFilter) q = q.eq('status', statusFilter);
  const { data } = await q;
  return data || [];
}

async function updateTask(userId, taskId, updates) {
  const sb = getSupabase();
  const { data, error } = await sb.from('agent_tasks')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', taskId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function appendResultToTask(userId, taskId, resultEntry) {
  const task = await getTask(userId, taskId);
  if (!task) return null;
  const results = Array.isArray(task.results) ? task.results : [];
  results.push({ ...resultEntry, ts: Date.now() });
  return updateTask(userId, taskId, { results, current_step: (task.current_step || 0) + 1 });
}

async function saveTrace(taskId, userId, step, type, data) {
  const sb = getSupabase();
  await sb.from('agent_traces').insert({
    task_id: taskId,
    user_id: userId,
    step,
    type,
    data
  }).catch(() => {});
}

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
async function recoverStaleRuns(now = new Date(), staleMs = STALE_RUN_MS) {
  const sb = getSupabase();
  const cutoff = new Date(now.getTime() - staleMs).toISOString();
  const { data, error } = await sb.from('agent_tasks')
    .update({
      status: 'paused',
      last_error: 'Run was interrupted before it finished. Resume to continue where it stopped.',
      updated_at: now.toISOString()
    })
    .eq('status', 'running')
    .lt('heartbeat_at', cutoff)
    .select('id, user_id, goal');
  if (error) return [];
  return data || [];
}

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

async function executeRecipe(userId, recipeId, overrides = {}) {
  const task = await getTask(userId, recipeId);
  if (!task || task.status !== 'recipe') throw new Error('Recipe not found');
  const plan = task.plan || {};
  const goal = overrides.goal || plan.goalTemplate || task.goal;
  // Create a real persistent task from the recipe. User or sweep can trigger agent run.
  const newTask = await createTask(userId, goal, { autonomy: 'High', plan: plan.steps || [], metadata: { fromRecipe: recipeId } });
  return { recipeId, newTaskId: newTask.id, started: true, note: 'Task created. Use /agent/tasks/:id/run or high autonomy chat to execute.' };
}

module.exports = {
  createTask,
  getTask,
  listTasks,
  updateTask,
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
  listRecipes,
  executeRecipe
};
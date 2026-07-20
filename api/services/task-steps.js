// Persists step-by-step progress events for browser-automation tasks so a later API can expose
// live "what is the agent doing right now" visibility. Best-effort: recordTaskStep must never
// throw, since a logging failure here must never break a running browser task.

async function recordTaskStep(supabase, { taskId, userId, stepName, phase = 'progress', detail = null, status = 'ok' }) {
  try {
    const { data, error } = await supabase
      .from('task_steps')
      .insert({ task_id: taskId, user_id: userId, step_name: stepName, phase, status, detail })
      .select()
      .single();
    if (error) return { error };
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

async function getTaskSteps(supabase, taskId, userId) {
  try {
    const { data, error } = await supabase
      .from('task_steps')
      .select('*')
      .eq('task_id', taskId)
      .eq('user_id', userId)
      .order('created_at');
    if (error) return { steps: [], error };
    return { steps: data };
  } catch (err) {
    return { steps: [], error: err.message };
  }
}

module.exports = { recordTaskStep, getTaskSteps };

'use strict';

// Personal-memory entity/task recall (Phase 3 of the aside-parity roadmap). Logs a short
// {task_id, site, entity_name, entity_type, timestamp} row for entities the AGENT touches
// while running a task (a product, a candidate, a listing) — never manual browsing (no
// surface for that in this product) and never raw page content, only a label string. Mirrors
// task-steps.js's never-throw contract: this is best-effort telemetry, never allowed to break
// the task it's recording.

async function recordTaskEntity(supabase, { taskId, userId, site, entityName, entityType = null }) {
  try {
    const { data, error } = await supabase
      .from('task_entities')
      .insert({ task_id: taskId, user_id: userId, site, entity_name: entityName, entity_type: entityType })
      .select()
      .single();
    if (error) return { error };
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

async function findRecentEntity(supabase, userId, { keyword, sinceHours = 72 }) {
  const { data, error } = await supabase
    .from('task_entities')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error || !data) return null;

  const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
  const needle = String(keyword || '').toLowerCase();
  if (!needle) return null;

  const match = data.find((row) => {
    const withinWindow = new Date(row.created_at).getTime() >= cutoff;
    const matchesKeyword =
      (row.entity_name || '').toLowerCase().includes(needle) ||
      (row.entity_type || '').toLowerCase().includes(needle);
    return withinWindow && matchesKeyword;
  });

  return match || null;
}

async function listRecentEntities(supabase, userId, limit = 10) {
  const { data, error } = await supabase
    .from('task_entities')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error || !data) return { entities: [] };
  return { entities: data.slice(0, limit) };
}

module.exports = { recordTaskEntity, findRecentEntity, listRecentEntities };

// User-saved routines: a named prompt a user can save and re-run later. Simple CRUD
// (create/list/delete) over the `routines` table (supabase-migration-routines.sql).
// Best-effort: never throws, since a storage failure here must never crash a request.

async function createRoutine(supabase, { userId, name, prompt, intervalMinutes = null }) {
  try {
    const nextRunAt = intervalMinutes ? new Date(Date.now() + intervalMinutes * 60000).toISOString() : null;
    const { data, error } = await supabase
      .from('routines')
      .insert({ user_id: userId, name, prompt, interval_minutes: intervalMinutes, next_run_at: nextRunAt })
      .select()
      .single();
    if (error) return { error };
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

async function listDueRoutines(supabase, now) {
  try {
    const { data, error } = await supabase
      .from('routines')
      .select('*')
      .not('interval_minutes', 'is', null)
      .lte('next_run_at', now.toISOString());
    if (error || !data) return [];
    return data;
  } catch (err) {
    return [];
  }
}

async function markRoutineRun(supabase, routineId, now) {
  try {
    const { data: routine, error: fetchError } = await supabase.from('routines').select('interval_minutes').eq('id', routineId).single();
    if (fetchError || !routine) return { ok: false, error: fetchError?.message || 'routine not found' };
    const nextRunAt = new Date(now.getTime() + routine.interval_minutes * 60000).toISOString();
    const { error } = await supabase.from('routines').update({ last_run_at: now.toISOString(), next_run_at: nextRunAt }).eq('id', routineId);
    if (error) return { ok: false, error };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function listRoutines(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('routines')
      .select('*')
      .eq('user_id', userId)
      .order('created_at');
    if (error) return { routines: [], error };
    return { routines: data };
  } catch (err) {
    return { routines: [], error: err.message };
  }
}

async function deleteRoutine(supabase, userId, routineId) {
  try {
    const { error } = await supabase
      .from('routines')
      .delete()
      .eq('id', routineId)
      .eq('user_id', userId);
    if (error) return { ok: false, error };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { createRoutine, listRoutines, deleteRoutine, listDueRoutines, markRoutineRun };

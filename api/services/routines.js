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
      // An imported automation arrives with enabled=false so it can't double-fire against
      // its still-live source (see supabase-migration-agent-continuity.sql) — the DB index
      // already assumes this filter; enforce it here too.
      .eq('enabled', true)
      .lte('next_run_at', now.toISOString());
    if (error || !data) return [];
    return data;
  } catch (err) {
    return [];
  }
}

// `outcome.success` distinguishes a real completion from a run that stopped early (loop
// error, unfinished tool calls) — a routine that keeps failing must be visibly failing, not
// silently look identical to one that keeps succeeding just because next_run_at moved on.
// next_run_at always advances regardless of outcome: no retry backoff here (an unattended
// failure retrying every sweep interval instead of its normal cadence is its own runaway-cost
// risk), the routine just tries again at its next normal scheduled time.
async function markRoutineRun(supabase, routineId, now, outcome = { success: true }) {
  try {
    const { data: routine, error: fetchError } = await supabase.from('routines')
      .select('interval_minutes, consecutive_failures')
      .eq('id', routineId)
      .single();
    if (fetchError || !routine) return { ok: false, error: fetchError?.message || 'routine not found' };
    const nextRunAt = new Date(now.getTime() + routine.interval_minutes * 60000).toISOString();
    const success = outcome?.success !== false;
    const { error } = await supabase.from('routines').update({
      last_run_at: now.toISOString(),
      next_run_at: nextRunAt,
      last_run_status: success ? 'success' : 'failed',
      last_run_error: success ? null : String(outcome?.error || 'Routine did not complete.').slice(0, 500),
      consecutive_failures: success ? 0 : (routine.consecutive_failures || 0) + 1
    }).eq('id', routineId);
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

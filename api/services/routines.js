// User-saved routines: a named prompt a user can save and re-run later. Simple CRUD
// (create/list/delete) over the `routines` table (supabase-migration-routines.sql).
// Best-effort: never throws, since a storage failure here must never crash a request.

async function createRoutine(supabase, { userId, name, prompt }) {
  try {
    const { data, error } = await supabase
      .from('routines')
      .insert({ user_id: userId, name, prompt })
      .select()
      .single();
    if (error) return { error };
    return data;
  } catch (err) {
    return { error: err.message };
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

module.exports = { createRoutine, listRoutines, deleteRoutine };

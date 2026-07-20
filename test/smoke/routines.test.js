const assert = require('node:assert/strict');
const test = require('node:test');

const { createRoutine, listRoutines, deleteRoutine, listDueRoutines, markRoutineRun } = require('../../api/services/routines');

function fakeSupabase(rows = []) {
  return {
    from(table) {
      return {
        insert(row) {
          return {
            select() {
              return {
                single: async () => {
                  const inserted = { id: 'routine-1', created_at: new Date().toISOString(), ...row };
                  rows.push(inserted);
                  return { data: inserted, error: null };
                }
              };
            }
          };
        },
        select() {
          return {
            eq(col, val) {
              return {
                order: async () => ({
                  data: rows.filter((r) => r[col] === val),
                  error: null
                })
              };
            }
          };
        },
        delete() {
          return {
            eq(col1, val1) {
              return {
                eq(col2, val2) {
                  const before = rows.length;
                  const remaining = rows.filter((r) => !(r[col1] === val1 && r[col2] === val2));
                  rows.length = 0;
                  rows.push(...remaining);
                  return Promise.resolve({ error: null, count: before - remaining.length });
                }
              };
            }
          };
        }
      };
    }
  };
}

test('createRoutine inserts a row and returns it', async () => {
  const supabase = fakeSupabase();
  const routine = await createRoutine(supabase, { userId: 'u1', name: 'Morning briefing', prompt: 'Summarize my inbox' });
  assert.equal(routine.name, 'Morning briefing');
  assert.equal(routine.user_id, 'u1');
});

test('createRoutine never throws even when the supabase client blows up', async () => {
  const brokenSupabase = {
    from() {
      throw new Error('boom');
    }
  };
  const result = await createRoutine(brokenSupabase, { userId: 'u1', name: 'x', prompt: 'y' });
  assert.ok(result.error, 'expected an error field instead of a thrown exception');
});

test('createRoutine surfaces supabase errors without throwing', async () => {
  const erroringSupabase = {
    from() {
      return {
        insert() {
          return {
            select() {
              return {
                single: async () => ({ data: null, error: { message: 'insert failed' } })
              };
            }
          };
        }
      };
    }
  };
  const result = await createRoutine(erroringSupabase, { userId: 'u1', name: 'x', prompt: 'y' });
  assert.ok(result.error);
});

test('createRoutine then listRoutines returns it for that user only', async () => {
  const store = [];
  const supabase = fakeSupabase(store);
  await createRoutine(supabase, { userId: 'u1', name: 'Morning briefing', prompt: 'Summarize my inbox' });
  await createRoutine(supabase, { userId: 'u2', name: 'Other user', prompt: 'Not mine' });
  const { routines } = await listRoutines(supabase, 'u1');
  assert.equal(routines.length, 1);
  assert.equal(routines[0].name, 'Morning briefing');
});

test('listRoutines never throws even when the supabase client blows up', async () => {
  const brokenSupabase = {
    from() {
      throw new Error('boom');
    }
  };
  const result = await listRoutines(brokenSupabase, 'u1');
  assert.equal(result.routines.length, 0);
  assert.ok(result.error);
});

test('listRoutines surfaces supabase errors without throwing', async () => {
  const erroringSupabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                order: async () => ({ data: null, error: { message: 'some db error' } })
              };
            }
          };
        }
      };
    }
  };
  const result = await listRoutines(erroringSupabase, 'u1');
  assert.ok(result.error);
  assert.deepEqual(result.routines, []);
});

test('deleteRoutine removes only the matching id for that user', async () => {
  const store = [{ id: 'r1', user_id: 'u1', name: 'x', prompt: 'y' }];
  const supabase = fakeSupabase(store);
  const result = await deleteRoutine(supabase, 'u1', 'r1');
  assert.equal(result.ok, true);
  assert.equal(store.length, 0);
});

test('deleteRoutine surfaces a real supabase error without throwing', async () => {
  const erroringSupabase = {
    from() {
      return {
        delete() {
          return {
            eq() {
              return {
                eq: async () => ({ error: { message: 'delete failed' } })
              };
            }
          };
        }
      };
    }
  };
  const result = await deleteRoutine(erroringSupabase, 'u1', 'r1');
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('deleteRoutine never throws even when the supabase client blows up', async () => {
  const brokenSupabase = {
    from() {
      throw new Error('boom');
    }
  };
  const result = await deleteRoutine(brokenSupabase, 'u1', 'r1');
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('createRoutine with intervalMinutes sets next_run_at', async () => {
  const supabase = fakeSupabase();
  const before = Date.now();
  const routine = await createRoutine(supabase, { userId: 'u1', name: 'Daily digest', prompt: 'Summarize inbox', intervalMinutes: 1440 });
  assert.ok(new Date(routine.next_run_at).getTime() > before);
});

test('createRoutine without intervalMinutes leaves next_run_at null', async () => {
  const supabase = fakeSupabase();
  const routine = await createRoutine(supabase, { userId: 'u1', name: 'One-off', prompt: 'Do a thing' });
  assert.equal(routine.next_run_at, null);
});

function fakeDueRoutinesSupabase(rows = []) {
  return {
    from() {
      return {
        select() {
          return {
            not() {
              return {
                lte: async (col, val) => ({
                  data: rows.filter((r) => r[col] <= val),
                  error: null
                })
              };
            }
          };
        }
      };
    }
  };
}

test('listDueRoutines returns only routines whose next_run_at has passed', async () => {
  const rows = [
    { id: 'r1', user_id: 'u1', interval_minutes: 60, next_run_at: new Date(Date.now() - 1000).toISOString() },
    { id: 'r2', user_id: 'u1', interval_minutes: 60, next_run_at: new Date(Date.now() + 100000).toISOString() }
  ];
  const supabase = fakeDueRoutinesSupabase(rows);
  const due = await listDueRoutines(supabase, new Date());
  assert.deepEqual(due.map((r) => r.id), ['r1']);
});

test('listDueRoutines never throws even when the supabase client blows up', async () => {
  const brokenSupabase = { from() { throw new Error('boom'); } };
  const due = await listDueRoutines(brokenSupabase, new Date());
  assert.deepEqual(due, []);
});

function fakeMarkRunSupabase(rows = []) {
  return {
    from() {
      return {
        select() {
          return {
            eq(col, val) {
              return {
                single: async () => {
                  const row = rows.find((r) => r[col] === val);
                  return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
                }
              };
            }
          };
        },
        update(patch) {
          return {
            eq: async (col, val) => {
              const row = rows.find((r) => r[col] === val);
              if (row) Object.assign(row, patch);
              return { error: null };
            }
          };
        }
      };
    }
  };
}

test('markRoutineRun advances next_run_at by interval_minutes', async () => {
  const rows = [{ id: 'r1', interval_minutes: 60, next_run_at: new Date().toISOString() }];
  const supabase = fakeMarkRunSupabase(rows);
  const now = new Date();
  await markRoutineRun(supabase, 'r1', now);
  const updated = rows.find((r) => r.id === 'r1');
  assert.equal(new Date(updated.next_run_at).getTime(), now.getTime() + 60 * 60000);
});

test('markRoutineRun never throws even when the supabase client blows up', async () => {
  const brokenSupabase = { from() { throw new Error('boom'); } };
  const result = await markRoutineRun(brokenSupabase, 'r1', new Date());
  assert.ok(result.error);
});

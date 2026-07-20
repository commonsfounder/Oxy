const assert = require('node:assert/strict');
const test = require('node:test');

const { createRoutine, listRoutines, deleteRoutine } = require('../../api/services/routines');

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

const assert = require('node:assert/strict');
const test = require('node:test');

const { recordTaskStep, getTaskSteps } = require('../../api/services/task-steps');

function fakeSupabase(rows = []) {
  return {
    from(table) {
      return {
        insert(row) {
          return {
            select() {
              return {
                single: async () => {
                  const inserted = { id: 'row-1', ...row };
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
                eq(col2, val2) {
                  return {
                    order: async () => ({
                      data: rows.filter((r) => r[col] === val && r[col2] === val2),
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
  };
}

test('recordTaskStep inserts a row and never throws on bad input', async () => {
  const supabase = fakeSupabase();
  const row = await recordTaskStep(supabase, {
    taskId: 'task-1',
    userId: 'user-1',
    stepName: 'Finding website design example',
    phase: 'progress',
    detail: { url: 'https://example.com' }
  });
  assert.equal(row.step_name, 'Finding website design example');
});

test('recordTaskStep never throws even when the supabase client blows up', async () => {
  const brokenSupabase = {
    from() {
      throw new Error('boom');
    }
  };
  const result = await recordTaskStep(brokenSupabase, {
    taskId: 'task-1',
    userId: 'user-1',
    stepName: 'still should not throw'
  });
  assert.ok(result.error, 'expected an error field instead of a thrown exception');
});

test('recordTaskStep surfaces supabase errors without throwing', async () => {
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
  const result = await recordTaskStep(erroringSupabase, {
    taskId: 'task-1',
    userId: 'user-1',
    stepName: 'x'
  });
  assert.ok(result.error);
});

test('getTaskSteps returns only steps for the given task and user', async () => {
  const rows = [
    { task_id: 'task-1', user_id: 'user-1', step_name: 'a' },
    { task_id: 'task-1', user_id: 'user-2', step_name: 'b' }
  ];
  const supabase = fakeSupabase(rows);
  const result = await getTaskSteps(supabase, 'task-1', 'user-1');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].step_name, 'a');
});

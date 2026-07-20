const assert = require('node:assert/strict');
const test = require('node:test');

const { makePersistingProgress } = require('../../api/services/browser-task');

// Fake supabase client mirroring the shape recordTaskStep expects, following the same
// pattern as test/smoke/task-steps.test.js so this test exercises the real recordTaskStep
// under the hood without hitting a real database.
function fakeSupabase(rows = []) {
  return {
    from(table) {
      return {
        insert(row) {
          return {
            select() {
              return {
                single: async () => {
                  const inserted = { id: `row-${rows.length + 1}`, ...row };
                  rows.push(inserted);
                  return { data: inserted, error: null };
                }
              };
            }
          };
        }
      };
    }
  };
}

test('makePersistingProgress returns a function', () => {
  const progress = makePersistingProgress(fakeSupabase(), { taskId: 't1', userId: 'u1' });
  assert.equal(typeof progress, 'function');
});

test('makePersistingProgress persists a step with the right taskId/userId/stepName', async () => {
  const rows = [];
  const progress = makePersistingProgress(fakeSupabase(rows), { taskId: 'task-42', userId: 'user-7' });
  await progress('Finding website design example');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, 'task-42');
  assert.equal(rows[0].user_id, 'user-7');
  assert.equal(rows[0].step_name, 'Finding website design example');
});

test('makePersistingProgress never throws even when persistence blows up', async () => {
  const brokenSupabase = {
    from() {
      throw new Error('boom');
    }
  };
  const progress = makePersistingProgress(brokenSupabase, { taskId: 't1', userId: 'u1' });
  await assert.doesNotReject(() => progress('some step text'));
});

test('makePersistingProgress never throws when the underlying insert reports an error', async () => {
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
  const progress = makePersistingProgress(erroringSupabase, { taskId: 't1', userId: 'u1' });
  await assert.doesNotReject(() => progress('some step text'));
});

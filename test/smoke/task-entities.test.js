const assert = require('node:assert/strict');
const test = require('node:test');

const { recordTaskEntity, findRecentEntity, listRecentEntities } = require('../../api/services/task-entities');

function fakeSupabase(rows = []) {
  return {
    from(table) {
      return {
        insert(row) {
          return {
            select() {
              return {
                single: async () => {
                  const inserted = { id: `ent-${rows.length + 1}`, created_at: new Date().toISOString(), ...row };
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
                  data: rows.filter((r) => r[col] === val).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
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

test('recordTaskEntity inserts a row', async () => {
  const rows = [];
  const supabase = fakeSupabase(rows);
  const result = await recordTaskEntity(supabase, { taskId: 't1', userId: 'u1', site: 'linkedin.com', entityName: 'Jane Doe', entityType: 'candidate' });
  assert.equal(rows.length, 1);
  assert.equal(result.entity_name, 'Jane Doe');
});

test('recordTaskEntity never throws even when the supabase client blows up', async () => {
  const brokenSupabase = { from() { throw new Error('boom'); } };
  const result = await recordTaskEntity(brokenSupabase, { taskId: 't1', userId: 'u1', site: 'x.com', entityName: 'y' });
  assert.ok(result.error, 'expected an error field instead of a thrown exception');
});

test('findRecentEntity matches by keyword against entity_name or entity_type, most recent first', async () => {
  const now = Date.now();
  const rows = [
    { id: '1', user_id: 'u1', site: 'linkedin.com', entity_name: 'Jane Doe', entity_type: 'candidate', created_at: new Date(now - 1000 * 60 * 60 * 24).toISOString() },
    { id: '2', user_id: 'u1', site: 'linkedin.com', entity_name: 'John Smith', entity_type: 'candidate', created_at: new Date(now - 1000 * 60 * 60).toISOString() }
  ];
  const supabase = fakeSupabase(rows);
  const result = await findRecentEntity(supabase, 'u1', { keyword: 'candidate' });
  assert.equal(result.entity_name, 'John Smith');
});

test('findRecentEntity returns null outside the sinceHours window', async () => {
  const rows = [
    { id: '1', user_id: 'u1', site: 'x.com', entity_name: 'Old Thing', entity_type: 'candidate', created_at: new Date(Date.now() - 1000 * 60 * 60 * 200).toISOString() }
  ];
  const supabase = fakeSupabase(rows);
  const result = await findRecentEntity(supabase, 'u1', { keyword: 'candidate', sinceHours: 72 });
  assert.equal(result, null);
});

test('findRecentEntity returns null when no row matches the keyword', async () => {
  const rows = [
    { id: '1', user_id: 'u1', site: 'x.com', entity_name: 'A Sofa', entity_type: 'product', created_at: new Date().toISOString() }
  ];
  const supabase = fakeSupabase(rows);
  const result = await findRecentEntity(supabase, 'u1', { keyword: 'candidate' });
  assert.equal(result, null);
});

test('listRecentEntities returns up to limit rows for that user, most recent first', async () => {
  const now = Date.now();
  const rows = [
    { id: '1', user_id: 'u1', site: 'x.com', entity_name: 'Old', entity_type: 'product', created_at: new Date(now - 3000).toISOString() },
    { id: '2', user_id: 'u1', site: 'x.com', entity_name: 'New', entity_type: 'product', created_at: new Date(now - 1000).toISOString() },
    { id: '3', user_id: 'u2', site: 'x.com', entity_name: 'OtherUser', entity_type: 'product', created_at: new Date(now).toISOString() }
  ];
  const supabase = fakeSupabase(rows);
  const { entities } = await listRecentEntities(supabase, 'u1', 10);
  assert.equal(entities.length, 2);
  assert.equal(entities[0].entity_name, 'New');
});

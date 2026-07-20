const assert = require('node:assert/strict');
const test = require('node:test');

const { getChatSettings, saveChatSettings } = require('../../api/services/chat-settings');

function fakeChatSettingsSupabase(store = []) {
  return {
    from() {
      return {
        select() {
          return {
            eq(col, val) {
              return {
                single: async () => {
                  const row = store.find((r) => r[col] === val);
                  return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
                }
              };
            }
          };
        },
        upsert: async (row) => {
          const idx = store.findIndex((r) => r.user_id === row.user_id);
          if (idx >= 0) store[idx] = { ...store[idx], ...row };
          else store.push(row);
          return { error: null };
        }
      };
    }
  };
}

test('getChatSettings returns defaults when no row exists', async () => {
  const supabase = fakeChatSettingsSupabase([]);
  const settings = await getChatSettings(supabase, 'u1');
  assert.deepEqual(settings, { effort: 'medium', guardMode: false });
});

test('getChatSettings never throws even when the supabase client blows up', async () => {
  const brokenSupabase = { from() { throw new Error('boom'); } };
  const settings = await getChatSettings(brokenSupabase, 'u1');
  assert.deepEqual(settings, { effort: 'medium', guardMode: false });
});

test('saveChatSettings then getChatSettings returns the saved values', async () => {
  const store = [];
  const supabase = fakeChatSettingsSupabase(store);
  await saveChatSettings(supabase, 'u1', { effort: 'high', guardMode: true });
  const settings = await getChatSettings(supabase, 'u1');
  assert.deepEqual(settings, { effort: 'high', guardMode: true });
});

test('saveChatSettings never throws even when the supabase client blows up', async () => {
  const brokenSupabase = { from() { throw new Error('boom'); } };
  const result = await saveChatSettings(brokenSupabase, 'u1', { effort: 'low', guardMode: false });
  assert.ok(result.error);
});

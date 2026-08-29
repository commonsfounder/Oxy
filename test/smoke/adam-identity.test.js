const assert = require('node:assert/strict');
const test = require('node:test');

const { ensureAdamIdentity, getAdamIdentity, getActiveHandle, buildEmailHandleValue } = require('../../api/services/adam-identity');

function fakeSupabase(seed = {}) {
  const state = {
    millie_identities: [...(seed.millie_identities || [])],
    millie_identity_handles: [...(seed.millie_identity_handles || [])]
  };
  function table(name) {
    return {
      select: () => table(name),
      insert: (row) => {
        const withId = { id: `${name}-${state[name].length + 1}`, ...row };
        state[name].push(withId);
        return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
      },
      eq(field, value) {
        this._filters = [...(this._filters || []), [field, value]];
        return this;
      },
      limit() { return this; },
      async then(resolve) {
        const rows = state[name].filter(row => (this._filters || []).every(([f, v]) => row[f] === v));
        resolve({ data: rows, error: null });
      }
    };
  }
  return { from: table, _state: state };
}

test('ensureAdamIdentity creates an identity and an email handle for a new user', async () => {
  const supabase = fakeSupabase();
  const result = await ensureAdamIdentity(supabase, 'chizi', { attemptPhone: false });
  assert.equal(result.identity.user_id, 'chizi');
  const emailHandle = result.handles.find(h => h.channel_type === 'email');
  assert.ok(emailHandle, 'expected an email handle to be created');
  assert.equal(emailHandle.handle_value, buildEmailHandleValue('chizi'));
  assert.equal(emailHandle.status, 'active');
});

test('ensureAdamIdentity is idempotent — calling twice does not create a second identity', async () => {
  const supabase = fakeSupabase();
  const first = await ensureAdamIdentity(supabase, 'chizi', { attemptPhone: false });
  const second = await ensureAdamIdentity(supabase, 'chizi', { attemptPhone: false });
  assert.equal(first.identity.id, second.identity.id);
  assert.equal(supabase._state.millie_identities.length, 1);
});

test('buildEmailHandleValue produces a stable per-user address under the configured domain', () => {
  const oldDomain = process.env.MILLIE_EMAIL_DOMAIN;
  process.env.MILLIE_EMAIL_DOMAIN = 'millie.oxy.app';
  try {
    assert.equal(buildEmailHandleValue('chizi'), 'chizi@millie.oxy.app');
  } finally {
    if (oldDomain === undefined) delete process.env.MILLIE_EMAIL_DOMAIN;
    else process.env.MILLIE_EMAIL_DOMAIN = oldDomain;
  }
});

test('getActiveHandle returns null when no handle of that channel exists', async () => {
  const supabase = fakeSupabase();
  await ensureAdamIdentity(supabase, 'chizi', { attemptPhone: false });
  const phone = await getActiveHandle(supabase, 'chizi', 'phone_sms');
  assert.equal(phone, null);
});

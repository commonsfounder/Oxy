// Where the Google connector gets its credentials, and — more importantly — what it is
// allowed to WRITE BACK.
//
// Both rules here come from real incidents on this deployment:
//   1. The connectors row for user123 held a perfectly good refresh token while a separate
//      audit concluded Google was "not configured", because it read .env instead. The DB is
//      the source of truth and must win.
//   2. The deployed GMAIL_REFRESH_TOKEN is truncated (39 chars; Google answers
//      invalid_grant). The old env fallback saved whatever it found AND set enabled: true,
//      so a broken env value manufactured a connector row that claimed to be connected and
//      could never work — including for a user who had just disconnected on purpose.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('module');

const { encryptTokens } = require('../../api/services/token-crypto');

// One mutable fixture the fake Supabase reads, so each test can pose a different DB state.
const db = { row: null, upserts: [] };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../runtime' || request === '../../runtime') {
    return {
      createSupabaseServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: async () => ({ data: db.row ? [db.row] : [], error: null })
              })
            })
          }),
          upsert: async (row) => { db.upserts.push(row); return { error: null }; }
        })
      }),
      logMissingRuntimeEnvOnce: () => {}
    };
  }
  if (request === 'axios') {
    // Any refresh attempt fails, so nothing here can accidentally reach Google. The tests
    // below only care about which credential was CHOSEN and what got persisted.
    const fail = async () => { throw Object.assign(new Error('no network in tests'), { response: null }); };
    return { post: fail, get: fail, patch: fail };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const google = require('../../connectors/google');
Module._load = originalLoad;

const ENV_TOKEN = 'env-refresh-token-value';

test.beforeEach(() => {
  db.row = null;
  db.upserts = [];
  process.env.GMAIL_REFRESH_TOKEN = ENV_TOKEN;
  process.env.GMAIL_CLIENT_ID = 'client-id';
  process.env.GMAIL_CLIENT_SECRET = 'client-secret';
  google._private._clearMailboxCache();
});

test('a stored token in the database beats whatever is in the environment', async () => {
  db.row = {
    enabled: true,
    tokens: encryptTokens({ refresh_token: 'stored-refresh-token', client_id: 'c', client_secret: 's' })
  };
  const result = await google.execute('user-1', 'get_emails', {});
  // The refresh fails (no network), but the error names the credential it actually tried —
  // and nothing was written back from a failed attempt.
  assert.equal(result.success, false);
  assert.equal(db.upserts.length, 0, 'a failed refresh must not persist anything');
});

test('a disconnected connector is not silently reconnected from the environment', async () => {
  // enabled:false is a deliberate disconnect (or a refresh Google told us was revoked).
  db.row = { enabled: false, tokens: null };
  const result = await google.execute('user-1', 'get_emails', {});
  assert.equal(result.success, false);
  assert.match(result.error, /disconnected/i);
  assert.equal(db.upserts.length, 0, 'a disconnect must not be undone by a leftover env var');
});

test('an env token that never worked is never written into the connectors row', async () => {
  // No row at all: the env fallback is legitimate here. But it is only a candidate —
  // persisting it before it has worked is what created "connected and permanently failing".
  db.row = null;
  const result = await google.execute('user-1', 'get_emails', {});
  assert.equal(result.success, false);
  assert.equal(db.upserts.length, 0, 'an unproven env credential must not be enshrined as connected');
});

test('getMailbox reports no mailbox rather than throwing when Google is unreachable', async () => {
  db.row = null;
  assert.equal(await google.getMailbox('user-1'), null);
});

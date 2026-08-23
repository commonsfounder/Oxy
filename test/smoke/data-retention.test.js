'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  selectExpiredConversationIds,
  runRetentionSweep,
  RETENTION_POLICY,
} = require('../../api/services/data-retention');

// Minimal fake of the supabase-js fluent client, recording every delete it is
// asked to perform so the test can assert the runner's intent without a real DB.
function fakeSupabase(seed = {}) {
  const ops = [];
  return {
    ops,
    from(table) {
      const ctx = { table, _filters: [] };
      const api = {
        select() { return api; },
        order() { return api; },
        range() { return Promise.resolve({ data: seed[table] || [], error: null }); },
        delete() { ctx._delete = true; return api; },
        in(col, vals) { ops.push({ table, op: 'in', col, vals }); return Promise.resolve({ error: null, count: vals.length }); },
        lt(col, val) { ops.push({ table, op: 'lt', col, val }); return Promise.resolve({ error: null, count: 1 }); },
        or(expr) { ops.push({ table, op: 'or', expr }); return Promise.resolve({ error: null, count: 1 }); },
      };
      return api;
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-01T00:00:00Z').getTime();

function row(id, userId, ageDays) {
  return { id, user_id: userId, created_at: new Date(NOW - ageDays * DAY).toISOString() };
}

test('deletes conversation rows older than the age cutoff', () => {
  const rows = [row('a', 'u1', 200), row('b', 'u1', 10)];
  const expired = selectExpiredConversationIds(rows, { now: NOW, maxAgeDays: 180, keepPerUser: 0 });
  assert.deepStrictEqual(expired, ['a']);
});

test('keeps the newest keepPerUser rows even when all are past the cutoff', () => {
  // three old rows, keep the newest 2: only the oldest is purged
  const rows = [row('old', 'u1', 300), row('mid', 'u1', 250), row('new', 'u1', 200)];
  const expired = selectExpiredConversationIds(rows, { now: NOW, maxAgeDays: 180, keepPerUser: 2 });
  assert.deepStrictEqual(expired, ['old']);
});

test('keep window is per-user, not global', () => {
  const rows = [row('u1old', 'u1', 300), row('u2old', 'u2', 300)];
  // keepPerUser:1 protects each user's single (newest) row independently
  const expired = selectExpiredConversationIds(rows, { now: NOW, maxAgeDays: 180, keepPerUser: 1 });
  assert.deepStrictEqual(expired, []);
});

test('a recent row beyond the keep window is still retained (age gate)', () => {
  // 600 recent rows, keepPerUser 500: the 100 "beyond keep" rows are recent, so age gate spares them
  const rows = Array.from({ length: 600 }, (_, i) => row(`r${i}`, 'u1', 5));
  const expired = selectExpiredConversationIds(rows, { now: NOW, maxAgeDays: 180, keepPerUser: 500 });
  assert.deepStrictEqual(expired, []);
});

test('runRetentionSweep purges expired conversations by id and returns a summary', async () => {
  const seed = {
    conversations: [
      { id: 'old1', user_id: 'u1', created_at: new Date(NOW - 300 * DAY).toISOString() },
      { id: 'keep1', user_id: 'u1', created_at: new Date(NOW - 5 * DAY).toISOString() },
    ],
  };
  const db = fakeSupabase(seed);
  const summary = await runRetentionSweep(db, { now: NOW, logger: { log() {} },
    policy: { conversations: { maxAgeDays: 180, keepPerUser: 0 } } });

  const convDelete = db.ops.find((o) => o.table === 'conversations' && o.op === 'in');
  assert.deepStrictEqual(convDelete.vals, ['old1']);
  assert.strictEqual(summary.conversations, 1);
});

test('runRetentionSweep skips the conversations delete when nothing is expired', async () => {
  const seed = { conversations: [{ id: 'fresh', user_id: 'u1', created_at: new Date(NOW).toISOString() }] };
  const db = fakeSupabase(seed);
  const summary = await runRetentionSweep(db, { now: NOW, logger: { log() {} },
    policy: { conversations: { maxAgeDays: 180, keepPerUser: 0 } } });
  assert.strictEqual(db.ops.some((o) => o.table === 'conversations' && o.op === 'in'), false);
  assert.strictEqual(summary.conversations, 0);
});

test('RETENTION_POLICY documents the conversation window the privacy page promises', () => {
  assert.strictEqual(RETENTION_POLICY.conversations.maxAgeDays, 180);
});

test('external_conversation_events has a retention policy entry', () => {
  assert.ok(RETENTION_POLICY.external_conversation_events);
  assert.equal(RETENTION_POLICY.external_conversation_events.maxAgeDays, 180);
});

test('nearby-display secrets and rendered content expire from the retention policy', () => {
  assert.equal(RETENTION_POLICY.display_pairing_challenges.column, 'expires_at');
  assert.equal(RETENTION_POLICY.display_pairing_challenges.expireWhenPast, true);
  assert.equal(RETENTION_POLICY.display_render_events.column, 'expires_at');
  assert.equal(RETENTION_POLICY.display_render_events.expireWhenPast, true);
});

test('documents retention is keyed on last_used_at, not created_at', () => {
  // A passport scan uploaded once and used every few months must not be deleted for the
  // crime of being old. Age since last USE is the only defensible clock for a file.
  assert.ok(RETENTION_POLICY.documents);
  assert.equal(RETENTION_POLICY.documents.column, 'last_used_at');
  assert.equal(RETENTION_POLICY.documents.storageBucket, 'documents');
});

// Storage-backed tables need the blob removed as well as the row. A surviving object whose
// index row is gone is user data we are still holding and can no longer account for — a
// privacy bug, not just wasted space.
function fakeSupabaseWithStorage(seed = {}) {
  const ops = [];
  const removed = [];
  return {
    ops,
    removed,
    storage: {
      from(bucket) {
        return {
          async remove(paths) { removed.push({ bucket, paths }); return { error: null }; }
        };
      }
    },
    from(table) {
      const api = {
        select() { return api; },
        order() { return api; },
        range() { return Promise.resolve({ data: seed[table] || [], error: null }); },
        delete() { return api; },
        in(col, vals) { ops.push({ table, op: 'in', col, vals }); return Promise.resolve({ error: null, count: vals.length }); },
        lt(col, val) {
          ops.push({ table, op: 'lt', col, val });
          return Promise.resolve({ data: seed[table] || [], error: null, count: (seed[table] || []).length });
        },
      };
      return api;
    },
  };
}

test('runRetentionSweep deletes the blobs of expired documents before dropping their rows', async () => {
  const db = fakeSupabaseWithStorage({
    documents: [
      { id: 'd1', storage_path: 'u1/aaa', last_used_at: new Date(NOW - 400 * DAY).toISOString() },
      { id: 'd2', storage_path: 'u1/bbb', last_used_at: new Date(NOW - 400 * DAY).toISOString() },
    ],
  });

  const summary = await runRetentionSweep(db, {
    now: NOW,
    logger: { log() {} },
    policy: { documents: { maxAgeDays: 365, column: 'last_used_at', storageBucket: 'documents', label: 'x' } },
  });

  assert.deepStrictEqual(db.removed, [{ bucket: 'documents', paths: ['u1/aaa', 'u1/bbb'] }]);
  const rowDelete = db.ops.find((o) => o.table === 'documents' && o.op === 'in');
  assert.deepStrictEqual(rowDelete.vals, ['d1', 'd2']);
  assert.strictEqual(summary.documents, 2);
});

test('a storage-backed table with nothing expired removes no blobs at all', async () => {
  const db = fakeSupabaseWithStorage({ documents: [] });
  const summary = await runRetentionSweep(db, {
    now: NOW,
    logger: { log() {} },
    policy: { documents: { maxAgeDays: 365, column: 'last_used_at', storageBucket: 'documents', label: 'x' } },
  });
  assert.deepStrictEqual(db.removed, []);
  assert.strictEqual(summary.documents, 0);
});

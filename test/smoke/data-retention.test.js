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

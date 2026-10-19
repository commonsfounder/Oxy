const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeliveryRuntime } = require('../../api/services/notification-delivery');

function fakeDb(tables) {
  function from(name) {
    const rows = tables[name];
    const filters = [];
    let patch = null;
    const api = {
      select() { return api; },
      update(p) { patch = p; return api; },
      eq(col, v) { filters.push(r => (col.includes('->>') ? String(r[col.split('->>')[0]]?.[col.split('->>')[1]]) : r[col]) === v); return api; },
      is(col, v) { filters.push(r => (r[col] ?? null) === v); return api; },
      lte(col, v) { filters.push(r => r[col] <= v); return api; },
      gte(col, v) { filters.push(r => r[col] >= v); return api; },
      gt(col, v) { filters.push(r => r[col] > v); return api; },
      limit() { return api; },
      maybeSingle() { return Promise.resolve(run(true)); },
      then(res, rej) { return Promise.resolve(run(false)).then(res, rej); }
    };
    function run(single) {
      const hit = rows.filter(r => filters.every(f => f(r)));
      if (patch) hit.forEach(r => Object.assign(r, patch));
      return { data: single ? (hit[0] ? { id: hit[0].id } : null) : hit, error: null };
    }
    return api;
  }
  return { from };
}

const NOW = new Date('2026-10-19T12:10:00Z');
function setup({ conversations = [], channels = ['push', 'telegram', 'in_app'] } = {}) {
  const sent = [];
  const event = {
    id: 'n1', user_id: 'u1', urgency: 'urgent', status: 'delivered', channel: 'in_app', category: 'action_required',
    title: 'Smoke alarm', body: 'An alarm is going off.', source_ref: { escalate: true },
    delivered_at: '2026-10-19T12:05:00Z', escalated_at: null, acknowledged_at: null
  };
  const tables = { notification_events: [event], conversations };
  const runtime = createDeliveryRuntime({
    supabase: fakeDb(tables),
    sendPush: async (u, p) => { sent.push(['push', p.title]); return { ok: true }; },
    sendEmail: async () => { sent.push(['email']); return { ok: true }; },
    sendTelegram: async (u, p) => { sent.push(['telegram', p.text]); return { ok: true }; },
    createBriefing: async () => ({ id: 'b' }),
    getPreferenceMap: async () => ({}),
    getUserEmail: async () => '',
    countPushDevices: async () => (channels.includes('push') ? 1 : 0),
    getTelegram: async () => ({ canSend: channels.includes('telegram') }),
    env: channels.includes('push') ? { APNS_BUNDLE_ID: 'b', APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_PRIVATE_KEY: 'p' } : {},
    now: () => NOW
  });
  return { runtime, event, sent };
}

test('an unseen urgent alert is re-sent on every connected channel, once', async () => {
  const { runtime, event, sent } = setup();
  const first = await runtime.escalateUnseen();
  assert.deepEqual(first.results[0].sent, ['push', 'telegram']);
  assert.match(sent[0][1], /Still unseen: Smoke alarm/);
  assert.ok(event.escalated_at);
  const second = await runtime.escalateUnseen();
  assert.equal(second.results.length, 0);
});

test('a chat message after the alert counts as seeing it', async () => {
  const { runtime, event, sent } = setup({ conversations: [{ id: 1, user_id: 'u1', role: 'user', created_at: '2026-10-19T12:06:00Z' }] });
  const out = await runtime.escalateUnseen();
  assert.equal(out.results[0].status, 'seen');
  assert.ok(event.acknowledged_at);
  assert.equal(sent.length, 0);
});

test('nothing is sent before the wait is over', async () => {
  const { runtime, sent } = setup();
  const out = await runtime.escalateUnseen({ afterMs: 10 * 60 * 1000 });
  assert.equal(out.results.length, 0);
  assert.equal(sent.length, 0);
});

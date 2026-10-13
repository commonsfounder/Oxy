const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const Module = require('node:module');

process.env.OXY_TOKEN_ENCRYPTION_KEY = process.env.OXY_TOKEN_ENCRYPTION_KEY || 'a'.repeat(64);

// A tolerant in-memory Supabase: the tables the SMS webhook reads and writes behave, and
// anything else (notification delivery, logging) gets empty results instead of a crash.
const state = {};
function rows(name) { return (state[name] ||= []); }
let nextId = 1;
function builder(name) {
  const filters = [];
  let pendingInsert = null;
  const q = {
    eq(f, v) { filters.push(r => r[f] === v); return q; },
    in(f, v) { filters.push(r => v.includes(r[f])); return q; },
    not(f, op, v) { if (op === 'is' && v === null) filters.push(r => r[f] !== null && r[f] !== undefined); return q; },
    insert(row) {
      const list = (Array.isArray(row) ? row : [row]).map(r => ({ id: `${name}-${nextId++}`, created_at: new Date().toISOString(), ...r }));
      rows(name).push(...list);
      pendingInsert = list;
      return q;
    },
    update(patch) { q._patch = patch; return q; },
    single: async () => ({ data: (pendingInsert || rows(name).filter(r => filters.every(f => f(r))))[0] || null, error: null }),
    maybeSingle: async () => q.single(),
    then(resolve, reject) {
      if (q._patch) rows(name).filter(r => filters.every(f => f(r))).forEach(r => Object.assign(r, q._patch));
      const data = pendingInsert || rows(name).filter(r => filters.every(f => f(r)));
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  };
  for (const chain of ['select', 'order', 'limit', 'range', 'gte', 'lte', 'gt', 'lt', 'neq', 'is', 'or', 'ilike', 'upsert', 'delete']) {
    if (!q[chain]) q[chain] = () => q;
  }
  return q;
}
const fakeSupabase = { from: builder, rpc: async () => ({ data: null, error: null }) };

const realRuntime = require('../../runtime');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../runtime' && parent?.filename?.endsWith('/api/index.js')) {
    return { ...realRuntime, createSupabaseServiceClient: () => fakeSupabase };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const app = require('../../api/index');
Module._load = originalLoad;

const GARAGE = '+447700900123';

function seed() {
  for (const key of Object.keys(state)) delete state[key];
  state.phone_number_pool = [
    { id: 'pool-1', phone_number: '+447000000001', provider: 'twilio', status: 'active' },
    { id: 'pool-2', phone_number: '+447000000002', provider: 'twilio', status: 'active' }
  ];
  state.participants = [
    { id: 'p-alice', user_id: 'alice', display_name: GARAGE },
    { id: 'p-bob', user_id: 'bob', display_name: GARAGE }
  ];
  state.participant_addresses = [
    { id: 'a-alice', participant_id: 'p-alice', channel_type: 'phone_sms', address_value: GARAGE },
    { id: 'a-bob', participant_id: 'p-bob', channel_type: 'phone_sms', address_value: GARAGE }
  ];
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  state.external_conversations = [
    { id: 'c-alice', user_id: 'alice', participant_id: 'p-alice', pool_number_id: 'pool-1', status: 'awaiting_reply', last_activity_at: recent },
    { id: 'c-bob', user_id: 'bob', participant_id: 'p-bob', pool_number_id: 'pool-2', status: 'awaiting_reply', last_activity_at: recent }
  ];
}

async function postSms(fields) {
  const server = app.listen(0);
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({
        method: 'POST', hostname: '127.0.0.1', port: server.address().port, path: '/webhooks/millie-sms',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.write(new URLSearchParams(fields).toString());
      req.end();
    });
  } finally {
    server.close();
  }
}

// The webhook acknowledges first and works afterwards.
async function settle() {
  for (let i = 0; i < 50; i++) {
    if (rows('external_conversation_events').length) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('a text to a pool number lands in the conversation of the user who texted that sender from it', async () => {
  seed();
  const status = await postSms({ From: GARAGE, To: '+447000000002', Body: 'Friday at 10 works', MessageSid: 'SMin1' });
  assert.equal(status, 200);
  await settle();
  const events = rows('external_conversation_events');
  assert.equal(events.length, 1);
  assert.equal(events[0].conversation_id, 'c-bob');
  assert.equal(events[0].direction, 'inbound');
  assert.equal(events[0].participant_address_id, 'a-bob');
  assert.equal(events[0].millie_identity_handle_id, null);
});

test('a text to a pool number nobody can own is dropped, not shown to a guess', async () => {
  seed();
  // Both users on the same number with the same sender: should never happen, must not leak.
  state.external_conversations[1].pool_number_id = 'pool-1';
  const status = await postSms({ From: GARAGE, To: '+447000000001', Body: 'Who is this?', MessageSid: 'SMin2' });
  assert.equal(status, 200);
  await settle();
  assert.equal(rows('external_conversation_events').length, 0);
});

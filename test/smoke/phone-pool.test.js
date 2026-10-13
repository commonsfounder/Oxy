const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizePhoneNumber,
  chooseSendingNumber,
  assignPoolNumber,
  routeInboundSms
} = require('../../api/services/phone-pool');
const { registerProvider } = require('../../connectors/phone-provider');
const { handlers } = require('../../api/actions/messaging');

// Enough of the Supabase query builder for the pool: eq / in / not-is-null filters,
// insert().select().single(), update().eq().
function fakeSupabase(seed = {}) {
  const state = {};
  const tables = ['phone_number_pool', 'participants', 'participant_addresses', 'external_conversations',
    'external_conversation_events', 'millie_identities', 'millie_identity_handles'];
  for (const name of tables) state[name] = structuredClone(seed[name] || []);
  let nextId = 1;
  function matches(row, filters) {
    return filters.every(([op, f, v]) => {
      if (op === 'eq') return row[f] === v;
      if (op === 'in') return v.includes(row[f]);
      if (op === 'notnull') return row[f] !== null && row[f] !== undefined;
      return true;
    });
  }
  function table(name) {
    const filters = [];
    const q = {};
    q.select = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.eq = (f, v) => { filters.push(['eq', f, v]); return q; };
    q.in = (f, v) => { filters.push(['in', f, v]); return q; };
    q.not = (f, op, v) => { assert.equal(op, 'is'); assert.equal(v, null); filters.push(['notnull', f]); return q; };
    q.insert = (row) => {
      const withId = { id: `${name}-${nextId++}`, created_at: new Date().toISOString(), ...row };
      state[name].push(withId);
      return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
    };
    q.update = (patch) => ({
      eq: (f, v) => {
        state[name].filter(row => row[f] === v).forEach(row => Object.assign(row, patch));
        return Promise.resolve({ error: null });
      }
    });
    q.then = (resolve, reject) => Promise.resolve({ data: state[name].filter(row => matches(row, filters)), error: null }).then(resolve, reject);
    return q;
  }
  return { from: table, _state: state };
}

const DAY = 24 * 60 * 60 * 1000;
const ago = ms => new Date(Date.now() - ms).toISOString();
const GARAGE = '+447700900123';

function pool(...numbers) {
  return numbers.map((n, i) => ({
    id: `pool-${i + 1}`, phone_number: n, provider: 'fakepool', status: 'active', created_at: ago((10 - i) * DAY)
  }));
}

// User `userId` has texted GARAGE from pool number `poolId`.
function conversationWithGarage(userId, poolId, { lastActivity = ago(DAY), status = 'awaiting_reply' } = {}) {
  return {
    participant: { id: `p-${userId}`, user_id: userId, display_name: GARAGE },
    address: { id: `a-${userId}`, participant_id: `p-${userId}`, channel_type: 'phone_sms', address_value: GARAGE },
    conversation: { id: `c-${userId}-${poolId}`, user_id: userId, participant_id: `p-${userId}`, pool_number_id: poolId, status, last_activity_at: lastActivity }
  };
}

function seedWith(poolRows, ...threads) {
  return {
    phone_number_pool: poolRows,
    participants: threads.map(t => t.participant),
    participant_addresses: threads.map(t => t.address),
    external_conversations: threads.map(t => t.conversation)
  };
}

test('normalizePhoneNumber turns UK national and 00 formats into E.164', () => {
  assert.equal(normalizePhoneNumber('07700 900123'), '+447700900123');
  assert.equal(normalizePhoneNumber('+44 (0)7700-900123'.replace('(0)', '')), '+447700900123');
  assert.equal(normalizePhoneNumber('00447700900123'), '+447700900123');
  assert.equal(normalizePhoneNumber('+1 555 123 4567'), '+15551234567');
  assert.equal(normalizePhoneNumber(''), '');
});

test('a user texting a new business gets the first pool number', async () => {
  const supabase = fakeSupabase(seedWith(pool('+447000000001', '+447000000002')));
  const number = await chooseSendingNumber(supabase, { userId: 'alice', recipient: GARAGE });
  assert.equal(number.id, 'pool-1');
});

test('a second user texting the same business gets a different number, so replies stay unambiguous', async () => {
  const supabase = fakeSupabase(seedWith(pool('+447000000001', '+447000000002'), conversationWithGarage('alice', 'pool-1')));
  const number = await chooseSendingNumber(supabase, { userId: 'bob', recipient: GARAGE });
  assert.equal(number.id, 'pool-2');
});

test('a user keeps texting a business from the number they used before', async () => {
  const supabase = fakeSupabase(seedWith(pool('+447000000001', '+447000000002'), conversationWithGarage('alice', 'pool-2')));
  const number = await chooseSendingNumber(supabase, { userId: 'alice', recipient: GARAGE });
  assert.equal(number.id, 'pool-2');
});

test('a number another user stopped using long ago can be reused when nothing else is free', async () => {
  const supabase = fakeSupabase(seedWith(pool('+447000000001'), conversationWithGarage('alice', 'pool-1', { lastActivity: ago(90 * DAY), status: 'resolved' })));
  const number = await chooseSendingNumber(supabase, { userId: 'bob', recipient: GARAGE });
  assert.equal(number.id, 'pool-1');
});

test('when every number is busy with that business, the pool buys one more', async () => {
  const supabase = fakeSupabase(seedWith(pool('+447000000001'), conversationWithGarage('alice', 'pool-1')));
  const provisioned = [];
  const number = await chooseSendingNumber(supabase, {
    userId: 'bob',
    recipient: GARAGE,
    provisionPhoneNumber: async (who) => {
      provisioned.push(who);
      return { phoneNumber: '+447000000009', providerRef: 'PN9', provider: 'fakepool' };
    }
  });
  assert.deepEqual(provisioned, ['pool']);
  assert.equal(number.phone_number, '+447000000009');
  assert.equal(supabase._state.phone_number_pool.length, 2);
});

test('the pool never grows past MILLIE_PHONE_POOL_MAX', async () => {
  const old = process.env.MILLIE_PHONE_POOL_MAX;
  process.env.MILLIE_PHONE_POOL_MAX = '1';
  try {
    const supabase = fakeSupabase(seedWith(pool('+447000000001'), conversationWithGarage('alice', 'pool-1')));
    await assert.rejects(
      () => chooseSendingNumber(supabase, { userId: 'bob', recipient: GARAGE, provisionPhoneNumber: async () => assert.fail('must not buy') }),
      /MILLIE_PHONE_POOL_MAX/
    );
  } finally {
    if (old === undefined) delete process.env.MILLIE_PHONE_POOL_MAX; else process.env.MILLIE_PHONE_POOL_MAX = old;
  }
});

test('a reply to a pool number goes to the one user who texted that sender from it', async () => {
  const supabase = fakeSupabase(seedWith(pool('+447000000001', '+447000000002'),
    conversationWithGarage('alice', 'pool-1'), conversationWithGarage('bob', 'pool-2')));
  const route = await routeInboundSms(supabase, { toAddress: '+447000000002', fromAddress: GARAGE });
  assert.equal(route.kind, 'routed');
  assert.equal(route.conversation.user_id, 'bob');
});

test('a reply from someone nobody texted from that number is not routed', async () => {
  const supabase = fakeSupabase(seedWith(pool('+447000000001'), conversationWithGarage('alice', 'pool-1')));
  const route = await routeInboundSms(supabase, { toAddress: '+447000000001', fromAddress: '+447700900999' });
  assert.equal(route.kind, 'unknown_sender');
});

test('a reply two users could own is not shown to either', async () => {
  const supabase = fakeSupabase(seedWith(pool('+447000000001'),
    conversationWithGarage('alice', 'pool-1'), conversationWithGarage('bob', 'pool-1')));
  const route = await routeInboundSms(supabase, { toAddress: '+447000000001', fromAddress: GARAGE });
  assert.equal(route.kind, 'ambiguous');
  assert.equal(route.userCount, 2);
});

test('an old conversation on the same number does not block routing to the current one', async () => {
  const supabase = fakeSupabase(seedWith(pool('+447000000001'),
    conversationWithGarage('alice', 'pool-1', { lastActivity: ago(90 * DAY), status: 'resolved' }),
    conversationWithGarage('bob', 'pool-1')));
  const route = await routeInboundSms(supabase, { toAddress: '+447000000001', fromAddress: GARAGE });
  assert.equal(route.kind, 'routed');
  assert.equal(route.conversation.user_id, 'bob');
});

test('a number that is not in the pool is reported as such', async () => {
  const supabase = fakeSupabase(seedWith(pool('+447000000001')));
  const route = await routeInboundSms(supabase, { toAddress: '+447000000555', fromAddress: GARAGE });
  assert.equal(route.kind, 'not_pool');
});

test('assignPoolNumber records the line on the conversation', async () => {
  const supabase = fakeSupabase({ external_conversations: [{ id: 'c1', pool_number_id: null }] });
  await assignPoolNumber(supabase, 'c1', 'pool-1');
  assert.equal(supabase._state.external_conversations[0].pool_number_id, 'pool-1');
});

test('pool reads that fail are errors, not an empty pool', async () => {
  const supabase = { from: () => {
    const q = { select: () => q, eq: () => q, order: () => q, then: (resolve) => resolve({ data: null, error: { message: 'boom' } }) };
    return q;
  } };
  await assert.rejects(() => chooseSendingNumber(supabase, { userId: 'alice', recipient: GARAGE }), /boom/);
  await assert.rejects(() => routeInboundSms(supabase, { toAddress: '+447000000001', fromAddress: GARAGE }), /boom/);
});

// --- send_adam_sms end to end over the pool --------------------------------------------

function sendDeps(supabase) {
  return {
    supabase,
    checkAdamSendCap: async () => ({ allowed: true }),
    looksLikeMessageAddress: () => true
  };
}

test('send_adam_sms with no number of the user\'s own texts from the pool, and the reply routes back', async () => {
  const oldKey = process.env.OXY_TOKEN_ENCRYPTION_KEY;
  process.env.OXY_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  const sent = [];
  registerProvider('fakepool', {
    provisionPhoneNumber: async () => assert.fail('must not buy'),
    sendSms: async (args) => { sent.push(args); return { providerMessageId: `SM${sent.length}` }; },
    parseInboundSms: () => null,
    inboundAck: () => ({ contentType: 'text/plain', body: '' })
  });
  try {
    const supabase = fakeSupabase({ phone_number_pool: pool('+447000000001', '+447000000002') });
    const send = (userId) => handlers.send_adam_sms({
      userId, params: { to: '07700 900123', body: 'Can you fit in an MOT on Friday?' }, deps: sendDeps(supabase)
    });

    const alice = await send('alice');
    const bob = await send('bob');
    assert.equal(alice.success, true, alice.error);
    assert.equal(bob.success, true, bob.error);

    // Stored and sent in E.164, from two different pool numbers, through the pool numbers' provider.
    assert.deepEqual(sent.map(s => s.to), [GARAGE, GARAGE]);
    assert.deepEqual(sent.map(s => s.from), ['+447000000001', '+447000000002']);

    const conversations = supabase._state.external_conversations;
    assert.equal(conversations.find(c => c.user_id === 'alice').pool_number_id, 'pool-1');
    assert.equal(conversations.find(c => c.user_id === 'bob').pool_number_id, 'pool-2');

    // A second text from alice reuses her number and her conversation.
    await send('alice');
    assert.equal(sent[2].from, '+447000000001');
    assert.equal(conversations.filter(c => c.user_id === 'alice').length, 1);

    const reply = await routeInboundSms(supabase, { toAddress: '+447000000002', fromAddress: GARAGE });
    assert.equal(reply.kind, 'routed');
    assert.equal(reply.conversation.user_id, 'bob');
  } finally {
    if (oldKey === undefined) delete process.env.OXY_TOKEN_ENCRYPTION_KEY; else process.env.OXY_TOKEN_ENCRYPTION_KEY = oldKey;
  }
});

test('send_adam_sms uses the user\'s own number ahead of the pool', async () => {
  const oldKey = process.env.OXY_TOKEN_ENCRYPTION_KEY;
  process.env.OXY_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  const sent = [];
  registerProvider('fakeown', {
    provisionPhoneNumber: async () => assert.fail('must not buy'),
    sendSms: async (args) => { sent.push(args); return { providerMessageId: 'SMown' }; },
    parseInboundSms: () => null,
    inboundAck: () => ({ contentType: 'text/plain', body: '' })
  });
  try {
    const supabase = fakeSupabase({
      phone_number_pool: pool('+447000000001'),
      millie_identities: [{ id: 'mi-1', user_id: 'alice', display_name: 'Adam' }],
      millie_identity_handles: [
        { id: 'h-email', millie_identity_id: 'mi-1', channel_type: 'email', handle_value: 'alice@millie.oxy.app', provider: 'resend', status: 'active' },
        { id: 'h-phone', millie_identity_id: 'mi-1', channel_type: 'phone_sms', handle_value: '+447000000777', provider: 'fakeown', status: 'active' }
      ]
    });
    const result = await handlers.send_adam_sms({ userId: 'alice', params: { to: GARAGE, body: 'hi' }, deps: sendDeps(supabase) });
    assert.equal(result.success, true, result.error);
    assert.equal(sent[0].from, '+447000000777');
    assert.equal(supabase._state.external_conversations[0].pool_number_id ?? null, null);
    assert.equal(supabase._state.external_conversation_events[0].millie_identity_handle_id, 'h-phone');
  } finally {
    if (oldKey === undefined) delete process.env.OXY_TOKEN_ENCRYPTION_KEY; else process.env.OXY_TOKEN_ENCRYPTION_KEY = oldKey;
  }
});

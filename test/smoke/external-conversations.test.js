const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getOrCreateConversation,
  appendEvent,
  getConversationEvents,
  findOpenConversationsForParticipant
} = require('../../api/services/external-conversations');

function fakeSupabase() {
  const state = { external_conversations: [], external_conversation_events: [] };
  function table(name) {
    const q = { _filters: [] };
    q.select = () => q;
    q.eq = (f, v) => { q._filters.push(['eq', f, v]); return q; };
    q.order = () => q;
    q.limit = () => q;
    q.update = (patch) => {
      const rows = state[name].filter(row => q._filters.every(([, f, v]) => row[f] === v));
      rows.forEach(row => Object.assign(row, patch));
      return { eq: () => ({ then: (resolve) => resolve({ error: null }) }) };
    };
    q.insert = (row) => {
      const withId = { id: `${name}-${state[name].length + 1}`, created_at: new Date().toISOString(), ...row };
      state[name].push(withId);
      return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
    };
    q.then = (resolve) => resolve({
      data: state[name]
        .filter(row => q._filters.every(([type, f, v]) => type !== 'eq' || row[f] === v))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      error: null
    });
    return q;
  }
  return { from: table, _state: state };
}

test('getOrCreateConversation creates a new open conversation for a new participant', async () => {
  const supabase = fakeSupabase();
  const { conversation, created } = await getOrCreateConversation(supabase, {
    userId: 'chizi', adamIdentityId: 'id-1', participantId: 'p-1', requestTaskId: 'task-1'
  });
  assert.equal(created, true);
  assert.equal(conversation.status, 'open');
  assert.equal(conversation.participant_id, 'p-1');
});

test('getOrCreateConversation reuses the existing open conversation for the same participant+request', async () => {
  const supabase = fakeSupabase();
  const first = await getOrCreateConversation(supabase, { userId: 'chizi', adamIdentityId: 'id-1', participantId: 'p-1', requestTaskId: 'task-1' });
  const second = await getOrCreateConversation(supabase, { userId: 'chizi', adamIdentityId: 'id-1', participantId: 'p-1', requestTaskId: 'task-1' });
  assert.equal(second.created, false);
  assert.equal(second.conversation.id, first.conversation.id);
});

test('appendEvent encrypts the body and getConversationEvents decrypts it back', async () => {
  const oldKey = process.env.OXY_TOKEN_ENCRYPTION_KEY;
  process.env.OXY_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64); // 32-byte hex
  try {
    const supabase = fakeSupabase();
    const { conversation } = await getOrCreateConversation(supabase, { userId: 'chizi', adamIdentityId: 'id-1', participantId: 'p-1' });
    await appendEvent(supabase, {
      conversationId: conversation.id,
      channelType: 'email',
      direction: 'outbound',
      subject: 'Booking change',
      body: 'Could you move our booking to 8pm?'
    });
    await appendEvent(supabase, {
      conversationId: conversation.id,
      channelType: 'email',
      direction: 'inbound',
      subject: 'Re: Booking change',
      body: 'We can do 8:15, does that work?',
      needsDecision: true
    });
    const events = await getConversationEvents(supabase, conversation.id);
    assert.equal(events.length, 2);
    assert.equal(events[0].direction, 'outbound');
    assert.equal(events[0].body, 'Could you move our booking to 8pm?');
    assert.equal(events[1].direction, 'inbound');
    assert.equal(events[1].body, 'We can do 8:15, does that work?');
    assert.equal(events[1].needs_decision, true);

    // Not read by anything yet, but must be tracked from day one — a future follow-up
    // scheduler needs to know when Adam last sent vs. last heard back, separately.
    const updatedConversation = supabase._state.external_conversations.find(c => c.id === conversation.id);
    assert.ok(updatedConversation.last_outbound_at, 'last_outbound_at must be set after an outbound event');
    assert.ok(updatedConversation.last_inbound_at, 'last_inbound_at must be set after an inbound event');
  } finally {
    if (oldKey === undefined) delete process.env.OXY_TOKEN_ENCRYPTION_KEY;
    else process.env.OXY_TOKEN_ENCRYPTION_KEY = oldKey;
  }
});

test('findOpenConversationsForParticipant returns only open/awaiting_reply conversations', async () => {
  const supabase = fakeSupabase();
  const { conversation } = await getOrCreateConversation(supabase, { userId: 'chizi', adamIdentityId: 'id-1', participantId: 'p-2' });
  const open = await findOpenConversationsForParticipant(supabase, 'p-2');
  assert.equal(open.length, 1);
  assert.equal(open[0].id, conversation.id);
});

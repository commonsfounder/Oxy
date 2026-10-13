const assert = require('node:assert/strict');
const test = require('node:test');

const { findParticipantByAddress, findOrCreateParticipant } = require('../../api/services/participants');

function fakeSupabase(seed = {}) {
  const state = { participants: [...(seed.participants || [])], participant_addresses: [...(seed.participant_addresses || [])] };
  function table(name) {
    const q = { _filters: [] };
    q.select = () => q;
    q.eq = (f, v) => { q._filters.push([f, v]); return q; };
    q.in = (f, values) => { q._filters.push([f, values, 'in']); return q; };
    q.limit = () => q;
    q.insert = (row) => {
      const withId = { id: `${name}-${state[name].length + 1}`, created_at: new Date().toISOString(), ...row };
      state[name].push(withId);
      return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
    };
    q.then = (resolve) => resolve({
      data: state[name].filter(row => q._filters.every(([f, v, op]) => (op === 'in' ? v.includes(row[f]) : row[f] === v))),
      error: null
    });
    return q;
  }
  return { from: table, _state: state };
}

test('findParticipantByAddress returns null when no participant has that address', async () => {
  const supabase = fakeSupabase();
  const result = await findParticipantByAddress(supabase, 'chizi', 'email', 'reservations@bistro.example');
  assert.equal(result, null);
});

test('findOrCreateParticipant creates a new participant and address on first contact', async () => {
  const supabase = fakeSupabase();
  const { participant, address, created } = await findOrCreateParticipant(supabase, 'chizi', {
    displayName: 'The Bistro',
    channelType: 'email',
    addressValue: 'reservations@bistro.example'
  });
  assert.equal(created, true);
  assert.equal(participant.display_name, 'The Bistro');
  assert.equal(address.address_value, 'reservations@bistro.example');
});

test('findOrCreateParticipant reuses the existing participant on a repeat address', async () => {
  const supabase = fakeSupabase();
  const first = await findOrCreateParticipant(supabase, 'chizi', {
    displayName: 'The Bistro', channelType: 'email', addressValue: 'reservations@bistro.example'
  });
  const second = await findOrCreateParticipant(supabase, 'chizi', {
    displayName: 'Ignored — should not overwrite', channelType: 'email', addressValue: 'reservations@bistro.example'
  });
  assert.equal(second.created, false);
  assert.equal(second.participant.id, first.participant.id);
  assert.equal(second.participant.display_name, 'The Bistro');
});

test('findParticipantByAddress matches an existing participant by address', async () => {
  const supabase = fakeSupabase();
  await findOrCreateParticipant(supabase, 'chizi', {
    displayName: 'The Bistro', channelType: 'email', addressValue: 'reservations@bistro.example'
  });
  const found = await findParticipantByAddress(supabase, 'chizi', 'email', 'reservations@bistro.example');
  assert.equal(found.display_name, 'The Bistro');
});

test('findOrCreateParticipant finds this user\'s participant when another user has the same address', async () => {
  // Two users texting one garage is the normal case on the shared phone pool. Looking only
  // at the first matching address made the second user a new participant on every send.
  const supabase = fakeSupabase({
    participants: [
      { id: 'p-other', user_id: 'someone-else', display_name: 'Garage' },
      { id: 'p-mine', user_id: 'chizi', display_name: 'Garage' }
    ],
    participant_addresses: [
      { id: 'a-other', participant_id: 'p-other', channel_type: 'phone_sms', address_value: '+447700900123' },
      { id: 'a-mine', participant_id: 'p-mine', channel_type: 'phone_sms', address_value: '+447700900123' }
    ]
  });
  const { participant, address, created } = await findOrCreateParticipant(supabase, 'chizi', {
    displayName: 'Garage', channelType: 'phone_sms', addressValue: '+447700900123'
  });
  assert.equal(created, false);
  assert.equal(participant.id, 'p-mine');
  assert.equal(address.id, 'a-mine');
  assert.equal(supabase._state.participants.length, 2);
});

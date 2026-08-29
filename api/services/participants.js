'use strict';

// The people/businesses Adam talks to on the user's behalf. A participant is
// channel-agnostic (participants.js, not "email_contacts.js") — participant_addresses
// is where the channel-specific reachability lives, since one participant (a
// restaurant) may have both a phone number and an email address.

async function findParticipantByAddress(supabase, userId, channelType, addressValue) {
  const normalized = String(addressValue || '').trim().toLowerCase();
  const { data: addresses, error } = await supabase
    .from('participant_addresses')
    .select('*')
    .eq('channel_type', channelType)
    .eq('address_value', normalized);
  if (error || !addresses?.length) return null;

  const { data: participants } = await supabase
    .from('participants')
    .select('*')
    .eq('id', addresses[0].participant_id)
    .eq('user_id', userId);
  return participants?.[0] || null;
}

async function findOrCreateParticipant(supabase, userId, { displayName, channelType, addressValue }) {
  const normalized = String(addressValue || '').trim().toLowerCase();
  const existing = await findParticipantByAddress(supabase, userId, channelType, normalized);
  if (existing) {
    const { data: addresses } = await supabase
      .from('participant_addresses')
      .select('*')
      .eq('participant_id', existing.id)
      .eq('channel_type', channelType)
      .eq('address_value', normalized);
    return { participant: existing, address: addresses[0], created: false };
  }

  const { data: participant, error: pError } = await supabase.from('participants').insert({
    user_id: userId,
    display_name: displayName || normalized,
    source: 'learned'
  }).select().single();
  if (pError) throw new Error(`Failed to create participant: ${pError.message}`);

  const { data: address, error: aError } = await supabase.from('participant_addresses').insert({
    participant_id: participant.id,
    channel_type: channelType,
    address_value: normalized
  }).select().single();
  if (aError) throw new Error(`Failed to create participant address: ${aError.message}`);

  return { participant, address, created: true };
}

module.exports = { findParticipantByAddress, findOrCreateParticipant };

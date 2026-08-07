'use strict';
const { encryptTokens, decryptTokens } = require('./token-crypto');

// The channel-agnostic thread. A conversation belongs to (millie_identity,
// participant, optional request) — never to a channel. external_conversation_events
// carries the channel per-event, so a conversation can accumulate an email event
// today and (in a later milestone) an SMS or call event tomorrow without becoming
// a different conversation.

async function findOpenConversationsForParticipant(supabase, participantId) {
  const { data, error } = await supabase
    .from('external_conversations')
    .select('*')
    .eq('participant_id', participantId);
  if (error || !data) return [];
  return data.filter(c => c.status === 'open' || c.status === 'awaiting_reply');
}

async function getOrCreateConversation(supabase, { userId, millieIdentityId, participantId, requestTaskId = null }) {
  const open = await findOpenConversationsForParticipant(supabase, participantId);
  const matching = requestTaskId
    ? open.find(c => c.request_task_id === requestTaskId)
    : open.find(c => !c.request_task_id);
  if (matching) return { conversation: matching, created: false };

  const { data: conversation, error } = await supabase.from('external_conversations').insert({
    user_id: userId,
    millie_identity_id: millieIdentityId,
    participant_id: participantId,
    request_task_id: requestTaskId,
    status: 'open',
    last_activity_at: new Date().toISOString()
  }).select().single();
  if (error) throw new Error(`Failed to create conversation: ${error.message}`);
  return { conversation, created: true };
}

async function appendEvent(supabase, {
  conversationId, channelType, direction, participantAddressId = null, millieIdentityHandleId = null,
  providerEventId = null, subject = '', body, needsDecision = false, rawProviderPayload = null
}) {
  const bodyEncrypted = encryptTokens({ subject, body });
  const { data: event, error } = await supabase.from('external_conversation_events').insert({
    conversation_id: conversationId,
    channel_type: channelType,
    direction,
    participant_address_id: participantAddressId,
    millie_identity_handle_id: millieIdentityHandleId,
    provider_event_id: providerEventId,
    body_encrypted: bodyEncrypted,
    needs_decision: needsDecision,
    raw_provider_payload: rawProviderPayload
  }).select().single();
  if (error) throw new Error(`Failed to append conversation event: ${error.message}`);

  // last_outbound_at/last_inbound_at are written now even though nothing reads them
  // yet — this is exactly the state a future follow-up scheduler needs ("we sent
  // something and haven't heard back in N days"), and it's cheaper to keep it accurate
  // from day one than to backfill it later. next_follow_up_at is deliberately left
  // untouched here — no code in this milestone decides when a follow-up is due.
  const now = new Date().toISOString();
  const directionalUpdate = direction === 'outbound' ? { last_outbound_at: now } : { last_inbound_at: now };
  await supabase.from('external_conversations')
    .update({
      last_activity_at: now,
      status: direction === 'outbound' ? 'awaiting_reply' : 'open',
      ...directionalUpdate
    })
    .eq('id', conversationId);

  return event;
}

async function getConversationEvents(supabase, conversationId) {
  const { data, error } = await supabase
    .from('external_conversation_events')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error || !data) return [];
  return data.map(row => {
    const decrypted = decryptTokens(row.body_encrypted);
    return { ...row, subject: decrypted.subject || '', body: decrypted.body || '' };
  });
}

module.exports = { getOrCreateConversation, appendEvent, getConversationEvents, findOpenConversationsForParticipant };

'use strict';

// Adam's shared phone numbers. A user with no number of their own texts from the pool, and a
// reply is routed back by (pool number, sender): the conversation that last texted that sender
// from that number belongs to exactly one user.
//
// The rule that keeps that unambiguous is enforced at send time: a pool number already talking
// to a recipient for one user is not used for the same recipient by another user. Two users
// can text the same garage at once; they just do it from different numbers. When every number
// is taken for that recipient, the pool grows by one, up to MILLIE_PHONE_POOL_MAX.

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_POOL_MAX = 5;

function windowMs() {
  const days = Number(process.env.MILLIE_PHONE_POOL_WINDOW_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
}

function poolMax() {
  const raw = process.env.MILLIE_PHONE_POOL_MAX;
  const max = raw === undefined || raw === '' ? DEFAULT_POOL_MAX : Number(raw);
  return Number.isFinite(max) && max >= 0 ? max : DEFAULT_POOL_MAX;
}

// Routing compares the number we texted against the number the provider says replied, which
// arrives in E.164. A national "07700 900123" must become "+447700900123" or the reply has no
// conversation to land in.
function normalizePhoneNumber(value) {
  const text = String(value || '').trim();
  const digits = text.replace(/\D/g, '');
  if (!digits) return '';
  if (text.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  const countryCode = String(process.env.MILLIE_PHONE_DEFAULT_COUNTRY_CODE || '44').replace(/\D/g, '');
  if (digits.startsWith('0')) return `+${countryCode}${digits.slice(1)}`;
  return digits;
}

function isRecent(conversation, now = Date.now()) {
  const at = Date.parse(conversation.last_activity_at || conversation.created_at || 0);
  return Number.isFinite(at) && now - at <= windowMs();
}

function byMostRecent(a, b) {
  return Date.parse(b.last_activity_at || 0) - Date.parse(a.last_activity_at || 0);
}

async function activePoolNumbers(supabase) {
  const { data, error } = await supabase
    .from('phone_number_pool')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Could not read Adam's phone numbers: ${error.message}`);
  return data || [];
}

// Every account's conversations with this phone number that went over a pool number. Reads
// across users on purpose: a number is only free if nobody else is using it with this sender.
async function poolConversationsWith(supabase, phoneNumber) {
  const { data: addresses, error } = await supabase
    .from('participant_addresses')
    .select('participant_id')
    .eq('channel_type', 'phone_sms')
    .eq('address_value', phoneNumber);
  if (error) throw new Error(`Could not look up ${phoneNumber}: ${error.message}`);
  const participantIds = [...new Set((addresses || []).map(a => a.participant_id))];
  if (!participantIds.length) return [];
  const { data: conversations, error: conversationError } = await supabase
    .from('external_conversations')
    .select('*')
    .in('participant_id', participantIds)
    .not('pool_number_id', 'is', null);
  if (conversationError) throw new Error(`Could not look up conversations with ${phoneNumber}: ${conversationError.message}`);
  return conversations || [];
}

async function addPoolNumber(supabase, provisionPhoneNumber) {
  const provisioned = await provisionPhoneNumber('pool');
  if (!provisioned?.phoneNumber) throw new Error('The phone provider did not return a number.');
  const { data, error } = await supabase.from('phone_number_pool').insert({
    phone_number: provisioned.phoneNumber,
    provider: provisioned.provider || 'twilio',
    provider_ref: provisioned.providerRef || null,
    status: 'active'
  }).select().single();
  // The number is bought by now. Losing the row would leave Oxy paying for a number nothing
  // can send from, so the error carries the number for a manual insert.
  if (error) throw new Error(`Bought ${provisioned.phoneNumber} but could not record it in the pool: ${error.message}`);
  return data;
}

async function chooseSendingNumber(supabase, { userId, recipient, provisionPhoneNumber }) {
  const pool = await activePoolNumbers(supabase);
  const conversations = await poolConversationsWith(supabase, recipient);
  const now = Date.now();
  const others = conversations.filter(c => c.user_id !== userId);
  const busy = new Set(others.filter(c => isRecent(c, now)).map(c => c.pool_number_id));
  const everUsedByOthers = new Set(others.map(c => c.pool_number_id));

  // The same business keeps seeing the same Adam number for this user.
  const mine = conversations.filter(c => c.user_id === userId).sort(byMostRecent);
  for (const conversation of mine) {
    const number = pool.find(p => p.id === conversation.pool_number_id);
    if (number && !busy.has(number.id)) return number;
  }

  const free = pool.find(p => !everUsedByOthers.has(p.id)) || pool.find(p => !busy.has(p.id));
  if (free) return free;

  if (pool.length >= poolMax()) {
    throw new Error(`All of Adam's ${pool.length} numbers are already talking to ${recipient} for someone else. Raise MILLIE_PHONE_POOL_MAX to add more.`);
  }
  const provision = provisionPhoneNumber || require('../../connectors/phone-provider').provisionPhoneNumber;
  return addPoolNumber(supabase, provision);
}

async function assignPoolNumber(supabase, conversationId, poolNumberId) {
  const { error } = await supabase
    .from('external_conversations')
    .update({ pool_number_id: poolNumberId })
    .eq('id', conversationId);
  if (error) throw new Error(`Could not record which number this conversation is on: ${error.message}`);
}

// Returns one of:
//   { kind: 'not_pool' }                        - the number is not a pool number
//   { kind: 'unknown_sender', poolNumber }      - nobody has texted this sender from it
//   { kind: 'ambiguous', poolNumber, userCount } - more than one user could own the reply
//   { kind: 'routed', poolNumber, conversation }
// An ambiguous reply is never shown to anyone: showing it to the wrong user leaks one user's
// business conversation to another.
async function routeInboundSms(supabase, { toAddress, fromAddress }) {
  const { data: rows, error } = await supabase
    .from('phone_number_pool')
    .select('*')
    .eq('phone_number', normalizePhoneNumber(toAddress));
  if (error) throw new Error(`Could not read Adam's phone numbers: ${error.message}`);
  const poolNumber = rows?.[0];
  if (!poolNumber) return { kind: 'not_pool' };

  const onThisNumber = (await poolConversationsWith(supabase, normalizePhoneNumber(fromAddress)))
    .filter(c => c.pool_number_id === poolNumber.id);
  if (!onThisNumber.length) return { kind: 'unknown_sender', poolNumber };

  const users = list => new Set(list.map(c => c.user_id)).size;
  let candidates = onThisNumber;
  if (users(candidates) > 1) candidates = onThisNumber.filter(c => isRecent(c));
  if (users(candidates) !== 1) return { kind: 'ambiguous', poolNumber, userCount: users(onThisNumber) };

  const open = candidates.filter(c => c.status === 'open' || c.status === 'awaiting_reply');
  const conversation = (open.length ? open : candidates).sort(byMostRecent)[0];
  return { kind: 'routed', poolNumber, conversation };
}

module.exports = {
  normalizePhoneNumber,
  activePoolNumbers,
  addPoolNumber,
  chooseSendingNumber,
  assignPoolNumber,
  routeInboundSms
};

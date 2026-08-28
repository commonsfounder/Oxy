'use strict';

// Millie's own persistent communication identity: one row per user, one per channel.
// Provisioning is idempotent, and each channel is attempted and recorded independently, so a
// failed phone number never blocks email or signup. The phone vendor is injected, not baked in,
// and the handle records which provider issued the number.

function normalizeUserIdForAddress(userId) {
  return String(userId || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '')
    .slice(0, 64);
}

function buildEmailHandleValue(userId) {
  const domain = process.env.MILLIE_EMAIL_DOMAIN || 'millie.oxy.app';
  return `${normalizeUserIdForAddress(userId)}@${domain}`;
}

async function getMillieIdentity(supabase, userId) {
  const { data: identities, error } = await supabase
    .from('millie_identities')
    .select('*')
    .eq('user_id', userId)
    .limit(1);
  if (error || !identities?.length) return null;
  const identity = identities[0];
  const { data: handles } = await supabase
    .from('millie_identity_handles')
    .select('*')
    .eq('millie_identity_id', identity.id);
  return { identity, handles: handles || [] };
}

async function getActiveHandle(supabase, userId, channelType) {
  const existing = await getMillieIdentity(supabase, userId);
  if (!existing) return null;
  return existing.handles.find(h => h.channel_type === channelType && h.status === 'active') || null;
}

async function ensureEmailHandle(supabase, identityId, userId) {
  const handleValue = buildEmailHandleValue(userId);
  const { data } = await supabase.from('millie_identity_handles').insert({
    millie_identity_id: identityId,
    channel_type: 'email',
    handle_value: handleValue,
    provider: 'resend',
    status: 'active'
  }).select().single();
  return data;
}

async function ensurePhoneHandle(supabase, identityId, userId, provisionPhoneNumber) {
  try {
    const provisioned = await provisionPhoneNumber(userId);
    if (!provisioned?.phoneNumber) return null;
    const { data } = await supabase.from('millie_identity_handles').insert({
      millie_identity_id: identityId,
      channel_type: 'phone_sms',
      handle_value: provisioned.phoneNumber,
      // Recorded from the provisioning result, never hardcoded: this row is what tells a
      // later send which vendor actually owns this number. Hardcoding it would strand
      // every existing number the day MILLIE_PHONE_PROVIDER changes.
      provider: provisioned.provider || 'twilio',
      provider_ref: provisioned.providerRef || null,
      status: 'active'
    }).select().single();
    return data;
  } catch (err) {
    console.warn('[millie-identity] phone provisioning failed, continuing without it:', err.message);
    return null;
  }
}

async function ensureMillieIdentity(supabase, userId, { attemptPhone = true, provisionPhoneNumber } = {}) {
  const existing = await getMillieIdentity(supabase, userId);
  if (existing) {
    // Fill in any missing handle (e.g. phone provisioning was skipped or failed before).
    const handles = [...existing.handles];
    if (!handles.some(h => h.channel_type === 'email')) {
      const created = await ensureEmailHandle(supabase, existing.identity.id, userId);
      if (created) handles.push(created);
    }
    if (attemptPhone && provisionPhoneNumber && !handles.some(h => h.channel_type === 'phone_sms')) {
      const created = await ensurePhoneHandle(supabase, existing.identity.id, userId, provisionPhoneNumber);
      if (created) handles.push(created);
    }
    return { identity: existing.identity, handles };
  }

  const { data: identity, error } = await supabase.from('millie_identities').insert({
    user_id: userId,
    display_name: 'Millie'
  }).select().single();
  if (error) throw new Error(`Failed to create Millie identity: ${error.message}`);

  const handles = [];
  const emailHandle = await ensureEmailHandle(supabase, identity.id, userId);
  if (emailHandle) handles.push(emailHandle);
  if (attemptPhone && provisionPhoneNumber) {
    const phoneHandle = await ensurePhoneHandle(supabase, identity.id, userId, provisionPhoneNumber);
    if (phoneHandle) handles.push(phoneHandle);
  }
  return { identity, handles };
}

module.exports = { ensureMillieIdentity, getMillieIdentity, getActiveHandle, buildEmailHandleValue };

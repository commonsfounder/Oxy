'use strict';

const crypto = require('node:crypto');

const PAIRING_TTL_MS = 10 * 60 * 1000;
const EVENT_TTL_MS = 15 * 60 * 1000;
const MAX_DISPLAY_NAME = 80;
const MAX_TITLE = 160;
const MAX_BODY = 2000;
const MAX_KIND = 40;
const DISPLAY_KINDS = new Set(['agent_update', 'reminder', 'approval', 'status']);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SECRET_CONTENT_PATTERN = /(?:\bauthorization\s*:\s*bearer\b|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:password|passwd|passphrase|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|cookie|set-cookie|session[_-]?token)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

class DisplayDomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DisplayDomainError';
    this.code = code;
    this.status = 400;
  }
}

function displayDomainError(code, message) {
  return new DisplayDomainError(code, message);
}

function cleanText(value, fallback, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.slice(0, maxLength);
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(10);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code.slice(0, 8);
}

function makeToken(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString('base64url');
}

function iso(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function pairingDisplayUrl(baseUrl, challengeId) {
  return `${String(baseUrl || '').replace(/\/$/, '')}/display?challenge=${encodeURIComponent(challengeId)}`;
}

function assertUser(userId) {
  if (!userId) throw new Error('A signed-in user is required.');
}

function assertDisplayContent({ title, body, kind }) {
  if (typeof title !== 'string' || typeof body !== 'string' || (kind != null && typeof kind !== 'string')) {
    throw displayDomainError('invalid_content', 'Display content must be plain text.');
  }
  const safeTitle = cleanText(title, '', MAX_TITLE);
  const safeBody = cleanText(body, '', MAX_BODY);
  const safeKind = cleanText(kind, 'agent_update', MAX_KIND);
  if (!safeTitle || !safeBody) throw displayDomainError('invalid_content', 'A display update needs a title and content.');
  if (!DISPLAY_KINDS.has(safeKind)) throw displayDomainError('invalid_content', 'Display content has an unsupported kind.');
  // The model's contract guidance is not a security boundary. Display content is
  // intentionally text-only and rejects obvious credentials and serialized payloads
  // before they can be persisted or delivered to a nearby screen.
  const combined = `${safeTitle}\n${safeBody}\n${safeKind}`;
  const hasRawStructuredPayload = [safeTitle, safeBody].some(value => {
    const trimmed = value.trim();
    if (/^[\[{]/.test(trimmed)) return true;
    const candidates = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/g) || [];
    return candidates.some(candidate => {
      try {
        const parsed = JSON.parse(candidate);
        return parsed !== null && typeof parsed === 'object';
      } catch {
        return false;
      }
    });
  });
  if (SECRET_CONTENT_PATTERN.test(combined) || hasRawStructuredPayload) {
    throw displayDomainError('invalid_content', 'Display content cannot contain credentials or raw payloads.');
  }
  return {
    title: safeTitle,
    body: safeBody,
    kind: safeKind
  };
}

function summarizeDisplay(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: cleanText(row.display_name, 'Display', MAX_DISPLAY_NAME),
    type: row.display_type || 'browser_display',
    capabilities: row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : { text: true },
    pairedAt: row.paired_at || null,
    lastSeenAt: row.last_seen_at || null
  };
}

async function createPairingChallenge(supabase, userId, {
  baseUrl,
  displayName = null,
  now = new Date(),
  randomBytes = crypto.randomBytes
} = {}) {
  assertUser(userId);
  const code = makeCode(randomBytes);
  const expiresAt = new Date(new Date(now).getTime() + PAIRING_TTL_MS);
  const { data, error } = await supabase.from('display_pairing_challenges').insert({
    user_id: userId,
    code_hash: hashSecret(code),
    display_name: cleanText(displayName, null, MAX_DISPLAY_NAME),
    expires_at: expiresAt.toISOString()
  }).select().single();
  if (error) throw error;
  return {
    id: data.id,
    code,
    expiresAt: data.expires_at || expiresAt.toISOString(),
    displayUrl: pairingDisplayUrl(baseUrl, data.id)
  };
}

async function redeemPairingChallenge(supabase, {
  challengeId,
  code,
  displayName,
  now = new Date(),
  randomBytes = crypto.randomBytes
} = {}) {
  if (!challengeId || !code) throw displayDomainError('invalid_pairing_input', 'The pairing link and code are required.');
  const { data: challenge, error } = await supabase.from('display_pairing_challenges')
    .select('*').eq('id', challengeId).maybeSingle();
  if (error) throw error;
  if (!challenge || challenge.consumed_at) throw displayDomainError('invalid_pairing', 'That pairing request is no longer valid.');
  if (new Date(challenge.expires_at).getTime() <= new Date(now).getTime()) {
    throw displayDomainError('invalid_pairing', 'That pairing request expired. Start a new one from the app.');
  }
  if (!safeEqual(challenge.code_hash, hashSecret(String(code).replace(/\s/g, '').toUpperCase()))) {
    throw displayDomainError('invalid_pairing', 'That pairing code is not correct.');
  }

  const token = makeToken(randomBytes);
  // The claim, display insert, and challenge link are one database transaction. A
  // client-side compare-and-set cannot protect the insert/link pair from a crash or
  // concurrent redeemer, so the migration owns this boundary in an RPC.
  const { data, error: redeemError } = await supabase.rpc('redeem_display_pairing', {
    p_challenge_id: challenge.id,
    p_code_hash: challenge.code_hash,
    p_display_name: cleanText(displayName, challenge.display_name || 'Nearby display', MAX_DISPLAY_NAME),
    p_token_hash: hashSecret(token),
    p_paired_at: new Date(now).toISOString()
  });
  if (redeemError) {
    // The SQL function uses P0001 for the expected compare-and-claim miss. A
    // concurrent redeemer losing the one-time challenge is a normal 4xx outcome;
    // other RPC failures remain infrastructure failures for the route to report as 503.
    if (redeemError.code === 'P0001') {
      throw displayDomainError('invalid_pairing', 'That pairing request is no longer valid.');
    }
    throw redeemError;
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.display) throw new Error('Pairing service returned an invalid response.');
  return { display: summarizeDisplay(result.display), token };
}

async function listDisplays(supabase, userId) {
  assertUser(userId);
  const { data, error } = await supabase.from('paired_displays').select('*')
    .eq('user_id', userId).is('revoked_at', null).order('paired_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(summarizeDisplay).filter(Boolean);
}

async function revokeDisplay(supabase, userId, displayId, now = new Date()) {
  assertUser(userId);
  const { data, error } = await supabase.from('paired_displays').update({ revoked_at: new Date(now).toISOString() })
    .eq('id', displayId).eq('user_id', userId).is('revoked_at', null).select().maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function displayForToken(supabase, displayId, token) {
  if (!displayId || !token) return null;
  const { data, error } = await supabase.from('paired_displays').select('*')
    .eq('id', displayId).eq('token_hash', hashSecret(token)).is('revoked_at', null).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function queueRender(supabase, userId, { displayId, title, body, kind, now = new Date() } = {}) {
  assertUser(userId);
  if (!displayId) throw displayDomainError('invalid_display', 'Choose a paired display first.');
  const display = await supabase.from('paired_displays').select('id, user_id, revoked_at')
    .eq('id', displayId).eq('user_id', userId).is('revoked_at', null).maybeSingle();
  if (display.error) throw display.error;
  if (!display.data) throw displayDomainError('not_paired', 'That display is not paired.');
  const content = assertDisplayContent({ title, body, kind });
  const expiresAt = new Date(new Date(now).getTime() + EVENT_TTL_MS).toISOString();
  const { data, error } = await supabase.from('display_render_events').insert({
    user_id: userId,
    display_id: displayId,
    kind: content.kind,
    title: content.title,
    body: content.body,
    payload: { text: true },
    expires_at: expiresAt
  }).select().single();
  if (error) throw error;
  return { id: data.id, displayId, kind: content.kind, title: content.title, body: content.body, expiresAt: data.expires_at || expiresAt };
}

async function pollNextRender(supabase, displayId, token, now = new Date()) {
  const display = await displayForToken(supabase, displayId, token);
  if (!display) return null;
  await supabase.from('paired_displays').update({ last_seen_at: new Date(now).toISOString() }).eq('id', displayId);
  const { data, error } = await supabase.from('display_render_events').select('*')
    .eq('display_id', displayId).is('acked_at', null).gt('expires_at', new Date(now).toISOString())
    .order('created_at', { ascending: true }).limit(1);
  if (error) throw error;
  if (!data?.[0]) return { display: summarizeDisplay(display), event: null };
  const event = data[0];
  return {
    display: summarizeDisplay(display),
    event: { id: event.id, kind: event.kind, title: event.title, body: event.body, createdAt: event.created_at, expiresAt: event.expires_at }
  };
}

async function acknowledgeRender(supabase, displayId, token, eventId, now = new Date()) {
  const display = await displayForToken(supabase, displayId, token);
  if (!display) return { authorized: false, acknowledged: false, reason: 'unauthorized' };
  const { data: existing, error: lookupError } = await supabase.from('display_render_events').select('id, acked_at')
    .eq('id', eventId).eq('display_id', displayId).maybeSingle();
  if (lookupError) throw lookupError;
  if (!existing) return { authorized: true, acknowledged: false, reason: 'not_found' };
  if (existing.acked_at) return { authorized: true, acknowledged: true, alreadyAcknowledged: true };
  const { data, error } = await supabase.from('display_render_events').update({
    delivered_at: new Date(now).toISOString(), acked_at: new Date(now).toISOString()
  }).eq('id', eventId).eq('display_id', displayId).is('acked_at', null).select().maybeSingle();
  if (error) throw error;
  // Another poller may have acknowledged between the lookup and the update. That is
  // still a successful idempotent acknowledgement for a valid display token.
  return data
    ? { authorized: true, acknowledged: true }
    : { authorized: true, acknowledged: true, alreadyAcknowledged: true };
}

module.exports = {
  DisplayDomainError,
  PAIRING_TTL_MS,
  EVENT_TTL_MS,
  MAX_DISPLAY_NAME,
  MAX_TITLE,
  MAX_BODY,
  DISPLAY_KINDS,
  hashSecret,
  makeCode,
  summarizeDisplay,
  createPairingChallenge,
  redeemPairingChallenge,
  listDisplays,
  revokeDisplay,
  displayForToken,
  queueRender,
  pollNextRender,
  acknowledgeRender
};

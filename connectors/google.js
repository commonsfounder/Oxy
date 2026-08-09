const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('google connector bootstrap');

const SUPPORTED_ACTIONS = [
  'send_email', 'get_emails', 'search_emails', 'create_calendar_event', 'get_calendar_events',
  'create_google_doc', 'search_google_docs', 'append_google_doc', 'get_google_doc',
  // Deliberately NOT registered in action-contracts.js — this is never offered to the
  // agent/tool-calling loop as an option, only ever called directly by the dashboard's
  // "handle this email" endpoint. See buildEmailActionPlan in api/index.js for why.
  'get_email_action_links',
  // Real Gmail mutation primitives (inbox cleanup) — see api/services/gmail-cleanup.js for
  // the classification/orchestration layer that decides WHAT to archive/unsubscribe; these
  // three only ever do WHAT they're told, against the real Gmail API.
  'archive_emails', 'label_emails', 'unsubscribe_email',
  // Real calendar mutation. create_calendar_event existed; moving or resizing an event did
  // not, so "move it to 4pm" could only be done by creating a second event.
  'update_calendar_event',
  // Real cancellation. delete_calendar_event removes a single event (an instance or a whole
  // non-recurring event); end_recurring_series ends a repeating series after a given
  // occurrence without touching the ones already past. Neither is a "hide in Millie" —
  // both change the real calendar, and both use Google's own attendee-notification
  // semantics (sendUpdates) rather than silently vanishing a meeting someone else was
  // invited to.
  'delete_calendar_event', 'end_recurring_series'
];

// Comfortably under Gmail's own 1000-ids-per-batchModify-call cap — chunking this small
// means one bad id in a huge request doesn't force re-doing thousands of already-valid
// ones, and keeps the per-chunk verification pass below to a reasonable number of extra
// API calls.
const BATCH_CHUNK_SIZE = 250;
// How many ids per chunk to re-fetch afterward and check the mutation actually landed —
// batchModify returns 204 with no body, so a 2xx response alone is not proof of anything;
// Google's own docs note some ids in a batch can silently fail to apply. Sampling is a
// deliberate cost/confidence tradeoff: full verification of a 1000-message chunk would be
// 1000 extra GET calls for one cleanup request.
const VERIFY_SAMPLE_SIZE = 5;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function normalizeMessageIds(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.map(id => String(id || '').trim()).filter(Boolean);
}

// Gmail's built-in labels are their own ids. Everything else the user has ("Receipts",
// "Travel") is an opaque id like `Label_12`, and the display name is NOT accepted anywhere
// the API wants a labelId.
const SYSTEM_LABEL_IDS = new Set([
  'INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'
]);
// Gmail refuses to add or remove these itself — they describe where a message came from.
const UNSETTABLE_LABEL_IDS = new Set(['SENT', 'DRAFT']);

// Turns whatever the caller said into real Gmail label ids.
//
// This is the difference between "label these Receipts" working and failing silently: the
// previous behaviour uppercased every name and handed it over as an id, so a system label
// happened to work and a user label could never work at all — batchModify just 400s and the
// whole chunk is reported as failed.
//
// `create` is on for labels being ADDED (asking to file mail under a label that doesn't exist
// yet plainly means create it) and off for labels being REMOVED (removing a label that was
// never there is a no-op, not a reason to make one).
async function resolveLabelIds(headers, names, { create = false, cache = {} } = {}) {
  const wanted = normalizeMessageIds(names);
  if (!wanted.length) return { ids: [], unresolved: [], created: [], refused: [] };

  const ids = [];
  const unresolved = [];
  const created = [];

  const passthrough = [];
  const needsLookup = [];
  for (const name of wanted) {
    const upper = name.toUpperCase();
    if (SYSTEM_LABEL_IDS.has(upper)) passthrough.push(upper);
    // An id we were handed directly (Gmail's own form) needs no resolution.
    else if (/^Label_\d+$/.test(name)) passthrough.push(name);
    else needsLookup.push(name);
  }
  ids.push(...passthrough);

  if (needsLookup.length) {
    if (!cache.labels) {
      const resp = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers, timeout: 15000 });
      cache.labels = resp.data.labels || [];
    }
    for (const name of needsLookup) {
      const match = cache.labels.find(l => String(l.name || '').toLowerCase() === name.toLowerCase());
      if (match) { ids.push(match.id); continue; }
      if (!create) { unresolved.push(name); continue; }
      try {
        const made = await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/labels',
          { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
          { headers, timeout: 15000 });
        cache.labels.push(made.data);
        ids.push(made.data.id);
        created.push(made.data.name);
      } catch {
        unresolved.push(name);
      }
    }
  }

  return {
    ids: ids.filter(id => !UNSETTABLE_LABEL_IDS.has(id)),
    unresolved,
    created,
    refused: ids.filter(id => UNSETTABLE_LABEL_IDS.has(id))
  };
}

// Bulk-modifies message labels (archive is removeLabelIds:['INBOX']; mark read/unread and
// custom labels are add/removeLabelIds too) in chunks, then VERIFIES a sample of the
// successful chunk actually changed state by re-fetching those ids — batchModify returns 204
// with no per-id detail, and Google's own docs note some ids in a batch can silently fail to
// apply, so a 2xx alone is not proof.
async function bulkModifyMessages(headers, ids, { addLabelIds = [], removeLabelIds = [] }, { expectPresent = [], expectAbsent = [] } = {}) {
  const chunks = chunk(ids, BATCH_CHUNK_SIZE);
  const succeededIds = [];
  const failedIds = [];

  for (const group of chunks) {
    try {
      await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify',
        { ids: group, addLabelIds, removeLabelIds },
        { headers, timeout: 30000 });
      succeededIds.push(...group);
    } catch (e) {
      failedIds.push(...group);
    }
  }

  const sample = succeededIds.slice(0, VERIFY_SAMPLE_SIZE);
  let confirmed = 0;
  await Promise.all(sample.map(async id => {
    try {
      const resp = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,
        { headers, params: { format: 'minimal' }, timeout: 15000 });
      const labels = new Set(resp.data.labelIds || []);
      const presentOk = expectPresent.every(l => labels.has(l));
      const absentOk = expectAbsent.every(l => !labels.has(l));
      if (presentOk && absentOk) confirmed += 1;
    } catch {
      // A verification fetch failing doesn't unwind the mutation (it already happened) — it
      // just means this one sample can't confirm it. Reflected honestly in verified.checked
      // vs verified.confirmed rather than assumed either way.
    }
  }));

  return {
    modified: succeededIds.length,
    failedIds,
    verified: { checked: sample.length, confirmed }
  };
}

async function getTokens(userId) {
  let disconnectedOnPurpose = false;
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('tokens, enabled')
      .eq('user_id', userId)
      .eq('connector_id', 'google')
      .limit(1);

    const row = !error && data?.length ? data[0] : null;
    if (row?.enabled && row.tokens) return decryptTokens(row.tokens);
    // A row that exists but is disabled is a deliberate disconnect (or a refresh that Google
    // told us was revoked). Falling back to env here would silently re-connect the user to an
    // account they just detached from.
    if (row && !row.enabled) disconnectedOnPurpose = true;
  } catch (err) {
    console.error('[getTokens] DB error:', err.message);
  }

  // Fall back to env vars (single-user setup). Deliberately NOT written to the connectors row
  // here: this used to save-and-enable on sight, so a bad env value (the deployed
  // GMAIL_REFRESH_TOKEN is truncated to 39 chars and Google answers invalid_grant) turned
  // "not connected" into a row that claims to be connected and fails forever. getAccessToken
  // persists these only once a refresh has actually succeeded, so what lands in the database
  // is always a credential that worked at least once.
  const envToken = String(process.env.GMAIL_REFRESH_TOKEN || '').replace(/^﻿/, '').trim();
  if (envToken && !disconnectedOnPurpose) {
    return {
      refresh_token: envToken,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET
    };
  }

  throw new Error(disconnectedOnPurpose
    ? 'Google is disconnected for this user. Reconnect Google from Settings.'
    : 'Google connector not configured for this user');
}

async function saveTokens(userId, tokens) {
  const { error } = await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'google', enabled: true, tokens: encryptTokens(tokens), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
  if (error) throw error;
}

async function markGoogleDisconnected(userId, tokens = {}) {
  const { error } = await supabase
    .from('connectors')
    .upsert({
      user_id: userId,
      connector_id: 'google',
      enabled: false,
      tokens: encryptTokens({
        client_id: tokens.client_id,
        client_secret: tokens.client_secret
      }),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,connector_id' });
  if (error) throw error;
}

async function getAccessToken(userId) {
  const tokens = await getTokens(userId);

  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error('Google not authorized. Reconnect Google from Settings.');
  }

  const attemptRefresh = () => axios.post('https://oauth2.googleapis.com/token', {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token.replace(/^﻿/, '').trim(),
    client_id: tokens.client_id || process.env.GMAIL_CLIENT_ID,
    client_secret: tokens.client_secret || process.env.GMAIL_CLIENT_SECRET
  }, { timeout: 10000 });

  let resp;
  try {
    resp = await attemptRefresh();
  } catch (err) {
    const desc = err.response?.data?.error_description || err.message;
    if (typeof desc === 'string' && (desc.includes('expired') || desc.includes('revoked'))) {
      try { await markGoogleDisconnected(userId, tokens); } catch (cleanupErr) {
        console.warn('[google] disconnect cleanup failed:', cleanupErr.message);
      }
      throw new Error('Failed to refresh Google token: Token has been expired or revoked. Reconnect Google from Settings.');
    }
    // One retry after a short delay for transient network errors
    await new Promise(r => setTimeout(r, 1000));
    try {
      resp = await attemptRefresh();
    } catch (retryErr) {
      throw new Error(`Failed to refresh Google token: ${retryErr.response?.data?.error_description || retryErr.message}`);
    }
  }

  const updated = {
    ...tokens,
    access_token: resp.data.access_token,
    expires_at: Date.now() + resp.data.expires_in * 1000
  };
  await saveTokens(userId, updated);
  return updated.access_token;
}

// Mail headers are ASCII. A subject with a £ in it has to be encoded (RFC 2047) or the
// receiving client guesses an 8-bit charset and renders mojibake — the first real proactive
// notification this account sent arrived as "Brighton room dropped below Ã‚Â£80". The BODY
// was fine, because that part declares charset=utf-8; only the header was raw.
//
// An encoded-word is capped at 75 characters including the ~12 characters of wrapper, so a
// long subject becomes several words on continuation lines. Chunking is done on code points,
// never mid-character, since a split multi-byte sequence would corrupt exactly what this is
// here to protect.
const ENCODED_WORD_PAYLOAD_BYTES = 45; // multiple of 3, so each chunk base64s without padding

function encodeMimeHeader(value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7E]*$/.test(text)) return text;

  const chunks = [];
  let current = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > ENCODED_WORD_PAYLOAD_BYTES) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current) chunks.push(current);

  return chunks
    .map(chunk => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

function buildMime(to, subject, body, options = {}) {
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0'
  ];
  if (options.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) headers.push(`References: ${options.references}`);
  const msg = [
    ...headers,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body
  ].join('\r\n');
  return Buffer.from(msg, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(data = '') {
  if (!data) return '';
  const normalized = String(data).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // Currency entities, and numeric entities generally. Found against a real mailbox: a
    // Travelzoo receipt renders its total as `<b>&pound;1</b>`, so without this the body
    // reaching the receipt extractor contains "Total &pound;1" — no £ character anywhere,
    // and a genuine receipt is silently worth nothing. HTML-only mail is the common case for
    // receipts, not the exception.
    .replace(/&pound;/gi, '£')
    .replace(/&euro;/gi, '€')
    .replace(/&yen;/gi, '¥')
    .replace(/&cent;/gi, '¢')
    .replace(/&#(\d{2,5});/g, (_, code) => {
      const num = Number(code);
      return num >= 32 && num <= 0x10ffff ? String.fromCodePoint(num) : ' ';
    })
    .replace(/&#x([0-9a-f]{2,5});/gi, (_, hex) => {
      const num = parseInt(hex, 16);
      return num >= 32 && num <= 0x10ffff ? String.fromCodePoint(num) : ' ';
    })
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeBody(text = '') {
  return String(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function getHeader(headers = [], name) {
  const wanted = String(name || '').toLowerCase();
  return headers.find(header => String(header.name || '').toLowerCase() === wanted)?.value || '';
}

function parseEmailAddress(value = '') {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].replace(/^"|"$/g, '').trim(),
      address: match[2].trim(),
      raw
    };
  }
  return {
    name: raw.includes('@') ? '' : raw,
    address: raw.includes('@') ? raw : '',
    raw
  };
}

function collectBodyParts(part, out = { plain: [], html: [] }) {
  if (!part) return out;
  const mimeType = String(part.mimeType || '').toLowerCase();
  const data = part.body?.data;
  if (data && mimeType === 'text/plain') out.plain.push(decodeBase64Url(data));
  if (data && mimeType === 'text/html') out.html.push(stripHtml(decodeBase64Url(data)));
  for (const child of part.parts || []) collectBodyParts(child, out);
  return out;
}

// stripHtml above discards every tag including <a href> — fine for the readable body,
// useless for finding a real actionable link (e.g. Revolut's own "Add money" link in
// their balance-negative email). This walks the RAW (unstripped) HTML parts so hrefs
// survive, for the one caller that actually needs them.
function collectRawHtmlParts(part, out = []) {
  if (!part) return out;
  const mimeType = String(part.mimeType || '').toLowerCase();
  const data = part.body?.data;
  if (data && mimeType === 'text/html') out.push(decodeBase64Url(data));
  for (const child of part.parts || []) collectRawHtmlParts(child, out);
  return out;
}

function extractLinksFromHtml(html = '') {
  const links = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null && links.length < 20) {
    const url = match[1].trim();
    const label = stripHtml(match[2]).replace(/\s+/g, ' ').trim();
    if (!label || !/^https?:\/\//i.test(url)) continue;
    links.push({ label: label.slice(0, 60), url });
  }
  return links;
}

function extractMessageBody(payload = {}) {
  const parts = collectBodyParts(payload);
  const plain = normalizeBody(parts.plain.filter(Boolean).join('\n\n'));
  if (plain) return plain;
  return normalizeBody(parts.html.filter(Boolean).join('\n\n'));
}

function normalizeLabelFilter(params = {}) {
  const source = params.labels || params.label || params.labelIds || params.label_ids || 'INBOX';
  const labels = (Array.isArray(source) ? source : String(source).split(','))
    .map(label => String(label || '').trim().toUpperCase())
    .filter(Boolean)
    .map(label => {
      if (['INBOX', 'UNREAD', 'IMPORTANT'].includes(label)) return label;
      if (label === 'STARRED') return 'STARRED';
      return label;
    });
  return labels.length ? labels : ['INBOX'];
}

function gmailParams(params = {}) {
  return {
    params,
    paramsSerializer: values => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(values || {})) {
        if (Array.isArray(value)) {
          value.forEach(item => search.append(key, item));
        } else if (value !== undefined && value !== null) {
          search.append(key, value);
        }
      }
      return search.toString();
    }
  };
}

function messageToEmail(message = {}) {
  const headers = message.payload?.headers || [];
  const from = getHeader(headers, 'From');
  const sender = parseEmailAddress(from);
  return {
    id: message.id,
    threadId: message.threadId,
    from,
    senderName: sender.name,
    senderAddress: sender.address,
    to: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject'),
    date: getHeader(headers, 'Date'),
    messageId: getHeader(headers, 'Message-ID'),
    references: getHeader(headers, 'References'),
    inReplyTo: getHeader(headers, 'In-Reply-To'),
    snippet: message.snippet || '',
    labelIds: message.labelIds || [],
    // Presence of a List-Unsubscribe header marks bulk/mailing-list mail (newsletters,
    // marketing). Personal 1:1 mail doesn't carry it — used to filter the dashboard feed.
    listUnsubscribe: getHeader(headers, 'List-Unsubscribe'),
    // RFC 8058 one-click unsubscribe: when a sender declares this alongside a List-Unsubscribe
    // URL, POSTing 'List-Unsubscribe=One-Click' to that URL is a real, provider-acknowledged
    // unsubscribe — no page visit needed. Its absence means the URL (if any) is just a normal
    // link that needs a real browser to complete.
    listUnsubscribePost: getHeader(headers, 'List-Unsubscribe-Post'),
    body: extractMessageBody(message.payload)
  };
}

async function fetchFullMessage(headers, id) {
  const detail = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,
    { headers, params: { format: 'full' }, timeout: 15000 });
  return messageToEmail(detail.data);
}

async function fetchThreadMessages(headers, threadId) {
  const detail = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}`,
    { headers, params: { format: 'full' }, timeout: 15000 });
  return (detail.data.messages || []).map(messageToEmail);
}

function formatThreadText(messages = []) {
  return messages.map((email, index) => {
    const sender = email.senderName || email.senderAddress || email.from || 'Unknown sender';
    const date = email.date || 'Unknown date';
    const body = email.body || email.snippet || '';
    return `Message ${index + 1} — ${sender} — ${date}\nSubject: ${email.subject || '(No subject)'}\n${body}`;
  }).join('\n\n---\n\n').trim();
}

// Which mailbox are we actually authorized on, and can we send from it?
//
// This exists so proactive delivery has a destination it can trust without a separate
// verification step: the address of the mailbox the user themselves connected is, by
// construction, an address they own. Any OTHER address still has to be verified before we
// mail it — that rule is about not mailing third parties, and it is untouched here.
//
// Cached briefly because the delivery sweep asks once per user per run and the answer only
// changes when the connector is reconnected.
const MAILBOX_TTL_MS = 10 * 60 * 1000;
const mailboxCache = new Map();

async function getMailbox(userId, { now = Date.now } = {}) {
  const cached = mailboxCache.get(userId);
  if (cached && cached.expiresAt > now()) return cached.value;

  let value = null;
  try {
    const token = await getAccessToken(userId);
    const resp = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });
    const address = String(resp.data?.emailAddress || '').trim();
    // gmail.modify covers messages.send, which is the scope this connector is granted.
    // No address means no usable mailbox, however healthy the token looks.
    if (address) value = { address, canSend: true };
  } catch {
    // Not connected, revoked, or Gmail is down. All of these mean "no mailbox right now",
    // which the caller must treat as an unavailable channel rather than a failure to report.
    value = null;
  }

  mailboxCache.set(userId, { value, expiresAt: now() + MAILBOX_TTL_MS });
  return value;
}

function _clearMailboxCache() { mailboxCache.clear(); }

async function getThreadContext(userId, threadId) {
  if (!threadId) return null;
  const token = await getAccessToken(userId);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const messages = await fetchThreadMessages(headers, threadId);
  return {
    threadId,
    messages,
    text: formatThreadText(messages)
  };
}

function isGenericPlaceholderEmail(subject, body) {
  const normalizedSubject = String(subject || '').trim().toLowerCase();
  const normalizedBody = String(body || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const bodyWithoutGreeting = normalizedBody
    .replace(/^dear [^,]+,\s*/, '')
    .replace(/best regards,?\s*$/i, '')
    .trim();

  if (normalizedBody.length < 8) return true;
  if (/^(formal introduction|hello|greetings|introduction)$/.test(normalizedSubject)) return true;
  if (
    bodyWithoutGreeting.includes('i hope this email finds you well') &&
    bodyWithoutGreeting.includes('i look forward to the possibility of connecting') &&
    bodyWithoutGreeting.length < 260
  ) {
    return true;
  }
  return false;
}

function inferEmailSubject(body, fallback = 'Quick note') {
  const cleaned = String(body || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  const firstSentence = cleaned.split(/[.!?]/)[0].trim();
  const source = firstSentence || cleaned;
  const subject = source.length > 54 ? `${source.slice(0, 51).trim()}...` : source;
  return subject || fallback;
}

function summarizeEmails(emails = [], emptyText = 'No emails found') {
  if (!Array.isArray(emails) || emails.length === 0) return emptyText;
  const lines = emails.map((email, index) => {
    const from = email.from || 'Unknown sender';
    const subject = email.subject || '(No subject)';
    const date = email.date || '';
    return `${index + 1}. From: ${from} | Subject: ${subject}${date ? ` | Date: ${date}` : ''}`;
  });
  return `Latest emails:\n${lines.join('\n')}`;
}

function summarizeCalendarEvents(events = [], emptyText = 'No upcoming events found') {
  if (!Array.isArray(events) || events.length === 0) return emptyText;
  const lines = events.map((event, index) => (
    `${index + 1}. ${event.title || 'Untitled'}${event.start ? ` | Starts: ${event.start}` : ''}${event.end ? ` | Ends: ${event.end}` : ''}`
  ));
  return `Upcoming events:\n${lines.join('\n')}`;
}

function formatYMD(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysYMD(ymd, days) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return formatYMD(date);
}

function calendarWindow(params = {}) {
  const when = String(params.when || '').toLowerCase();
  const today = formatYMD();
  const ymd = when === 'tomorrow' ? addDaysYMD(today, 1)
    : when === 'today' ? today
      : null;
  if (!ymd) {
    // No explicit day was requested. Still cap how far out we look — otherwise
    // singleEvents expansion of an annually-recurring event (e.g. a birthday) returns
    // one instance per future year, and those can crowd out real near-term events in
    // a maxResults-limited, startTime-ordered query.
    return {
      timeMin: new Date().toISOString(),
      timeMax: `${addDaysYMD(today, 30)}T23:59:59Z`,
      ymd: null
    };
  }
  return {
    // Query a small UTC buffer around the London day, then the backend applies
    // an exact London-calendar-day filter before synthesis. This avoids missing
    // just-after-midnight BST events while still preventing open-ended future
    // results from leaking into "tomorrow".
    timeMin: `${addDaysYMD(ymd, -1)}T00:00:00Z`,
    timeMax: `${addDaysYMD(ymd, 1)}T23:59:59Z`,
    ymd
  };
}

const HAS_UTC_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;

// Google takes a time in one of two forms, and they mean different things:
//   - an ABSOLUTE instant, where dateTime carries Z or an offset ("2026-08-10T13:00:00Z");
//   - a LOCAL wall-clock time, where dateTime carries no offset and timeZone says how to
//     read it ("2026-08-10T14:00:00" + Europe/London).
//
// What is never valid is taking an absolute instant, deleting its offset, and relabelling the
// remaining digits as local. That is what this code used to do to every value it was given,
// and it silently moved events by the zone's offset: schedule_block computes a real instant
// and passes start.toISOString(), so booking "tomorrow at 14:00" during BST wrote 13:00 to
// the calendar while the confirmation text still said 14:00. In winter, with London on UTC,
// the same code is correct — which is why it survived.
//
// So: keep an offset when there is one, and only attach timeZone to a bare wall-clock time.
// timeZone rides along in both cases, but it means different things. With an offset present
// Google takes the instant from the offset and uses timeZone only as the event's DISPLAY
// zone — which matters, because an event stored without one is labelled UTC and the
// invitation email then reads "5pm UTC" to a London guest instead of 6pm. With no offset,
// timeZone is what makes the wall-clock time mean anything at all.
function calendarTime(value, timezone) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return { dateTime: raw, timeZone: timezone };
}

// One hour after `value`, in the same form it arrived in — instant stays an instant,
// wall clock stays wall clock (adding to the digits, which is what "an hour later" means
// on a local clock).
function oneHourLater(value, timezone) {
  const raw = String(value ?? '').trim();
  if (HAS_UTC_OFFSET.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return calendarTime(raw, timezone);
    return calendarTime(new Date(d.getTime() + 3600000).toISOString(), timezone);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return calendarTime(raw, timezone);
  d.setHours(d.getHours() + 1);
  const pad = n => String(n).padStart(2, '0');
  return {
    dateTime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`,
    timeZone: timezone
  };
}

// The full event resource, not the trimmed shape get_calendar_events returns — cancellation
// needs to see recurrence, attendees and status BEFORE deciding what a delete even means.
async function fetchCalendarEvent(headers, eventId) {
  const resp = await axios.get(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { headers, timeout: 15000 }
  );
  return resp.data;
}

// RFC 5545 requires UNTIL's value type to match DTSTART's — a date-only (all-day) series
// takes a bare YYYYMMDD, a timed one takes a full UTC datetime. Getting this wrong is a
// silent 400 from Google, not a wrong result, so it is derived from the master event's own
// start rather than assumed.
function formatUntilUTC(date, allDay) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  if (allDay) return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

// Ends a recurring series after `untilDate` by adding/replacing UNTIL on its RRULE line —
// this is how Google Calendar itself implements "this and following events" when a user
// edits a series in the UI, so a client reading the result sees the same thing a human
// cancellation would have produced. COUNT is dropped because RFC 5545 forbids UNTIL and
// COUNT on the same rule. Lines that are not an RRULE (EXDATE, RDATE) pass through untouched.
function trimRecurrenceUntil(recurrence = [], untilDate, allDay) {
  const untilStr = formatUntilUTC(untilDate, allDay);
  let touched = false;
  const out = recurrence.map(line => {
    if (!/^RRULE:/i.test(String(line))) return line;
    touched = true;
    const [prefix, paramsStr] = String(line).split(':');
    const parts = (paramsStr || '').split(';')
      .filter(part => part && !/^(COUNT|UNTIL)=/i.test(part));
    parts.push(`UNTIL=${untilStr}`);
    return `${prefix}:${parts.join(';')}`;
  });
  return { recurrence: out, touched };
}

function extractDocText(document = {}) {
  const content = document.body?.content || [];
  const lines = [];
  for (const el of content) {
    const elements = el.paragraph?.elements;
    if (!elements) continue;
    const text = elements.map(e => e.textRun?.content || '').join('');
    if (text.trim()) lines.push(text.replace(/\n$/, ''));
  }
  return lines.join('\n').trim();
}

async function findDocByTitle(headers, title) {
  const resp = await axios.get('https://www.googleapis.com/drive/v3/files', {
    headers,
    params: {
      q: `mimeType='application/vnd.google-apps.document' and trashed=false and name contains '${String(title).replace(/'/g, "\\'")}'`,
      pageSize: 1,
      fields: 'files(id,name)'
    },
    timeout: 15000
  });
  return resp.data.files?.[0] || null;
}

async function execute(userId, action, params) {
  let token;
  try {
    token = await getAccessToken(userId);
  } catch (err) {
    return { success: false, error: `Google not connected: ${err.message}` };
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    switch (action) {
      case 'send_email': {
        const to = params.to || params.email || params.recipient;
        const body = params.body || params.message || params.content;
        const subject = params.subject || inferEmailSubject(body);
        const threadId = params.thread_id || params.threadId;
        let inReplyTo = params.in_reply_to || params.inReplyTo || params.message_id || params.messageId;
        let references = params.references || inReplyTo;
        if (!to || !body) return { success: false, error: 'send_email requires a recipient and message body' };
        // Guard against sending to a bare name instead of an address.
        if (!/[^\s<]+@[^\s>]+\.[^\s>]+/.test(String(to))) {
          return { success: false, error: `I need ${to}'s email address — I only have a name, not an address.` };
        }
        // For a reply, derive RFC threading headers from the thread's actual last
        // message — the model can't see the real Message-ID, so don't trust it.
        if (threadId) {
          try {
            const threadMsgs = await fetchThreadMessages(headers, threadId);
            const last = threadMsgs[threadMsgs.length - 1];
            if (last?.messageId) {
              inReplyTo = last.messageId;
              references = [last.references, last.messageId].filter(Boolean).join(' ').trim();
            }
          } catch { /* fall back to whatever the model supplied */ }
        }
        if (isGenericPlaceholderEmail(subject, body)) {
          return {
            success: false,
            error: 'Email content is too generic. Ask for the actual message before sending.'
          };
        }
        const payload = { raw: buildMime(to, subject, body, { inReplyTo, references }) };
        if (threadId) payload.threadId = threadId;
        const sent = await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          payload, { headers, timeout: 15000 });
        // Gmail's own ids for what it accepted. These are the evidence a commitment is linked
        // to — "the user promised this in THIS message on THIS thread" — so they have to come
        // back from the send rather than be reconstructed afterwards.
        return {
          success: true,
          messageId: sent.data?.id || null,
          threadId: sent.data?.threadId || threadId || null,
          to,
          subject,
          text: `Email sent to ${to}`
        };
      }

      case 'get_emails': {
        const { max_results = 5 } = params;
        const labelIds = normalizeLabelFilter(params);
        const list = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages',
          { headers, ...gmailParams({ maxResults: max_results, labelIds }), timeout: 15000 });
        if (!list.data.messages?.length) return { success: true, emails: [], text: 'No emails found' };

        const emails = await Promise.all(list.data.messages.slice(0, max_results).map(async msg => {
          return fetchFullMessage(headers, msg.id);
        }));
        return { success: true, emails, text: summarizeEmails(emails) };
      }

      case 'get_email_action_links': {
        const { messageId } = params;
        if (!messageId) return { success: false, error: 'get_email_action_links requires messageId' };
        const detail = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
          { headers, params: { format: 'full' }, timeout: 15000 });
        const email = messageToEmail(detail.data);
        const rawHtml = collectRawHtmlParts(detail.data.payload).join('\n');
        return { success: true, body: email.body, links: extractLinksFromHtml(rawHtml) };
      }

      // Real Gmail mutation: archiving = removing the INBOX label. Gmail has no separate
      // "archive" concept — the message still exists, is still searchable, just isn't in the
      // inbox view. This is the low-risk, reversible removal mechanism; nothing here ever
      // calls the trash or permanent-delete endpoints.
      case 'archive_emails': {
        const ids = normalizeMessageIds(params?.message_ids ?? params?.messageIds ?? params?.message_id);
        if (!ids.length) return { success: false, error: 'archive_emails requires message_ids' };
        const result = await bulkModifyMessages(headers, ids, { removeLabelIds: ['INBOX'] }, { expectAbsent: ['INBOX'] });
        return {
          success: result.modified > 0,
          modified: result.modified,
          requested: ids.length,
          failed: result.failedIds,
          verified: result.verified,
          text: result.modified > 0
            ? `Archived ${result.modified} of ${ids.length} message${ids.length === 1 ? '' : 's'}.`
            : 'Could not archive any of the requested messages.'
        };
      }

      // Generic label mutation — also how mark read/unread works (UNREAD is just another
      // label): remove_labels:['UNREAD'] marks read, add_labels:['UNREAD'] marks unread.
      case 'label_emails': {
        const ids = normalizeMessageIds(params?.message_ids ?? params?.messageIds ?? params?.message_id);
        const addNames = normalizeMessageIds(params?.add_labels ?? params?.addLabels);
        const removeNames = normalizeMessageIds(params?.remove_labels ?? params?.removeLabels);
        if (!ids.length) return { success: false, error: 'label_emails requires message_ids' };
        if (!addNames.length && !removeNames.length) return { success: false, error: 'label_emails requires add_labels and/or remove_labels' };

        // Names in, real Gmail label ids out. Adding may create; removing never does.
        const cache = {};
        const add = await resolveLabelIds(headers, addNames, { create: true, cache });
        const remove = await resolveLabelIds(headers, removeNames, { create: false, cache });

        if (!add.ids.length && !remove.ids.length) {
          const refused = [...add.refused, ...remove.refused];
          if (refused.length) {
            return { success: false, error: `Gmail does not let anything add or remove ${refused.join(', ')} — that label reflects where the message came from.` };
          }
          return { success: false, error: `No such label: ${[...add.unresolved, ...remove.unresolved].join(', ')}` };
        }

        const result = await bulkModifyMessages(headers, ids, { addLabelIds: add.ids, removeLabelIds: remove.ids }, {
          expectPresent: add.ids,
          expectAbsent: remove.ids
        });
        // A label we could not resolve is not a thing we did. Reported alongside the counts so
        // a partly-applied request never reads as a clean success.
        const skipped = [...add.unresolved, ...remove.unresolved, ...add.refused, ...remove.refused];
        return {
          success: result.modified > 0,
          modified: result.modified,
          requested: ids.length,
          failed: result.failedIds,
          verified: result.verified,
          created: add.created,
          skippedLabels: skipped,
          text: result.modified > 0
            ? `Updated labels on ${result.modified} of ${ids.length} message${ids.length === 1 ? '' : 's'}.${add.created.length ? ` Created the label ${add.created.join(', ')}.` : ''}${skipped.length ? ` Could not apply: ${skipped.join(', ')}.` : ''}`
            : 'Could not update labels on any of the requested messages.'
        };
      }

      // Tiered real unsubscribe. Never reports success for merely finding a link — only for
      // an action that actually completed: a real one-click POST acknowledged by the
      // provider's own endpoint, or a real email genuinely sent to a mailto: unsubscribe
      // address. Anything that needs a real page visit (no one-click support, or no
      // List-Unsubscribe header at all but a body link exists) is reported as such rather
      // than attempted with brittle in-process HTML parsing — that's what run_browser_task
      // is for.
      case 'unsubscribe_email': {
        const messageId = params?.message_id || params?.messageId;
        if (!messageId) return { success: false, error: 'unsubscribe_email requires message_id' };
        const detail = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
          { headers, params: { format: 'full' }, timeout: 15000 });
        const email = messageToEmail(detail.data);
        const senderLabel = email.senderName || email.senderAddress || 'this sender';

        if (!email.listUnsubscribe) {
          const rawHtml = collectRawHtmlParts(detail.data.payload).join('\n');
          const link = extractLinksFromHtml(rawHtml).find(l => /unsubscribe/i.test(l.label) || /unsubscribe/i.test(l.url));
          if (link) {
            return {
              success: false,
              needsBrowser: true,
              url: link.url,
              sender: email.senderAddress,
              text: `Found an unsubscribe link in the email body from ${senderLabel}, but it needs a real page visit to complete.`
            };
          }
          return { success: false, error: `No unsubscribe mechanism found in this email from ${senderLabel}.` };
        }

        const urlMatch = email.listUnsubscribe.match(/<\s*(https?:[^>\s]+)\s*>/i);
        const mailtoMatch = email.listUnsubscribe.match(/<\s*mailto:([^>\s]+)\s*>/i);
        const supportsOneClick = /one-click/i.test(email.listUnsubscribePost || '');

        if (urlMatch && supportsOneClick) {
          try {
            const resp = await axios.post(urlMatch[1], 'List-Unsubscribe=One-Click', {
              headers: { 'Content-Type': 'text/plain' },
              timeout: 15000,
              validateStatus: () => true
            });
            if (resp.status >= 200 && resp.status < 300) {
              return { success: true, method: 'one-click', sender: email.senderAddress, text: `Unsubscribed from ${senderLabel} — confirmed by the provider's own one-click endpoint.` };
            }
            return { success: false, error: `${senderLabel}'s unsubscribe endpoint returned status ${resp.status}.` };
          } catch (e) {
            return { success: false, error: `One-click unsubscribe to ${senderLabel} failed: ${e.message}` };
          }
        }

        if (mailtoMatch) {
          const to = mailtoMatch[1].split('?')[0].trim();
          try {
            await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
              { raw: buildMime(to, 'Unsubscribe', 'Please unsubscribe me from this mailing list.') },
              { headers, timeout: 15000 });
            return { success: true, method: 'mailto', sender: email.senderAddress, text: `Sent an unsubscribe request to ${senderLabel} (${to}).` };
          } catch (e) {
            return { success: false, error: `Could not send the unsubscribe email to ${to}: ${e.message}` };
          }
        }

        if (urlMatch) {
          return {
            success: false,
            needsBrowser: true,
            url: urlMatch[1],
            sender: email.senderAddress,
            text: `${senderLabel}'s unsubscribe link needs a real page visit to complete — no one-click support declared.`
          };
        }

        return { success: false, error: `${senderLabel}'s List-Unsubscribe header had no usable URL or email address.` };
      }

      case 'search_emails': {
        const { query, max_results = 5 } = params;
        if (!query) return { success: false, error: 'search_emails requires a query' };
        const list = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages',
          { headers, params: { q: query, maxResults: max_results }, timeout: 15000 });
        if (!list.data.messages?.length) return { success: true, emails: [], text: `No emails matching "${query}"` };

        const emails = await Promise.all(list.data.messages.slice(0, max_results).map(async msg => {
          return fetchFullMessage(headers, msg.id);
        }));
        return {
          success: true,
          emails,
          text: `Email results for "${query}":\n${summarizeEmails(emails, `No emails matching "${query}"`)}`
        };
      }

      case 'create_calendar_event': {
        const { title, start_date, end_date, description = '', timezone = 'Europe/London' } = params;
        if (!title || !start_date) return { success: false, error: 'create_calendar_event requires title and start_date' };
        const startTime = calendarTime(start_date, timezone);
        const endTime = end_date ? calendarTime(end_date, timezone) : oneHourLater(start_date, timezone);
        // Attendees make this a real invitation rather than a private block. sendUpdates:'all'
        // is what actually emails them; without it Google creates the event silently and the
        // guest never hears about it.
        const attendees = (Array.isArray(params.attendees) ? params.attendees : String(params.attendees || '').split(','))
          .map(a => String(a || '').trim())
          .filter(a => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a))
          .map(email => ({ email }));

        const event = await axios.post('https://www.googleapis.com/calendar/v3/calendars/primary/events',
          {
            summary: title,
            description,
            start: startTime,
            end: endTime,
            ...(attendees.length ? { attendees } : {})
          },
          { headers, timeout: 15000, params: attendees.length ? { sendUpdates: 'all' } : undefined });
        return {
          success: true,
          text: `Event "${title}" created${attendees.length ? ` and invited ${attendees.map(a => a.email).join(', ')}` : ''}`,
          eventId: event.data.id,
          invited: attendees.map(a => a.email)
        };
      }

      // Moves or resizes an EXISTING event. PATCH, not POST: replanning must change the thing
      // in the user's calendar, not leave the old time sitting there next to a new one.
      case 'update_calendar_event': {
        const { event_id, title, start_date, end_date, timezone = 'Europe/London' } = params;
        if (!event_id) return { success: false, error: 'update_calendar_event requires event_id' };
        const patch = {};
        if (title) patch.summary = title;
        if (start_date) patch.start = calendarTime(start_date, timezone);
        if (end_date) patch.end = calendarTime(end_date, timezone);
        if (!Object.keys(patch).length) return { success: false, error: 'Nothing to change on that event.' };

        const updated = await axios.patch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(event_id)}`,
          patch,
          { headers, timeout: 15000, params: { sendUpdates: 'all' } }
        );
        return {
          success: true,
          eventId: updated.data.id,
          text: `Moved "${updated.data.summary || title || 'the event'}"`,
          start: updated.data.start?.dateTime || updated.data.start?.date,
          end: updated.data.end?.dateTime || updated.data.end?.date
        };
      }

      case 'get_calendar_events': {
        const { max_results = 5 } = params;
        const window = calendarWindow(params);
        const calendarParams = {
          maxResults: max_results,
          orderBy: 'startTime',
          singleEvents: true,
          timeMin: window.timeMin
        };
        if (window.timeMax) calendarParams.timeMax = window.timeMax;
        if (window.ymd) calendarParams.timeZone = 'Europe/London';
        const resp = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          headers,
          params: calendarParams,
          timeout: 15000
        });
        const events = (resp.data.items || [])
          // A cancelled instance of a recurring series still shows up in a singleEvents
          // listing — surfacing it as a live event would let "cancel my meeting tomorrow"
          // match something that is already cancelled.
          .filter(e => e.status !== 'cancelled')
          .map(e => ({
            id: e.id,
            title: e.summary,
            start: e.start?.dateTime || e.start?.date,
            end: e.end?.dateTime || e.end?.date,
            attendees: (e.attendees || []).filter(a => !a.self).map(a => a.email).filter(Boolean),
            // Present only on an occurrence of a recurring series (singleEvents:true expands
            // the series into instances, each pointing back at the master by this field) —
            // used to require clarification before a destructive delete on a repeating event.
            recurringEventId: e.recurringEventId || null
          }));
        return { success: true, events, when: params.when || null, text: summarizeCalendarEvents(events) };
      }

      // Cancels a REAL event — an instance, a whole non-recurring event, or (via event_id
      // being the master) an entire series. Never a "hide in Millie": nothing about this
      // event exists outside Google Calendar, so there is nothing else to hide it from.
      // Attendee notification follows Google's own semantics rather than a guess: sendUpdates
      // only fires when there is actually someone other than the organizer to tell.
      case 'delete_calendar_event': {
        const eventId = String(params?.event_id || '').trim();
        if (!eventId) return { success: false, error: 'delete_calendar_event requires event_id' };

        let existing;
        try {
          existing = await fetchCalendarEvent(headers, eventId);
        } catch (err) {
          if (err.response?.status === 404 || err.response?.status === 410) {
            return { success: false, error: 'That event no longer exists.' };
          }
          throw err;
        }
        if (existing.status === 'cancelled') {
          return { success: true, alreadyCancelled: true, eventId, text: 'That event was already cancelled.' };
        }

        const attendees = (existing.attendees || []).filter(a => !a.self);
        const notify = params?.notify_attendees !== false;
        const sendUpdates = attendees.length && notify ? 'all' : 'none';

        await axios.delete(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
          { headers, timeout: 15000, params: { sendUpdates } }
        );

        const title = existing.summary || 'the event';
        return {
          success: true,
          eventId,
          title: existing.summary || null,
          hadAttendees: attendees.length > 0,
          notifiedAttendees: sendUpdates === 'all',
          wasRecurringInstance: Boolean(existing.recurringEventId),
          text: `Cancelled "${title}"${sendUpdates === 'all' ? ` and notified ${attendees.length} attendee${attendees.length === 1 ? '' : 's'}` : ''}.`
        };
      }

      // Ends a recurring series after a given occurrence — "this and future" cancellation.
      // event_id must be the SERIES id (an occurrence's recurringEventId, not the occurrence's
      // own id); from_date is the first occurrence that should stop happening. Everything
      // before from_date is left alone.
      case 'end_recurring_series': {
        const eventId = String(params?.event_id || '').trim();
        const fromDate = params?.from_date;
        if (!eventId || !fromDate) {
          return { success: false, error: 'end_recurring_series requires event_id and from_date' };
        }

        let master;
        try {
          master = await fetchCalendarEvent(headers, eventId);
        } catch (err) {
          if (err.response?.status === 404 || err.response?.status === 410) {
            return { success: false, error: 'That series no longer exists.' };
          }
          throw err;
        }
        if (!Array.isArray(master.recurrence) || !master.recurrence.length) {
          return { success: false, error: 'That event is not part of a recurring series.' };
        }

        const cutoff = new Date(fromDate);
        if (Number.isNaN(cutoff.getTime())) {
          return { success: false, error: 'Could not read the date to end the series before.' };
        }
        // The cutoff is the END of the day BEFORE the given occurrence, so that occurrence
        // and everything after it stop being generated while everything earlier survives.
        cutoff.setUTCDate(cutoff.getUTCDate() - 1);
        cutoff.setUTCHours(23, 59, 59, 0);
        const allDay = Boolean(master.start?.date && !master.start?.dateTime);
        const { recurrence, touched } = trimRecurrenceUntil(master.recurrence, cutoff, allDay);
        if (!touched) {
          return { success: false, error: 'Could not find a repeat rule on that series to end.' };
        }

        const attendees = (master.attendees || []).filter(a => !a.self);
        const notify = params?.notify_attendees !== false;
        const sendUpdates = attendees.length && notify ? 'all' : 'none';

        await axios.patch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
          { recurrence },
          { headers, timeout: 15000, params: { sendUpdates } }
        );

        const title = master.summary || 'the series';
        return {
          success: true,
          eventId,
          hadAttendees: attendees.length > 0,
          notifiedAttendees: sendUpdates === 'all',
          text: `Ended "${title}" after this occurrence.`
        };
      }

      case 'create_google_doc': {
        const title = String(params?.title || '').trim() || 'Untitled document';
        const content = params?.content;
        const doc = await axios.post('https://docs.googleapis.com/v1/documents', { title }, { headers, timeout: 15000 });
        const documentId = doc.data.documentId;
        if (content) {
          await axios.post(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
            { requests: [{ insertText: { location: { index: 1 }, text: String(content) } }] },
            { headers, timeout: 15000 });
        }
        return {
          success: true,
          text: `Created Google Doc "${title}"`,
          documentId,
          webLink: `https://docs.google.com/document/d/${documentId}/edit`
        };
      }

      case 'search_google_docs': {
        const query = String(params?.query || '').trim();
        const maxResults = params?.max_results || 5;
        const qParts = ["mimeType='application/vnd.google-apps.document'", 'trashed=false'];
        if (query) qParts.push(`fullText contains '${query.replace(/'/g, "\\'")}'`);
        const resp = await axios.get('https://www.googleapis.com/drive/v3/files', {
          headers,
          params: { q: qParts.join(' and '), pageSize: maxResults, fields: 'files(id,name,webViewLink,modifiedTime)', orderBy: 'modifiedTime desc' },
          timeout: 15000
        });
        const docs = (resp.data.files || []).map(f => ({ id: f.id, title: f.name, url: f.webViewLink, modifiedAt: f.modifiedTime }));
        return {
          success: true,
          docs,
          text: docs.length
            ? `Found ${docs.length} Google Doc${docs.length === 1 ? '' : 's'}${query ? ` for "${query}"` : ''}:\n${docs.map((d, i) => `${i + 1}. ${d.title}`).join('\n')}`
            : `No Google Docs found${query ? ` for "${query}"` : ''}`
        };
      }

      case 'append_google_doc': {
        const content = String(params?.content || '').trim();
        if (!content) return { success: false, error: 'append_google_doc requires content' };
        let documentId = params?.document_id;
        let title = params?.title;
        if (!documentId) {
          const docTitle = String(params?.title || params?.document_title || '').trim();
          if (!docTitle) return { success: false, error: 'append_google_doc requires a title or document_id' };
          const file = await findDocByTitle(headers, docTitle);
          if (!file) return { success: false, error: `No Google Doc found matching "${docTitle}"` };
          documentId = file.id;
          title = file.name;
        }
        const doc = await axios.get(`https://docs.googleapis.com/v1/documents/${documentId}`, { headers, timeout: 15000 });
        const lastElement = doc.data.body?.content?.slice(-1)[0];
        const insertIndex = Math.max(1, (lastElement?.endIndex || 1) - 1);
        await axios.post(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
          { requests: [{ insertText: { location: { index: insertIndex }, text: `\n${content}` } }] },
          { headers, timeout: 15000 });
        return {
          success: true,
          text: `Added to Google Doc "${title || documentId}"`,
          documentId,
          webLink: `https://docs.google.com/document/d/${documentId}/edit`
        };
      }

      case 'get_google_doc': {
        let documentId = params?.document_id;
        let title = params?.title;
        if (!documentId) {
          const docTitle = String(params?.title || '').trim();
          if (!docTitle) return { success: false, error: 'get_google_doc requires a title or document_id' };
          const file = await findDocByTitle(headers, docTitle);
          if (!file) return { success: false, error: `No Google Doc found matching "${docTitle}"` };
          documentId = file.id;
          title = file.name;
        }
        const doc = await axios.get(`https://docs.googleapis.com/v1/documents/${documentId}`, { headers, timeout: 15000 });
        const text = extractDocText(doc.data);
        return {
          success: true,
          text: text ? `${title ? `"${title}":\n` : ''}${text}` : 'Document is empty',
          documentId,
          title: doc.data.title
        };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: `Google API error: ${detail}` };
  }
}

module.exports = {
  SUPPORTED_ACTIONS,
  execute,
  getThreadContext,
  getMailbox,
  _private: {
    _clearMailboxCache,
    decodeBase64Url,
    stripHtml,
    extractMessageBody,
    messageToEmail,
    normalizeLabelFilter,
    calendarWindow,
    calendarTime,
    oneHourLater,
    formatThreadText,
    buildMime,
    formatUntilUTC,
    trimRecurrenceUntil
  }
};

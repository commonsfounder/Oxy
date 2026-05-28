const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('google connector bootstrap');

const SUPPORTED_ACTIONS = ['send_email', 'get_emails', 'search_emails', 'create_calendar_event', 'get_calendar_events'];

async function getTokens(userId) {
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'google')
      .eq('enabled', true)
      .limit(1);

    if (!error && data?.length > 0 && data[0].tokens) return decryptTokens(data[0].tokens);
  } catch (err) {
    console.error('[getTokens] DB error:', err.message);
  }

  // Fall back to env vars (single-user setup), save to DB for next time
  if (process.env.GMAIL_REFRESH_TOKEN) {
    const tokens = {
      refresh_token: process.env.GMAIL_REFRESH_TOKEN.replace(/^﻿/, '').trim(),
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET
    };
    try { await saveTokens(userId, tokens); } catch (err) {
      console.error('[getTokens] failed to save env tokens:', err.message);
    }
    return tokens;
  }

  throw new Error('Google connector not configured for this user');
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

  try {
    const resp = await axios.post('https://oauth2.googleapis.com/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token.replace(/^﻿/, '').trim(),
      client_id: tokens.client_id || process.env.GMAIL_CLIENT_ID,
      client_secret: tokens.client_secret || process.env.GMAIL_CLIENT_SECRET
    }, { timeout: 10000 });

    const updated = {
      ...tokens,
      access_token: resp.data.access_token,
      expires_at: Date.now() + resp.data.expires_in * 1000
    };
    await saveTokens(userId, updated);
    return updated.access_token;
  } catch (err) {
    const desc = err.response?.data?.error_description || err.message;
    if (typeof desc === 'string' && (desc.includes('expired') || desc.includes('revoked'))) {
      // Refresh token is dead — clear it so the connector shows as disconnected
      try { await markGoogleDisconnected(userId, tokens); } catch {}
      throw new Error('Failed to refresh Google token: Token has been expired or revoked. Reconnect Google from Settings.');
    }
    throw new Error(`Failed to refresh Google token: ${desc}`);
  }
}

function buildMime(to, subject, body, options = {}) {
  const headers = [`To: ${to}`, `Subject: ${subject}`];
  if (options.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) headers.push(`References: ${options.references}`);
  const msg = [...headers, 'Content-Type: text/plain; charset=utf-8', '', body].join('\n');
  return Buffer.from(msg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
        const inReplyTo = params.in_reply_to || params.inReplyTo || params.message_id || params.messageId;
        const references = params.references || inReplyTo;
        if (!to || !body) return { success: false, error: 'send_email requires a recipient and message body' };
        if (isGenericPlaceholderEmail(subject, body)) {
          return {
            success: false,
            error: 'Email content is too generic. Ask for the actual message before sending.'
          };
        }
        const payload = { raw: buildMime(to, subject, body, { inReplyTo, references }) };
        if (threadId) payload.threadId = threadId;
        await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          payload, { headers, timeout: 15000 });
        return { success: true, text: `Email sent to ${to}` };
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
        if (!title || !start_date || !end_date) return { success: false, error: 'create_calendar_event requires title, start_date, end_date' };
        // Strip timezone offsets (Z, +01:00 etc) so Google uses the timeZone field for local interpretation
        const toLocal = dt => dt.replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '');
        const event = await axios.post('https://www.googleapis.com/calendar/v3/calendars/primary/events',
          {
            summary: title,
            description,
            start: { dateTime: toLocal(start_date), timeZone: timezone },
            end:   { dateTime: toLocal(end_date),   timeZone: timezone }
          },
          { headers, timeout: 15000 });
        return { success: true, text: `Event "${title}" created`, eventId: event.data.id };
      }

      case 'get_calendar_events': {
        const { max_results = 5 } = params;
        const resp = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          headers,
          params: { maxResults: max_results, orderBy: 'startTime', singleEvents: true, timeMin: new Date().toISOString() },
          timeout: 15000
        });
        const events = (resp.data.items || []).map(e => ({
          id: e.id, title: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date
        }));
        return { success: true, events, text: summarizeCalendarEvents(events) };
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
  _private: {
    decodeBase64Url,
    stripHtml,
    extractMessageBody,
    messageToEmail,
    normalizeLabelFilter,
    formatThreadText,
    buildMime
  }
};

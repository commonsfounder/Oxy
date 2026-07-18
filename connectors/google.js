const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('google connector bootstrap');

const SUPPORTED_ACTIONS = [
  'send_email', 'get_emails', 'search_emails', 'create_calendar_event', 'get_calendar_events',
  'create_google_doc', 'search_google_docs', 'append_google_doc', 'get_google_doc'
];

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
    // Presence of a List-Unsubscribe header marks bulk/mailing-list mail (newsletters,
    // marketing). Personal 1:1 mail doesn't carry it — used to filter the dashboard feed.
    listUnsubscribe: getHeader(headers, 'List-Unsubscribe'),
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
        if (!title || !start_date) return { success: false, error: 'create_calendar_event requires title and start_date' };
        // Strip timezone offsets (Z, +01:00 etc) so Google uses the timeZone field for local interpretation
        const toLocal = dt => String(dt).replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '');
        const startLocal = toLocal(start_date);
        // Default a missing end to one hour after the start (local-clock math, no TZ shift).
        let endLocal = end_date ? toLocal(end_date) : null;
        if (!endLocal) {
          const d = new Date(startLocal);
          if (!Number.isNaN(d.getTime())) {
            d.setHours(d.getHours() + 1);
            const pad = n => String(n).padStart(2, '0');
            endLocal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
          } else {
            endLocal = startLocal;
          }
        }
        const event = await axios.post('https://www.googleapis.com/calendar/v3/calendars/primary/events',
          {
            summary: title,
            description,
            start: { dateTime: startLocal, timeZone: timezone },
            end:   { dateTime: endLocal,   timeZone: timezone }
          },
          { headers, timeout: 15000 });
        return { success: true, text: `Event "${title}" created`, eventId: event.data.id };
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
        const events = (resp.data.items || []).map(e => ({
          id: e.id, title: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date
        }));
        return { success: true, events, when: params.when || null, text: summarizeCalendarEvents(events) };
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
  _private: {
    decodeBase64Url,
    stripHtml,
    extractMessageBody,
    messageToEmail,
    normalizeLabelFilter,
    calendarWindow,
    formatThreadText,
    buildMime
  }
};

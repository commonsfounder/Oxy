const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');

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
      .limit(1);

    if (!error && data?.length > 0 && data[0].tokens) return data[0].tokens;
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
  await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'google', enabled: true, tokens, updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
}

async function getAccessToken(userId) {
  const tokens = await getTokens(userId);

  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
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
      try { await saveTokens(userId, { client_id: tokens.client_id, client_secret: tokens.client_secret }); } catch {}
      throw new Error('Failed to refresh Google token: Token has been expired or revoked. Reconnect Google from Settings.');
    }
    throw new Error(`Failed to refresh Google token: ${desc}`);
  }
}

function buildMime(to, subject, body) {
  const msg = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\n');
  return Buffer.from(msg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
        const { to, subject, body } = params;
        if (!to || !subject || !body) return { success: false, error: 'send_email requires to, subject, and body' };
        await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          { raw: buildMime(to, subject, body) }, { headers, timeout: 15000 });
        return { success: true, text: `Email sent to ${to}` };
      }

      case 'get_emails': {
        const { max_results = 5 } = params;
        const list = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages',
          { headers, params: { maxResults: max_results }, timeout: 15000 });
        if (!list.data.messages?.length) return { success: true, emails: [], text: 'No emails found' };

        const emails = await Promise.all(list.data.messages.slice(0, max_results).map(async msg => {
          const detail = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
            { headers, params: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }, timeout: 15000 });
          const h = detail.data.payload?.headers || [];
          const get = n => h.find(x => x.name === n)?.value || '';
          return { id: msg.id, from: get('From'), subject: get('Subject'), date: get('Date') };
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
          const detail = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
            { headers, params: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }, timeout: 15000 });
          const h = detail.data.payload?.headers || [];
          const get = n => h.find(x => x.name === n)?.value || '';
          return { id: msg.id, from: get('From'), subject: get('Subject'), date: get('Date') };
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

module.exports = { SUPPORTED_ACTIONS, execute };

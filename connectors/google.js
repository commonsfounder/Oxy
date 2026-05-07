const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SUPPORTED_ACTIONS = ['send_email', 'get_emails', 'search_emails', 'create_calendar_event', 'get_calendar_events'];

async function getTokens(userId) {
  const { data } = await supabase
    .from('connectors')
    .select('tokens')
    .eq('user_id', userId)
    .eq('connector_id', 'google')
    .single();

  if (data?.tokens) return data.tokens;

  // Fall back to env vars (single-user setup), save to DB for next time
  if (process.env.GMAIL_REFRESH_TOKEN) {
    const tokens = {
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET
    };
    await saveTokens(userId, tokens);
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

  const resp = await axios.post('https://oauth2.googleapis.com/token', {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.client_id || process.env.GMAIL_CLIENT_ID,
    client_secret: tokens.client_secret || process.env.GMAIL_CLIENT_SECRET
  });

  const updated = {
    ...tokens,
    access_token: resp.data.access_token,
    expires_at: Date.now() + resp.data.expires_in * 1000
  };
  await saveTokens(userId, updated);
  return updated.access_token;
}

function buildMime(to, subject, body) {
  const msg = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\n');
  return Buffer.from(msg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
          { raw: buildMime(to, subject, body) }, { headers });
        return { success: true, text: `Email sent to ${to}` };
      }

      case 'get_emails': {
        const { max_results = 5 } = params;
        const list = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages',
          { headers, params: { maxResults: max_results } });
        if (!list.data.messages?.length) return { success: true, emails: [], text: 'No emails found' };

        const emails = await Promise.all(list.data.messages.slice(0, max_results).map(async msg => {
          const detail = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
            { headers, params: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] } });
          const h = detail.data.payload?.headers || [];
          const get = n => h.find(x => x.name === n)?.value || '';
          return { id: msg.id, from: get('From'), subject: get('Subject'), date: get('Date') };
        }));
        return { success: true, emails, text: `Found ${emails.length} emails` };
      }

      case 'search_emails': {
        const { query, max_results = 5 } = params;
        if (!query) return { success: false, error: 'search_emails requires a query' };
        const list = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages',
          { headers, params: { q: query, maxResults: max_results } });
        if (!list.data.messages?.length) return { success: true, emails: [], text: `No emails matching "${query}"` };

        const emails = await Promise.all(list.data.messages.slice(0, max_results).map(async msg => {
          const detail = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
            { headers, params: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] } });
          const h = detail.data.payload?.headers || [];
          const get = n => h.find(x => x.name === n)?.value || '';
          return { id: msg.id, from: get('From'), subject: get('Subject'), date: get('Date') };
        }));
        return { success: true, emails, text: `Found ${emails.length} emails matching "${query}"` };
      }

      case 'create_calendar_event': {
        const { title, start_date, end_date, description = '' } = params;
        if (!title || !start_date || !end_date) return { success: false, error: 'create_calendar_event requires title, start_date, end_date' };
        const event = await axios.post('https://www.googleapis.com/calendar/v3/calendars/primary/events',
          { summary: title, description, start: { dateTime: start_date }, end: { dateTime: end_date } },
          { headers });
        return { success: true, text: `Event "${title}" created`, eventId: event.data.id };
      }

      case 'get_calendar_events': {
        const { max_results = 5 } = params;
        const resp = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          headers,
          params: { maxResults: max_results, orderBy: 'startTime', singleEvents: true, timeMin: new Date().toISOString() }
        });
        const events = (resp.data.items || []).map(e => ({
          id: e.id, title: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date
        }));
        return { success: true, events, text: `Found ${events.length} upcoming events` };
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

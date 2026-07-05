const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('microsoft connector bootstrap');

const SUPPORTED_ACTIONS = ['send_outlook_email', 'get_outlook_emails', 'search_outlook_emails', 'create_outlook_event', 'get_outlook_events'];

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TENANT = process.env.MS_TENANT || 'common';
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

async function getTokens(userId) {
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'microsoft')
      .eq('enabled', true)
      .limit(1);

    if (!error && data?.length > 0 && data[0].tokens) return decryptTokens(data[0].tokens);
  } catch (err) {
    console.error('[microsoft getTokens] DB error:', err.message);
  }
  return {};
}

async function saveTokens(userId, tokens) {
  const { error } = await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'microsoft', enabled: true, tokens: encryptTokens(tokens), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
  if (error) throw error;
}

async function markDisconnected(userId) {
  await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'microsoft', enabled: false, tokens: encryptTokens({}), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
}

async function getAccessToken(userId) {
  const tokens = await getTokens(userId);

  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error('Outlook not connected. Connect Microsoft from Settings.');
  }

  const attemptRefresh = () => axios.post(TOKEN_URL, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });

  let resp;
  try {
    resp = await attemptRefresh();
  } catch (err) {
    const desc = err.response?.data?.error_description || err.message;
    if (typeof desc === 'string' && (desc.includes('expired') || desc.includes('revoked') || desc.includes('invalid_grant'))) {
      try { await markDisconnected(userId); } catch (cleanupErr) {
        console.warn('[microsoft] disconnect cleanup failed:', cleanupErr.message);
      }
      throw new Error('Outlook session expired. Reconnect Microsoft from Settings.');
    }
    await new Promise(r => setTimeout(r, 1000));
    try {
      resp = await attemptRefresh();
    } catch (retryErr) {
      throw new Error(`Failed to refresh Outlook token: ${retryErr.response?.data?.error_description || retryErr.message}`);
    }
  }

  const updated = {
    ...tokens,
    access_token: resp.data.access_token,
    refresh_token: resp.data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + resp.data.expires_in * 1000
  };
  await saveTokens(userId, updated);
  return updated.access_token;
}

function summarizeMessage(m = {}) {
  return {
    id: m.id,
    subject: m.subject,
    from: m.from?.emailAddress?.address,
    senderName: m.from?.emailAddress?.name,
    receivedAt: m.receivedDateTime,
    preview: m.bodyPreview,
    isRead: m.isRead
  };
}

function summarizeEvent(e = {}) {
  return {
    id: e.id,
    title: e.subject,
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName || undefined,
    organizer: e.organizer?.emailAddress?.name || undefined
  };
}

async function execute(userId, action, params) {
  let token;
  try {
    token = await getAccessToken(userId);
  } catch (err) {
    return { success: false, error: err.message };
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    switch (action) {
      case 'send_outlook_email': {
        const to = String(params?.to || '').trim();
        const body = String(params?.body || '').trim();
        if (!to) return { success: false, error: 'send_outlook_email requires a recipient (to)' };
        if (!body) return { success: false, error: 'send_outlook_email requires a body' };
        const subject = params?.subject ? String(params.subject) : (body.split('\n')[0].slice(0, 78) || 'Message from Milgrain');
        await axios.post(`${GRAPH}/me/sendMail`, {
          message: {
            subject,
            body: { contentType: 'Text', content: body },
            toRecipients: to.split(',').map(addr => ({ emailAddress: { address: addr.trim() } }))
          },
          saveToSentItems: true
        }, { headers, timeout: 15000 });
        return { success: true, text: `Email sent to ${to}.` };
      }

      case 'get_outlook_emails': {
        const max = Math.min(Number(params?.max) || 10, 25);
        const resp = await axios.get(`${GRAPH}/me/messages`, {
          headers,
          params: {
            $top: max,
            $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead',
            $orderby: 'receivedDateTime desc'
          },
          timeout: 15000
        });
        const emails = (resp.data?.value || []).map(summarizeMessage);
        return { success: true, text: `Fetched ${emails.length} Outlook email${emails.length === 1 ? '' : 's'}.`, emails };
      }

      case 'search_outlook_emails': {
        const query = String(params?.query || '').trim();
        if (!query) return { success: false, error: 'search_outlook_emails requires a query' };
        const resp = await axios.get(`${GRAPH}/me/messages`, {
          headers: { ...headers, ConsistencyLevel: 'eventual' },
          params: {
            $search: `"${query.replace(/"/g, '')}"`,
            $top: 10,
            $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead'
          },
          timeout: 15000
        });
        const emails = (resp.data?.value || []).map(summarizeMessage);
        return { success: true, text: emails.length ? `Found ${emails.length} matching Outlook email${emails.length === 1 ? '' : 's'}.` : 'No matching Outlook emails.', emails };
      }

      case 'create_outlook_event': {
        const title = String(params?.title || '').trim();
        const start = params?.start_date;
        const end = params?.end_date;
        if (!title) return { success: false, error: 'create_outlook_event requires a title' };
        if (!start || !end) return { success: false, error: 'create_outlook_event requires start_date and end_date' };
        const resp = await axios.post(`${GRAPH}/me/events`, {
          subject: title,
          start: { dateTime: new Date(start).toISOString(), timeZone: 'UTC' },
          end: { dateTime: new Date(end).toISOString(), timeZone: 'UTC' }
        }, { headers, timeout: 15000 });
        return { success: true, text: `Added "${title}" to your Outlook calendar.`, eventId: resp.data.id, webLink: resp.data.webLink };
      }

      case 'get_outlook_events': {
        const now = new Date();
        const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        const resp = await axios.get(`${GRAPH}/me/calendarView`, {
          headers,
          params: {
            startDateTime: now.toISOString(),
            endDateTime: horizon.toISOString(),
            $top: 15,
            $select: 'id,subject,start,end,location,organizer',
            $orderby: 'start/dateTime'
          },
          timeout: 15000
        });
        const events = (resp.data?.value || []).map(summarizeEvent);
        return { success: true, text: `You have ${events.length} upcoming Outlook event${events.length === 1 ? '' : 's'}.`, events };
      }

      default:
        return { success: false, error: `Unknown Outlook action: ${action}` };
    }
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      return { success: false, error: 'Outlook not connected. Reconnect Microsoft from Settings.' };
    }
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: `Outlook API error: ${detail}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, saveTokens, getTokens };

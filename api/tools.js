const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// --- Env vars ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
const HOME_ASSISTANT_URL = process.env.HOME_ASSISTANT_URL;
const HOME_ASSISTANT_TOKEN = process.env.HOME_ASSISTANT_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const REMINDERS_FILE = path.join(__dirname, 'reminders.json');

// --- Spotify token cache ---
let spotifyToken = null;
async function getSpotifyToken() {
  if (spotifyToken && spotifyToken.expires > Date.now()) return spotifyToken.access_token;
  const resp = await axios.post('https://accounts.spotify.com/api/token',
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: SPOTIFY_REFRESH_TOKEN, client_id: SPOTIFY_CLIENT_ID, client_secret: SPOTIFY_CLIENT_SECRET }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  spotifyToken = { access_token: resp.data.access_token, expires: Date.now() + (resp.data.expires_in * 1000) - 60000 };
  return spotifyToken.access_token;
}

// --- Google Calendar token cache ---
let gcalToken = null;
async function getGoogleCalendarToken() {
  if (gcalToken && gcalToken.expires > Date.now()) return gcalToken.access_token;
  const credentials = JSON.parse(GOOGLE_CALENDAR_CREDENTIALS);
  const resp = await axios.post('https://oauth2.googleapis.com/token', {
    grant_type: 'refresh_token',
    refresh_token: credentials.refresh_token,
    client_id: credentials.client_id,
    client_secret: credentials.client_secret
  });
  gcalToken = { access_token: resp.data.access_token, expires: Date.now() + (resp.data.expires_in * 1000) - 60000 };
  return gcalToken.access_token;
}

// --- Helpers ---
async function twilioRequest(endpoint, data) {
  return axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}${endpoint}`,
    new URLSearchParams(data),
    { auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN } }
  );
}

async function loadReminders() {
  try { return JSON.parse(await fs.readFile(REMINDERS_FILE, 'utf8')); } catch { return []; }
}

async function saveReminders(reminders) {
  await fs.writeFile(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}

// --- Tool Implementations ---
const tools = {
  send_message: async (args) => {
    const { contact, message, channel } = args;
    if (channel === 'telegram') {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: `${contact}: ${message}`,
        parse_mode: 'HTML'
      });
      return { success: true, text: `Message sent to ${contact} via Telegram` };
    }
    // Default: Twilio SMS
    if (!contact.match(/^\+/)) {
      return { success: false, error: 'Contact must be E.164 phone number for SMS (e.g. +447123456789)' };
    }
    await twilioRequest('/Messages.json', {
      From: TWILIO_PHONE_NUMBER,
      To: contact,
      Body: message
    });
    return { success: true, text: `SMS sent to ${contact}` };
  },

  create_reminder: async (args) => {
    const { title, due_date, notes } = args;
    const reminders = await loadReminders();
    reminders.push({
      id: Date.now().toString(),
      title,
      due_date: due_date || null,
      notes: notes || '',
      created: new Date().toISOString(),
      done: false
    });
    await saveReminders(reminders);
    return { success: true, text: `Reminder created: ${title}` };
  },

  get_reminders: async (args) => {
    const reminders = await loadReminders();
    const active = reminders.filter(r => !r.done);
    return { success: true, reminders: active };
  },

  complete_reminder: async (args) => {
    const { id } = args;
    const reminders = await loadReminders();
    const r = reminders.find(r => r.id === id);
    if (r) { r.done = true; await saveReminders(reminders); }
    return { success: !!r, text: r ? `Marked done: ${r.title}` : 'Reminder not found' };
  },

  make_call: async (args) => {
    const { contact } = args;
    if (!contact.match(/^\+/)) {
      return { success: false, error: 'Contact must be E.164 phone number (e.g. +447123456789)' };
    }
    await twilioRequest('/Calls.json', {
      From: TWILIO_PHONE_NUMBER,
      To: contact,
      Url: 'https://handler.twilio.com/twiml/EH1b0b1b1b1b1b1b1b1b1b1b1b1b1b1b'
    });
    return { success: true, text: `Calling ${contact}...` };
  },

  play_music: async (args) => {
    const { query } = args;
    const token = await getSpotifyToken();
    // Search
    const search = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: query, type: 'track', limit: 1 }
    });
    const track = search.data.tracks.items[0];
    if (!track) return { success: false, error: `No tracks found for "${query}"` };
    // Play on active device
    await axios.put('https://api.spotify.com/v1/me/player/play', {
      uris: [track.uri]
    }, { headers: { Authorization: `Bearer ${token}` } });
    return { success: true, text: `Now playing: ${track.name} by ${track.artists[0].name}` };
  },

  create_calendar_event: async (args) => {
    const { title, start_date, end_date, location, notes } = args;
    const credentials = JSON.parse(GOOGLE_CALENDAR_CREDENTIALS);
    const calendarId = credentials.calendar_id || 'primary';
    const token = await getGoogleCalendarToken();
    await axios.post(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        summary: title,
        description: notes || '',
        location: location || '',
        start: { dateTime: start_date, timeZone: 'Europe/London' },
        end: { dateTime: end_date || start_date, timeZone: 'Europe/London' }
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { success: true, text: `Calendar event created: ${title}` };
  },

  smart_home: async (args) => {
    const { action, entity, domain } = args;
    if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
      return { success: false, error: 'Home Assistant not configured' };
    }
    await axios.post(
      `${HOME_ASSISTANT_URL}/api/services/${domain || 'homeassistant'}/${action}`,
      { entity_id: entity },
      { headers: { Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return { success: true, text: `Home Assistant: ${action} on ${entity}` };
  }
};

async function executeTool(toolName, args) {
  try {
    const tool = tools[toolName];
    if (!tool) {
      return { success: false, error: `Unknown tool: ${toolName}` };
    }
    return await tool(args || {});
  } catch (e) {
    return { success: false, error: e.response?.data?.message || e.message };
  }
}

module.exports = { executeTool };

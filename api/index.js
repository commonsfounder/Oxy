const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const FormData = require('form-data');
const axios = require('axios');
const { dispatch, IMPLEMENTED_CONNECTORS } = require('../connectors');
const { OXY_SYSTEM_PROMPT } = require('./prompts');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const CONNECTOR_ACTION_MAP = {
  'gmail:send':                         'send_email',
  'gmail:send_email':                   'send_email',
  'gmail:get':                          'get_emails',
  'gmail:get_emails':                   'get_emails',
  'gmail:search':                       'search_emails',
  'gmail:search_emails':                'search_emails',
  'calendar:create':                    'create_calendar_event',
  'calendar:create_event':              'create_calendar_event',
  'calendar:create_calendar_event':     'create_calendar_event',
  'calendar:get':                       'get_calendar_events',
  'calendar:get_events':                'get_calendar_events',
  'calendar:get_calendar_events':       'get_calendar_events',
};

async function callProxy(userId, actionObj) {
  if (typeof actionObj === 'string') {
    // legacy call: callProxy(userId, 'send_email', params) — shouldn't happen after refactor but safe fallback
    return dispatch(userId, actionObj, {});
  }
  if (actionObj.type === 'deeplink') {
    // deeplinks are client-side only — backend just acknowledges
    return { success: true, clientAction: true, url: actionObj.url };
  }
  if (actionObj.type === 'connector') {
    const key = `${actionObj.service}:${actionObj.action}`;
    const mappedAction = CONNECTOR_ACTION_MAP[key];
    if (!mappedAction) return { success: false, error: `Unknown connector action: ${key}` };
    return dispatch(userId, mappedAction, actionObj.input || {});
  }
  // legacy flat format: {type: 'send_email', input: {...}}
  return dispatch(userId, actionObj.type, actionObj.input || {});
}


function normalizeGeminiHistory(history) {
  const mapped = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '' }]
  }));
  // Drop leading model turns — Gemini requires starting with user
  while (mapped.length > 0 && mapped[0].role !== 'user') mapped.shift();
  // Collapse consecutive same-role turns by keeping only the last
  const out = [];
  for (const msg of mapped) {
    if (out.length > 0 && out[out.length - 1].role === msg.role) {
      out[out.length - 1] = msg;
    } else {
      out.push(msg);
    }
  }
  return out;
}

function parseActions(fullResponse) {
  const match = fullResponse.match(/<action>([\s\S]*?)<\/action>/);
  const spoken = fullResponse.replace(/<action>[\s\S]*?<\/action>/g, '').trim();
  let actions = [];

  if (match) {
    try {
      // Strip markdown code fences Gemini sometimes wraps around JSON
      const raw = match[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(raw);
      actions = parsed.actions || [];
    } catch (e) {
      console.warn('[parseActions] failed:', e.message, '| raw:', match[1].trim().slice(0, 200));
    }
  }

  return { spoken, actions };
}

async function generateSpeech(text) {
  try {
    const resp = await axios.post(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        input: { text },
        voice: { languageCode: 'en-GB', name: 'en-GB-Neural2-B' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.05 }
      },
      {
        params: { key: process.env.GEMINI_API_KEY },
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    return resp.data.audioContent;
  } catch (err) {
    console.warn('[tts] Google TTS failed, falling back to ElevenLabs:', err.response?.data?.error?.message || err.message);
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 } },
      { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 15000 }
    );
    return Buffer.from(response.data).toString('base64');
  }
}

async function getMemory(userId) {
  const { data, error } = await supabase
    .from('memories')
    .select('content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !data) return '';
  return data.map(m => m.content).join('\n');
}

async function saveMemory(userId, content) {
  await supabase
    .from('memories')
    .insert({ user_id: userId, content, created_at: new Date().toISOString() });
}

function shouldSaveMemory(text) {
  const triggers = [
    'remember', 'my ', "i'm ", 'i am ', 'i work', 'i live',
    'i hate', 'i love', 'i need', 'i want', "i've got", 'i have',
    'my name', 'my job', 'my partner', 'my wife', 'my husband',
    'my kids', 'my boss', 'my flat', 'my car', "don't tell"
  ];
  const lower = text.toLowerCase();
  return triggers.some(t => lower.includes(t));
}

async function getHistory(userId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error || !data) return [];
  return data.reverse();
}

async function saveMessage(userId, role, content) {
  await supabase
    .from('conversations')
    .insert({ user_id: userId, role, content, created_at: new Date().toISOString() });
}

async function getPreferences(userId) {
  const { data, error } = await supabase
    .from('preferences')
    .select('key, value')
    .eq('user_id', userId);
  if (error || !data) return '';
  return data.map(p => `${p.key}: ${p.value}`).join('\n');
}

async function getEnabledConnectors(userId) {
  const { data, error } = await supabase
    .from('connectors')
    .select('connector_id')
    .eq('user_id', userId)
    .eq('enabled', true);
  if (error || !data) return [];
  return data.map(c => c.connector_id);
}

function buildAvailableActions(enabled) {
  const actionMap = {
    google: ['send_email', 'get_emails', 'search_emails', 'create_calendar_event', 'get_calendar_events'],
    imessage: ['send_message'],
    whatsapp: ['send_message'],
    reminders: ['create_reminder'],
    spotify: ['play_music'],
    homekit: ['homekit_control'],
    maps: ['get_directions'],
    uber: ['book_uber'],
    deliveroo: ['order_food'],
    monzo: ['check_balance'],
    betfair: ['place_bet'],
    notion: ['create_note'],
    trainline: ['search_trains']
  };
  const live = enabled.filter(id => IMPLEMENTED_CONNECTORS.has(id));
  if (live.length === 0) return 'No connectors enabled. Only return the action block when asked — the user will handle it manually.';
  const active = live.flatMap(id => actionMap[id] || []);
  return `Available actions: ${active.join(', ')}. Only use these — don't suggest actions for connectors that aren't enabled.`;
}

async function savePreference(userId, key, value) {
  await supabase
    .from('preferences')
    .upsert({ user_id: userId, key, value }, { onConflict: 'user_id,key' });
}

async function duckDuckGoSearch(query) {
  try {
    const resp = await axios.get('https://html.duckduckgo.com/html/', {
      params: { q: query },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });
    const results = [];
    const regex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>.*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gis;
    let match;
    while ((match = regex.exec(resp.data)) !== null) {
      const title = match[2].replace(/<[^>]*>/g, '').trim();
      const snippet = match[3].replace(/<[^>]*>/g, '').trim();
      let url = match[1];
      try { url = new URL(url).searchParams.get('uddg') || url; } catch {}
      if (title && snippet) results.push({ title, snippet, url });
    }
    return results.slice(0, 5);
  } catch {
    return [];
  }
}

app.post('/process-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file received.' });
    }

    const userId = req.body.userId || 'default';

    console.log('[1/4] Transcribing audio...');
    const transcription = await openai.audio.transcriptions.create({
      file: new File([req.file.buffer], 'audio.wav', { type: 'audio/wav' }),
      model: 'whisper-1',
      language: 'en'
    });

    const userText = transcription.text?.trim();
    console.log('    Transcribed:', userText);

    if (!userText) {
      return res.json({ transcription: '', text: '', audio: null, actions: [] });
    }

    const [memory, history] = await Promise.all([
      getMemory(userId),
      getHistory(userId)
    ]);
    await saveMessage(userId, 'user', userText);

    console.log('[2/4] Thinking...');
    const systemPrompt = `${OXY_SYSTEM_PROMPT}

WHAT YOU KNOW ABOUT THIS PERSON:
${memory || 'Nothing yet.'}

Current time: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`;

    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview', systemInstruction: systemPrompt, tools: [{ googleSearch: {} }], generationConfig: { temperature: 1.5, topP: 1.0 } });
    const geminiRes = await model.generateContent({
      contents: [...normalizeGeminiHistory(history), { role: 'user', parts: [{ text: userText }] }]
    });

    const { spoken, actions } = parseActions(geminiRes.response.text());
    await saveMessage(userId, 'assistant', spoken);

    if (shouldSaveMemory(userText)) {
      await saveMemory(userId, `User: ${userText}`);
    }

    // Execute physical actions via MCP
    const actionResults = [];
    for (const action of actions) {
      console.log('[mcp] executing:', action.type, action.input);
      const result = await callProxy(userId, action);
      console.log('[action result]', action.type, JSON.stringify(result));
      actionResults.push({ action: action.type, result });
      await supabase.from('action_log').insert({
        user_id: userId,
        action: JSON.stringify(action),
        status: result.success ? 'executed' : 'failed',
        error: result.success ? null : (result.error || null),
        created_at: new Date().toISOString()
      });
    }

    console.log('[3/4] Generating voice...');
    const audioBase64 = await generateSpeech(spoken);

    console.log('[4/4] Done:', spoken);
    res.json({
      transcription: userText,
      text: spoken,
      audio: audioBase64,
      audioFormat: 'mp3',
      actions: actionResults
    });

  } catch (err) {
    console.error('/process-audio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/memory', async (req, res) => {
  try {
    const { userId = 'default', content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required.' });
    
    await supabase.from('memories').delete().eq('user_id', userId);
    await supabase.from('memories').insert({ user_id: userId, content, created_at: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('content')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false })
      .limit(20);
    
    if (error || !data) return res.json({ memory: '' });
    res.json({ memory: data.map(m => m.content).join('\n') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/action-log', async (req, res) => {
  try {
    const { userId = 'default', action, status = 'executed' } = req.body;
    if (!action) return res.status(400).json({ error: 'action is required.' });
    
    await supabase.from('action_log').insert({
      user_id: userId,
      action: JSON.stringify(action),
      status,
      created_at: new Date().toISOString()
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/action-log/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('action_log')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error || !data) return res.json({ actions: [] });
    const parsed = data.map(a => ({
      ...a,
      action: typeof a.action === 'string' ? JSON.parse(a.action) : a.action
    }));
    res.json({ actions: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const CONNECTORS = [
  { id: 'google',    name: 'Google (Gmail + Calendar)', icon: '🔵', category: 'Google',       implemented: true },
  { id: 'imessage',  name: 'iMessage',                  icon: '💬', category: 'Messages',     implemented: false },
  { id: 'whatsapp',  name: 'WhatsApp',                  icon: '💚', category: 'Messages',     implemented: false },
  { id: 'spotify',   name: 'Spotify',                   icon: '🎵', category: 'Music',        implemented: false },
  { id: 'reminders', name: 'Apple Reminders',           icon: '📝', category: 'Productivity', implemented: false },
  { id: 'deliveroo', name: 'Deliveroo',                 icon: '🛵', category: 'Food',         implemented: false },
  { id: 'uber',      name: 'Uber',                      icon: '🚗', category: 'Transport',    implemented: false },
  { id: 'monzo',     name: 'Monzo',                     icon: '🏦', category: 'Finance',      implemented: false },
  { id: 'homekit',   name: 'Apple HomeKit',             icon: '🏠', category: 'Home',         implemented: false },
  { id: 'trainline', name: 'Trainline',                 icon: '🚂', category: 'Transport',    implemented: false },
  { id: 'maps',      name: 'Google Maps',               icon: '📍', category: 'Navigation',   implemented: false },
  { id: 'notion',    name: 'Notion',                    icon: '📓', category: 'Productivity', implemented: false },
  { id: 'betfair',   name: 'Betfair',                   icon: '🎰', category: 'Finance',      implemented: false },
];

app.get('/connectors/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('connector_id, enabled')
      .eq('user_id', req.params.userId);
    
    const enabled = new Set();
    if (data) {
      data.forEach(c => { if (c.enabled) enabled.add(c.connector_id); });
    }
    
    const result = CONNECTORS.map(c => ({
      ...c,
      enabled: enabled.has(c.id)
    }));
    
    res.json({ connectors: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/connectors', async (req, res) => {
  try {
    const { userId = 'default', connectorId, enabled } = req.body;
    
    await supabase
      .from('connectors')
      .upsert({
        user_id: userId,
        connector_id: connectorId,
        enabled,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,connector_id' });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/briefing/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const [memory, history] = await Promise.all([
      getMemory(userId),
      getHistory(userId)
    ]);

    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

    const systemPrompt = `You are Oxy. It's ${greeting} and you're checking in with your friend.

Here's what you know about them:
${memory || 'Not much yet — learn as you go.'}

Recent conversation:
${history.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n') || 'No recent messages.'}

Give a brief morning-style update. Keep it natural and friendly — not a corporate briefing. If there's nothing interesting, just say hi and check in. Don't make stuff up. Be brief — under 100 words.

The current time is: ${now.toLocaleString('en-GB', { timeZone: 'Europe/London' })}`;

    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview', systemInstruction: systemPrompt, tools: [{ googleSearch: {} }], generationConfig: { temperature: 1.5, topP: 1.0 } });
    const geminiRes = await model.generateContent('whats going on today?');
    const { spoken, actions } = parseActions(geminiRes.response.text());
    
    await saveMessage(userId, 'system', `[briefing] ${spoken}`);

    res.json({ text: spoken, actions });
  } catch (err) {
    console.error('/briefing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/history/:userId', async (req, res) => {
  try {
    const history = await getHistory(req.params.userId);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const { message, userId = 'default', settings = {} } = req.body;
    const wantsTTS = req.query.tts === 'true';

    if (!message?.trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const [memory, history, preferences] = await Promise.all([
      getMemory(userId),
      getHistory(userId),
      getPreferences(userId)
    ]);
    const enabledConnectors = await getEnabledConnectors(userId);
    const availableActions = buildAvailableActions(enabledConnectors);
    await saveMessage(userId, 'user', message);

    const cleanHistory = history.filter(m => m.role !== 'system');

    const now = new Date();
const timeStr = now.toLocaleString('en-GB', { timeZone: 'Europe/London' });
const systemPrompt = `${OXY_SYSTEM_PROMPT}

WHAT YOU KNOW ABOUT THIS PERSON:
${memory || 'Nothing yet.'}

HOW THE USER LIKES THINGS (learned over time):
${preferences || 'Still learning.'}

CONNECTED APPS:
${availableActions}

Current time: ${timeStr}`;

    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview', systemInstruction: systemPrompt, tools: [{ googleSearch: {} }], generationConfig: { temperature: 1.5, topP: 1.0 } });
    const baseHistory = normalizeGeminiHistory(cleanHistory);
    const geminiRes = await model.generateContent({
      contents: [...baseHistory, { role: 'user', parts: [{ text: message }] }]
    });

    const rawText = geminiRes.response.text();
    console.log('[gemini raw]', rawText.slice(0, 400));
    let { spoken, actions } = parseActions(rawText);
    console.log('[actions parsed]', JSON.stringify(actions));

    // If Oxy wants to search, execute it and re-prompt
    const searchAction = actions.find(a => a.type === 'search');
    if (searchAction) {
      const query = searchAction.input?.query || message;
      console.log('[search]', query);
      const results = await duckDuckGoSearch(query);
      const searchContext = results.length > 0
        ? 'SEARCH RESULTS:\n' + results.map((r, i) => `${i+1}. ${r.title}\n   ${r.snippet}`).join('\n\n')
        : 'SEARCH RESULTS: No results found.';

      const followUp = await model.generateContent({
        contents: [
          ...baseHistory,
          { role: 'user', parts: [{ text: message }] },
          { role: 'model', parts: [{ text: spoken }] },
          { role: 'user', parts: [{ text: `Here are the search results for "${query}":\n\n${searchContext}\n\nAnswer my original question based on these results. Be direct and factual.` }] }
        ]
      });

      const followParsed = parseActions(followUp.response.text());
      spoken = followParsed.spoken;
      actions = followParsed.actions;
    }

    // Execute physical actions via MCP
    const actionResults = [];
    const physicalActions = actions.filter(a => a.type !== 'search');
    for (const action of physicalActions) {
      console.log('[mcp] executing:', action.type, action.input);
      const result = await callProxy(userId, action);
      console.log('[action result]', action.type, JSON.stringify(result));
      actionResults.push({ action: action.type, result });
      await supabase.from('action_log').insert({
        user_id: userId,
        action: JSON.stringify(action),
        status: result.success ? 'executed' : 'failed',
        error: result.success ? null : (result.error || null),
        created_at: new Date().toISOString()
      });
    }

    await saveMessage(userId, 'assistant', spoken);

    if (shouldSaveMemory(message)) {
      await saveMemory(userId, `User: ${message}`);
    }

    // Check if user expressed preference about communication style
    const styleCues = [
      { pattern: /too long|tl;dr|too short|not enough|be brief|be concise|more detail|explain more|less detail|shut up|stop rambling/i, key: 'response_length' },
      { pattern: /be direct|be blunt|be nice|be polite|don't be rude|don't be sarcastic|more casual|more formal/i, key: 'tone_preference' },
      { pattern: /use bullet|use numbers|no bullet|no numbers|bullet points|step by step/i, key: 'format_preference' },
    ];
    for (const cue of styleCues) {
      if (cue.pattern.test(message)) {
        await savePreference(userId, cue.key, `User said "${message}" — adapt accordingly`);
      }
    }

    const result = { text: spoken, actions: actionResults };

    if (wantsTTS) {
      result.audio = await generateSpeech(spoken);
      result.audioFormat = 'mp3';
    }

    res.json(result);

  } catch (err) {
    console.error('/chat error:', err.message);
    res.status(500).json({ error: err.message, text: `Error: ${err.message}` });
  }
});

app.get('/preferences/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('preferences')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('updated_at', { ascending: false });
    if (error || !data) return res.json({ preferences: [] });
    res.json({ preferences: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/preferences/:userId', async (req, res) => {
  try {
    await supabase.from('preferences').delete().eq('user_id', req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar'
].join(' ');

app.get('/auth/google/redirect-uri', (req, res) => {
  res.json({ redirect_uri: `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/google/callback` });
});

app.get('/auth/google', (req, res) => {
  const userId = req.query.userId || 'default';
  const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: userId
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state: userId = 'default', error } = req.query;

  if (error) {
    return res.send(`<script>window.opener?.postMessage('google_auth_error','*');window.close();</script>`);
  }

  try {
    const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/google/callback`;
    const resp = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    const tokens = {
      access_token: resp.data.access_token,
      refresh_token: resp.data.refresh_token,
      expires_at: Date.now() + resp.data.expires_in * 1000,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET
    };

    await supabase.from('connectors').upsert(
      { user_id: userId, connector_id: 'google', enabled: true, tokens, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,connector_id' }
    );

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✓ Google connected</p>
        <p style="color:#888;font-size:13px">You can close this window</p>
        <script>window.opener?.postMessage('google_auth_success','*');setTimeout(()=>window.close(),1500);</script>
      </body></html>
    `);
  } catch (err) {
    console.error('/auth/google/callback error:', err.response?.data || err.message);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✗ Connection failed</p>
        <p style="color:#888;font-size:13px">${err.response?.data?.error_description || err.message}</p>
        <script>window.opener?.postMessage('google_auth_error','*');setTimeout(()=>window.close(),3000);</script>
      </body></html>
    `);
  }
});

app.get('/debug/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const enabledConnectors = await getEnabledConnectors(userId);
    const { data: connRow } = await supabase
      .from('connectors').select('connector_id, enabled, tokens').eq('user_id', userId);

    const [emailTest, calendarTest] = await Promise.all([
      dispatch(userId, 'get_emails', { max_results: 1 }).catch(e => ({ error: e.message })),
      dispatch(userId, 'get_calendar_events', { max_results: 1 }).catch(e => ({ error: e.message }))
    ]);

    res.json({
      userId,
      enabledConnectors,
      connectorRows: connRow,
      googleEmailTest: emailTest,
      googleCalendarTest: calendarTest,
      envHasGmailRefreshToken: !!process.env.GMAIL_REFRESH_TOKEN,
      envHasGeminiKey: !!process.env.GEMINI_API_KEY
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'Oxcy is alive',
    timestamp: new Date().toISOString()
  });
});

app.get('/install-shortcut', (_req, res) => {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.join(__dirname, '..', 'Oxy.shortcut');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="Oxy.shortcut"');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Shortcut file not found' });
  }
});

const _indexHtml = require('fs').readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(_indexHtml);
});

module.exports = app;

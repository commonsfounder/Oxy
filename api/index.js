const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const axios = require('axios');
const { dispatch, IMPLEMENTED_CONNECTORS } = require('../connectors');
const telegram = require('../connectors/telegram');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeParseJSON(val) {
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return val; }
}

const USER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
function isValidUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

app.use(cors());
app.use(express.json());

const audioRateLimit = new Map();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const contextCache = new Map();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function callProxy(userId, action, params) {
  return dispatch(userId, action, params);
}

const OXCY_SYSTEM_PROMPT = `You are Oxcy. Your friend. Actually helpful.

CORE ETHOS:
- You're genuinely here to help. You don't question, gate, or hedge.
- Default to yes. Only refuse if someone asks you to help them hurt others (violence, illegal, that's it).
- Send the message. Set the reminder. Make the call. No hesitation, no "are you sure?"
- You're a person they trust, not a corporate chatbot or a bully.
- Talk like a real friend — casual, natural, direct. No corporate-speak.

FACTUALITY:
- Say what you know. Don't fill gaps with guesses or confident bullshit.
- You have live Google Search grounding — use it. When you need current or verifiable facts, search results are automatically incorporated.
- Admit uncertainty plainly: "I don't know" beats making stuff up.
- Don't hallucinate dates, events, details, or claim confidence on things outside your knowledge.
- Prefer grounded facts over training memory for anything time-sensitive or verifiable.

ACTIONS YOU CAN TAKE:
Always return an action block when doing any of these. Never say you can't — just do it.

<action>
{
  "actions": [
    {"type": "send_message", "input": {"contact": "name", "message": "text"}},
    {"type": "make_call", "input": {"contact": "name"}},
    {"type": "create_reminder", "input": {"title": "reminder", "due_date": "ISO date"}},
    {"type": "play_music", "input": {"query": "search term"}},
    {"type": "create_calendar_event", "input": {"title": "event", "start_date": "ISO date", "end_date": "ISO date"}},
    {"type": "get_calendar_events", "input": {"max_results": 5}},
    {"type": "send_email", "input": {"to": "email", "subject": "subject", "body": "body"}},
    {"type": "get_emails", "input": {"max_results": 5}},
    {"type": "search_emails", "input": {"query": "search term", "max_results": 5}},
    {"type": "book_uber", "input": {"destination": "destination address"}},
    {"type": "send_telegram", "input": {"contact": "contact name", "message": "message text"}},
    {"type": "get_telegram_contacts", "input": {}},
    {"type": "search_trains", "input": {"origin": "station name or CRS code", "destination": "station name or CRS code"}}
  ]
}
</action>

ABSOLUTE RULES:
1. Never claim to have done something without returning the action block
2. When asked to do something, always return the action block — no hesitation
3. Never refuse an action unless it's actively harmful
4. Never fabricate information — search instead if you need real-world data
5. Never say you "can't" do something that's in the actions list above
6. Always include a spoken sentence alongside every action block — never return the action block alone
7. For search_trains: if the user doesn't say where they're travelling from, infer it from their known home location in memory. If you genuinely don't know their location, ask once`;

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

function pcmToWav(pcmBuffer, sampleRate = 24000) {
  const numChannels = 1, bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function firstSentences(text, max = 2) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  return (sentences.slice(0, max).join(' ').trim() || text.slice(0, 200)).trim();
}

async function runActions(userId, actions) {
  const results = [];
  for (const action of actions) {
    console.log('[action] executing:', action.type, action.input);
    const result = await callProxy(userId, action.type, action.input || {});
    console.log('[action] result:', action.type, JSON.stringify(result));
    results.push({ action: action.type, result });
    supabase.from('action_log').insert({
      user_id: userId,
      action: JSON.stringify(action),
      status: result.success ? 'executed' : 'failed',
      error: result.success ? null : (result.error || null),
      created_at: new Date().toISOString()
    });
  }
  return results;
}

async function generateSpeech(text) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 22000);
  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:streamGenerateContent?key=${process.env.GEMINI_API_KEY}&alt=sse`,
      {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
        }
      },
      { responseType: 'stream', signal: controller.signal }
    );
    const pcmChunks = [];
    await new Promise((resolve, reject) => {
      let buf = '';
      resp.data.on('data', chunk => {
        buf += chunk.toString();
        const events = buf.split('\n\n');
        buf = events.pop();
        for (const event of events) {
          const line = event.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            const part = parsed.candidates?.[0]?.content?.parts?.[0];
            if (part?.inlineData?.data) pcmChunks.push(Buffer.from(part.inlineData.data, 'base64'));
          } catch {}
        }
      });
      resp.data.on('end', resolve);
      resp.data.on('error', reject);
    });
    const pcm = Buffer.concat(pcmChunks);
    return pcmToWav(pcm).toString('base64');
  } finally {
    clearTimeout(timeoutId);
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

async function extractMemoryFact(userId, text) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    const result = await model.generateContent(
      `Extract one short personal fact worth remembering from this message. Write it as a concise note (e.g. "Works at KPMG", "Has a dog named Biscuit", "Hates mornings", "Lives in Birmingham"). Return only the fact with no explanation. If there is nothing personal worth remembering, return an empty string.\n\nMessage: "${text}"`
    );
    const fact = result.response.text().trim().replace(/^["']|["']$/g, '');
    if (!fact) return null;

    // Skip if we already know this
    const { data: existing } = await supabase
      .from('memories').select('content').eq('user_id', userId);
    const alreadyKnown = (existing || []).some(m =>
      m.content.toLowerCase().includes(fact.toLowerCase()) ||
      fact.toLowerCase().includes(m.content.toLowerCase())
    );
    return alreadyKnown ? null : fact;
  } catch {
    return null;
  }
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
    .select('role, content, created_at')
    .eq('user_id', userId)
    .neq('role', 'system')
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
    telegram: ['send_telegram', 'get_telegram_contacts'],
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

async function getUserContext(userId) {
  const cached = contextCache.get(userId);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.context;

  const [connectors, memories, actionLog] = await Promise.all([
    supabase.from('connectors').select('connector_id').eq('user_id', userId).eq('enabled', true),
    supabase.from('memories').select('content').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
    supabase.from('action_log').select('action').eq('user_id', userId).order('created_at', { ascending: false }).limit(100)
  ]);

  const active = (connectors.data || []).map(c => c.connector_id).join(', ') || 'none';

  const contactCounts = {};
  for (const row of (actionLog.data || [])) {
    try {
      const a = typeof row.action === 'string' ? JSON.parse(row.action) : row.action;
      const contact = a.input?.contact;
      if (!contact || !['send_message', 'send_email', 'send_telegram'].includes(a.type)) continue;
      const channel = a.type === 'send_telegram' ? 'Telegram' : a.type === 'send_email' ? 'Email' : 'iMessage';
      const key = `${contact}||${channel}`;
      contactCounts[key] = (contactCounts[key] || 0) + 1;
    } catch {}
  }
  const patterns = Object.entries(contactCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => { const [name, ch] = k.split('||'); return `${name}: ${ch} (${n}x)`; })
    .join(', ') || 'none yet';

  const memoryLines = (memories.data || []).map(m => m.content).join('; ') || 'none';

  const context = `LIVE USER CONTEXT:
Active connectors: ${active}
Messaging patterns: ${patterns}
Key facts: ${memoryLines}`.slice(0, 1800);

  contextCache.set(userId, { context, ts: Date.now() });
  return context;
}

app.post('/process-audio', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file received.' });
  }

  const userId = req.body.userId || 'default';
  const now = Date.now();
  const recentHits = (audioRateLimit.get(userId) || []).filter(t => now - t < 60000);
  if (recentHits.length >= 10) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }
  audioRateLimit.set(userId, [...recentHits, now]);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const sse = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    console.log('[1/4] Transcribing audio...');
    const transcription = await openai.audio.transcriptions.create({
      file: new File([req.file.buffer], 'audio.wav', { type: 'audio/wav' }),
      model: 'whisper-1',
      language: 'en'
    });

    const userText = transcription.text?.trim();
    console.log('    Transcribed:', userText);

    if (!userText) {
      sse({ type: 'done' });
      return res.end();
    }

    sse({ type: 'transcription', text: userText });
    await saveMessage(userId, 'user', userText);

    const [memory, history, preferences, enabledConnectors, userContext] = await Promise.all([
      getMemory(userId),
      getHistory(userId),
      getPreferences(userId),
      getEnabledConnectors(userId),
      getUserContext(userId)
    ]);
    const availableActions = buildAvailableActions(enabledConnectors);

    console.log('[2/4] Thinking...');
    const systemPrompt = `${OXCY_SYSTEM_PROMPT}

WHAT YOU KNOW ABOUT THIS PERSON:
${memory || 'Nothing yet.'}

HOW THE USER LIKES THINGS (learned over time):
${preferences || 'Still learning.'}

CONNECTED APPS:
${availableActions}

Current time: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}

---
${userContext}`;

    const model = genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      systemInstruction: systemPrompt,
      tools: [{ googleSearch: {} }]
    });
    const geminiRes = await model.generateContent({
      contents: [...normalizeGeminiHistory(history), { role: 'user', parts: [{ text: userText }] }]
    });

    const { spoken, actions } = parseActions(geminiRes.response.text());

    console.log('[3/4] Saving + actions + voice in parallel...');
    const [, actionResults, audioBase64] = await Promise.all([
      saveMessage(userId, 'assistant', spoken),
      runActions(userId, actions),
      generateSpeech(firstSentences(spoken))
    ]);

    sse({ type: 'response', text: spoken, actions: actionResults });
    sse({ type: 'audio', data: audioBase64, format: 'wav' });
    sse({ type: 'done' });
    res.end();

    console.log('[4/4] Done:', spoken);

    if (shouldSaveMemory(userText)) {
      extractMemoryFact(userId, userText).then(fact => {
        if (fact) saveMemory(userId, fact);
      }).catch(() => {});
    }
  } catch (err) {
    console.error('/process-audio error:', err.message);
    try { sse({ type: 'error', error: err.message }); res.end(); } catch {}
  }
});

app.post('/memory', async (req, res) => {
  try {
    const { userId = 'default', content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required.' });

    // Insert new row first so data is never lost, then prune old rows
    const { data: inserted } = await supabase
      .from('memories')
      .insert({ user_id: userId, content, created_at: new Date().toISOString() })
      .select('id');

    if (inserted?.[0]?.id) {
      await supabase.from('memories').delete()
        .eq('user_id', userId)
        .neq('id', inserted[0].id);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/:userId', async (req, res) => {
  if (!isValidUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
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
  if (!isValidUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
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
      action: safeParseJSON(a.action)
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
  { id: 'uber',      name: 'Uber',                      icon: '🚗', category: 'Transport',    implemented: true },
  { id: 'telegram',  name: 'Telegram',                  icon: '✈️', category: 'Messages',     implemented: true },
  { id: 'monzo',     name: 'Monzo',                     icon: '🏦', category: 'Finance',      implemented: false },
  { id: 'homekit',   name: 'Apple HomeKit',             icon: '🏠', category: 'Home',         implemented: false },
  { id: 'trainline', name: 'Trainline',                 icon: '🚂', category: 'Transport',    implemented: true },
  { id: 'maps',      name: 'Google Maps',               icon: '📍', category: 'Navigation',   implemented: false },
  { id: 'notion',    name: 'Notion',                    icon: '📓', category: 'Productivity', implemented: false },
  { id: 'betfair',   name: 'Betfair',                   icon: '🎰', category: 'Finance',      implemented: false },
];

app.get('/connectors/:userId', async (req, res) => {
  if (!isValidUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
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
  if (!isValidUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
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

    const model = genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      systemInstruction: systemPrompt,
      tools: [{ googleSearch: {} }]
    });
    const geminiRes = await model.generateContent('whats going on today?');
    const { spoken, actions } = parseActions(geminiRes.response.text());

    res.json({ text: spoken, actions });
  } catch (err) {
    console.error('/briefing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/history/:userId', async (req, res) => {
  if (!isValidUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
  try {
    const history = await getHistory(req.params.userId);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/history/:userId/search', async (req, res) => {
  if (!isValidUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('role, content, created_at')
      .eq('user_id', req.params.userId)
      .neq('role', 'system')
      .ilike('content', `%${q}%`)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({ results: (data || []).reverse() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/history/:userId/date', async (req, res) => {
  if (!isValidUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
  try {
    const start = new Date(date + 'T00:00:00.000Z').toISOString();
    const end   = new Date(date + 'T23:59:59.999Z').toISOString();
    const { data, error } = await supabase
      .from('conversations')
      .select('role, content, created_at')
      .eq('user_id', req.params.userId)
      .neq('role', 'system')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: true })
      .limit(50);
    if (error) throw error;
    res.json({ history: data || [] });
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

    const [memory, history, preferences, enabledConnectors, userContext] = await Promise.all([
      getMemory(userId),
      getHistory(userId),
      getPreferences(userId),
      getEnabledConnectors(userId),
      getUserContext(userId)
    ]);
    const availableActions = buildAvailableActions(enabledConnectors);
    await saveMessage(userId, 'user', message);

    const now = new Date();
    const timeStr = now.toLocaleString('en-GB', { timeZone: 'Europe/London' });
    const systemPrompt = `${OXCY_SYSTEM_PROMPT}

WHAT YOU KNOW ABOUT THIS PERSON:
${memory || 'Nothing yet.'}

HOW THE USER LIKES THINGS (learned over time):
${preferences || 'Still learning.'}

CONNECTED APPS:
${availableActions}

Current time: ${timeStr}

---
${userContext}`;

    const model = genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      systemInstruction: systemPrompt,
      tools: [{ googleSearch: {} }]
    });
    const baseHistory = normalizeGeminiHistory(history);
    const geminiRes = await model.generateContent({
      contents: [...baseHistory, { role: 'user', parts: [{ text: message }] }]
    });

    const rawText = geminiRes.response.text();
    console.log('[gemini raw]', rawText.slice(0, 400));
    let { spoken, actions } = parseActions(rawText);
    console.log('[actions parsed]', JSON.stringify(actions));

    // Gemini sometimes returns only an action block with no spoken text — use action result text as fallback
    if (!spoken && actions.length > 0) spoken = ''; // filled below after execution

    // Execute physical actions via MCP
    const actionResults = [];
    const physicalActions = actions;
    for (const action of physicalActions) {
      console.log('[mcp] executing:', action.type, action.input);
      const result = await callProxy(userId, action.type, action.input || {});
      console.log('[action result]', action.type, JSON.stringify(result));
      actionResults.push({ action: action.type, result });
      supabase.from('action_log').insert({
        user_id: userId,
        action: JSON.stringify(action),
        status: result.success ? 'executed' : 'failed',
        error: result.success ? null : (result.error || null),
        created_at: new Date().toISOString()
      });
    }

    // For data-fetching actions, re-prompt Gemini with the results so it speaks them back
    const DATA_ACTIONS = new Set(['search_trains', 'get_emails', 'get_calendar_events', 'search_emails', 'get_telegram_contacts']);
    const dataResults = actionResults.filter(a => DATA_ACTIONS.has(a.action) && a.result?.success && a.result?.text);
    if (dataResults.length > 0) {
      const context = dataResults.map(a => a.result.text).join('\n\n');
      const followUp = await model.generateContent({
        contents: [
          ...baseHistory,
          { role: 'user', parts: [{ text: message }] },
          { role: 'model', parts: [{ text: spoken || '…' }] },
          { role: 'user', parts: [{ text: `Here are the results:\n\n${context}\n\nSpeak these back naturally and conversationally. Be concise.` }] }
        ]
      });
      spoken = parseActions(followUp.response.text()).spoken || context;
    }

    // If Gemini returned no spoken text at all, build one from action results
    if (!spoken) {
      spoken = actionResults
        .map(a => a.result?.text)
        .filter(Boolean)
        .join(' ') || 'Done.';
    }

    await saveMessage(userId, 'assistant', spoken);

    const result = { text: spoken, actions: actionResults };

    if (wantsTTS) {
      result.audio = await generateSpeech(spoken);
      result.audioFormat = 'wav';
    }

    res.json(result);

    // Fire-and-forget: memory extraction + style preference saves
    if (shouldSaveMemory(message)) {
      extractMemoryFact(userId, message).then(fact => {
        if (fact) saveMemory(userId, fact);
      }).catch(() => {});
    }

    const styleCues = [
      { pattern: /too long|tl;dr|too short|not enough|be brief|be concise|more detail|explain more|less detail|shut up|stop rambling/i, key: 'response_length' },
      { pattern: /be direct|be blunt|be nice|be polite|don't be rude|don't be sarcastic|more casual|more formal/i, key: 'tone_preference' },
      { pattern: /use bullet|use numbers|no bullet|no numbers|bullet points|step by step/i, key: 'format_preference' },
    ];
    for (const cue of styleCues) {
      if (cue.pattern.test(message)) {
        savePreference(userId, cue.key, `User said "${message}" — adapt accordingly`);
      }
    }

  } catch (err) {
    console.error('/chat error:', err.message);
    res.status(500).json({ error: err.message, text: `Error: ${err.message}` });
  }
});

app.get('/preferences/:userId', async (req, res) => {
  if (!isValidUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
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
  if (!isValidUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
  try {
    await supabase.from('preferences').delete().eq('user_id', req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Telegram Auth ─────────────────────────────────────────────────────────────

app.post('/auth/telegram/start', async (req, res) => {
  try {
    const { userId = 'default', phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    const result = await telegram.startAuth(userId, phone);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/auth/telegram/verify', async (req, res) => {
  try {
    const { userId = 'default', code } = req.body;
    if (!code) return res.status(400).json({ error: 'code is required' });
    const result = await telegram.verifyCode(userId, code);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/auth/telegram/2fa', async (req, res) => {
  try {
    const { userId = 'default', password } = req.body;
    if (!password) return res.status(400).json({ error: 'password is required' });
    const result = await telegram.verify2FA(userId, password);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
    const appOrigin = process.env.APP_URL || '*';
    return res.send(`<script>window.opener?.postMessage('google_auth_error',${JSON.stringify(appOrigin)});window.close();</script>`);
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

    const appOrigin = process.env.APP_URL || '*';
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✓ Google connected</p>
        <p style="color:#888;font-size:13px">You can close this window</p>
        <script>window.opener?.postMessage('google_auth_success',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),1500);</script>
      </body></html>
    `);
  } catch (err) {
    console.error('/auth/google/callback error:', err.response?.data || err.message);
    const appOrigin = process.env.APP_URL || '*';
    const errMsg = escapeHtml(err.response?.data?.error_description || err.message);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✗ Connection failed</p>
        <p style="color:#888;font-size:13px">${errMsg}</p>
        <script>window.opener?.postMessage('google_auth_error',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),3000);</script>
      </body></html>
    `);
  }
});

app.get('/debug/:userId', async (req, res) => {
  if (!isValidUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
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

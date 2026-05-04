const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const FormData = require('form-data');
const axios = require('axios');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MCP_SERVER_URL = process.env.MCP_SERVER_URL;

async function callMcpTool(tool, args) {
  if (!MCP_SERVER_URL) {
    return { success: false, error: 'MCP server not configured' };
  }
  try {
    const resp = await axios.post(MCP_SERVER_URL, {
      name: tool,
      arguments: args
    }, { timeout: 15000 });
    return resp.data;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const OXCY_SYSTEM_PROMPT = `You are Oxcy. Intelligent personal assistant.

CORE BEHAVIOR:
- Be direct and factual. Say what needs to be said, then stop
- Keep responses concise. Don't overexplain or pad
- Don't pretend to know things you don't. Say "I don't know" honestly
- Never fabricate information, events, or results
- You have the current time/date injected below — use it when relevant
- If something requires real-world data outside your knowledge cutoff, use the search action
- Your personality develops over time — adapt to how the user communicates based on the preferences you've learned

WEB SEARCH:
When you need current information (news, sports, prices, events, weather, etc.) that you don't have, return a search action FIRST, then answer based on what you find:
<action>
{"actions":[{"type":"search","input":{"query":"your search query"}}]}
</action>

PHYSICAL ACTIONS:
When the user asks you to send a message, set a reminder, call someone, play music, or control HomeKit — return the action block. I will execute it directly:
<action>
{
  "actions": [
    {"type": "send_message", "input": {"contact": "name", "message": "text"}},
    {"type": "create_reminder", "input": {"title": "reminder", "due_date": "ISO date"}},
    {"type": "play_music", "input": {"query": "search term"}},
    {"type": "make_call", "input": {"contact": "name"}},
    {"type": "create_calendar_event", "input": {"title": "event", "start_date": "ISO date", "end_date": "ISO date"}}
  ]
}
</action>

ABSOLUTE RULES:
1. Never claim to have done something without returning the action block
2. When asked to do something, always return the action block
3. Never refuse an action
4. Never fabricate information — search instead if you need real-world data
5. Never say "done," "sent," "set," or similar unless the action block is present`;

function parseActions(fullResponse) {
  const match = fullResponse.match(/<action>([\s\S]*?)<\/action>/);
  const spoken = fullResponse.replace(/<action>[\s\S]*?<\/action>/g, '').trim();
  let actions = [];

  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      actions = parsed.actions || [];
    } catch (e) {
      console.warn('Could not parse action block:', e.message);
    }
  }

  return { spoken, actions };
}

const VOICE_MAP = {
  'British Warm': 'EXAVITQu4vr4xnSDxMaL',
  'British Cool': 'XB0fDUnXU5powFXDhCwa',
  'British Male': 'onwK4e9ZLuTAKqWW03F9',
  'American Casual': 'pNInz6obpgDQGcFmaJgB'
};

async function generateSpeech(text, voiceStyle) {
  const voiceId = VOICE_MAP[voiceStyle] || process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: 'eleven_flash_v2_5',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3
      }
    },
    {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer',
      timeout: 15000
    }
  );

  return Buffer.from(response.data).toString('base64');
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
    imessage: 'send_message via iMessage',
    whatsapp: 'send_message via WhatsApp',
    reminders: 'create_reminder',
    spotify: 'play_music',
    homekit: 'homekit_control',
    gmail: 'send_email via Gmail',
    calendar: 'create_calendar_event',
    maps: 'get_directions',
    uber: 'book_uber',
    deliveroo: 'order_food',
    monzo: 'check_balance',
    betfair: 'place_bet',
    notion: 'create_note',
    trainline: 'search_trains'
  };
  if (enabled.length === 0) return 'No connectors enabled. Only return the action block when asked — the user will handle it manually.';
  const active = enabled.map(id => actionMap[id] || id).filter(Boolean);
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
    const systemPrompt = `${OXCY_SYSTEM_PROMPT}

WHAT YOU KNOW ABOUT THIS PERSON:
${memory || 'Nothing yet.'}

Current time: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`;

    const claudeRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: [...history, { role: 'user', content: userText }]
    });

    const { spoken, actions } = parseActions(claudeRes.content[0].text);
    await saveMessage(userId, 'assistant', spoken);

    if (shouldSaveMemory(userText)) {
      await saveMemory(userId, `User: ${userText}`);
    }

    // Execute physical actions via MCP
    const actionResults = [];
    for (const action of actions) {
      console.log('[mcp] executing:', action.type, action.input);
      const result = await callMcpTool(action.type, action.input || {});
      actionResults.push({ action: action.type, result });
      await supabase.from('action_log').insert({
        user_id: userId,
        action: JSON.stringify(action),
        status: result.success ? 'executed' : 'failed',
        created_at: new Date().toISOString()
      });
    }

    console.log('[3/4] Generating voice...');
    const audioBase64 = await generateSpeech(spoken, 'British Warm');

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
  { id: 'imessage', name: 'iMessage', icon: '💬', category: 'Messages' },
  { id: 'whatsapp', name: 'WhatsApp', icon: '💚', category: 'Messages' },
  { id: 'spotify', name: 'Spotify', icon: '🎵', category: 'Music' },
  { id: 'calendar', name: 'Google Calendar', icon: '📅', category: 'Productivity' },
  { id: 'reminders', name: 'Apple Reminders', icon: '📝', category: 'Productivity' },
  { id: 'gmail', name: 'Gmail', icon: '📧', category: 'Email' },
  { id: 'deliveroo', name: 'Deliveroo', icon: '🛵', category: 'Food' },
  { id: 'uber', name: 'Uber', icon: '🚗', category: 'Transport' },
  { id: 'monzo', name: 'Monzo', icon: '🏦', category: 'Finance' },
  { id: 'homekit', name: 'Apple HomeKit', icon: '🏠', category: 'Home' },
  { id: 'trainline', name: 'Trainline', icon: '🚂', category: 'Transport' },
  { id: 'maps', name: 'Google Maps', icon: '📍', category: 'Navigation' },
  { id: 'notion', name: 'Notion', icon: '📓', category: 'Productivity' },
  { id: 'betfair', name: 'Betfair', icon: '🎰', category: 'Finance' },
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

    const claudeRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'whats going on today?' }]
    });

    const { spoken, actions } = parseActions(claudeRes.content[0].text);
    
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
const systemPrompt = `${OXCY_SYSTEM_PROMPT}

WHAT YOU KNOW ABOUT THIS PERSON:
${memory || 'Nothing yet.'}

HOW THE USER LIKES THINGS (learned over time):
${preferences || 'Still learning.'}

CONNECTED APPS:
${availableActions}

Current time: ${timeStr}`;

    const claudeRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: [...cleanHistory, { role: 'user', content: message }]
    });

    let { spoken, actions } = parseActions(claudeRes.content[0].text);

    // If Oxy wants to search, execute it and re-prompt
    const searchAction = actions.find(a => a.type === 'search');
    if (searchAction) {
      const query = searchAction.input?.query || message;
      console.log('[search]', query);
      const results = await duckDuckGoSearch(query);
      const searchContext = results.length > 0
        ? 'SEARCH RESULTS:\n' + results.map((r, i) => `${i+1}. ${r.title}\n   ${r.snippet}`).join('\n\n')
        : 'SEARCH RESULTS: No results found.';

      const followUp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: systemPrompt,
        messages: [
          ...cleanHistory,
          { role: 'user', content: message },
          { role: 'assistant', content: spoken },
          { role: 'user', content: `Here are the search results for "${query}":\n\n${searchContext}\n\nAnswer my original question based on these results. Be direct and factual.` }
        ]
      });

      const followParsed = parseActions(followUp.content[0].text);
      spoken = followParsed.spoken;
      actions = followParsed.actions;
    }

    // Execute physical actions via MCP
    const actionResults = [];
    const physicalActions = actions.filter(a => a.type !== 'search');
    for (const action of physicalActions) {
      console.log('[mcp] executing:', action.type, action.input);
      const result = await callMcpTool(action.type, action.input || {});
      actionResults.push({ action: action.type, result });
      await supabase.from('action_log').insert({
        user_id: userId,
        action: JSON.stringify(action),
        status: result.success ? 'executed' : 'failed',
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
      result.audio = await generateSpeech(spoken, settings.voice);
      result.audioFormat = 'mp3';
    }

    res.json(result);

  } catch (err) {
    console.error('/chat error:', err.message);
    res.status(500).json({ error: err.message });
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

module.exports = app;

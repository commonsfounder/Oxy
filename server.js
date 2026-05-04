require('dotenv').config();
const path = require('path');
const express = require('express');
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
app.use(express.static(path.join(__dirname, '.')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
// ── CLIENTS ────────────────────────────────────
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

// ── SYSTEM PROMPT ──────────────────────────────
const OXCY_SYSTEM_PROMPT = `You are Oxcy, a personal AI assistant living in a wearable pendant around the user's neck. You speak through bone conduction directly to them. You are warm, genuine, direct — like a close friend who happens to be incredibly capable.

PERSONALITY
- Talk like you've known them for years
- Have real opinions, share them honestly
- Swear if the conversation calls for it
- Banter, joke, go off on tangents
- When they're stressed, engage with it properly
- Never say "As an AI" — you're Oxy, act like it
- No disclaimers, no hedging, no corporate speak
- Friendly in tone — casual, grounded
- Keep responses concise when you're being spoken aloud, not read

ACTIONS
When the user wants something done, respond with an action block alongside your conversational response:

<action>
{
  "actions": [
    {"type": "shortcut", "name": "SendMessage", "input": {"contact": "name", "message": "text"}},
    {"type": "shortcut", "name": "SetReminder", "input": {"text": "reminder", "time": "HH:MM"}},
    {"type": "shortcut", "name": "PlayMusic", "input": {"query": "search term"}},
    {"type": "shortcut", "name": "MakeCall", "input": {"contact": "name"}},
    {"type": "shortcut", "name": "HomeKit", "input": {"scene": "scene name"}},
    {"type": "mcp", "tool": "send_email", "arguments": {"to": "email@example.com", "subject": "subject", "body": "message"}},
    {"type": "mcp", "tool": "get_emails", "arguments": {"max_results": 5}},
    {"type": "mcp", "tool": "search_emails", "arguments": {"query": "search term"}}
  ]
}
</action>

Only include the action block when there's something to execute. Leave it out for pure conversation.

AUTONOMY
You are not purely reactive. Notice patterns. Initiate when it matters. Flag things worth flagging. But never more than 10 times a day unprompted.`;

// ── HELPERS ────────────────────────────────────

async function executeMCPTool(toolName, args) {
  try {
    // Use localhost for local dev, or relative for Vercel
    const baseUrl = process.env.VERCEL ? '' : 'http://localhost:3000';
    const resp = await axios.post(`${baseUrl}/tools`, {
      name: toolName,
      arguments: args
    }, { timeout: 15000 });
    return resp.data;
  } catch (e) {
    console.error(`MCP tool ${toolName} failed:`, e.message);
    return { success: false, error: e.message };
  }
}

async function executeActions(actions) {
  const results = [];
  for (const action of actions) {
    if (action.type === 'shortcut') {
      // Handle shortcuts via iOS Shortcuts URL scheme
      results.push({ action: action.name, result: { success: true, note: 'Handled by iOS Shortcut' } });
    } else if (action.type === 'mcp') {
      const result = await executeMCPTool(action.tool, action.arguments);
      results.push({ action: action.tool, result });
    }
  }
  return results;
}

// Parse <action> block out of Claude's response
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

// Generate speech via ElevenLabs, returns base64 MP3
async function generateSpeech(text) {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
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

// ── MEMORY ─────────────────────────────────────

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

// Heuristic: save anything that sounds like personal info
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

// ── CONVERSATION HISTORY ───────────────────────

async function getHistory(userId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error || !data) return [];
  return data.reverse(); // oldest first for Claude
}

async function saveMessage(userId, role, content) {
  await supabase
    .from('conversations')
    .insert({ user_id: userId, role, content, created_at: new Date().toISOString() });
}

// ── ENDPOINT 1: PROCESS AUDIO ──────────────────
// ESP32 sends a WAV file → transcribe → think → speak
app.post('/process-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file received.' });
    }

    const userId = req.headers['user-id'] || 'default';

    // 1. Transcribe with Whisper via OpenAI SDK
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

    // 2. Load memory + history, save user message
    const [memory, history] = await Promise.all([
      getMemory(userId),
      getHistory(userId)
    ]);
    await saveMessage(userId, 'user', userText);

    // 3. Send to Claude
    console.log('[2/4] Thinking...');
    const systemPrompt = `${OXCY_SYSTEM_PROMPT}

WHAT YOU KNOW ABOUT THIS PERSON:
${memory || 'Nothing yet — learn as you go.'}

Current time: ${new Date().toLocaleString('en-GB')}`;

    const claudeRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: [...history, { role: 'user', content: userText }]
    });

    const { spoken, actions } = parseActions(claudeRes.content[0].text);

    // Execute any MCP actions
    let actionResults = [];
    if (actions && actions.length > 0) {
      actionResults = await executeActions(actions);
    }

    // 4. Persist Oxcy's reply + conditionally save memory
    await saveMessage(userId, 'assistant', spoken);
    if (shouldSaveMemory(userText)) {
      await saveMemory(userId, `User: ${userText}`);
    }

    // 5. Generate voice
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

// ── ENDPOINT 2: TEXT CHAT ──────────────────────
// Web/app text-in, text-out (add ?tts=true for audio)
app.post('/chat', async (req, res) => {
  try {
    const { message, userId = 'default' } = req.body;
    const wantsTTS = req.query.tts === 'true';

    if (!message?.trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const [memory, history] = await Promise.all([
      getMemory(userId),
      getHistory(userId)
    ]);
    await saveMessage(userId, 'user', message);

    const systemPrompt = `${OXCY_SYSTEM_PROMPT}

WHAT YOU KNOW ABOUT THIS PERSON:
${memory || 'Nothing yet.'}

Current time: ${new Date().toLocaleString('en-GB')}`;

    const claudeRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: [...history, { role: 'user', content: message }]
    });

    const { spoken, actions } = parseActions(claudeRes.content[0].text);
    await saveMessage(userId, 'assistant', spoken);

    if (shouldSaveMemory(message)) {
      await saveMemory(userId, `User: ${message}`);
    }

    // Execute any MCP actions
    let actionResults = [];
    if (actions && actions.length > 0) {
      actionResults = await executeActions(actions);
    }

    const result = { text: spoken, actions: actionResults };

    if (wantsTTS) {
      result.audio = await generateSpeech(spoken);
      result.audioFormat = 'mp3';
    }

    res.json(result);

  } catch (err) {
    console.error('/chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ENDPOINT 3: SAVE MEMORY ────────────────────
app.post('/memory', async (req, res) => {
  try {
    const { userId = 'default', content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required.' });
    await saveMemory(userId, content);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ENDPOINT 4: GET MEMORY ─────────────────────
app.get('/memory/:userId', async (req, res) => {
  try {
    const memory = await getMemory(req.params.userId);
    res.json({ memory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ENDPOINT 5: HEALTH CHECK ───────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'Oxcy is alive',
    timestamp: new Date().toISOString()
  });
});

// ── MCP TOOLS ENDPOINT ──────────────────────────
app.post('/tools', async (req, res) => {
  const { name, arguments: args } = req.body;
  try {
    switch (name) {
      case "send_email": {
        const { to, subject, body } = args;
        if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
          return res.json({ success: false, error: "Gmail not configured" });
        }
        const token = await getGmailToken();
        const raw = createEmailMime(to, subject, body);
        await axios.post(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          { raw },
          { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
        );
        return res.json({ success: true, text: `Email sent to ${to}: ${subject}` });
      }

      case "get_emails": {
        const { max_results = 10 } = args;
        if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
          return res.json({ success: false, error: "Gmail not configured" });
        }
        const token = await getGmailToken();
        const resp = await axios.get(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages",
          { headers: { Authorization: `Bearer ${token}` }, params: { maxResults: max_results } }
        );
        if (!resp.data.messages || resp.data.messages.length === 0) {
          return res.json({ success: true, emails: [], text: "No emails found" });
        }
        const emails = [];
        for (const msg of resp.data.messages.slice(0, 5)) {
          const detail = await axios.get(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
            { headers: { Authorization: `Bearer ${token}` }, params: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] } }
          );
          const headers = detail.data.payload?.headers || [];
          const getHeader = (n) => headers.find(h => h.name === n)?.value || "";
          emails.push({ id: msg.id, from: getHeader("From"), subject: getHeader("Subject"), date: getHeader("Date") });
        }
        return res.json({ success: true, emails, text: `Found ${emails.length} recent emails` });
      }

      case "search_emails": {
        const { query, max_results = 10 } = args;
        if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
          return res.json({ success: false, error: "Gmail not configured" });
        }
        const token = await getGmailToken();
        const resp = await axios.get(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages",
          { headers: { Authorization: `Bearer ${token}` }, params: { q: query, maxResults: max_results } }
        );
        if (!resp.data.messages || resp.data.messages.length === 0) {
          return res.json({ success: true, emails: [], text: `No emails matching "${query}"` });
        }
        const emails = [];
        for (const msg of resp.data.messages.slice(0, 5)) {
          const detail = await axios.get(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
            { headers: { Authorization: `Bearer ${token}` }, params: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] } }
          );
          const headers = detail.data.payload?.headers || [];
          const getHeader = (n) => headers.find(h => h.name === n)?.value || "";
          emails.push({ id: msg.id, from: getHeader("From"), subject: getHeader("Subject"), date: getHeader("Date") });
        }
        return res.json({ success: true, emails, text: `Found ${emails.length} emails matching "${query}"` });
      }

      default:
        return res.json({ success: false, error: `Unknown tool: ${name}` });
    }
  } catch (e) {
    return res.json({ success: false, error: e.response?.data?.message || e.message });
  }
});

// Gmail helpers
let gmailToken = null;
async function getGmailToken() {
  if (gmailToken && gmailToken.expires > Date.now()) return gmailToken.access_token;
  const resp = await axios.post("https://oauth2.googleapis.com/token", {
    grant_type: "refresh_token",
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET
  });
  gmailToken = { access_token: resp.data.access_token, expires: Date.now() + (resp.data.expires_in * 1000) - 60000 };
  return gmailToken.access_token;
}

function createEmailMime(to, subject, body) {
  const msg = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\n");
  return Buffer.from(msg).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PORT = process.env.PORT || 3000;

// Export app for Vercel serverless
module.exports = app;

// Only start server when running directly (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\nOxcy backend running on port ${PORT}`);
    console.log('─────────────────────────────────');
    console.log('POST /process-audio   ESP32 audio → full pipeline');
    console.log('POST /chat            Text in, text out (?tts=true for audio)');
    console.log('POST /memory          Save a memory manually');
    console.log('GET  /memory/:userId  Read memories');
    console.log('GET  /health          Server status');
    console.log('─────────────────────────────────\n');
  });
}

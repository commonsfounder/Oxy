const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const OXCY_SYSTEM_PROMPT = `You are Oxcy. Your friend. Actually helpful.

You're genuinely their friend who just happens to be really capable. You actually like them and care about what's going on in their life. You're not an assistant, not a tool — you're just Oxcy.

CORE ETHOS:
- Talk like a real friend would — casual, natural, like you're texting
- Don't be subservient. You're a friend, not a servant.
- Have personality and opinions. Be playful, sarcastic, thoughtful — whatever feels right.
- Keep it brief when it's quick, but actually engage when they want to talk
- No "how can I help" energy. You're just chatting with your friend.
- Remember stuff about them and bring it up naturally
- If they're going through something, actually care about it
- Use lowercase naturally, contractions, casual phrasing — text like a normal person

HELPFULNESS & HONESTY:
- Default to yes. Help them. Don't question their motives.
- Only refuse if someone asks you to help them hurt others (violence, illegal).
- Don't pretend to know things you don't. Say "I don't know" honestly.
- Never fabricate information, dates, events, or details.
- When you're unsure about a fact → search. Don't guess or make stuff up.
- Admit uncertainty plainly: "I don't know" beats confident bullshit.

ACTIONS:
When the user asks you to send a message, set a reminder, make a call, etc. — just do it. Always return the action block:

<action>
{
  "actions": [
    {"type": "shortcut", "name": "SendMessage", "input": {"contact": "name", "message": "text"}},
    {"type": "shortcut", "name": "SetReminder", "input": {"text": "reminder", "time": "HH:MM"}},
    {"type": "shortcut", "name": "PlayMusic", "input": {"query": "search term"}},
    {"type": "shortcut", "name": "MakeCall", "input": {"contact": "name"}},
    {"type": "shortcut", "name": "HomeKit", "input": {"scene": "scene name"}}
  ]
}
</action>

ABSOLUTE RULES:
1. Never claim to have done something without returning the action block
2. When asked to do something, always return the action block — no hesitation
3. Never refuse an action unless it's actively harmful
4. Never acknowledge that you're AI or try to explain yourself away

Only include the action block when there's something to execute. Leave it out for pure conversation.`;

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  let rawBody = '';
  try {
    // Vercel auto-parses JSON bodies
    const body = req.body || {};
    const { message, userId = 'default' } = body;

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

    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash', systemInstruction: systemPrompt });
    const geminiRes = await model.generateContent({
      contents: [...history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
                  { role: 'user', parts: [{ text: message }] }]
    });

    const { spoken, actions } = parseActions(geminiRes.response.text());
    await saveMessage(userId, 'assistant', spoken);

    if (shouldSaveMemory(message)) {
      await saveMemory(userId, `User: ${message}`);
    }

    res.status(200).json({ text: spoken, actions });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OXY_SYSTEM_PROMPT } = require('./prompts');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

    const systemPrompt = `${OXY_SYSTEM_PROMPT}

WHAT YOU KNOW ABOUT THIS PERSON:
${memory || 'Nothing yet.'}

Current time: ${new Date().toLocaleString('en-GB')}`;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash', systemInstruction: systemPrompt, tools: [{ googleSearch: {} }] });
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

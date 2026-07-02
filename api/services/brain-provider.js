'use strict';
/*
 * Brain provider seam.
 *
 * The main chat brain streams from Gemini today. This wraps that one call so we
 * can A/B a second provider (Groq, OpenAI-compatible) behind a flag WITHOUT
 * touching the consumer: streamBrain() yields chunks shaped exactly like the
 * @google/genai stream ({ text, candidates }), so the `for await` loop in
 * index.js works unchanged regardless of provider.
 *
 * Flagged + default-off, so production is untouched:
 *   OXY_BRAIN_PROVIDER = gemini (default) | groq
 *   OXY_GROQ_MODEL     = e.g. llama-3.3-70b-versatile (capable) or
 *                              llama-3.1-8b-instant (fastest)
 *   GROQ_API_KEY       = required only when provider=groq
 *
 * Caveat: Groq has no Google Search grounding. config.tools (googleSearch) is
 * silently dropped on the Groq path, so search turns are NOT apples-to-apples
 * until a search tool is bolted on separately.
 */

const { GoogleGenAI } = require('@google/genai');

let _gemini = null;
function geminiClient() {
  if (!_gemini) _gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
  return _gemini;
}

function getBrainProvider() {
  return (process.env.OXY_BRAIN_PROVIDER || 'gemini').toLowerCase();
}

// Gemini contents (role/parts) + systemInstruction -> OpenAI-style messages.
function toOpenAIMessages(contents, systemInstruction) {
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  for (const c of contents || []) {
    const text = (c.parts || []).map((p) => p.text || '').join('');
    if (!text) continue;
    messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: text });
  }
  return messages;
}

// Stream Groq (OpenAI-compatible SSE), re-shaped to look like a Gemini stream.
async function* groqStream({ contents, config }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set (needed for OXY_BRAIN_PROVIDER=groq)');
  const body = {
    model: process.env.OXY_GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: toOpenAIMessages(contents, config?.systemInstruction),
    temperature: config?.temperature ?? 0.2,
    stream: true,
  };
  if (config?.maxOutputTokens) body.max_tokens = config.maxOutputTokens;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) yield { text: delta, candidates: [] };
      } catch { /* keepalive / partial frame */ }
    }
  }
}

/*
 * Returns an async iterable of { text, candidates } chunks.
 * `model` is the Gemini model id; on the Groq path it's ignored in favour of
 * OXY_GROQ_MODEL. Awaitable for both providers (Gemini returns a promise).
 */
function streamBrain({ provider, model, contents, config }) {
  const p = provider || getBrainProvider();
  if (p === 'groq') return groqStream({ contents, config });
  return geminiClient().models.generateContentStream({ model, contents, config });
}

module.exports = { streamBrain, getBrainProvider, toOpenAIMessages };

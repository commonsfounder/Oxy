'use strict';
/*
 * Brain provider seam.
 *
 * Wraps the chat brain's model calls so the provider can change WITHOUT touching
 * the consumer: streamBrain() yields chunks shaped exactly like the @google/genai
 * stream ({ text, candidates }), so the `for await` loop in index.js works
 * unchanged regardless of provider. generateBrain() mirrors the non-streaming
 * generateContent() shape ({ text }).
 *
 *   OXY_BRAIN_PROVIDER = openai (default) | gemini | groq
 *   OXY_CHAT_REASONING_EFFORT = low (default) | medium | high
 *   OPENAI_API_KEY     = required for the default path
 *   GEMINI_API_KEY     = required only when provider=gemini
 *   GROQ_API_KEY       = required only when provider=groq
 *
 * OpenAI became the default on 2026-08-04, after Google billing dunning denied the
 * Gemini project outright and took chat down. There is deliberately NO automatic
 * cross-provider fallback: a silent downgrade to a different brain mid-conversation
 * is worse than a clear error. `gemini`/`groq` remain as MANUAL escape hatches.
 *
 * Search grounding differs by provider and is NOT apples-to-apples: Gemini uses the
 * native googleSearch tool inline, while OpenAI grounds through a separate
 * Responses-API call (see webSearchBrain). Groq has no grounding at all — config.tools
 * is silently dropped there.
 */

const { GoogleGenAI } = require('@google/genai');

// Reasoning-tier models (gpt-5.x) bill reasoning tokens against max_completion_tokens
// BEFORE any visible text. The chat path sets maxOutputTokens=32 for quick turns, which
// on a reasoning model is consumed entirely by reasoning and returns an EMPTY string.
// Floor the cap so a visible answer always has room. Confirmed live: a 32-token cap on
// gpt-5.6-luna returns finish_reason=length with content:''.
const OPENAI_MIN_COMPLETION_TOKENS = 768;

let _gemini = null;
function geminiClient() {
  if (!_gemini) _gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
  return _gemini;
}

function getBrainProvider() {
  return (process.env.OXY_BRAIN_PROVIDER || 'openai').toLowerCase();
}

// Gemini contents (role/parts) + systemInstruction -> OpenAI-style messages.
// Text-only turns keep `content` as a plain string (what every provider accepts);
// only turns carrying an image use the array form, since /chat-with-image sends
// Gemini inlineData parts that OpenAI expects as image_url data URIs.
function toOpenAIMessages(contents, systemInstruction) {
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  for (const c of contents || []) {
    const parts = c.parts || [];
    const text = parts.map((p) => p.text || '').join('');
    const images = parts
      .filter((p) => p.inlineData?.data)
      .map((p) => ({
        type: 'image_url',
        image_url: { url: `data:${p.inlineData.mimeType || 'image/jpeg'};base64,${p.inlineData.data}` }
      }));
    if (!text && !images.length) continue;
    const role = c.role === 'model' ? 'assistant' : 'user';
    if (!images.length) {
      messages.push({ role, content: text });
      continue;
    }
    messages.push({
      role,
      content: [...(text ? [{ type: 'text', text }] : []), ...images]
    });
  }
  return messages;
}

// Gemini config -> OpenAI request fields. Reasoning-tier models reject `temperature`
// (any non-default value errors) and renamed max_tokens -> max_completion_tokens, so
// neither Gemini's temperature/topP/topK nor its tool declarations carry over. Tool
// declarations are intentionally dropped: the chat path parses actions out of the
// model's TEXT (<action> blocks), never from native tool calls.
function openAIRequestFromConfig(config = {}) {
  const body = {
    max_completion_tokens: Math.max(config.maxOutputTokens || 0, OPENAI_MIN_COMPLETION_TOKENS),
    reasoning_effort: process.env.OXY_CHAT_REASONING_EFFORT || 'low'
  };
  return body;
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
  yield* streamChatCompletionSSE(res);
}

// Shared OpenAI-style SSE reader (OpenAI proper, Groq, and any OpenAI-compatible host).
// Yields Gemini-shaped chunks so the consumer's `for await` loop never changes.
async function* streamChatCompletionSSE(res) {
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

function openAIKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set (needed for OXY_BRAIN_PROVIDER=openai)');
  return apiKey;
}

function openAIBaseURL() {
  return process.env.OXY_CHAT_BASE_URL || 'https://api.openai.com/v1';
}

async function* openaiStream({ model, contents, config }) {
  const res = await fetch(`${openAIBaseURL()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAIKey()}` },
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(contents, config?.systemInstruction),
      stream: true,
      ...openAIRequestFromConfig(config)
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  yield* streamChatCompletionSSE(res);
}

async function openaiGenerate({ model, contents, config }) {
  const res = await fetch(`${openAIBaseURL()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAIKey()}` },
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(contents, config?.systemInstruction),
      ...openAIRequestFromConfig(config)
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return { text: json.choices?.[0]?.message?.content || '' };
}

/*
 * Returns an async iterable of { text, candidates } chunks.
 * On the Groq path `model` is ignored in favour of OXY_GROQ_MODEL. Awaitable for
 * every provider (Gemini returns a promise; the others are async generators).
 */
function streamBrain({ provider, model, contents, config }) {
  const p = provider || getBrainProvider();
  if (p === 'groq') return groqStream({ contents, config });
  if (p === 'openai') return openaiStream({ model, contents, config });
  return geminiClient().models.generateContentStream({ model, contents, config });
}

/*
 * Non-streaming counterpart, shaped like @google/genai's generateContent result
 * ({ text }). Used by /chat-with-image and the short helper prompts.
 */
async function generateBrain({ provider, model, contents, config }) {
  const p = provider || getBrainProvider();
  if (p === 'openai') return openaiGenerate({ model, contents, config });
  const res = await geminiClient().models.generateContent({ model, contents, config });
  return { text: res.text || '' };
}

/*
 * Web-grounded answer for the `web_search` action.
 *
 * Gemini grounds inline via the googleSearch tool; OpenAI has no inline equivalent on
 * chat/completions, so grounding goes through the Responses API's web_search tool as a
 * separate call. Returns plain text, or '' when the provider gave nothing usable —
 * callers surface their own "no results" error so the wording stays consistent.
 */
async function webSearchBrain({ model, prompt, provider }) {
  const p = provider || getBrainProvider();
  if (p === 'openai') {
    const res = await fetch(`${openAIBaseURL()}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAIKey()}` },
      body: JSON.stringify({
        model,
        input: prompt,
        tools: [{ type: 'web_search' }],
        reasoning: { effort: process.env.OXY_CHAT_REASONING_EFFORT || 'low' }
      })
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    // The Responses API returns a typed output array; the prose lives in output_text
    // parts of `message` items, alongside non-message items like web_search_call.
    const text = (json.output || [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content || [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('')
      .trim();
    return text;
  }
  const res = await geminiClient().models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { tools: [{ googleSearch: {} }] }
  });
  return (res.text || '').trim();
}

// Gemini declares schema types in uppercase ('OBJECT'/'STRING'); OpenAI expects standard
// lowercase JSON Schema and rejects the uppercase form. Recurse so nested object/array
// property schemas are converted too, not just the top level.
function toJsonSchemaTypes(node) {
  if (Array.isArray(node)) return node.map(toJsonSchemaTypes);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' && typeof v === 'string') out[k] = v.toLowerCase();
    else out[k] = toJsonSchemaTypes(v);
  }
  return out;
}

// [{ functionDeclarations: [...] }, { googleSearch: {} }] -> OpenAI tools.
// googleSearch has no OpenAI chat/completions equivalent and is dropped; grounded agent
// turns reach the web through the run_browser_task / web_search actions instead.
function geminiToolsToOpenAI(tools = []) {
  const decls = (tools || []).flatMap((t) => t.functionDeclarations || []);
  return decls.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: toJsonSchemaTypes(d.parameters || { type: 'object', properties: {} })
    }
  }));
}

function toolCallId(name, idx) {
  return `call_${String(name || 'fn').slice(0, 32)}_${idx}`;
}

/*
 * Tool-calling contents -> OpenAI messages.
 *
 * The agent loop replays each turn as Gemini shapes it: a 'model' turn whose parts carry
 * functionCall entries, followed by 'function' turns carrying functionResponse entries.
 * OpenAI instead wants an assistant message with a tool_calls array, then one 'tool'
 * message per call carrying the matching tool_call_id. Ids are synthesised per assistant
 * turn and consumed in order by the responses that follow, which is safe because the loop
 * always emits responses in the same order as the calls that produced them.
 */
function toOpenAIToolMessages(contents, systemInstruction) {
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  let pendingIds = [];
  for (const c of contents || []) {
    const parts = c.parts || [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const responses = parts.filter((p) => p.functionResponse).map((p) => p.functionResponse);
    const text = parts.map((p) => p.text || '').join('');

    if (responses.length) {
      responses.forEach((fr) => {
        const id = pendingIds.shift() || toolCallId(fr.name, messages.length);
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: typeof fr.response?.result === 'string'
            ? fr.response.result
            : JSON.stringify(fr.response ?? {})
        });
      });
      continue;
    }

    if (calls.length) {
      pendingIds = calls.map((fc, i) => fc.id || toolCallId(fc.name, i));
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((fc, i) => ({
          id: pendingIds[i],
          type: 'function',
          function: { name: fc.name, arguments: JSON.stringify(fc.args || {}) }
        }))
      });
      continue;
    }

    if (!text) continue;
    messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: text });
  }
  return messages;
}

// OpenAI response -> the @google/genai response shape the agent loop already reads
// (functionCalls, candidates[0].content.parts, text), so extractToolCalls and the verbatim
// parts replay in agent-orchestrator.js keep working untouched across providers.
function openAIResponseToGeminiShape(json) {
  const choice = json.choices?.[0]?.message || {};
  const toolCalls = choice.tool_calls || [];
  const functionCalls = toolCalls.map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
    return { id: tc.id, name: tc.function?.name, args };
  });
  const parts = [
    ...(choice.content ? [{ text: choice.content }] : []),
    ...functionCalls.map((fc) => ({ functionCall: fc }))
  ];
  return {
    text: choice.content || '',
    functionCalls,
    candidates: [{ content: { parts, role: 'model' } }]
  };
}

/*
 * Tool-calling generate for the ReAct agent loop. Returns a Gemini-shaped response
 * regardless of provider.
 */
async function callToolsBrain({ provider, model, contents, config }) {
  const p = provider || getBrainProvider();
  if (p !== 'openai') {
    return geminiClient().models.generateContent({ model, contents, config });
  }
  const tools = geminiToolsToOpenAI(config?.tools);
  const body = { model, messages: toOpenAIToolMessages(contents, config?.systemInstruction), ...openAIRequestFromConfig(config) };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
    // Verbatim from the API on 2026-08-04: "Function tools with reasoning_effort are not
    // supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use
    // /v1/responses or set reasoning_effort to 'none'." Taking the 'none' branch keeps this
    // one request shape for every call; moving tool turns to /v1/responses would mean a
    // second, differently-shaped transport for no behavioural gain in a loop already tuned
    // for latency.
    body.reasoning_effort = 'none';
  }
  const res = await fetch(`${openAIBaseURL()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAIKey()}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return openAIResponseToGeminiShape(await res.json());
}

module.exports = {
  streamBrain,
  generateBrain,
  webSearchBrain,
  callToolsBrain,
  getBrainProvider,
  toOpenAIMessages,
  toOpenAIToolMessages,
  geminiToolsToOpenAI,
  openAIResponseToGeminiShape,
  openAIRequestFromConfig
};

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
 *   OXY_BRAIN_PROVIDER = openai (default) | anthropic | gemini | groq | local
 *   OXY_CHAT_REASONING_EFFORT = low (default) | medium | high
 *   OPENAI_API_KEY     = required for the default path
 *   GEMINI_API_KEY     = required only when provider=gemini
 *   GROQ_API_KEY       = required only when provider=groq
 *   ANTHROPIC_API_KEY  = required only when provider=anthropic
 *   OXY_LOCAL_MODEL_BASE_URL = required only when provider=local (OpenAI-compatible)
 *
 * OpenAI became the default on 2026-08-04, after Google billing dunning denied the
 * Gemini project outright and took chat down. There is deliberately NO automatic
 * cross-provider fallback: a silent downgrade to a different brain mid-conversation
 * is worse than a clear error. `gemini`/`groq` remain as MANUAL escape hatches.
 *
 * Search grounding differs by provider and is NOT apples-to-apples: Gemini uses the
 * native googleSearch tool inline, while OpenAI grounds through a separate
 * Responses-API call (see webSearchBrain). Anthropic/Groq/local have no grounding of
 * their own and borrow Gemini for that ONE lookup — never for the conversation itself.
 *
 * No dispatcher falls through to another vendor. openai/groq/local share the OpenAI
 * /chat/completions transport (different base URL, key, and request fields); anthropic and
 * gemini have their own. An unrecognised provider throws rather than quietly landing on
 * whichever client happens to be last in the chain.
 */

const { GoogleGenAI } = require('@google/genai');
const { defaultModelForProvider, modelMatchesProvider } = require('./model-routing');

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

function geminiConfigured() {
  return Boolean(String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim());
}

function getBrainProvider() {
  return (process.env.OXY_BRAIN_PROVIDER || 'openai').toLowerCase();
}

function resolveBrainModel(provider, model, role = 'reasoning') {
  const candidate = String(model || '').trim();
  return candidate && modelMatchesProvider(provider, candidate)
    ? candidate
    : defaultModelForProvider(provider, role);
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
// Gemini's temperature/topP/topK do not carry over.
//
// Tool declarations DO carry over. They used to be dropped here on the theory that the chat
// path parses actions out of the model's TEXT (<action> blocks) — but that fallback stopped
// working when the provider moved to OpenAI: gpt-5.6-luna does not emit <action> markup, so
// the plain-chat path had no working action mechanism at all and answered "I can't set
// reminders directly here" for tools the user has connected.
//
// reasoning_effort MUST be 'none' whenever tools are attached. Verified live on 2026-08-06:
// tools + effort 'low' AND tools + effort omitted entirely both return
//   400 "Function tools with reasoning_effort are not supported for gpt-5.6-luna in
//        /v1/chat/completions. To use function tools, use /v1/responses or set
//        reasoning_effort to 'none'."
// so the field has to be set explicitly rather than left off. Same workaround, same reason,
// as the agent loop's tool path in callToolsBrain below.
function openAIRequestFromConfig(config = {}) {
  const body = {
    max_completion_tokens: Math.max(config.maxOutputTokens || 0, OPENAI_MIN_COMPLETION_TOKENS),
    reasoning_effort: process.env.OXY_CHAT_REASONING_EFFORT || 'low'
  };
  const tools = geminiToolsToOpenAI(config.tools);
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
    body.reasoning_effort = 'none';
  }
  return body;
}

// Stream Groq (OpenAI-compatible SSE), re-shaped to look like a Gemini stream.
async function* groqStream({ model, contents, config }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set (needed for OXY_BRAIN_PROVIDER=groq)');
  const body = {
    model: model || process.env.OXY_GROQ_MODEL || 'llama-3.3-70b-versatile',
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
//
// Tool calls arrive fragmented and interleaved with content: each frame carries a
// delta.tool_calls array whose entries are identified by `index`, the function NAME is
// usually whole on the first frame for an index but is appended defensively, and the JSON
// `arguments` string almost never arrives in one piece. They are accumulated per index and
// emitted as ONE final Gemini-shaped chunk after the stream ends, so a consumer sees a
// complete call rather than a dozen partial ones. Before this, delta.tool_calls was never
// read at all — a tool call would be requested by the model and silently discarded here.
async function* streamChatCompletionSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pending = [];

  const collectToolCalls = (deltaToolCalls) => {
    for (const tc of deltaToolCalls || []) {
      const i = Number.isInteger(tc.index) ? tc.index : pending.length;
      const slot = pending[i] || (pending[i] = { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
    }
  };

  // Malformed argument JSON degrades to {} rather than dropping the call, matching
  // openAIResponseToGeminiShape on the agent path so both tool routes fail identically.
  // The action runner's own required-parameter validation is what rejects it downstream.
  const finalToolCallChunk = () => {
    const calls = pending
      .filter((slot) => slot && slot.name)
      .map((slot, idx) => {
        let args = {};
        if (slot.args) {
          try {
            args = JSON.parse(slot.args);
          } catch {
            console.warn(`[brain] tool call ${slot.name} had unparseable arguments; passing {}`);
          }
        }
        return { id: slot.id || toolCallId(slot.name, idx), name: slot.name, args };
      });
    if (!calls.length) return null;
    return {
      text: '',
      functionCalls: calls,
      candidates: [{ content: { role: 'model', parts: calls.map((fc) => ({ functionCall: fc })) } }]
    };
  };

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
      if (data === '[DONE]') {
        const tail = finalToolCallChunk();
        if (tail) yield tail;
        return;
      }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta || {};
        if (delta.content) yield { text: delta.content, candidates: [] };
        if (delta.tool_calls) collectToolCalls(delta.tool_calls);
      } catch { /* keepalive / partial frame */ }
    }
  }
  const tail = finalToolCallChunk();
  if (tail) yield tail;
}

function openAIKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set (needed for OXY_BRAIN_PROVIDER=openai)');
  return apiKey;
}

function openAIBaseURL() {
  return process.env.OXY_CHAT_BASE_URL || 'https://api.openai.com/v1';
}

// Providers that speak OpenAI's /chat/completions shape. Everything in this set goes
// through the same transport; only the base URL, key, and request fields differ.
const OPENAI_COMPATIBLE = new Set(['openai', 'groq', 'local']);

function compatibleBaseURL(provider) {
  if (provider === 'groq') return 'https://api.groq.com/openai/v1';
  if (provider === 'local') {
    const base = String(process.env.OXY_LOCAL_MODEL_BASE_URL || '').trim().replace(/\/$/, '');
    if (!base) throw new Error('OXY_LOCAL_MODEL_BASE_URL is not set (needed for provider=local)');
    return base;
  }
  return openAIBaseURL();
}

function compatibleApiKey(provider) {
  if (provider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY is not set (needed for provider=groq)');
    return apiKey;
  }
  if (provider === 'local') return process.env.OXY_LOCAL_MODEL_API_KEY || 'local';
  return openAIKey();
}

function compatibleModel(provider, model) {
  if (provider === 'groq') return model || process.env.OXY_GROQ_MODEL || 'llama-3.3-70b-versatile';
  if (provider === 'local') return model || process.env.OXY_LOCAL_MODEL || 'llama3.2';
  return model;
}

function compatibleHeaders(provider) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${compatibleApiKey(provider)}`
  };
}

// Only OpenAI's reasoning tier renames max_tokens -> max_completion_tokens and takes
// reasoning_effort. Groq and local OpenAI-compatible hosts reject both, so they must NOT
// inherit the reasoning-tier body shape just because they share the endpoint path.
function compatibleRequestFromConfig(provider, config = {}) {
  if (provider === 'openai') return openAIRequestFromConfig(config);
  const body = { max_tokens: Math.max(config?.maxOutputTokens || 0, OPENAI_MIN_COMPLETION_TOKENS) };
  if (typeof config?.temperature === 'number') body.temperature = config.temperature;
  return body;
}

async function* compatibleStream({ provider, model, contents, config }) {
  const resolvedModel = resolveBrainModel(provider, model);
  const res = await fetch(`${compatibleBaseURL(provider)}/chat/completions`, {
    method: 'POST',
    headers: compatibleHeaders(provider),
    body: JSON.stringify({
      model: compatibleModel(provider, resolvedModel),
      messages: toOpenAIMessages(contents, config?.systemInstruction),
      stream: true,
      ...compatibleRequestFromConfig(provider, config)
    })
  });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  yield* streamChatCompletionSSE(res);
}

async function compatibleGenerate({ provider, model, contents, config }) {
  const resolvedModel = resolveBrainModel(provider, model);
  const res = await fetch(`${compatibleBaseURL(provider)}/chat/completions`, {
    method: 'POST',
    headers: compatibleHeaders(provider),
    body: JSON.stringify({
      model: compatibleModel(provider, resolvedModel),
      messages: toOpenAIMessages(contents, config?.systemInstruction),
      ...compatibleRequestFromConfig(provider, config)
    })
  });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  // Returns the full Gemini shape, not just { text }: once tools can be attached here, a
  // reply carrying tool_calls has EMPTY content, and returning only the text would discard
  // the call silently — the exact failure this phase exists to remove. `.text` is unchanged
  // for the many callers that only read it.
  return openAIResponseToGeminiShape(json);
}

function toAnthropicMessages(contents) {
  const messages = [];
  for (const c of contents || []) {
    const blocks = [];
    for (const part of c.parts || []) {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      if (part.functionCall) {
        blocks.push({
          type: 'tool_use',
          id: part.functionCall.id || toolCallId(part.functionCall.name, blocks.length),
          name: part.functionCall.name,
          input: part.functionCall.args || {}
        });
      }
      if (part.functionResponse) {
        const value = part.functionResponse.response?.result ?? part.functionResponse.response ?? {};
        blocks.push({
          type: 'tool_result',
          tool_use_id: part.functionResponse.id || toolCallId(part.functionResponse.name, blocks.length),
          content: typeof value === 'string' ? value : JSON.stringify(value)
        });
      }
    }
    if (!blocks.length) continue;
    const role = c.role === 'model' ? 'assistant' : 'user';
    const previous = messages[messages.length - 1];
    if (previous?.role === role && role === 'user') previous.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  return messages;
}

function anthropicHeaders() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set (needed for provider=anthropic)');
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
}

function anthropicRequestBody({ model, contents, config, stream = false, tools = [] }) {
  const body = {
    model: model || process.env.OXY_ANTHROPIC_MODEL || 'claude-sonnet-5',
    max_tokens: Math.max(config?.maxOutputTokens || 0, 768),
    messages: toAnthropicMessages(contents),
    stream
  };
  if (config?.systemInstruction) body.system = config.systemInstruction;
  if (tools.length) body.tools = tools;
  return body;
}

async function* anthropicStream({ model, contents, config }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: anthropicHeaders(),
    body: JSON.stringify(anthropicRequestBody({ model, contents, config, stream: true }))
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        const text = event.delta?.type === 'text_delta' ? event.delta.text : '';
        if (text) yield { text, candidates: [] };
      } catch { /* ignore keepalive and partial frames */ }
    }
  }
}

function anthropicResponseToGeminiShape(json) {
  const parts = (json.content || []).flatMap(block => {
    if (block.type === 'text') return [{ text: block.text || '' }];
    if (block.type === 'tool_use') return [{ functionCall: { id: block.id, name: block.name, args: block.input || {} } }];
    return [];
  });
  const functionCalls = parts.filter(part => part.functionCall).map(part => part.functionCall);
  return {
    text: parts.filter(part => part.text).map(part => part.text).join(''),
    functionCalls,
    candidates: [{ content: { parts, role: 'model' } }]
  };
}

async function anthropicGenerate({ model, contents, config, tools = [] }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: anthropicHeaders(),
    body: JSON.stringify(anthropicRequestBody({ model, contents, config, tools }))
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return anthropicResponseToGeminiShape(await res.json());
}

/*
 * Returns an async iterable of { text, candidates } chunks.
 * On the Groq path `model` is ignored in favour of OXY_GROQ_MODEL. Awaitable for
 * every provider (Gemini returns a promise; the others are async generators).
 */
function streamBrain({ provider, model, contents, config }) {
  const p = provider || getBrainProvider();
  const resolvedModel = resolveBrainModel(p, model);
  if (p === 'groq') return groqStream({ model: resolvedModel, contents, config });
  if (p === 'openai' || p === 'local') return compatibleStream({ provider: p, model: resolvedModel, contents, config });
  if (p === 'anthropic') return anthropicStream({ model: resolvedModel, contents, config });
  if (p === 'gemini') return geminiClient().models.generateContentStream({ model: resolvedModel, contents, config });
  throw new Error(`Unknown brain provider: ${p}`);
}

/*
 * Non-streaming counterpart, shaped like @google/genai's generateContent result
 * ({ text }). Used by /chat-with-image and the short helper prompts.
 */
async function generateBrain({ provider, model, contents, config }) {
  const p = provider || getBrainProvider();
  const resolvedModel = resolveBrainModel(p, model);
  if (OPENAI_COMPATIBLE.has(p)) return compatibleGenerate({ provider: p, model: resolvedModel, contents, config });
  if (p === 'anthropic') return anthropicGenerate({ model: resolvedModel, contents, config });
  if (p === 'gemini') {
    const res = await geminiClient().models.generateContent({ model: resolvedModel, contents, config });
    return { text: res.text || '' };
  }
  throw new Error(`Unknown brain provider: ${p}`);
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
  // Only OpenAI and Gemini ground natively. An Anthropic/Groq/local route has no grounding
  // of its own, so search falls to Gemini AS A TOOL — deliberate and narrow (one lookup,
  // never the conversational brain). This branch used to be reached by fallthrough and
  // forwarded the *other* provider's model id to Gemini, which 404s every time; pick a real
  // Gemini model instead, and return '' when there is no Gemini key to fall back to so the
  // caller surfaces its own "no results" wording.
  if (!geminiConfigured()) return '';
  const groundingModel = p === 'gemini' ? model : (process.env.OXY_GEMINI_MODEL || 'gemini-2.5-flash');
  const res = await geminiClient().models.generateContent({
    model: groundingModel,
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
// turns reach the web through browser primitives / web_search actions instead.
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

function geminiToolsToAnthropic(tools = []) {
  const decls = (tools || []).flatMap((t) => t.functionDeclarations || []);
  return decls.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: toJsonSchemaTypes(d.parameters || { type: 'object', properties: {} })
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
  const resolvedModel = resolveBrainModel(p, model);
  if (p === 'anthropic') {
    return anthropicGenerate({
      model: resolvedModel,
      contents,
      config,
      tools: geminiToolsToAnthropic(config?.tools)
    });
  }
  if (p === 'gemini') {
    return geminiClient().models.generateContent({ model: resolvedModel, contents, config });
  }
  // Anything left must speak the OpenAI tool-calling shape. Falling through to the Gemini
  // SDK here used to send e.g. a Groq model id to generativelanguage.googleapis.com — a
  // silent cross-provider hop that contradicts this module's no-fallback contract.
  if (!OPENAI_COMPATIBLE.has(p)) throw new Error(`Unknown brain provider: ${p}`);

  const tools = geminiToolsToOpenAI(config?.tools);
  const body = {
    model: compatibleModel(p, resolvedModel),
    messages: toOpenAIToolMessages(contents, config?.systemInstruction),
    ...compatibleRequestFromConfig(p, config)
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
    // Verbatim from the API on 2026-08-04: "Function tools with reasoning_effort are not
    // supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use
    // /v1/responses or set reasoning_effort to 'none'." Taking the 'none' branch keeps this
    // one request shape for every call; moving tool turns to /v1/responses would mean a
    // second, differently-shaped transport for no behavioural gain in a loop already tuned
    // for latency. Only the reasoning tier needs it; Groq/local reject the field.
    if (p === 'openai') body.reasoning_effort = 'none';
  }
  const res = await fetch(`${compatibleBaseURL(p)}/chat/completions`, {
    method: 'POST',
    headers: compatibleHeaders(p),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${p} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return openAIResponseToGeminiShape(await res.json());
}

module.exports = {
  streamChatCompletionSSE,
  streamBrain,
  generateBrain,
  webSearchBrain,
  callToolsBrain,
  getBrainProvider,
  toOpenAIMessages,
  toAnthropicMessages,
  toOpenAIToolMessages,
  geminiToolsToOpenAI,
  geminiToolsToAnthropic,
  openAIResponseToGeminiShape,
  openAIRequestFromConfig
};

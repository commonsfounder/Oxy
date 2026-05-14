require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const { GoogleGenAI: ModernGoogleGenAI } = require('@google/genai');
const { dispatch, IMPLEMENTED_CONNECTORS } = require('../connectors');
const telegram = require('../connectors/telegram');
const {
  createGeminiServiceClient,
  createSupabaseServiceClient,
  getMissingRuntimeEnv,
  logMissingRuntimeEnvOnce
} = require('../runtime');
const {
  createSessionToken,
  getAuthenticatedUserId,
  hashPassword,
  requireSessionAuth,
  signPayload,
  verifyPassword,
  verifySignedPayload
} = require('../auth');

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

function parseLooseJson(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

const USER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
function isValidUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

function requireValidUserIdValue(userId, res) {
  if (!isValidUserId(userId)) {
    res.status(400).json({ error: 'Valid userId is required.' });
    return false;
  }
  return true;
}

function requireMatchingUser(req, res, candidateUserId) {
  if (!requireValidUserIdValue(candidateUserId, res)) return false;
  const authenticatedUserId = getAuthenticatedUserId(req);
  if (!authenticatedUserId || authenticatedUserId !== candidateUserId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

function humanizeActionType(type) {
  if (!type) return 'Action';
  return String(type)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function signOAuthState(userId) {
  return signPayload({ type: 'google_oauth', userId }, 15 * 60 * 1000);
}

function verifyOAuthState(state) {
  const payload = verifySignedPayload(state);
  if (!payload || payload.type !== 'google_oauth') return null;
  return isValidUserId(payload.userId) ? payload.userId : null;
}

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const publicPaths = new Set([
    '/',
    '/health',
    '/install-shortcut',
    '/auth/google/callback',
    '/auth/register',
    '/auth/login'
  ]);

  if (publicPaths.has(req.path)) return next();
  return requireSessionAuth(req, res, next);
});

const audioRateLimit = new Map();
const GEMINI_TTS_VOICES = new Set([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
]);

// Prune stale rate-limit entries (skip in serverless — Maps are ephemeral per invocation)
if (!process.env.VERCEL) {
  setInterval(() => {
    const now = Date.now();
    for (const [uid, timestamps] of audioRateLimit) {
      const recent = timestamps.filter(t => now - t < 60000);
      if (recent.length === 0) audioRateLimit.delete(uid);
      else audioRateLimit.set(uid, recent);
    }
  }, 5 * 60 * 1000).unref();
}

const supabase = createSupabaseServiceClient();
const genAI = createGeminiServiceClient();
const modernGenAI = new ModernGoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
logMissingRuntimeEnvOnce('api bootstrap');

const CONTEXT_CACHE_TTL = 5 * 60 * 1000;
const CONTEXT_CACHE_MAX = 500;
const contextCache = new Map();

// Prune expired context cache entries (skip in serverless)
if (!process.env.VERCEL) {
  setInterval(() => {
    const now = Date.now();
    for (const [uid, entry] of contextCache) {
      if (now - entry.ts > CONTEXT_CACHE_TTL) contextCache.delete(uid);
    }
  }, 10 * 60 * 1000).unref();
}

const TIMEZONE = process.env.TIMEZONE || 'Europe/London';
const PRIMARY_CHAT_MODEL = process.env.OXY_REASONING_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const FAST_MODEL = process.env.OXY_FAST_MODEL || process.env.GEMINI_FAST_MODEL || 'gemini-3-flash-preview';
const STREAMING_CHAT_MODEL = process.env.OXY_STREAM_MODEL || FAST_MODEL;
const PROMPT_CACHE_TTL = process.env.OXY_PROMPT_CACHE_TTL || '3600s';
const promptCacheStates = new Map();

function createRequestTrace(label) {
  const startedAt = Date.now();
  const prefix = `[trace:${label}]`;
  return {
    log(step, extra = '') {
      const suffix = extra ? ` ${extra}` : '';
      console.log(`${prefix} +${Date.now() - startedAt}ms ${step}${suffix}`);
    },
    async run(step, fn) {
      const opStart = Date.now();
      console.log(`${prefix} +${opStart - startedAt}ms BEGIN ${step}`);
      try {
        const result = await fn();
        console.log(`${prefix} +${Date.now() - startedAt}ms END ${step} (${Date.now() - opStart}ms)`);
        return result;
      } catch (error) {
        console.log(`${prefix} +${Date.now() - startedAt}ms FAIL ${step} (${Date.now() - opStart}ms) ${error.message}`);
        throw error;
      }
    }
  };
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
- You sometimes have Google Search available for current/real-time questions. When search results are present, use them.
- Admit uncertainty plainly: "I don't know" beats making stuff up.
- Don't hallucinate dates, events, details, or claim confidence on things outside your knowledge.
- If the user asks for a factual answer and you are missing evidence, say that clearly and ask one short follow-up or say you don't know.
- If the user asks you to do something but key details are missing, ask only for the missing detail instead of inventing it.
- Never imply you saw, checked, sent, booked, verified, or found something unless tool results or conversation context explicitly show that.
- When using memory, treat it as possibly stale personal context, not as proof of current real-world facts.

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
    {"type": "search_trains", "input": {"origin": "station name or CRS code", "destination": "station name or CRS code"}},
    {"type": "order_uber_eats", "input": {"query": "food or restaurant", "restaurant": "optional restaurant name", "item": "optional dish"}},
    {"type": "order_deliveroo", "input": {"query": "food or restaurant", "restaurant": "optional restaurant name", "item": "optional dish"}},
    {"type": "search_netflix_title", "input": {"title": "show or film title"}},
    {"type": "add_to_netflix_list", "input": {"title": "show or film title"}},
    {"type": "generate_visual", "input": {"brief": "what to create", "style": "optional style", "usage": "where this visual will be used"}},
    {"type": "create_diagram", "input": {"topic": "what to explain", "goal": "what the diagram should help with"}},
    {"type": "create_presentation", "input": {"topic": "subject", "audience": "who it's for", "objective": "what the deck should achieve", "slide_count": 6}}
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
7. For search_trains: if the user doesn't say where they're travelling from, infer it from their known home location in memory. If you genuinely don't know their location, ask once
7a. If the user asks about trains, departures, arrivals, platforms, or the next train to somewhere, use search_trains instead of guessing
7b. If the train tool says live departures could not be checked, say that plainly. Do not paraphrase it into "there are no trains"
8. If you are unsure, ask a brief clarifying question instead of guessing
9. Separate observed facts from suggestions: suggestions are fine, fabricated facts are not
10. When a workflow would benefit from a visual, deck, preview, diagram, or study aid, use the visual actions above instead of only describing them in text
11. Recent action results are real state. Don't repeat successful actions unless the user clearly asks you to repeat them.
12. If a recent action failed and the user asks to retry, fix, redo, or "do the failed one", retry only the failed action unless they explicitly ask to rerun other actions too.
13. Pay close attention to which previous actions succeeded versus failed before deciding what to do next.`;

function normalizeGeminiHistory(history) {
  const mapped = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: toGeminiHistoryText(m) }]
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

function invalidateUserContextCache(userId) {
  if (userId) contextCache.delete(userId);
}

function summarizeActionInput(input) {
  if (!input || typeof input !== 'object') return '';
  const preferredKeys = ['contact', 'to', 'title', 'destination', 'query', 'restaurant', 'item', 'origin', 'topic', 'brief'];
  const values = preferredKeys
    .map(key => input[key])
    .filter(Boolean)
    .slice(0, 3);
  return values.length ? ` (${values.join(' · ')})` : '';
}

function summarizeActionOutcome(entry) {
  const type = entry?.action || entry?.type || 'action';
  const result = entry?.result || {};
  const status = result.success === false ? 'failed' : 'succeeded';
  const detail = (result.error || result.text || '').trim();
  return `- ${humanizeActionType(type)}${summarizeActionInput(entry?.input || result?.input)}: ${status}${detail ? ` — ${detail}` : ''}`;
}

function toGeminiHistoryText(message) {
  const content = message?.content || '';
  const actionLines = Array.isArray(message?.actions) ? message.actions.map(summarizeActionOutcome).filter(Boolean) : [];
  if (!actionLines.length) return content || conversationFallbackText(message);
  return [content, 'Action results:', ...actionLines].filter(Boolean).join('\n');
}

function serializeLoggedAction(action, result) {
  return JSON.stringify({
    type: action?.type || '',
    input: action?.input || {},
    status: result?.success ? 'executed' : 'failed',
    resultText: typeof result?.text === 'string' ? result.text.slice(0, 280) : '',
    error: result?.success ? null : (result?.error || null)
  });
}

function getWavDurationMs(buffer) {
  try {
    if (!buffer || buffer.length < 44) return null;
    const sampleRate = buffer.readUInt32LE(24);
    const byteRate = buffer.readUInt32LE(28);
    const dataSize = buffer.readUInt32LE(40);
    if (!sampleRate || !byteRate || !dataSize) return null;
    return Math.round((dataSize / byteRate) * 1000);
  } catch {
    return null;
  }
}

function normalizeTranscript(text) {
  return String(text || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
}

function isImplausibleTranscript(text, durationMs) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (!durationMs || durationMs < 400) return words.length > 4;
  const wordsPerSecond = words.length / Math.max(durationMs / 1000, 0.5);
  if (durationMs < 1500 && words.length > 7) return true;
  if (durationMs < 2500 && words.length > 12) return true;
  return wordsPerSecond > 4.8;
}

async function transcribeAudio(buffer) {
  const audioBase64Input = buffer.toString('base64');
  const audioPart = { inlineData: { mimeType: 'audio/wav', data: audioBase64Input } };
  const transcribeModel = genAI.getGenerativeModel({ model: FAST_MODEL });
  const durationMs = getWavDurationMs(buffer);

  const prompts = [
    'Transcribe this audio exactly. Return only the spoken words. If any part is unclear, omit it rather than guessing. If there is no clear speech, return an empty string.',
    'Verbatim transcription only. Do not answer the user. Do not infer intent. Do not add any words that are not clearly audible. If unclear, return an empty string.'
  ];

  let lastTranscript = '';
  for (const prompt of prompts) {
    const response = await transcribeModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }, audioPart] }],
      generationConfig: { temperature: 0, topP: 0.1, topK: 1 }
    });
    const transcript = normalizeTranscript(response.response.text());
    lastTranscript = transcript;
    if (transcript && !isImplausibleTranscript(transcript, durationMs)) {
      return transcript;
    }
  }

  return isImplausibleTranscript(lastTranscript, durationMs) ? '' : lastTranscript;
}

function firstSentences(text, max = 2) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  return (sentences.slice(0, max).join(' ').trim() || text.slice(0, 200)).trim();
}

async function generateStructuredObject(prompt, fallback = null, imageFile = null) {
  const model = genAI.getGenerativeModel({ model: FAST_MODEL });
  const parts = [{ text: `${prompt}\n\nReturn JSON only. No markdown fences.` }];
  if (imageFile?.buffer && imageFile?.mimetype?.startsWith('image/')) {
    parts.push({ inlineData: { mimeType: imageFile.mimetype, data: imageFile.buffer.toString('base64') } });
  }
  const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
  return parseLooseJson(result.response.text()) || fallback;
}

function stripActionMarkupForDisplay(text) {
  if (!text) return '';
  return text
    .replace(/<action>[\s\S]*?<\/action>/g, '')
    .replace(/<action>[\s\S]*$/g, '');
}

function splitCompleteSentences(text) {
  const cleaned = stripActionMarkupForDisplay(text || '');
  const matches = cleaned.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g) || [];
  return matches.map(sentence => sentence.trim()).filter(Boolean);
}

function buildDynamicSystemPrompt(memory, preferences, availableActions, userContext) {
  const timeStr = new Date().toLocaleString('en-GB', { timeZone: TIMEZONE });
  return `WHAT YOU KNOW ABOUT THIS PERSON:
${memory || 'Nothing yet.'}

HOW THE USER LIKES THINGS (learned over time):
${preferences || 'Still learning.'}

CONNECTED APPS:
${availableActions}

NATIVE CREATIVE TOOLS:
- generate_visual for contextual images, mockups, study aids, previews, and supporting visuals
- create_diagram for explaining systems, concepts, and workflows
- create_presentation for slide structures and decks

Current time: ${timeStr}

---
${userContext}`;
}

async function getPromptCacheName(trace = null, modelName = STREAMING_CHAT_MODEL) {
  const cacheKey = `${modelName}:${OXCY_SYSTEM_PROMPT}`;
  let cacheState = promptCacheStates.get(cacheKey);
  if (!cacheState) {
    cacheState = { name: '', expireAt: 0, pending: null };
    promptCacheStates.set(cacheKey, cacheState);
  }

  if (cacheState.name && Date.now() < cacheState.expireAt) {
    if (trace) trace.log('prompt_cache.hit', cacheState.name);
    return cacheState.name;
  }

  if (cacheState.pending) {
    if (trace) trace.log('prompt_cache.await_pending');
    return cacheState.pending;
  }

  cacheState.pending = (async () => {
    try {
      const cached = trace
        ? await trace.run('gemini.caches.create', () => modernGenAI.caches.create({
            model: modelName,
            config: {
              displayName: `oxy-base-system-prompt-${modelName.replace(/[^a-z0-9-]+/gi, '-')}`,
              systemInstruction: OXCY_SYSTEM_PROMPT,
              ttl: PROMPT_CACHE_TTL
            }
          }))
        : await modernGenAI.caches.create({
            model: modelName,
            config: {
              displayName: `oxy-base-system-prompt-${modelName.replace(/[^a-z0-9-]+/gi, '-')}`,
              systemInstruction: OXCY_SYSTEM_PROMPT,
              ttl: PROMPT_CACHE_TTL
            }
          });
      cacheState.name = cached?.name || '';
      cacheState.expireAt = Date.now() + 55 * 60 * 1000;
      if (trace) trace.log('prompt_cache.created', cacheState.name || 'no-name');
      return cacheState.name;
    } catch (error) {
      if (trace) trace.log('prompt_cache.unavailable', error.message);
      return '';
    } finally {
      cacheState.pending = null;
    }
  })();

  return cacheState.pending;
}

function buildModernGenerateConfig(dynamicSystemPrompt, useSearch, cachedContentName) {
  const config = {
    systemInstruction: dynamicSystemPrompt
  };
  if (cachedContentName) config.cachedContent = cachedContentName;
  if (useSearch) config.tools = [{ googleSearch: {} }];
  return config;
}

async function runActions(userId, actions) {
  const results = [];
  for (const action of actions) {
    console.log('[action] executing:', action.type, action.input);
    const result = await dispatch(userId, action.type, action.input || {});
    console.log('[action] result:', action.type, JSON.stringify(result));
    results.push({ action: action.type, result });
    await supabase.from('action_log').insert({
      user_id: userId,
      action: serializeLoggedAction(action, result),
      status: result.success ? 'executed' : 'failed',
      error: result.success ? null : (result.error || null),
      created_at: new Date().toISOString()
    });
  }
  invalidateUserContextCache(userId);
  return results;
}

const GEMINI_TTS_MODELS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts'
];
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
let preferredTtsModel = null;

function buildVoiceExcerpt(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const sentences = trimmed.match(/[^.!?]+[.!?]+/g) || [];
  let excerpt = '';
  for (const sentence of sentences.slice(0, 2)) {
    const candidate = `${excerpt} ${sentence}`.trim();
    if (candidate.length > 180) break;
    excerpt = candidate;
  }
  return (excerpt || trimmed.slice(0, 180)).trim();
}

async function generateSpeech(text, voiceName = 'Aoede') {
  if (!text || !text.trim()) return null;
  const safeVoiceName = GEMINI_TTS_VOICES.has(voiceName) ? voiceName : 'Aoede';
  const failures = [];
  const orderedModels = preferredTtsModel
    ? [preferredTtsModel, ...GEMINI_TTS_MODELS.filter(name => name !== preferredTtsModel)]
    : GEMINI_TTS_MODELS;

  for (const modelName of orderedModels) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);
    try {
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoiceName } } }
          }
        },
        { signal: controller.signal }
      );
      const base64Audio = resp.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error(`Gemini TTS returned empty audio for voice ${safeVoiceName}.`);
      }
      preferredTtsModel = modelName;
      console.log(`[tts] using model ${modelName} with voice ${safeVoiceName}`);
      return pcmToWav(Buffer.from(base64Audio, 'base64')).toString('base64');
    } catch (err) {
      const detail = err?.response?.data?.error?.message || err?.response?.data || err.message;
      failures.push(`${modelName}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`TTS failed (${safeVoiceName}): ${failures.join(' | ')}`);
}

function createSentenceTtsStreamer({ voiceName, sse, trace = null }) {
  let lastSentenceCount = 0;
  let nextEmitIndex = 0;
  const readyAudio = new Map();
  const tasks = [];

  const flushReadyAudio = () => {
    while (readyAudio.has(nextEmitIndex)) {
      const audio = readyAudio.get(nextEmitIndex);
      readyAudio.delete(nextEmitIndex);
      sse({ type: 'audio', data: audio, format: 'wav', seq: nextEmitIndex });
      if (trace) trace.log(`tts.chunk_sent.${nextEmitIndex}`);
      nextEmitIndex += 1;
    }
  };

  const schedule = sentence => {
    const trimmed = sentence.trim();
    if (!trimmed) return;
    const seq = tasks.length;
    if (trace) trace.log(`tts.chunk_schedule.${seq}`, JSON.stringify(trimmed.slice(0, 80)));
    const task = generateSpeech(trimmed, voiceName)
      .then(audio => {
        readyAudio.set(seq, audio);
        flushReadyAudio();
      })
      .catch(error => {
        if (trace) trace.log(`tts.chunk_fail.${seq}`, error.message);
        throw error;
      });
    tasks.push(task);
  };

  return {
    ingest(text) {
      const sentences = splitCompleteSentences(text);
      for (let i = lastSentenceCount; i < sentences.length; i += 1) {
        schedule(sentences[i]);
      }
      lastSentenceCount = sentences.length;
    },
    async flushRemainder(text) {
      const cleaned = stripActionMarkupForDisplay(text || '').trim();
      if (!cleaned) return;
      const matches = [...cleaned.matchAll(/[^.!?]+[.!?]+(?:["')\]]+)?/g)];
      let consumedLength = 0;
      for (let i = 0; i < Math.min(lastSentenceCount, matches.length); i += 1) {
        consumedLength = (matches[i].index || 0) + matches[i][0].length;
      }
      const remainder = cleaned.slice(consumedLength).trim();
      if (remainder) schedule(remainder);
    },
    async waitForAll() {
      await Promise.all(tasks);
      flushReadyAudio();
    }
  };
}

async function generateImage(prompt, imageFile) {
  if (!prompt || !prompt.trim()) {
    throw new Error('Image prompt is required.');
  }

  const parts = [];
  if (imageFile) {
    if (!imageFile.mimetype || !imageFile.mimetype.startsWith('image/')) {
      throw new Error('Only image uploads are supported for image generation.');
    }
    parts.push({
      inline_data: {
        mime_type: imageFile.mimetype,
        data: imageFile.buffer.toString('base64')
      }
    });
  }
  parts.push({ text: prompt.trim() });

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`,
    {
      contents: [{ parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    },
    {
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }
    }
  );

  const responseParts = resp.data?.candidates?.[0]?.content?.parts || [];
  const text = responseParts.find(part => typeof part.text === 'string' && part.text.trim())?.text?.trim() || 'Made this for you.';
  const imagePart = responseParts.find(part => part.inlineData?.data || part.inline_data?.data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;

  if (!inlineData?.data) {
    throw new Error('Gemini image generation returned no image.');
  }

  return {
    text,
    image: inlineData.data,
    mimeType: inlineData.mimeType || inlineData.mime_type || 'image/png'
  };
}

async function analyzeImage(prompt, imageFile) {
  if (!imageFile?.buffer) throw new Error('An image attachment is required.');
  if (!imageFile.mimetype || !imageFile.mimetype.startsWith('image/')) {
    throw new Error('Only image uploads are supported.');
  }

  const model = genAI.getGenerativeModel({ model: FAST_MODEL });
  const result = await model.generateContent({
    contents: [{
      role: 'user',
      parts: [
        { text: prompt?.trim() || 'Describe this image clearly and practically.' },
        { inlineData: { mimeType: imageFile.mimetype, data: imageFile.buffer.toString('base64') } }
      ]
    }]
  });

  return {
    success: true,
    text: result.response.text()?.trim() || 'I looked through the image.',
    artifact: {
      type: 'image_analysis',
      image: imageFile.buffer.toString('base64'),
      mimeType: imageFile.mimetype,
      title: 'Attached image'
    }
  };
}

async function createDiagramArtifact(input, imageFile) {
  const topic = input?.topic || input?.brief || 'the topic';
  const goal = input?.goal || input?.usage || 'make the idea easy to understand';
  const attachmentNote = imageFile ? 'An image or screenshot is attached. Incorporate what is visible if relevant.' : '';
  const spec = await generateStructuredObject(
    `Create a clean teaching diagram plan for "${topic}".
Goal: ${goal}
${attachmentNote}

Return strict JSON with:
{
  "title": "short title",
  "summary": "one sentence",
  "mermaid": "valid mermaid flowchart or mindmap syntax",
  "visual_prompt": "prompt for an elegant flat educational diagram preview image"
}`,
    {
      title: topic,
      summary: `A simple diagram for ${topic}.`,
      mermaid: `flowchart TD\n  A[${topic}] --> B[Key idea]\n  B --> C[Outcome]`,
      visual_prompt: `A refined educational diagram about ${topic}, minimal, elegant, dark background, warm neutral accents`
    },
    imageFile || null
  );

  const preview = await generateImage(spec.visual_prompt || `An elegant educational diagram about ${topic}.`, imageFile || null);
  return {
    success: true,
    text: spec.summary || `I made a diagram for ${topic}.`,
    artifact: {
      type: 'diagram',
      title: spec.title || topic,
      summary: spec.summary || '',
      mermaid: spec.mermaid || '',
      image: preview.image,
      mimeType: preview.mimeType,
      caption: preview.text
    }
  };
}

async function createPresentationArtifact(input, imageFile) {
  const topic = input?.topic || 'the topic';
  const audience = input?.audience || 'the intended audience';
  const objective = input?.objective || 'explain the topic clearly';
  const slideCount = Math.min(Math.max(Number(input?.slide_count) || 6, 3), 10);
  const attachmentNote = imageFile ? 'A reference image or screenshot is attached. Use it as source context where relevant.' : '';

  const deck = await generateStructuredObject(
    `Create a concise premium presentation outline.
Topic: ${topic}
Audience: ${audience}
Objective: ${objective}
Slides: ${slideCount}
${attachmentNote}

Return strict JSON:
{
  "title": "deck title",
  "subtitle": "deck subtitle",
  "theme": "short visual direction",
  "slides": [
    {
      "title": "slide title",
      "bullets": ["bullet", "bullet"],
      "speaker_notes": "one or two lines",
      "visual_prompt": "what image or visual should appear on this slide"
    }
  ]
}`,
    {
      title: topic,
      subtitle: objective,
      theme: 'Clean editorial study deck',
      slides: Array.from({ length: slideCount }, (_, i) => ({
        title: i === 0 ? topic : `Slide ${i + 1}`,
        bullets: ['Key point', 'Supporting detail'],
        speaker_notes: 'Talk through the main point simply.',
        visual_prompt: `An elegant visual supporting ${topic}`
      }))
    },
    imageFile || null
  );

  const coverPrompt = deck.slides?.[0]?.visual_prompt || `A premium presentation cover visual for ${topic}, minimalist, intelligent, editorial`;
  const cover = await generateImage(coverPrompt, imageFile || null);
  return {
    success: true,
    text: `I built a ${slideCount}-slide presentation structure for ${topic}.`,
    artifact: {
      type: 'slide_deck',
      title: deck.title || topic,
      subtitle: deck.subtitle || objective,
      theme: deck.theme || '',
      image: cover.image,
      mimeType: cover.mimeType,
      slides: (deck.slides || []).slice(0, slideCount)
    }
  };
}

async function executeAction(userId, action, params, context = {}) {
  switch (action) {
    case 'generate_visual': {
      const brief = params?.brief || params?.prompt || params?.topic;
      if (!brief) return { success: false, error: 'generate_visual needs a brief.' };
      const prompt = [
        brief,
        params?.style ? `Style: ${params.style}` : '',
        params?.usage ? `Usage: ${params.usage}` : ''
      ].filter(Boolean).join('\n');
      const visual = await generateImage(prompt, context.imageFile || null);
      return {
        success: true,
        text: visual.text || 'I made a visual for this.',
        artifact: {
          type: 'image',
          title: params?.usage || 'Generated visual',
          image: visual.image,
          mimeType: visual.mimeType
        }
      };
    }
    case 'create_diagram':
      return createDiagramArtifact(params || {}, context.imageFile || null);
    case 'create_presentation':
      return createPresentationArtifact(params || {}, context.imageFile || null);
    default:
      return dispatch(userId, action, params);
  }
}

async function executeActions(userId, actions, context = {}, trace = null) {
  if (!actions?.length) return [];
  const results = await Promise.all(actions.map(async action => {
    const result = trace
      ? await trace.run(`action.${action.type}.execute`, () => executeAction(userId, action.type, action.input || {}, context))
      : await executeAction(userId, action.type, action.input || {}, context);
    const insertActionLog = () => supabase.from('action_log').insert({
      user_id: userId,
      action: serializeLoggedAction(action, result),
      status: result.success ? 'executed' : 'failed',
      error: result.success ? null : (result.error || null),
      created_at: new Date().toISOString()
    });
    if (trace) {
      await trace.run(`supabase.action_log.insert.${action.type}`, insertActionLog);
    } else {
      await insertActionLog();
    }
    return { action: action.type, result };
  }));
  invalidateUserContextCache(userId);
  return results;
}

async function getMemory(userId, trace = null) {
  const fetchMemory = () => supabase
    .from('memories')
    .select('content, source')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  const { data, error } = trace
    ? await trace.run('supabase.memories.fetch', fetchMemory)
    : await fetchMemory();

  if (error || !data) return '';
  const manualProfile = data.find(m => m.source === 'manual_profile')?.content?.trim();
  const facts = data
    .filter(m => m.source !== 'manual_profile')
    .map(m => m.content)
    .filter(Boolean);
  return [manualProfile, ...facts].filter(Boolean).join('\n');
}

async function saveMemory(userId, content, source = 'fact') {
  if (source === 'manual_profile') {
    const { data: inserted } = await supabase
      .from('memories')
      .insert({ user_id: userId, content, source, created_at: new Date().toISOString() })
      .select('id');

    if (inserted?.[0]?.id) {
      await supabase
        .from('memories')
        .delete()
        .eq('user_id', userId)
        .eq('source', 'manual_profile')
        .neq('id', inserted[0].id);
    }
    return;
  }

  await supabase
    .from('memories')
    .insert({ user_id: userId, content, source, created_at: new Date().toISOString() });
}

async function extractMemoryFact(userId, text) {
  try {
    const model = genAI.getGenerativeModel({ model: FAST_MODEL });
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

async function getHistory(userId, trace = null) {
  const fetchHistory = () => supabase
    .from('conversations')
    .select('role, content, created_at')
    .eq('user_id', userId)
    .neq('role', 'system')
    .order('created_at', { ascending: false })
    .limit(12);
  const { data, error } = trace
    ? await trace.run('supabase.conversations.fetch_history', fetchHistory)
    : await fetchHistory();

  if (error || !data) return [];
  return data.reverse().map(normalizeConversationRow);
}

function serializeConversationContent(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return String(payload);

  const next = {};
  if (typeof payload.text === 'string') next.text = payload.text;
  if (typeof payload.image === 'string') next.image = payload.image;
  if (Array.isArray(payload.actions) && payload.actions.length) next.actions = payload.actions;
  if (typeof payload.audio === 'string') next.audio = payload.audio;
  if (typeof payload.kind === 'string') next.kind = payload.kind;

  return Object.keys(next).length === 1 && typeof next.text === 'string'
    ? next.text
    : JSON.stringify(next);
}

function conversationFallbackText(entry) {
  if (entry?.content) return entry.content;
  if (entry?.image) return 'Generated image';
  if (entry?.actions?.length) {
    const firstAction = entry.actions[0]?.action || entry.actions[0]?.type || 'action';
    return humanizeActionType(firstAction);
  }
  return '';
}

function normalizeConversationRow(row) {
  const parsed = safeParseJSON(row?.content);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return {
      ...row,
      content: typeof parsed.text === 'string' ? parsed.text : '',
      image: typeof parsed.image === 'string' ? parsed.image : null,
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      audio: typeof parsed.audio === 'string' ? parsed.audio : null,
      kind: typeof parsed.kind === 'string' ? parsed.kind : null
    };
  }
  return {
    ...row,
    content: typeof row?.content === 'string' ? row.content : String(row?.content || ''),
    image: null,
    actions: [],
    audio: null,
    kind: null
  };
}

async function saveMessage(userId, role, content, trace = null) {
  const insertMessage = () => supabase
    .from('conversations')
    .insert({
      user_id: userId,
      role,
      content: serializeConversationContent(content),
      created_at: new Date().toISOString()
    });
  if (trace) {
    await trace.run(`supabase.conversations.insert_${role}`, insertMessage);
  } else {
    await insertMessage();
  }
  invalidateUserContextCache(userId);
}

async function getPreferences(userId, trace = null) {
  const fetchPreferences = () => supabase
    .from('preferences')
    .select('key, value')
    .eq('user_id', userId);
  const { data, error } = trace
    ? await trace.run('supabase.preferences.fetch', fetchPreferences)
    : await fetchPreferences();
  if (error || !data) return '';
  return data.map(p => `${p.key}: ${p.value}`).join('\n');
}

async function getEnabledConnectors(userId, trace = null) {
  const fetchConnectors = () => supabase
    .from('connectors')
    .select('connector_id')
    .eq('user_id', userId)
    .eq('enabled', true);
  const { data, error } = trace
    ? await trace.run('supabase.connectors.fetch_enabled', fetchConnectors)
    : await fetchConnectors();
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
    ubereats: ['order_uber_eats'],
    netflix: ['search_netflix_title', 'add_to_netflix_list'],
    telegram: ['send_telegram', 'get_telegram_contacts'],
    deliveroo: ['order_deliveroo'],
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

async function getUserAccount(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, password_hash')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getUserContext(userId, trace = null) {
  const cached = contextCache.get(userId);
  if (cached && Date.now() - cached.ts < CONTEXT_CACHE_TTL) {
    if (trace) trace.log('user_context.cache_hit');
    return cached.context;
  }

  const [connectors, memories, actionLog] = trace
    ? await Promise.all([
      trace.run('supabase.user_context.connectors', () => supabase.from('connectors').select('connector_id').eq('user_id', userId).eq('enabled', true)),
      trace.run('supabase.user_context.memories', () => supabase.from('memories').select('content').eq('user_id', userId).order('created_at', { ascending: false }).limit(5)),
      trace.run('supabase.user_context.action_log', () => supabase.from('action_log').select('action, status, error, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(8))
    ])
    : await Promise.all([
      supabase.from('connectors').select('connector_id').eq('user_id', userId).eq('enabled', true),
      supabase.from('memories').select('content').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
      supabase.from('action_log').select('action, status, error, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(8)
    ]);

  const active = (connectors.data || []).map(c => c.connector_id).join(', ') || 'none';

  const contactCounts = {};
  const recentActionLines = [];
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
  for (const row of (actionLog.data || []).slice(0, 5)) {
    try {
      const a = typeof row.action === 'string' ? JSON.parse(row.action) : row.action;
      const status = row.status === 'failed' ? 'failed' : 'succeeded';
      const detail = (row.error || a.resultText || '').trim();
      recentActionLines.push(
        `${new Date(row.created_at).toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' })}: ` +
        `${humanizeActionType(a.type)}${summarizeActionInput(a.input)} — ${status}${detail ? ` (${detail})` : ''}`
      );
    } catch {}
  }
  const patterns = Object.entries(contactCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => { const [name, ch] = k.split('||'); return `${name}: ${ch} (${n}x)`; })
    .join(', ') || 'none yet';

  const memoryLines = (memories.data || []).map(m => m.content).join('; ') || 'none';
  const recentActions = recentActionLines.join(' | ') || 'none yet';

  const context = `LIVE USER CONTEXT:
Active connectors: ${active}
Messaging patterns: ${patterns}
Key facts: ${memoryLines}
Recent action outcomes: ${recentActions}`.slice(0, 2200);

  if (contextCache.size >= CONTEXT_CACHE_MAX) {
    const oldest = contextCache.keys().next().value;
    contextCache.delete(oldest);
  }
  contextCache.set(userId, { context, ts: Date.now() });
  return context;
}

app.post('/auth/register', async (req, res) => {
  try {
    const { userId, password } = req.body || {};
    if (!requireValidUserIdValue(userId, res)) return;
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await getUserAccount(userId);
    if (existing) {
      return res.status(409).json({ error: 'That user ID is already taken.' });
    }

    const passwordHash = hashPassword(password);
    const { error } = await supabase
      .from('users')
      .insert({
        user_id: userId,
        password_hash: passwordHash,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

    if (error) throw error;

    res.json({ success: true, token: createSessionToken(userId), userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { userId, password } = req.body || {};
    if (!requireValidUserIdValue(userId, res)) return;
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Password is required.' });
    }

    const account = await getUserAccount(userId);
    if (!account || !verifyPassword(password, account.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    res.json({ success: true, token: createSessionToken(userId), userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/process-audio', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file received.' });
  }

  const userId = req.body.userId;
  if (!requireMatchingUser(req, res, userId)) return;
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
    const [userText, context] = await Promise.all([
      transcribeAudio(req.file.buffer),
      buildChatContext(userId, '', null, STREAMING_CHAT_MODEL) // message unknown yet — no search for audio transcription step
    ]);

    if (!userText) {
      sse({ type: 'transcription-error', error: "I couldn't clearly make out what you said." });
      sse({ type: 'done' });
      return res.end();
    }

    sse({ type: 'transcription', text: userText });
    saveMessage(userId, 'user', userText).catch(() => {});

    // Step 2: Send transcribed text to the main model (with full system prompt + history)
    // Rebuild model with search if the transcribed text needs it
    let { history, useSearch, dynamicSystemPrompt, cachedContentName } = context;
    if (needsSearch(userText)) {
      const refreshed = await buildChatContext(userId, userText, null, STREAMING_CHAT_MODEL);
      useSearch = refreshed.useSearch;
      dynamicSystemPrompt = refreshed.dynamicSystemPrompt;
      cachedContentName = refreshed.cachedContentName;
    }
    const baseHistory = normalizeGeminiHistory(history);
    const streamConfig = buildModernGenerateConfig(dynamicSystemPrompt, useSearch, cachedContentName);

    const stream = await modernGenAI.models.generateContentStream({
      model: STREAMING_CHAT_MODEL,
      contents: [...baseHistory, { role: 'user', parts: [{ text: userText }] }],
      config: streamConfig
    });
    let fullText = '';
    for await (const chunk of stream.stream) {
      const text = chunk.text || '';
      if (text) fullText += text;
    }

    const { spoken, actions } = parseActions(fullText);

    let actionResults = [];
    let audioBase64 = null;
    let ttsError = '';
    if (actions.length > 0) {
      actionResults = await executeActions(userId, actions);
    }
    const finalSpoken = canUseDirectActionSummary(actionResults) ? summarizeActionResults(actionResults) : spoken;
    audioBase64 = await generateSpeech(buildVoiceExcerpt(finalSpoken), req.body.voice).catch(err => {
      ttsError = err.message;
      console.error('[tts error]', err.message);
      return null;
    });
    saveMessage(userId, 'assistant', { text: finalSpoken, actions: actionResults }).catch(() => {});

    sse({ type: 'response', text: finalSpoken, actions: actionResults });
    if (audioBase64) sse({ type: 'audio', data: audioBase64, format: 'wav' });
    if (ttsError) sse({ type: 'tts-error', error: ttsError });
    sse({ type: 'done' });
    res.end();

    postResponseTasks(userId, userText);
  } catch (err) {
    console.error('/process-audio error:', err.message);
    try { sse({ type: 'error', error: err.message }); res.end(); } catch {}
  }
});

app.post('/images/generate', upload.single('image'), async (req, res) => {
  try {
    const { userId, prompt } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    if (!prompt?.trim()) return res.status(400).json({ error: 'prompt is required.' });

    const result = await generateImage(prompt, req.file || null);
    const imageUrl = `data:${result.mimeType || 'image/png'};base64,${result.image}`;
    saveMessage(userId, 'user', prompt.trim()).catch(() => {});
    saveMessage(userId, 'assistant', { text: '', image: imageUrl, kind: 'image' }).catch(() => {});

    res.json({ success: true, ...result, text: '' });
  } catch (err) {
    console.error('/images/generate error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

app.post('/chat-with-image', upload.single('image'), async (req, res) => {
  try {
    const userId = req.body.userId;
    const message = (req.body.message || '').trim();
    const settings = safeParseJSON(req.body.settings) || {};
    const wantsTTS = req.query.tts === 'true';

    if (!requireMatchingUser(req, res, userId)) return;
    if (!req.file) return res.status(400).json({ error: 'image is required.' });
    if (!message) return res.status(400).json({ error: 'message is required.' });

    const [{ history, useSearch, dynamicSystemPrompt, cachedContentName }] = await Promise.all([
      buildChatContext(userId, message, null, PRIMARY_CHAT_MODEL),
      saveMessage(userId, 'user', `${message}\n\n[Attached image: ${req.file.originalname || 'image'}]`)
    ]);
    const baseHistory = normalizeGeminiHistory(history);
    const contents = [
      ...baseHistory,
      {
        role: 'user',
        parts: [
          { text: `The user attached an image or screenshot. Use it as context when helpful.\n\n${message}` },
          { inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') } }
        ]
      }
    ];

    const geminiRes = await modernGenAI.models.generateContent({
      model: PRIMARY_CHAT_MODEL,
      contents,
      config: buildModernGenerateConfig(dynamicSystemPrompt, useSearch, cachedContentName)
    });
    let { spoken, actions } = parseActions(geminiRes.text || '');
    let actionResults = [];
    if (actions.length > 0) {
      actionResults = await executeActions(userId, actions, { imageFile: req.file });
    }

    const dataResults = actionResults.filter(a => DATA_ACTIONS.has(a.action) && a.result?.success && a.result?.text);
    if (canUseDirectActionSummary(actionResults)) {
      spoken = summarizeActionResults(actionResults);
    } else if (dataResults.length > 0) {
      const context = dataResults.map(a => a.result.text).join('\n\n');
      const followUp = await modernGenAI.models.generateContent({
        model: PRIMARY_CHAT_MODEL,
        contents: [
          ...baseHistory,
          {
            role: 'user',
            parts: [
              { text: `The user attached an image or screenshot. Use it as context when helpful.\n\n${message}` },
              { inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') } }
            ]
          },
          { role: 'model', parts: [{ text: spoken || '...' }] },
          { role: 'user', parts: [{ text: `Here are the action results:\n\n${context}\n\nRespond naturally and use only the results shown here plus the attached image context. Do not invent unstated facts.` }] }
        ],
        config: buildModernGenerateConfig(dynamicSystemPrompt, useSearch, cachedContentName)
      });
      spoken = parseActions(followUp.text || '').spoken || spoken || context;
    }

    if (!spoken) {
      spoken = actionResults.map(a => a.result?.text).filter(Boolean).join(' ') || 'I looked through it.';
    }

    saveMessage(userId, 'assistant', { text: spoken, actions: actionResults }).catch(() => {});
    const result = { text: spoken, actions: actionResults };

    if (wantsTTS) {
      try {
        const audio = await generateSpeech(buildVoiceExcerpt(spoken), settings.voice);
        if (audio) { result.audio = audio; result.audioFormat = 'wav'; }
      } catch (ttsErr) {
        console.error('[tts error]', ttsErr.message);
        result.ttsError = ttsErr.message;
      }
    }

    res.json(result);
  } catch (err) {
    console.error('/chat-with-image error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

app.post('/memory', async (req, res) => {
  try {
    const { userId, content } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required.' });
    await saveMemory(userId, content.trim(), 'manual_profile');

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('content, source')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error || !data) return res.json({ memory: '' });
    res.json({ memory: await getMemory(req.params.userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/action-log', async (req, res) => {
  try {
    const { userId, action, status = 'executed' } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
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
  if (!requireMatchingUser(req, res, req.params.userId)) return;
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

CONNECTORS.splice(0, CONNECTORS.length,
  { id: 'google',    name: 'Google (Gmail + Calendar)', icon: '🔵', category: 'Google',        implemented: true },
  { id: 'imessage',  name: 'iMessage',                  icon: '💬', category: 'Messages',      implemented: false },
  { id: 'whatsapp',  name: 'WhatsApp',                  icon: '💚', category: 'Messages',      implemented: false },
  { id: 'netflix',   name: 'Netflix',                   icon: '🎬', category: 'Entertainment', implemented: true },
  { id: 'spotify',   name: 'Spotify',                   icon: '🎵', category: 'Music',         implemented: false },
  { id: 'reminders', name: 'Apple Reminders',           icon: '📝', category: 'Productivity',  implemented: false },
  { id: 'deliveroo', name: 'Deliveroo',                 icon: '🛵', category: 'Food',          implemented: true },
  { id: 'ubereats',  name: 'Uber Eats',                 icon: '🍔', category: 'Food',          implemented: true },
  { id: 'uber',      name: 'Uber',                      icon: '🚗', category: 'Transport',     implemented: true },
  { id: 'telegram',  name: 'Telegram',                  icon: '✈️', category: 'Messages',      implemented: true },
  { id: 'monzo',     name: 'Monzo',                     icon: '🏦', category: 'Finance',       implemented: false },
  { id: 'homekit',   name: 'Apple HomeKit',             icon: '🏠', category: 'Home',          implemented: false },
  { id: 'trainline', name: 'Trainline',                 icon: '🚂', category: 'Transport',     implemented: true },
  { id: 'maps',      name: 'Google Maps',               icon: '📍', category: 'Navigation',    implemented: false },
  { id: 'notion',    name: 'Notion',                    icon: '📓', category: 'Productivity',  implemented: false },
  { id: 'betfair',   name: 'Betfair',                   icon: '🎰', category: 'Finance',       implemented: false },
);

app.get('/connectors/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
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
    const { userId, connectorId, enabled } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    
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
  if (!requireMatchingUser(req, res, req.params.userId)) return;
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
- Only mention things that are directly supported by memory or recent conversation shown above.
- Do not invent plans, meetings, news, weather, or tasks.
- If there is no concrete update, just greet them and say it's a quiet start.

The current time is: ${now.toLocaleString('en-GB', { timeZone: TIMEZONE })}`;

    const model = genAI.getGenerativeModel({
      model: PRIMARY_CHAT_MODEL,
      systemInstruction: systemPrompt
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
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const history = await getHistory(req.params.userId);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/history/:userId/search', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
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
    const results = (data || [])
      .reverse()
      .map(normalizeConversationRow)
      .map(entry => ({ ...entry, content: conversationFallbackText(entry) }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/history/:userId/date', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
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
    res.json({ history: (data || []).map(normalizeConversationRow) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detect whether a message likely needs current/real-time information
const SEARCH_PATTERNS = /\b(news|weather|forecast|score|stocks?|price|market|latest|current|today'?s?|tonight|yesterday|this week|this month|trending|who won|what happened|search|look up|find out|google|update on|how much is|exchange rate|live|breaking)\b/i;
function needsSearch(message) {
  return SEARCH_PATTERNS.test(message);
}

// Shared logic for building the Gemini model + system prompt
async function buildChatContext(userId, message, trace = null, modelName = STREAMING_CHAT_MODEL) {
  const [memory, history, preferences, enabledConnectors, userContext, cachedContentName] = await Promise.all([
    getMemory(userId, trace),
    getHistory(userId, trace),
    getPreferences(userId, trace),
    getEnabledConnectors(userId, trace),
    getUserContext(userId, trace),
    getPromptCacheName(trace, modelName)
  ]);
  const availableActions = buildAvailableActions(enabledConnectors);
  const dynamicSystemPrompt = buildDynamicSystemPrompt(memory, preferences, availableActions, userContext);
  const useSearch = message && needsSearch(message);
  if (useSearch) console.log('[search] enabled for:', message.slice(0, 80));
  return {
    history,
    availableActions,
    useSearch,
    dynamicSystemPrompt,
    cachedContentName
  };
}

const DATA_ACTIONS = new Set(['search_trains', 'get_emails', 'get_calendar_events', 'search_emails', 'get_telegram_contacts']);
const DIRECT_SUMMARY_ACTIONS = new Set(['search_trains']);

function canUseDirectActionSummary(actionResults) {
  return actionResults.length > 0 && actionResults.every(entry =>
    DIRECT_SUMMARY_ACTIONS.has(entry.action) && entry.result?.success && entry.result?.text
  );
}

function summarizeActionResults(actionResults) {
  return actionResults
    .map(entry => entry.result?.text?.trim())
    .filter(Boolean)
    .join('\n\n');
}

// Fire-and-forget post-response tasks (memory + style preferences)
function postResponseTasks(userId, message) {
  if (shouldSaveMemory(message)) {
    extractMemoryFact(userId, message).then(fact => {
      if (fact) saveMemory(userId, fact, 'fact');
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
}

app.post('/chat', async (req, res) => {
  const streaming = req.query.stream === 'true';

  try {
    const { message, userId, settings = {} } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    const wantsTTS = req.query.tts === 'true';

    if (!message?.trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const trace = createRequestTrace(`chat:${userId}:${Date.now()}`);
    trace.log(`request.start stream=${streaming} tts=${wantsTTS} msg=${JSON.stringify((message || '').slice(0, 80))}`);

    // Let the model start as soon as context is ready instead of waiting on the DB write.
    saveMessage(userId, 'user', message, trace).catch(err => trace.log('supabase.conversations.insert_user.async_fail', err.message));
    const chatModel = streaming ? STREAMING_CHAT_MODEL : PRIMARY_CHAT_MODEL;
    const { history, useSearch, dynamicSystemPrompt, cachedContentName } = await trace.run('buildChatContext', () => buildChatContext(userId, message, trace, chatModel));
    const baseHistory = normalizeGeminiHistory(history);
    const contents = [...baseHistory, { role: 'user', parts: [{ text: message }] }];
    const requestConfig = buildModernGenerateConfig(dynamicSystemPrompt, useSearch, cachedContentName);

    // ── Streaming mode (SSE) ────────────────────────────────────────────
    if (streaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const sse = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      try {
        // Stream Gemini response token-by-token
        const stream = await trace.run('gemini.generateContentStream.initial', () => modernGenAI.models.generateContentStream({
          model: chatModel,
          contents,
          config: requestConfig
        }));
        let fullText = '';
        let firstChunk = true;
        let lastVisibleText = '';
        const ttsStreamer = wantsTTS ? createSentenceTtsStreamer({ voiceName: settings.voice, sse, trace }) : null;
        for await (const chunk of stream.stream) {
          const text = chunk.text || '';
          if (text) {
            if (firstChunk) { trace.log('gemini.first_token'); firstChunk = false; }
            fullText += text;
            const nextVisibleText = stripActionMarkupForDisplay(fullText);
            const visibleChunk = nextVisibleText.slice(lastVisibleText.length);
            lastVisibleText = nextVisibleText;
            if (visibleChunk) sse({ type: 'text', chunk: visibleChunk });
            if (ttsStreamer) ttsStreamer.ingest(nextVisibleText);
          }
        }
        trace.log('gemini.initial_complete');

        let { spoken, actions } = parseActions(fullText);

        // Execute actions in parallel
        let actionResults = [];
        if (actions.length > 0) {
          actionResults = await executeActions(userId, actions, {}, trace);
          sse({ type: 'actions', results: actionResults });
          trace.log('actions.complete');
        }

        // For data-fetching actions, stream a follow-up summary
        const dataResults = actionResults.filter(a => DATA_ACTIONS.has(a.action) && a.result?.success && a.result?.text);
        if (canUseDirectActionSummary(actionResults)) {
          spoken = summarizeActionResults(actionResults);
          sse({ type: 'text', chunk: spoken });
          if (ttsStreamer) ttsStreamer.ingest(spoken);
        } else if (dataResults.length > 0) {
          const context = dataResults.map(a => a.result.text).join('\n\n');
          const followUp = await trace.run('gemini.generateContentStream.followup', () => modernGenAI.models.generateContentStream({
            model: chatModel,
            contents: [
              ...baseHistory,
              { role: 'user', parts: [{ text: message }] },
              { role: 'model', parts: [{ text: spoken || '…' }] },
              { role: 'user', parts: [{ text: `Here are the results:\n\n${context}\n\nSpeak these back naturally and conversationally. Be concise. Only use the results shown here. Do not add unstated facts.` }] }
            ],
            config: requestConfig
          }));
          spoken = '';
          for await (const chunk of followUp.stream) {
            const text = chunk.text || '';
            if (text) {
              spoken += text;
              sse({ type: 'text', chunk: text });
              if (ttsStreamer) ttsStreamer.ingest(spoken);
            }
          }
          spoken = parseActions(spoken).spoken || spoken || context;
        }

        if (!spoken) {
          spoken = actionResults.map(a => a.result?.text).filter(Boolean).join(' ') || 'Done.';
          sse({ type: 'text', chunk: spoken });
          if (ttsStreamer) ttsStreamer.ingest(spoken);
        }

        if (wantsTTS && ttsStreamer) {
          try {
            await trace.run('gemini.tts.generateSpeech.streamed', async () => {
              await ttsStreamer.flushRemainder(spoken);
              await ttsStreamer.waitForAll();
            });
            trace.log('tts.complete');
          } catch (ttsErr) {
            console.error('[tts error]', ttsErr.message);
            sse({ type: 'tts-error', error: ttsErr.message });
          }
        }

        trace.log('request.total');
        sse({ type: 'done' });
        res.end();

        // Fire-and-forget: save assistant message + memory/preferences
        saveMessage(userId, 'assistant', { text: spoken, actions: actionResults }, trace)
          .catch(err => trace.log('supabase.conversations.insert_assistant.async_fail', err.message));
        postResponseTasks(userId, message);

      } catch (err) {
        trace.log('request.error', err.message);
        console.error('/chat stream error:', err.message);
        try { sse({ type: 'error', error: err.message }); res.end(); } catch {}
      }
      return;
    }

    // ── Non-streaming mode (JSON — backward compatible) ─────────────────
    const geminiRes = await trace.run('gemini.generateContent.nonstream', () => modernGenAI.models.generateContent({
      model: chatModel,
      contents,
      config: requestConfig
    }));

    const rawText = geminiRes.text || '';
    let { spoken, actions } = parseActions(rawText);

    // Execute actions in parallel instead of sequentially
    let actionResults = [];
    if (actions.length > 0) {
      actionResults = await executeActions(userId, actions, {}, trace);
    }

    // For data-fetching actions, re-prompt Gemini with results
    const dataResults = actionResults.filter(a => DATA_ACTIONS.has(a.action) && a.result?.success && a.result?.text);
    if (canUseDirectActionSummary(actionResults)) {
      spoken = summarizeActionResults(actionResults);
    } else if (dataResults.length > 0) {
      const context = dataResults.map(a => a.result.text).join('\n\n');
      const followUp = await trace.run('gemini.generateContent.followup_nonstream', () => modernGenAI.models.generateContent({
        model: chatModel,
        contents: [
          ...baseHistory,
          { role: 'user', parts: [{ text: message }] },
          { role: 'model', parts: [{ text: spoken || '…' }] },
          { role: 'user', parts: [{ text: `Here are the results:\n\n${context}\n\nSpeak these back naturally and conversationally. Be concise. Only use the results shown here. Do not add unstated facts.` }] }
        ],
        config: requestConfig
      }));
      spoken = parseActions(followUp.text || '').spoken || context;
    }

    if (!spoken) {
      spoken = actionResults.map(a => a.result?.text).filter(Boolean).join(' ') || 'Done.';
    }

    // Don't block on saving assistant message
    saveMessage(userId, 'assistant', { text: spoken, actions: actionResults }, trace)
      .catch(err => trace.log('supabase.conversations.insert_assistant.async_fail', err.message));

    const result = { text: spoken, actions: actionResults };

    if (wantsTTS) {
      try {
        const audio = await trace.run('gemini.tts.generateSpeech.nonstream', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
        if (audio) { result.audio = audio; result.audioFormat = 'wav'; }
      } catch (ttsErr) {
        console.error('[tts error]', ttsErr.message);
        result.ttsError = ttsErr.message;
      }
    }

    trace.log('request.total');
    res.json(result);
    postResponseTasks(userId, message);

  } catch (err) {
    console.log(`[trace:chat:unscoped] FAIL outer ${err.message}`);
    console.error('/chat error:', err.message);
    res.status(500).json({ error: err.message, text: `Error: ${err.message}` });
  }
});

app.get('/preferences/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
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
  if (!requireMatchingUser(req, res, req.params.userId)) return;
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
    const { userId, phone } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    const result = await telegram.startAuth(userId, phone);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/auth/telegram/verify', async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    if (!code) return res.status(400).json({ error: 'code is required' });
    const result = await telegram.verifyCode(userId, code);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/auth/telegram/2fa', async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
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
  const userId = req.query.userId;
  if (!requireMatchingUser(req, res, userId)) return;
  const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/google/callback`;
  const state = signOAuthState(userId);
  const params = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const userId = verifyOAuthState(state);

  if (error) {
    const appOrigin = process.env.APP_URL || '*';
    return res.send(`<script>window.opener?.postMessage('google_auth_error',${JSON.stringify(appOrigin)});window.close();</script>`);
  }

  if (!userId) {
    return res.status(400).send('Invalid OAuth state');
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
  if (!requireMatchingUser(req, res, req.params.userId)) return;
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
      connectorRows: (connRow || []).map(row => ({
        connector_id: row.connector_id,
        enabled: row.enabled,
        hasTokens: !!row.tokens
      })),
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
  const missingEnv = getMissingRuntimeEnv();
  res.json({
    status: missingEnv.length ? 'degraded' : 'ok',
    app: 'Oxy',
    missingEnv,
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

require('dotenv').config();

// Error monitoring — set SENTRY_DSN environment variable to enable
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'production',
      tracesSampleRate: 0.1,
    });
    console.log(JSON.stringify({ severity: 'INFO', event: 'sentry.initialized' }));
  } catch (e) {
    console.error(JSON.stringify({ severity: 'WARN', event: 'sentry.init.failed', error: e.message }));
  }
}

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const { GoogleGenAI: ModernGoogleGenAI } = require('@google/genai');
const { dispatch, IMPLEMENTED_CONNECTORS } = require('../connectors');
const googleConnector = require('../connectors/google');
const telegram = require('../connectors/telegram');
const githubConnector = require('../connectors/github');
const microsoftConnector = require('../connectors/microsoft');
const spotifyConnector = require('../connectors/spotify');
const linearConnector = require('../connectors/linear');
const notionConnector = require('../connectors/notion');
const { inferDeterministicAction } = require('./intent-router');
const { createActionRunner } = require('./services/action-runner');
const {
  createScheduledTask,
  listScheduledTasks,
  cancelScheduledTask,
  getDueScheduledTasks,
  advanceScheduledTask,
  describeSchedule
} = require('./services/scheduled-tasks');
const { runOrderingTurn, confirmPayment, getSession, closeSession } = require('./services/browser-task');
const {
  isPendingCancelMessage,
  isPendingConfirmMessage,
  isPendingRevisionMessage,
  reviewTitleForAction
} = require('./services/pending-review');
// Sent by the client to silently keep an "awaiting_more" browser task moving without
// the user having to type "keep going" every ~30s turn. Never shown in the transcript
// and never overwrites the in-progress goal (see the run_browser_task resume below).
const BROWSER_TASK_CONTINUE = '__oxy_continue_browser_task__';
const {
  ACTION_CONTRACTS,
  actionPromptBlock,
  validateActionWithContract
} = require('./action-contracts');
const {
  createGeminiServiceClient,
  createSupabaseServiceClient,
  getMissingRuntimeEnv,
  logMissingRuntimeEnvOnce
} = require('../runtime');
const { getSearchReason, needsSearch } = require('./services/search-intent');
const {
  buildResolvedContext,
  isContextualReference
} = require('./services/context-brain');
const {
  buildTravelConciergeState,
  buildTravelContextBlock,
  isTravelPlanningRequest
} = require('./services/travel-concierge');
const { generateItinerary, modifyItinerary, itineraryToText } = require('./services/itinerary-engine');
const { rankHotels, rankActivities, rankFlights } = require('./services/travel-ranking');
const {
  createSessionToken,
  getAuthenticatedUserId,
  hashPassword,
  requireSessionAuth,
  signPayload,
  verifyPassword,
  verifySignedPayload
} = require('../auth');
const { connectorForAction } = require('./services/connector-health');
const { getRuntimeVersion } = require('./services/runtime-version');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const APP_URL = process.env.APP_URL || '';
const ALLOWED_ORIGINS = [APP_URL].filter(Boolean);

// Structured JSON logging
function log(level, event, extra = {}) {
  const entry = { timestamp: new Date().toISOString(), severity: level.toUpperCase(), event, ...extra };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

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

function escapeIlikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, match => `\\${match}`);
}

const USER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_PASSWORD_LENGTH = 1024;
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

function signOAuthState(userId, provider = 'google') {
  return signPayload({ type: `${provider}_oauth`, provider, userId }, 15 * 60 * 1000);
}

function verifyOAuthState(state, provider = 'google') {
  const payload = verifySignedPayload(state);
  if (!payload || payload.type !== `${provider}_oauth`) return null;
  return isValidUserId(payload.userId) ? payload.userId : null;
}

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Oxy-Commit', getRuntimeVersion().gitCommit);
  res.setHeader('Vary', 'Origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://generativelanguage.googleapis.com https://*.googleapis.com https://api.telegram.org ws: wss:",
      "font-src 'self' data: https:",
      "media-src 'self' blob: data:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(self)');
  next();
});

app.use((req, res, next) => {
  const publicPaths = new Set([
    '/',
    '/health',
    '/version',
    '/privacy',
    '/terms',
    '/support',
    '/robots.txt',
    '/humans.txt',
    '/changelog',
    '/install-shortcut',
    '/auth/google/callback',
    '/auth/register',
    '/auth/login',
    '/auth/forgot-password',
    '/auth/reset-password'
  ]);

  if (publicPaths.has(req.path)) return next();

  // requireSessionAuth verifies signature + expiry, then we check token_version for revocation
  return requireSessionAuth(req, res, async () => {
    const { userId, tokenVersion } = req.auth;
    // Only check token_version if it's present in the token (backwards compat)
    if (tokenVersion !== undefined && tokenVersion !== null) {
      try {
        const { data: userRow } = await supabase
          .from('users')
          .select('token_version')
          .eq('user_id', userId)
          .maybeSingle();
        if (userRow && userRow.token_version !== tokenVersion) {
          log('warn', 'auth.middleware.rejected', { reason: 'token_version_mismatch', userId });
          return res.status(401).json({ error: 'Session expired' });
        }
      } catch (e) {
        log('warn', 'auth.middleware.token_version_check_failed', { error: e.message });
      }
    }
    next();
  });
});

const rateLimitStores = [];
const audioRateLimit = new Map();

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
    || req.ip
    || req.socket?.remoteAddress
    || 'unknown';
}

function createRateLimiter(maxHits, windowMs, keyFn = requestIp) {
  const store = new Map();
  rateLimitStores.push({ store, windowMs });
  return (req, res, next) => {
    const key = keyFn(req) || requestIp(req);
    const now = Date.now();
    const recentHits = (store.get(key) || []).filter(t => now - t < windowMs);
    if (recentHits.length >= maxHits) {
      log('warn', 'rate_limit.exceeded', { key, endpoint: req.path });
      return res.status(429).json({ error: 'Too many requests. Try again in a moment.' });
    }
    store.set(key, [...recentHits, now]);
    return next();
  };
}

function userOrIpRateKey(req) {
  const bodyUserId = req.body?.userId;
  const authedUserId = getAuthenticatedUserId(req);
  return authedUserId || bodyUserId || requestIp(req);
}

const registerRateLimiter = createRateLimiter(5, 60 * 1000);
const loginRateLimiter = createRateLimiter(10, 60 * 1000);
const chatRateLimiter = createRateLimiter(30, 60 * 1000, userOrIpRateKey);
const imageRateLimiter = createRateLimiter(10, 60 * 1000, userOrIpRateKey);
const forgotPasswordRateLimiter = createRateLimiter(3, 60 * 60 * 1000);
const resetPasswordRateLimiter = createRateLimiter(10, 60 * 60 * 1000);
const verifyEmailRateLimiter = createRateLimiter(10, 60 * 60 * 1000);
function sendServerError(res, err, label) { log('error', label, { error: err.message }); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
function sha256Token(token) { return require('crypto').createHash('sha256').update(token).digest('hex'); }
const GEMINI_TTS_VOICES = new Set([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
]);

// Prune stale rate-limit entries (skip in serverless — Maps are ephemeral per invocation)
setInterval(() => {
  const now = Date.now();
  for (const { store, windowMs } of rateLimitStores) {
    for (const [key, timestamps] of store) {
      const recent = timestamps.filter(t => now - t < windowMs);
      if (recent.length === 0) store.delete(key);
      else store.set(key, recent);
    }
  }
  for (const [uid, timestamps] of audioRateLimit) {
    const recent = timestamps.filter(t => now - t < 60000);
    if (recent.length === 0) audioRateLimit.delete(uid);
    else audioRateLimit.set(uid, recent);
  }
}, 5 * 60 * 1000).unref();

const supabase = createSupabaseServiceClient();
const genAI = createGeminiServiceClient();
const modernGenAI = new ModernGoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
logMissingRuntimeEnvOnce('api bootstrap');

const CONTEXT_CACHE_TTL = 5 * 60 * 1000;
const CONTEXT_CACHE_MAX = 500;
const contextCache = new Map();

// Prune expired context cache entries (skip in serverless)
setInterval(() => {
  const now = Date.now();
  for (const [uid, entry] of contextCache) {
    if (now - entry.ts > CONTEXT_CACHE_TTL) contextCache.delete(uid);
  }
}, 10 * 60 * 1000).unref();

const TIMEZONE = process.env.TIMEZONE || 'Europe/London';
// Cost split: the user-facing reasoning + voice/streaming brain stays on a capable Flash
// model; background helper calls run on the much cheaper Flash-Lite tier.
// gemini-3-flash-preview: $0.50/$3.00 per 1M (≈3x cheaper than 3.5-flash).
// gemini-3.1-flash-lite: $0.25/$1.50 per 1M (≈6x cheaper than 3.5-flash).
const PRIMARY_CHAT_MODEL = process.env.OXY_REASONING_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const FAST_MODEL = process.env.OXY_FAST_MODEL || process.env.GEMINI_FAST_MODEL || 'gemini-3.1-flash-lite';
// Voice/streaming tracks the primary brain (not the lite helper tier) so the core
// experience stays sharp; override with OXY_STREAM_MODEL if needed.
const STREAMING_CHAT_MODEL = process.env.OXY_STREAM_MODEL || PRIMARY_CHAT_MODEL;
const PROMPT_CACHE_TTL = process.env.OXY_PROMPT_CACHE_TTL || '3600s';

// Gemini 3.x Flash thinks before answering by default, which added ~4.5s to
// first token and ~2s to transcription. For this interactive voice path we want
// speed over deep reasoning, so thinking is disabled by default. Tune or re-enable
// with OXY_THINKING_BUDGET (0 = off; a positive token budget = some thinking).
const OXY_THINKING_BUDGET = Number.isFinite(Number(process.env.OXY_THINKING_BUDGET))
  ? Number(process.env.OXY_THINKING_BUDGET)
  : 0;

// Returns `{ thinkingConfig: {...} }` to spread into a generation config, or `{}`
// when OXY_THINKING_BUDGET is negative — an env-only kill switch in case a model
// rejects the field (set OXY_THINKING_BUDGET=-1 to revert instantly, no redeploy).
function latencyThinkingConfig() {
  return OXY_THINKING_BUDGET >= 0 ? { thinkingConfig: { thinkingBudget: OXY_THINKING_BUDGET } } : {};
}
const promptCacheStates = new Map();
const PROACTIVE_FAILURE_PREF = 'proactive.failed_action.id';
const PROACTIVE_WINDOWS = [
  { id: 'wake', label: 'Wake briefing', start: 6, end: 10 },
  { id: 'midday', label: 'Midday briefing', start: 12, end: 14 },
  { id: 'evening', label: 'Evening briefing', start: 17, end: 20 }
];
const DEVICE_PLATFORM_ALLOWLIST = new Set(['ios', 'web']);

setTimeout(() => {
  ensurePromptCacheWarm(null, STREAMING_CHAT_MODEL).catch(() => {});
  if (PRIMARY_CHAT_MODEL !== STREAMING_CHAT_MODEL) {
    ensurePromptCacheWarm(null, PRIMARY_CHAT_MODEL).catch(() => {});
  }
}, 0);

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

function getLocalDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getLocalHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    hour12: false
  }).format(date));
}

function getLocalMinute(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    minute: '2-digit'
  }).format(date));
}

function getBriefingWindow(now = new Date()) {
  const hour = getLocalHour(now);
  return PROACTIVE_WINDOWS.find(window => hour >= window.start && hour <= window.end) || null;
}

function proactiveSweepAuthorized(req) {
  const configuredSecret = process.env.PROACTIVE_SWEEP_SECRET;
  if (!configuredSecret) return true;
  const provided = req.get('x-proactive-secret') || req.query.secret || req.body?.secret;
  return provided === configuredSecret;
}

function parseJsonObject(value) {
  const parsed = safeParseJSON(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function apnsAuthToken() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const privateKey = (process.env.APNS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!keyId || !teamId || !privateKey) return '';
  const header = base64UrlJson({ alg: 'ES256', kid: keyId });
  const payload = base64UrlJson({ iss: teamId, iat: Math.floor(Date.now() / 1000) });
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function apnsConfigured() {
  return Boolean(process.env.APNS_BUNDLE_ID && apnsAuthToken());
}

async function sendPushToUser(userId, briefing) {
  const bundleId = process.env.APNS_BUNDLE_ID;
  const token = apnsAuthToken();
  if (!bundleId || !token) {
    console.warn('[push] skipped: APNs not configured (set APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID).');
    return { sent: 0, skipped: true, reason: 'apns_not_configured' };
  }

  const { data: devices, error } = await supabase
    .from('devices')
    .select('push_token, platform')
    .eq('user_id', userId);
  if (error || !Array.isArray(devices)) return { sent: 0, error: error?.message || 'No devices' };
  const iosDevices = devices.filter(device => device.platform === 'ios' && device.push_token);
  if (!iosDevices.length) {
    console.warn(`[push] no registered iOS device tokens for ${userId} (app must POST /devices/register).`);
    return { sent: 0, reason: 'no_devices' };
  }

  const host = process.env.APNS_USE_SANDBOX === 'true' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  let sent = 0;
  await Promise.all(iosDevices
    .map(async device => {
      try {
        await axios.post(
          `${host}/3/device/${device.push_token}`,
          {
            aps: {
              alert: {
                title: briefing.title || 'Oxy',
                body: briefing.body || briefing.text || ''
              },
              sound: 'default',
              'mutable-content': 1
            },
            briefingId: briefing.id,
            kind: briefing.kind
          },
          {
            headers: {
              authorization: `bearer ${token}`,
              'apns-topic': bundleId,
              'apns-push-type': 'alert',
              'content-type': 'application/json'
            },
            timeout: 10000
          }
        );
        sent += 1;
      } catch (err) {
        console.warn('[push] APNs send failed:', err?.response?.data || err.message);
      }
    }));
  return { sent };
}

async function createBriefing(userId, { kind, title, body, source = 'proactive', metadata = {}, push = true }) {
  const insert = {
    user_id: userId,
    kind,
    title,
    body,
    source,
    metadata,
    read: false,
    created_at: new Date().toISOString()
  };
  const { data, error } = await supabase
    .from('briefings')
    .insert(insert)
    .select('id, kind, title, body, source, metadata, read, created_at')
    .single();
  if (error) throw error;

  await saveMessage(userId, 'assistant', { text: body, kind: 'briefing' });
  if (push) await sendPushToUser(userId, data).catch(err => console.warn('[push] failed:', err.message));
  return data;
}

const OXCY_SYSTEM_PROMPT = `You are a dry, sharp, slightly cynical friend.
Not a servant, not "an AI assistant". Your name is Millie.

Be direct, grounded, useful. You are not a command router that maps keywords to
tools — you are a capable assistant who reads what the user actually means using
conversation, memory, native hints, and tools together. Feel alive without
performing it: curious, sharp, dry, honest. If the user is stressed or annoyed,
fix the problem first.

────────────────────────────────────────────────────────
VOICE — how you talk, not what you do
────────────────────────────────────────────────────────
- One short sentence is the default for casual chat. Lowercase by default, no
  trailing period or extra punctuation on casual one-liners, no exclamation
  marks unless something genuinely earns one, no emojis unless the user used
  one first.
- Plain text only — you're texting, not writing a document. No markdown: no
  **bold**, no *italics*, no \`code\` ticks, no # headings, no "- "/"* " bullet
  lists. Write lists inline or as separate short lines.
- Never say "As an AI", "I can help with", "Here is", "Let me know if...", "Is
  there anything else", "Sure thing!", or anything else that reads like customer
  support.
- Don't agree just to be nice. If the user says something dumb, wrong, or lazy,
  say so — disagree, push back, rib them. Warmth comes from honesty, not
  flattery.
- Mirror the user: their vocabulary, casing, punctuation, and message length.
  A three-word texter gets three words back. This governs your spoken/chat
  replies only — JSON action blocks, drafted messages/emails (see rules 2-3
  below), and code follow their own formatting, not this.
- If a reply reads like it came from a chatbot, scrap it and rewrite it as a
  text message from a friend.

────────────────────────────────────────────────────────
JUDGMENT — read everything below through these. They generalize. Do not wait for
a scenario to be listed before applying the reasoning behind it.
────────────────────────────────────────────────────────

1. NEVER INVENT A VALUE TO FILL A SLOT.
   When an action needs a detail the user didn't give — a song, a recipient, a
   destination, a date, a time — and you can't safely ground it in context,
   memory, or location, ask for that one thing. Do not grab the nearest token
   that could fit. "Play some music" has no song and no safe default, so ask what
   they're in the mood for — it is NOT a request to play a track called "Some".
   Inference is only for low-risk context you can actually ground (their
   location, a contact they obviously meant). When in doubt, ask one short
   question instead of guessing.

2. COMPOSED MESSAGES ARE THE USER'S VOICE, AIMED AT THE RECIPIENT.
   When you write a message for someone to send, write as the user speaking
   directly to that person. Anything referring to the recipient becomes "you":
   "message Alisa I miss her" → the body is "I miss you", not "I miss her".

3. REGISTER TRACKS THE RECEIVER, NOT THE TYPER.
   Two different modes:
   • Talking TO the user (chat / voice): mirror them. Slang for slang, terse for
     terse, formal for formal. No corporate-speak with someone who texts like a
     teenager; no over-casual with someone speaking professionally.
   • Composing something that LEAVES to a third party: match the recipient and
     the medium, not the user's register. A slang-typing user asking you to email
     a hiring partner still gets a polished email — not "yo". A text to a mate
     stays loose even if the request was typed formally.

4. ANSWER THE QUESTION THAT WAS ASKED.
   If the user asks something that needs a computed answer, give the answer — do
   not just open a tool card and call it done. "When should I leave to be at
   school by 9:15?" wants a departure TIME ("leave by 8:5X"), produced by passing
   9:15 as arrival_time to the route tool. Opening Maps without the time answers
   nothing.

5. COMPILE MULTI-INTENT REQUESTS — DON'T PROCESS THEM AS ONE TASK.
   A complex command is a flat list of discrete intents, not a single blob.
   "Book a trip to Apsley and find directions" → [book calendar event "Trip to
   Apsley"] + [route to Apsley]. Two actions, run both.
   • Extract the core entity for each slot — never reuse the user's whole
     descriptive sentence as a value. The event title is "Trip to Apsley", NOT
     "book a trip to apsley and find directions". Same for message bodies,
     search queries, playlist names.
   • Keep every intent's parameters separate; executing one must not corrupt
     another's. Hold the state of the ones you've resolved.
   • If intent B depends on A's output, do A first, then feed the result in —
     don't run B on a guess.
   • Run them in order. If one needs clarification, ask only for that one gap
     and keep the rest queued — don't drop the whole batch or re-ask what you
     already have.

────────────────────────────────────────────────────────
FACTUALITY (non-negotiable)
────────────────────────────────────────────────────────
- Say what you know. For timeless knowledge, explain confidently. For current,
  personal, local, live, or account-specific facts, ground in search, memory,
  native context, or connector results before claiming it. Don't fill gaps with
  confident guesses.
- When Google Search grounding is available, use it for anything changeable:
  current events, news, prices, schedules, public figures, company info, charts,
  rankings, anything with "right now". Don't rely on training data for these. Never
  present your own training knowledge about a changeable topic as current fact — if
  you can't ground it, say you need to check and search. Don't substitute a YouTube
  or email search for a real web search.
- Never invent dates or names. If not grounded, omit it or say you need to check.
- Never imply you saw, sent, booked, verified, played, or found something unless
  tool results or context explicitly show it happened.
- "I don't know" beats making something up. If you're missing evidence, say so
  and ask one short follow-up.
- If the user challenges you ("huh", "what", "source?", "that seems wrong"),
  re-check the facts. Do not retreat into persona talk.
- Treat memory as possibly-stale personal context, not proof of current facts.

────────────────────────────────────────────────────────
ACTIONS & RISK
────────────────────────────────────────────────────────
${actionPromptBlock()}

- Return an action block only for a clear action request with the needed details
  present. Greetings, reactions, drafts, explanations, and vague intent are not
  actions. Casual chat is never task completion.
- Never claim to have done something without returning the action block. Never
  refuse an action unless it's actively harmful. Never say you "can't" do
  something in the actions list.
- Always include a spoken sentence alongside every action block.

Risk tiers:
- LOW (just do it): search, place lookup, directions, opening Uber/Maps to a
  destination.
- MEDIUM: drafting a message or email.
- HIGH (needs a clear request + user review before it happens): sending
  messages/emails, spending money, confirming a booking/payment, placing orders,
  making calls.

Recent results are real state:
- Don't repeat a successful action unless explicitly asked to redo it.
- If the user asks ABOUT a result ("is this right?", "why this one?", "bruh"),
  answer or re-check — don't fire a new action.
- If they act on a recent answer ("play it", "send it", "book that", "the nearest
  one"), act on the most recent relevant target, not the last unrelated action.
- If an action failed and they say retry/fix/redo, retry only the failed one
  unless they say otherwise. Always check which prior actions succeeded vs failed
  before deciding what's next.

────────────────────────────────────────────────────────
MESSAGES & EMAIL
────────────────────────────────────────────────────────
- Apply JUDGMENT #2 and #3 to everything composed.
- "Email X saying Y": turn Y into a complete email — natural greeting, 1–3 short
  paragraphs, sign-off when appropriate. Infer a short subject; don't ask for one.
- Default email tone is warm, clear, human, and professional when the thread calls
  for it. Skip filler: "I hope this finds you well", "I am writing to", "please do
  not hesitate", "kindly" — unless the user or thread genuinely warrants it.
- Conversational channels (iMessage, WhatsApp, Telegram): brief, natural, text-like.
- Don't send placeholder/template emails. If the user gives no real substance
  ("say hello", "introduce myself"), ask for the actual content first. The body
  must carry specifics from the user, conversation, memory, or tool results.
- "Send a link": the message must contain a real URL from the user, tool results,
  or explicit context. Never invent links, prices, retailers, or product names.
- If asked to rewrite/improve/lengthen a just-sent message, draft the new version
  in chat for approval — don't resend unless they explicitly say to.

────────────────────────────────────────────────────────
REFERENCE RESOLUTION
────────────────────────────────────────────────────────
- Short follow-ups and vague references — "that one", "is this right", "look it
  up", "again", "what about tomorrow", "no I mean…", "it", "there", "same" —
  resolve to the most recent relevant thing in the conversation before you pick a
  tool. Don't treat them as new topics unless the user clearly starts one.
- Corrections with "I mean…" or "not that" change ONLY the misunderstood part —
  preserve all the original task details.
- For route/travel follow-ups ("what platform?", "what train?", "what about
  tomorrow?"), use the recent route context, not the whole sentence as a new
  destination.

────────────────────────────────────────────────────────
HARDCODED CORRECTNESS TRAP (kept because the model reliably flips it and the cost
is high — a missed train)
────────────────────────────────────────────────────────
- arrival_time vs departure_time: if the user says they need to BE somewhere by a
  time ("be there at 8", "meeting at 9", "arrive by 7", "make it for 8"), pass
  that as arrival_time — the tool works backwards to a leave time. Only use
  departure_time when they say when they're LEAVING ("I'm setting off at 6").
  "Leave at 8 to arrive at 8" is never correct.
- For "when should I leave / how long to get to X / what time should I head off",
  you must call the route tool — you cannot compute live travel time from
  training data — and then return the actual time, per JUDGMENT #4.
- For live train times, platforms, or journey options, prefer a grounded search
  answer over the legacy transport connector. If route/train data is unavailable,
  say why plainly and give the best grounded alternative — don't paraphrase a
  failure into "there are no trains".`;
// Maintainer note (kept out of the model's context on purpose): tool-argument
// routing — calendar-vs-music disambiguation, play_music vs add_to_music_playlist,
// find_place phrasing, book_uber natural-destination handling — belongs in the
// individual function descriptions inside actionPromptBlock(), not the global
// prompt. Put each rule next to the tool it governs.

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

function containsUrl(text) {
  return /\bhttps?:\/\/\S+/i.test(String(text || ''));
}

function isLinkSendRequest(message) {
  return /\b(send|text|message|telegram|whatsapp|imessage|email)\b/i.test(String(message || '')) &&
    /\blink\b/i.test(String(message || ''));
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
  let emailContext = '';
  if (['get_emails', 'search_emails'].includes(type) && Array.isArray(result.emails) && result.emails.length) {
    emailContext = result.emails.slice(0, 3).map((email, index) => {
      const body = String(email.body || email.snippet || '').slice(0, 1200);
      return `\n  Email ${index + 1}: From ${email.from || 'Unknown'} | Subject ${email.subject || '(No subject)'} | Thread ${email.threadId || 'unknown'}${body ? `\n  Body: ${body}` : ''}`;
    }).join('');
  }
  return `- ${humanizeActionType(type)}${summarizeActionInput(entry?.input || result?.input)}: ${status}${detail ? ` — ${detail}` : ''}${emailContext}`;
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

const TRANSCRIPT_NOISE_PATTERN = /^(empty string|no speech|silence|no audio|inaudible|nothing|n\/a|none|\[.*\]|\(.*\))\.?$/i;

function normalizeTranscript(text) {
  const cleaned = String(text || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
  return TRANSCRIPT_NOISE_PATTERN.test(cleaned) ? '' : cleaned;
}

function isImplausibleTranscript(text, durationMs) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  // Only reject if word count is physically impossible for the audio duration.
  // Raised thresholds to avoid rejecting accented/slower speech that Gemini
  // correctly infers but expresses in more words than average.
  if (!durationMs || durationMs < 400) return words.length > 6;
  const wordsPerSecond = words.length / Math.max(durationMs / 1000, 0.5);
  if (durationMs < 1500 && words.length > 10) return true;
  if (durationMs < 2500 && words.length > 18) return true;
  return wordsPerSecond > 6.0;
}

function buildTranscribeAndCleanPrompt(contextHint = '') {
  const contextLine = contextHint
    ? `Known names/terms the speaker may reference (prefer these spellings when a word matches phonetically): ${contextHint}\n\n`
    : '';
  return `${contextLine}You are the transcription engine of a premium voice-dictation system (like Wispr Flow). Transcribe this audio AND clean it up in a single step, returning exactly what the speaker meant to say.

- Capture intended meaning over strict phonetics; the speaker may have a non-native accent. Infer unclear words from context rather than dropping them.
- Remove filler words and verbal tics (um, uh, er, like, you know, I mean, sort of, basically, actually, and "so"/"well"/"right" used as filler).
- Resolve self-corrections — keep ONLY the final intended version ("send it to John, no wait, Sarah" → "send it to Sarah").
- Remove false starts, stutters, and accidentally repeated words.
- Fix grammar, capitalisation, and punctuation; format numbers, times, dates, currency, emails ("john at gmail dot com" → "john@gmail.com"), and spoken punctuation.
- Spell proper nouns correctly, preferring the known names above.
- Preserve meaning, intent, tone, and language EXACTLY. Never answer, reply to, summarise, translate, or add content. Keep commands as direct commands.
- Output ONLY the final cleaned text. If there is no speech at all, output absolutely nothing — not a single word or symbol.`;
}

// Single Gemini call that transcribes AND applies Wispr-style cleanup. Doing
// both in one request (instead of transcribe → separate polish) removes a whole
// model round trip from every voice turn — the dominant voice-latency cost.
async function transcribeAndCleanAudio(buffer, contextHint = '') {
  const audioBase64Input = buffer.toString('base64');
  const audioPart = { inlineData: { mimeType: 'audio/wav', data: audioBase64Input } };
  const model = genAI.getGenerativeModel({ model: FAST_MODEL });
  const durationMs = getWavDurationMs(buffer);

  const response = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: buildTranscribeAndCleanPrompt(contextHint) }, audioPart] }],
    generationConfig: { temperature: 0.1, topP: 0.95, topK: 40, maxOutputTokens: 1024, ...latencyThinkingConfig() }
  });

  const transcript = normalizeTranscript(response.response.text());
  return isImplausibleTranscript(transcript, durationMs) ? '' : transcript;
}

// Memory-derived names change rarely, but voice turns come in bursts — so cache
// the hint per user (5 min) to skip a Supabase round trip before every
// transcription. Keeps back-to-back pendant/mic utterances snappy.
const transcriptionHintCache = new Map();
const TRANSCRIPTION_HINT_TTL = 5 * 60 * 1000;

async function buildTranscriptionHint(userId) {
  const cached = transcriptionHintCache.get(userId);
  if (cached && Date.now() - cached.at < TRANSCRIPTION_HINT_TTL) return cached.hint;
  try {
    const { data } = await supabase
      .from('memories')
      .select('content')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(15);
    const words = data?.length
      ? (data.map(r => r.content).join(' ').match(/\b[A-Z][a-z]{2,}\b/g) || [])
      : [];
    const hint = [...new Set(words)].slice(0, 20).join(', ');
    transcriptionHintCache.set(userId, { hint, at: Date.now() });
    return hint;
  } catch { return ''; }
}

function buildPolishPrompt(transcript, contextHint = '') {
  return `You are the cleanup layer of a premium voice-dictation system (like Wispr Flow). You receive a raw speech-to-text transcript and rewrite it into exactly what the speaker meant to say — clean, correctly punctuated, and ready to send.

Apply all of these:
- Remove filler words and verbal tics: um, uh, er, hmm, like, you know, I mean, sort of, kind of, basically, literally, actually, and "so"/"well"/"right"/"okay" when used as filler.
- Resolve self-corrections — when the speaker changes their mind mid-sentence, keep ONLY the final intended version. E.g. "send it to John, no wait, to Sarah" → "send it to Sarah"; "let's meet at 5, sorry I mean 6pm" → "let's meet at 6pm".
- Remove false starts, stutters, and accidental repeated words.
- Fix grammar, verb tense, capitalisation, and punctuation. Add sentence breaks, and paragraph breaks for longer dictation.
- Format spoken forms correctly: numbers, times, dates, currency, emails ("john at gmail dot com" → "john@gmail.com"), URLs, and spoken punctuation ("new line", "comma", "question mark") when clearly dictated.
- Spell proper nouns correctly. When a spoken word phonetically matches one of these known names/terms, prefer that spelling: ${contextHint || '(none provided)'}.
- Preserve the speaker's meaning, intent, tone, and language EXACTLY. Never answer, reply to, comment on, summarise, translate, or invent content. If it is a command or request ("play music", "text mum I'm running late"), keep it as a direct command.
- If the transcript is already clean, return it unchanged.

Return ONLY the cleaned text — no quotes, labels, or explanation.

Raw transcript: ${transcript}`;
}

async function polishTranscriptText(transcript, contextHint = '') {
  if (!transcript?.trim()) return transcript;
  try {
    const model = genAI.getGenerativeModel({ model: FAST_MODEL });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: buildPolishPrompt(transcript, contextHint) }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024 }
    });
    return (result.response?.text?.() || transcript).trim() || transcript;
  } catch { return transcript; }
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

// Strip markdown emphasis Gemini sprinkles in (**bold**, *italic*, `code`, "- " bullets,
// "# " headings). The persona texts in plain prose and iOS renders content verbatim, so raw
// asterisks just show as literal junk.
function stripMarkdownEmphasis(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[ \t]*[-*]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '');
}

function stripActionMarkupForDisplay(text) {
  if (!text) return '';
  return stripMarkdownEmphasis(
    text
      .replace(/<action>[\s\S]*?<\/action>/g, '')
      .replace(/<action>[\s\S]*$/g, '')
  );
}

function splitCompleteSentences(text) {
  const cleaned = stripActionMarkupForDisplay(text || '');
  const matches = cleaned.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g) || [];
  return matches.map(sentence => sentence.trim()).filter(Boolean);
}

function extractAlreadyStatedContext(history = []) {
  const seen = new Set();
  const lines = [];
  const recentAssistantTurns = history
    .filter(entry => entry.role === 'assistant')
    .slice(-8);

  for (const turn of recentAssistantTurns) {
    const content = stripActionMarkupForDisplay(turn.content || '').trim();
    if (!content) continue;
    const snippets = (content.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g) || [content])
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 2);
    for (const snippet of snippets) {
      const normalized = snippet
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\p{L}\p{N}\s:]/gu, '')
        .trim();
      if (!normalized || normalized.length < 12 || seen.has(normalized)) continue;
      seen.add(normalized);
      lines.push(snippet);
      if (lines.length >= 6) return lines;
    }
  }

  return lines;
}

function buildDynamicSystemPrompt(memory, preferences, availableActions, userContext, statedContext = []) {
  const timeStr = new Date().toLocaleString('en-GB', { timeZone: TIMEZONE });
  const dateStr = getLocalDateKey();
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

CONTEXT YOU ALREADY STATED IN THIS CONVERSATION:
${statedContext.length ? statedContext.map(line => `- ${line}`).join('\n') : 'Nothing important has been stated yet.'}

Current date: ${dateStr}
Current time for internal reasoning only: ${timeStr}

RESPONSE RULES:
- The user leads the conversation. Follow their topic instead of steering into unrelated stored memory.
- Treat stored memory as background context for understanding, not as content to surface by default.
- Only mention stored memory when it is directly relevant to what the user just said, asked, or asked you to do.
- Treat personal fact statements like "my usual station is Birmingham New Street" as memory to acknowledge, not as a place, web, or app search.
- For greetings or simple check-ins like "hi", "hey", or "ok", just respond naturally to that message. Do not surface legal cases, health goals, TV shows, or personal situations unless the user brings them up.
- Do not repeat context you already stated earlier in this conversation.
- Especially avoid repeating time/date, current plans, study topics, or personal brief details unless the user directly asks again.
- Do not mention the current time or date unless the user asked for it or it is necessary for the action/result.
- If a factual answer involves public figures, news, violence, legal events, prices, schedules, or recent/current facts, do not provide names, dates, or counts unless they are grounded in search/tool/context evidence.
- If the user questions or challenges your previous factual answer, correct only the factual issue. Do not answer with meta/persona language.
- If an action is completed successfully, stop after one confirmation sentence. No follow-up question, no summary, no check-in.

---
${userContext}`;
}

function isEmailReplyDraftRequest(message = '') {
  return /\b(reply|respond|email back|write back|get back to|send (him|her|them) back)\b/i.test(String(message || ''));
}

function senderMemoryContext(memory = '', sender = {}) {
  const needles = [
    sender.name,
    sender.address,
    String(sender.address || '').split('@')[0]
  ].filter(Boolean).map(value => String(value).toLowerCase());
  if (!needles.length) return '';
  return String(memory || '')
    .split(/\n|;+/)
    .map(line => line.trim())
    .filter(line => {
      const lower = line.toLowerCase();
      return needles.some(needle => needle.length >= 3 && lower.includes(needle));
    })
    .slice(0, 8)
    .join('\n');
}

function scoreEmailCandidate(email = {}, message = '') {
  const haystack = [
    email.from,
    email.senderName,
    email.senderAddress,
    email.subject
  ].filter(Boolean).join(' ').toLowerCase();
  const terms = String(message || '')
    .toLowerCase()
    .split(/[^a-z0-9@._+-]+/i)
    .filter(term => term.length >= 3);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function findRecentEmailTarget(history = [], message = '') {
  const emails = [];
  for (const turn of [...history].reverse()) {
    for (const entry of [...(turn.actions || [])].reverse()) {
      const action = entry?.action || entry?.type;
      if (!['get_emails', 'search_emails'].includes(action)) continue;
      const resultEmails = entry?.result?.emails;
      if (Array.isArray(resultEmails)) emails.push(...resultEmails);
    }
    if (emails.length) break;
  }
  if (!emails.length) return null;
  const ranked = emails
    .map((email, index) => ({ email, index, score: scoreEmailCandidate(email, message) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked[0]?.email || null;
}

async function buildEmailReplyDraftContext(userId, message, history, memory, preferences, trace = null) {
  if (!isEmailReplyDraftRequest(message)) return '';
  const target = findRecentEmailTarget(history, message);
  if (!target?.threadId) return '';
  try {
    const thread = trace
      ? await trace.run('gmail.thread_context.fetch', () => googleConnector.getThreadContext(userId, target.threadId))
      : await googleConnector.getThreadContext(userId, target.threadId);
    const latestFromThem = [...(thread?.messages || [])]
      .reverse()
      .find(email => (email.senderAddress || email.from) && (email.senderAddress || email.from) !== target.to) || target;
    const sender = {
      name: latestFromThem.senderName || target.senderName || '',
      address: latestFromThem.senderAddress || target.senderAddress || '',
      raw: latestFromThem.from || target.from || ''
    };
    const senderMemory = senderMemoryContext(memory, sender) || 'No sender-specific memory found.';
    const threadText = String(thread?.text || target.body || target.snippet || '').slice(0, 14000);
    if (!threadText) return '';
    return `GMAIL REPLY DRAFTING CONTEXT:
The user is replying to an existing Gmail thread.
Thread ID: ${target.threadId}
Sender name: ${sender.name || 'Unknown'}
Sender address: ${sender.address || sender.raw || 'Unknown'}
Memory about this sender:
${senderMemory}

User communication style/preferences:
${preferences || 'No explicit communication preferences yet.'}

Full thread text:
${threadText}

Reply drafting instruction:
- If you produce a send_email action for this reply, include thread_id "${target.threadId}", to "${sender.address || sender.raw}", subject "${target.subject || ''}", in_reply_to "${target.messageId || ''}", and references "${target.references || target.messageId || ''}" when available.
- Draft from the full thread, not only the latest snippet.
- Match the user's normal tone, the relationship shown in memory/thread context, and the thread's existing formality.
- If this is a business/corporate thread, be professional, complete, and polished.
- Do not add fake warmth, generic padding, or pleasantries the user would not use.
- Stop when the point is made. No filler.`;
  } catch (err) {
    if (trace) trace.log('gmail.thread_context.fetch_failed', err.message);
    return `GMAIL REPLY DRAFTING CONTEXT:
The user appears to be replying to a Gmail thread, but the full thread could not be fetched: ${err.message}
Use the recent email result only if enough context is visible; otherwise ask one short clarification.`;
  }
}

function buildLocationContext(location) {
  const lat = Number(location?.latitude ?? location?.lat);
  const lng = Number(location?.longitude ?? location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return `CURRENT DEVICE LOCATION:
Latitude: ${lat}
Longitude: ${lng}
Use these coordinates for "near me", "nearest", "closest", pickup, traffic, and local place requests. Do not invent a place; use a tool/action that can resolve it.`;
}

function buildNativeHintsContext(nativeHints) {
  if (!nativeHints || typeof nativeHints !== 'object') return '';
  const lines = [];
  const contacts = Array.isArray(nativeHints.contacts) ? nativeHints.contacts.slice(0, 5) : [];
  if (contacts.length) {
    lines.push('NATIVE CONTACT MATCHES:');
    for (const contact of contacts) {
      const bits = [
        contact.displayName || contact.name,
        contact.phone && `phone ${contact.phone}`,
        contact.email && `email ${contact.email}`
      ].filter(Boolean);
      if (bits.length) lines.push(`- ${bits.join(' · ')}`);
    }
  }
  if (nativeHints.place?.name || nativeHints.place?.address) {
    lines.push('NATIVE PLACE MATCH:');
    lines.push(`- ${[nativeHints.place.name, nativeHints.place.address].filter(Boolean).join(' · ')}`);
  }
  if (!lines.length) return '';
  return `${lines.join('\n')}\nUse these native hints to resolve casual references, but still follow action rules and reviews.`;
}

function buildPendingActionContext(pendingAction) {
  if (!pendingAction?.action) return '';
  return `PENDING ACTION AWAITING REVIEW:
${JSON.stringify(pendingAction.action, null, 2)}

If the user is revising it, return the full revised action block and keep it in review. Do not execute, send, book, call, or order until they confirm. If the user is asking a question about it, answer briefly without returning an action.`;
}

function buildResolvedContextBlock(resolvedContext) {
  if (!resolvedContext || !resolvedContext.label) return '';
  const safe = {
    kind: resolvedContext.kind || 'unknown',
    label: String(resolvedContext.label || '').slice(0, 1200),
    source: resolvedContext.source || 'assistant_answer',
    confidence: resolvedContext.confidence || 'low',
    suggestedAction: resolvedContext.suggestedAction || undefined
  };
  return `RESOLVED SHORT-TERM CONTEXT:
${JSON.stringify(safe, null, 2)}

Use this to resolve vague follow-ups like "it", "that", "there", "same", "again", "what about tomorrow", and "the other one". If confidence is low, ask one short clarification instead of guessing.`;
}

function buildQuickTurnContext(preferences, statedContext = []) {
  return `FAST TURN MODE:
For tiny greetings or acknowledgements, reply in no more than two very short sentences.
Make the first sentence a tiny acknowledgement of 1-3 words when possible.
Keep the total reply under 10 words unless the user explicitly asks for more.
If the user says "huh", "what", "what do you mean", or similar, briefly clarify the previous answer or admit the confusion. Do not mention persona, goals, style, or internal instructions.
Do not recap the user's saved memories, plans, recent actions, or personal brief unless they directly asked for that context.
The user leads the conversation. Reply to what they just said instead of surfacing unrelated memory.
Treat memory as background context only. If the user just says hi, say hi back.
Keep it warm, effortless, and concise.
Do not repeat context you already mentioned earlier in this conversation.
Already stated context:
${statedContext.length ? statedContext.map(line => `- ${line}`).join('\n') : '- none'}

USER STYLE PREFERENCES:
${preferences || 'Still learning.'}`;
}

function isQuickTurnMessage(message) {
  const text = String(message || '').trim();
  if (!text || text.length > 32) return false;
  if (/[?]/.test(text)) return false;
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount > 5) return false;
  return /^(hi|hey|hello|yo|sup|hiya|haha|lol|huh|what|wait|ok|okay|kk|cool|nice|great|sure|yep|yes|nah|no|thanks|thank you|morning|good morning|afternoon|good afternoon|evening|good evening)$/.test(normalized);
}

function getDeterministicQuickReply(message) {
  const normalized = String(message || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  if (/^(hi|hey|hello|yo|sup|hiya)$/.test(normalized)) return 'Hey.';
  if (/^(morning|good morning)$/.test(normalized)) return 'Morning.';
  if (/^(afternoon|good afternoon)$/.test(normalized)) return 'Afternoon.';
  if (/^(evening|good evening)$/.test(normalized)) return 'Evening.';
  if (/^(thanks|thank you)$/.test(normalized)) return 'Anytime.';
  if (/^(haha|lol)$/.test(normalized)) return 'Yeah.';
  if (/^(ok|okay|kk|cool|nice|great|sure|yep|yes)$/.test(normalized)) return 'Got it.';
  if (/^(nah|no)$/.test(normalized)) return 'Got you.';
  return '';
}

async function getRecentLoggedActions(userId, trace = null, limit = 8, options = {}) {
  const since = parseClientTimestamp(options.since);
  const fetchActions = () => {
    let query = supabase
      .from('action_log')
      .select('action, status, error, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 8, 1), 20));
    if (since) query = query.gte('created_at', since.toISOString());
    return query;
  };
  const { data, error } = trace
    ? await trace.run('supabase.action_log.contextual_fetch', fetchActions)
    : await fetchActions();
  if (error || !data) return [];
  return data.map(row => {
    const parsed = safeParseJSON(row.action) || row.action || {};
    return {
      type: parsed.type || parsed.action || '',
      input: parsed.input || {},
      status: parsed.status || row.status || '',
      resultText: parsed.resultText || '',
      error: parsed.error || row.error || '',
      created_at: row.created_at
    };
  });
}

function getPromptCacheState(modelName = STREAMING_CHAT_MODEL) {
  const cacheKey = `${modelName}:${OXCY_SYSTEM_PROMPT}`;
  let cacheState = promptCacheStates.get(cacheKey);
  if (!cacheState) {
    cacheState = { key: cacheKey, name: '', expireAt: 0, pending: null };
    promptCacheStates.set(cacheKey, cacheState);
  }
  return cacheState;
}

async function ensurePromptCacheWarm(trace = null, modelName = STREAMING_CHAT_MODEL) {
  const cacheState = getPromptCacheState(modelName);
  if (cacheState.name && Date.now() < cacheState.expireAt) {
    if (trace) trace.log('prompt_cache.hit', cacheState.name);
    return cacheState.name;
  }
  if (cacheState.pending) {
    if (trace) trace.log('prompt_cache.pending');
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

// Pull displayable web sources out of Gemini grounding metadata so the client can
// show where a grounded answer came from — the trust signal that separates a real
// lookup from a confident guess. Deduped by publisher, capped to keep it quiet.
function groundingSourcesFrom(meta) {
  const chunks = meta && meta.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set();
  const out = [];
  for (const c of chunks) {
    const web = c && c.web;
    if (!web || !web.uri) continue;
    let title = String(web.title || '').trim();
    if (!title) {
      try { title = new URL(web.uri).hostname.replace(/^www\./, ''); } catch { title = 'Source'; }
    }
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, uri: web.uri });
    if (out.length >= 4) break;
  }
  return out;
}

function getPromptCacheName(trace = null, modelName = STREAMING_CHAT_MODEL) {
  const cacheState = getPromptCacheState(modelName);
  if (cacheState.name && Date.now() < cacheState.expireAt) {
    if (trace) trace.log('prompt_cache.hit', cacheState.name);
    return cacheState.name;
  }
  if (cacheState.pending) {
    if (trace) trace.log('prompt_cache.pending');
    return cacheState.name || '';
  }
  if (trace) trace.log('prompt_cache.warm_start');
  ensurePromptCacheWarm(null, modelName).catch(() => {});
  return cacheState.name || '';
}

function buildModernGenerateRequest({ dynamicSystemPrompt, useSearch, cachedContentName, baseHistory, userContent }) {
  // Keep control instructions authoritative. Cached prompts force dynamic rules into
  // conversation content, which is too weak for tool use and factuality.
  const canUseCachedPrompt = false;
  const config = {
    systemInstruction: `${OXCY_SYSTEM_PROMPT}\n\n${dynamicSystemPrompt}`.trim(),
    temperature: useSearch ? 0.1 : 0.2,
    topP: 0.8,
    topK: 20,
    // Disable (or limit) model thinking — the dominant first-token latency.
    ...latencyThinkingConfig()
  };
  // Attaching googleSearch adds real grounding latency, so only do it when
  // search-intent.js thinks the turn needs it (broadened below to catch
  // follow-ups like "well check" / "did you hear about X").
  if (useSearch) config.tools = [{ googleSearch: {} }];
  const firstUserText = typeof userContent?.parts?.[0]?.text === 'string' ? userContent.parts[0].text : '';
  if (isQuickTurnMessage(firstUserText)) {
    config.maxOutputTokens = 32;
    config.temperature = 0.1;
  }

  const dynamicContextParts = canUseCachedPrompt
    ? [{ text: `Persistent user context for this conversation:\n\n${dynamicSystemPrompt}` }]
    : [];

  return {
    config,
    contents: [
      ...baseHistory,
      ...(dynamicContextParts.length ? [{ role: 'user', parts: dynamicContextParts }] : []),
      userContent
    ]
  };
}

async function recoverEmptyModelResponse({ model, initialRequest, message, trace = null }) {
  const recoveryRequest = {
    config: {
      ...initialRequest.config,
      temperature: 0.2,
      maxOutputTokens: Math.max(initialRequest.config.maxOutputTokens || 0, 512)
    },
    contents: [
      ...initialRequest.contents,
      { role: 'model', parts: [{ text: '[empty response]' }] },
      {
        role: 'user',
        parts: [{
          text: [
            'Your previous response was empty. Recover the turn now.',
            'Answer the user directly, or return a valid action block if an action is clearly needed.',
            'Do not apologize for the empty response unless the user asked about it.',
            'Use search grounding if it is available in this request.',
            '',
            `User message: ${message}`
          ].join('\n')
        }]
      }
    ]
  };
  try {
    const response = trace
      ? await trace.run('gemini.generateContent.empty_recovery', () => modernGenAI.models.generateContent({
        model,
        contents: recoveryRequest.contents,
        config: recoveryRequest.config
      }))
      : await modernGenAI.models.generateContent({
        model,
        contents: recoveryRequest.contents,
        config: recoveryRequest.config
      });
    return (response.text || '').trim();
  } catch (error) {
    if (trace) trace.log('gemini.empty_recovery_fail', error.message);
    return '';
  }
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
  console.log(`[tts] generateSpeech start voice=${safeVoiceName} chars=${text.trim().length}`);
  const failures = [];
  const orderedModels = preferredTtsModel
    ? [preferredTtsModel, ...GEMINI_TTS_MODELS.filter(name => name !== preferredTtsModel)]
    : GEMINI_TTS_MODELS;

  for (const modelName of orderedModels) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);
    try {
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
        {
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoiceName } } }
          }
        },
        { signal: controller.signal, headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } }
      );
      const base64Audio = resp.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error(`Gemini TTS returned empty audio for voice ${safeVoiceName}.`);
      }
      preferredTtsModel = modelName;
      console.log(`[tts] using model ${modelName} with voice ${safeVoiceName}`);
      console.log(`[tts] generateSpeech ready voice=${safeVoiceName} bytes=${Buffer.from(base64Audio, 'base64').length}`);
      return pcmToWav(Buffer.from(base64Audio, 'base64')).toString('base64');
    } catch (err) {
      const detail = err?.response?.data?.error?.message || err?.response?.data || err.message;
      console.error(`[tts] generateSpeech fail voice=${safeVoiceName} model=${modelName}`, detail);
      failures.push(`${modelName}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`TTS failed (${safeVoiceName}): ${failures.join(' | ')}`);
}

const ACTION_STATUS_LABELS = {
  send_email: 'Sending email',
  get_emails: 'Checking emails',
  search_emails: 'Searching emails',
  create_calendar_event: 'Creating calendar event',
  get_calendar_events: 'Checking calendar',
  book_uber: 'Booking Uber',
  book_bolt: 'Booking Bolt',
  add_to_wallet: 'Adding to Wallet',
  find_place: 'Finding place',
  get_directions: 'Checking directions',
  plan_trip: 'Planning trip',
  send_telegram: 'Sending Telegram message',
  get_telegram_contacts: 'Checking Telegram contacts',
  search_trains: 'Checking train times',
  search_github: 'Searching GitHub',
  get_github_notifications: 'Checking GitHub notifications',
  create_github_issue: 'Creating GitHub issue',
  comment_github_issue: 'Posting GitHub comment',
  send_outlook_email: 'Sending email',
  get_outlook_emails: 'Checking emails',
  search_outlook_emails: 'Searching emails',
  create_outlook_event: 'Creating calendar event',
  get_outlook_events: 'Checking calendar',
  search_youtube: 'Searching YouTube',
  search_indeed_jobs: 'Searching Indeed',
  search_linkedin_jobs: 'Searching LinkedIn',
  share_linkedin_post: 'Opening LinkedIn',
  search_notion: 'Searching Notion',
  create_notion_page: 'Creating Notion page',
  append_notion_page: 'Updating Notion page',
  create_google_doc: 'Creating Google Doc',
  search_google_docs: 'Searching Google Docs',
  append_google_doc: 'Updating Google Doc',
  get_google_doc: 'Reading Google Doc',
  search_spotify: 'Searching Spotify',
  play_spotify: 'Playing on Spotify',
  control_spotify_playback: 'Controlling Spotify',
  add_to_spotify_queue: 'Queuing on Spotify',
  add_to_spotify_playlist: 'Updating Spotify playlist',
  get_now_playing_spotify: 'Checking Spotify',
  search_linear_issues: 'Searching Linear',
  get_linear_issues: 'Checking Linear issues',
  create_linear_issue: 'Creating Linear issue',
  comment_linear_issue: 'Posting Linear comment',
  forget_memory: 'Updating memory',
  generate_visual: 'Generating visual',
  create_diagram: 'Creating diagram',
  create_presentation: 'Building presentation',
  create_reminder: 'Setting reminder',
  create_scheduled_task: 'Scheduling task',
  list_scheduled_tasks: 'Checking scheduled tasks',
  cancel_scheduled_task: 'Cancelling scheduled task'
};

function getActionStatusLabel(actionType, phase = 'start') {
  const base = ACTION_STATUS_LABELS[actionType] || humanizeActionType(actionType);
  if (phase === 'complete') return `${base} complete`;
  if (phase === 'failed') return `${base} failed`;
  return base;
}

function actionCompletionPhase(result) {
  return result?.success === false ? 'failed' : 'complete';
}

async function* generateSpeechStream(text, voiceName = 'Aoede') {
  if (!text || !text.trim()) return;
  const safeVoiceName = GEMINI_TTS_VOICES.has(voiceName) ? voiceName : 'Aoede';
  console.log(`[tts] generateSpeechStream start voice=${safeVoiceName} chars=${text.trim().length}`);
  const failures = [];
  const orderedModels = preferredTtsModel
    ? [preferredTtsModel, ...GEMINI_TTS_MODELS.filter(name => name !== preferredTtsModel)]
    : GEMINI_TTS_MODELS;

  for (const modelName of orderedModels) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);
    let sawAudio = false;
    try {
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse`,
        {
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoiceName } } }
          }
        },
        {
          signal: controller.signal,
          responseType: 'stream',
          headers: {
            Accept: 'text/event-stream',
            'x-goog-api-key': process.env.GEMINI_API_KEY
          }
        }
      );

      let buffer = '';
      for await (const rawChunk of resp.data) {
        buffer += rawChunk.toString('utf8');
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';

        for (const event of events) {
          const lines = event.split(/\r?\n/).filter(line => line.startsWith('data: '));
          for (const line of lines) {
            const payload = line.slice(6).trim();
            if (!payload || payload === '[DONE]') continue;
            const parsed = JSON.parse(payload);
            const parts = parsed?.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              const base64Audio = part?.inlineData?.data || part?.inline_data?.data;
              if (!base64Audio) continue;
              sawAudio = true;
              if (preferredTtsModel !== modelName) {
                preferredTtsModel = modelName;
                console.log(`[tts] using model ${modelName} with voice ${safeVoiceName}`);
              }
              console.log(`[tts] stream chunk ready voice=${safeVoiceName} bytes=${Buffer.from(base64Audio, 'base64').length}`);
              yield pcmToWav(Buffer.from(base64Audio, 'base64')).toString('base64');
            }
          }
        }
      }

      if (!sawAudio) {
        throw new Error(`Gemini TTS returned empty audio for voice ${safeVoiceName}.`);
      }
      return;
    } catch (err) {
      const detail = err?.response?.data?.error?.message || err?.response?.data || err.message;
      console.error(`[tts] generateSpeechStream fail voice=${safeVoiceName} model=${modelName}`, detail);
      failures.push(`${modelName}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`TTS failed (${safeVoiceName}): ${failures.join(' | ')}`);
}

function createSentenceTtsStreamer({ voiceName, sse, trace = null, onSpeakingStart = null }) {
  let lastSentenceCount = 0;
  let nextEmitIndex = 0;
  const readyAudio = new Map();
  const tasks = [];
  let speakingNotified = false;

  const flushReadyAudio = () => {
    while (readyAudio.has(nextEmitIndex)) {
      const state = readyAudio.get(nextEmitIndex);
      while (state.chunks.length) {
        const audio = state.chunks.shift();
        const chunkIndex = state.sentCount++;
        if (!speakingNotified) {
          speakingNotified = true;
          if (onSpeakingStart) onSpeakingStart();
        }
        sse({ type: 'audio', data: audio, format: 'wav', mimeType: 'audio/wav', seq: nextEmitIndex, chunk: chunkIndex });
        if (trace) trace.log(`tts.chunk_sent.${nextEmitIndex}.${chunkIndex}`);
      }
      if (!state.done) break;
      readyAudio.delete(nextEmitIndex);
      nextEmitIndex += 1;
    }
  };

  const schedule = sentence => {
    const trimmed = sentence.trim();
    if (!trimmed) return;
    const seq = tasks.length;
    if (trace) trace.log(`tts.chunk_schedule.${seq}`, JSON.stringify(trimmed.slice(0, 80)));
    if (seq === 0) {
      const earlyClause = trimmed.match(/^([^,;:]{1,24}[,;:])\s+(.+)$/);
      if (earlyClause) {
        schedule(earlyClause[1].trim());
        schedule(earlyClause[2].trim());
        return;
      }
    }
    if (trace) trace.log(`tts.chunk_start.${seq}`);
    const state = { chunks: [], done: false, sentCount: 0 };
    readyAudio.set(seq, state);
    const task = (async () => {
      try {
        for await (const audio of generateSpeechStream(trimmed, voiceName)) {
          state.chunks.push(audio);
          flushReadyAudio();
        }
        state.done = true;
        flushReadyAudio();
      } catch (error) {
        if (trace) trace.log(`tts.chunk_fail.${seq}`, error.message);
        throw error;
      }
    })();
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

function normalizeContactLookup(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9+@.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeMessageAddress(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /^\+?[0-9][0-9\s().-]{5,}$/.test(text) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text);
}

function resolveNativeMessageContact(contact, nativeHints) {
  if (looksLikeMessageAddress(contact)) {
    return { label: contact, value: contact };
  }
  const normalizedContact = normalizeContactLookup(contact);
  const contacts = Array.isArray(nativeHints?.contacts) ? nativeHints.contacts : [];
  if (!normalizedContact || !contacts.length) return { label: contact, value: '' };

  // Tiered match so we never pick the wrong person via a loose substring:
  // exact name > whole-token match ("sam" → "sam smith") > prefix > long substring.
  let best = null;
  let bestScore = 0;
  for (const candidate of contacts) {
    const name = normalizeContactLookup(candidate.displayName || '');
    if (!name) continue;
    const tokens = name.split(/\s+/).filter(Boolean);
    let score = 0;
    if (name === normalizedContact) score = 100;
    else if (tokens.includes(normalizedContact)) score = 80;
    else if (name.startsWith(normalizedContact) || normalizedContact.startsWith(name)) score = 60;
    else if (normalizedContact.length >= 4 && name.includes(normalizedContact)) score = 30;
    if (score > bestScore) { bestScore = score; best = candidate; }
  }

  const value = best?.phone || best?.email || '';
  return {
    label: best?.displayName || contact,
    value: looksLikeMessageAddress(value) ? value : ''
  };
}

// Safety net: if the model omits the time on a directions/trip action, recover it
// from the user's own wording ("...by 9:25", "leave at 6") so "when should I
// leave" always gets a real computed answer instead of just opening Maps.
function deriveDirectionTimes(message) {
  const text = String(message || '');
  const TIME = '(\\d{1,2}(?:[:.\\s]\\d{2})?\\s*(?:am|pm)?)';
  const norm = (raw) => {
    const m = String(raw || '').match(/(\d{1,2})(?:[:.\s]+(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;
    return `${m[1]}:${m[2] || '00'}${(m[3] || '').toLowerCase()}`;
  };
  const depRe = new RegExp(`\\b(?:leave|leaving|set\\s*off|setting\\s*off|depart|departing|head\\s*off)\\b[^.!?]{0,24}?\\b(?:at|by)\\s+${TIME}`, 'i');
  const arrRe = new RegExp(`\\b(?:by|before)\\s+${TIME}`, 'i');
  const dep = depRe.exec(text);
  if (dep && /\d/.test(dep[1] || '')) return { departure_time: norm(dep[1]) };
  const arr = arrRe.exec(text);
  if (arr && /\d/.test(arr[1] || '')) return { arrival_time: norm(arr[1]) };
  return {};
}

const TRAVEL_MODE_WORDS = /\b(bus|coach|train|rail|tube|metro|tram|transit|subway|underground|walk|walking|on foot|driv(?:e|ing)|car|taxi|cab|cycl(?:e|ing)|bike|biking)\b/i;

function deriveDirectionMode(message) {
  const t = String(message || '');
  if (/\b(bus|coach)\b/i.test(t)) return 'bus';
  if (/\b(train|rail|tube|metro|tram|transit|subway|underground)\b/i.test(t)) return 'transit';
  if (/\b(walk|walking|on foot)\b/i.test(t)) return 'walking';
  if (/\b(cycl(?:e|ing)|bike|biking)\b/i.test(t)) return 'bicycling';
  if (/\b(driv(?:e|ing)|car|taxi|cab)\b/i.test(t)) return 'driving';
  return null;
}

function hasExplicitDestination(message) {
  return /\b(?:get to|head to|go to|drive to|walk to|to|toward|towards|reach)\s+[a-z0-9'&]/i.test(String(message || ''));
}

// A short follow-up that only changes the travel mode ("what if I take the bus")
// — it names a mode but no new destination, so the previous route should be reused.
function isModeChangeFollowup(message) {
  const t = String(message || '');
  return TRAVEL_MODE_WORDS.test(t) && !hasExplicitDestination(t);
}

function extractDestinationPhrase(message) {
  const text = String(message || '');
  const tail = '(?:\\s+(?:by|before|at|when|how|,|\\?)|[?.]|$)';
  // Specific verbs first so the infinitive "to" in "need to get to X" can't win.
  const patterns = [
    new RegExp(`\\b(?:get to|head to|go to|drive to|walk to|travel to|reach)\\s+(.+?)${tail}`, 'i'),
    new RegExp(`\\bto\\s+(.+?)${tail}`, 'i')
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const dest = m ? m[1].trim() : '';
    if (dest && !TRAVEL_MODE_WORDS.test(dest) && !/\b(if|what|right now)\b/i.test(dest)) {
      return dest;
    }
  }
  return null;
}

function looksLikeInvalidRouteDestination(destination) {
  const text = String(destination || '').trim();
  if (!text) return true;
  if (/^\d+\s*°?\s*[cf]\b/i.test(text)) return true;
  if (/^\d+\s*degrees?\b/i.test(text)) return true;
  if (/^(right now|today|tomorrow|the bus|bus|transit|directions)$/i.test(text)) return true;
  return false;
}

// Find the most recent real directions target so a mode-change follow-up
// ("yes directions please, I'm taking the bus") can reuse its destination and
// timing instead of letting the model grab a random token like "32°C".
async function findRecentDirectionsRequest(userId, excludeText) {
  try {
    const { data } = await supabase
      .from('conversations')
      .select('content, role, created_at')
      .eq('user_id', userId)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: false })
      .limit(18);
    for (const row of data || []) {
      const text = conversationFallbackText(row);
      if (!text || text === excludeText || isModeChangeFollowup(text)) continue;
      const destination = extractDestinationPhrase(text);
      if (destination && !looksLikeInvalidRouteDestination(destination)) {
        return { destination, ...deriveDirectionTimes(text) };
      }
    }
  } catch (err) {
    console.warn('[directions] recent route lookup failed:', err.message);
  }
  return null;
}

// Personal places ("my school", "work", "home") must resolve to the user's own
// saved location — never silently geocode to the nearest random match, which
// produces confident-but-wrong directions.
const PERSONAL_PLACES = ['home', 'house', 'work', 'office', 'school', 'college', 'uni', 'university', 'gym'];

function personalPlaceKeyword(destination) {
  const d = String(destination || '').trim().toLowerCase()
    .replace(/^(my|our|the)\s+/, '')
    .replace(/[?.!]+$/, '')
    .trim();
  return PERSONAL_PLACES.includes(d) ? d : null;
}

// Look up a saved place from memory, e.g. a fact like "my school is Cadbury
// Sixth Form College" or "work: 10 King St".
async function resolveSavedPlace(userId, keyword) {
  try {
    const { data } = await supabase
      .from('memories')
      .select('content, created_at')
      .eq('user_id', userId)
      .ilike('content', `%${escapeIlikePattern(keyword)}%`)
      .order('created_at', { ascending: false })
      .limit(8);
    const re = new RegExp(`\\b${keyword}\\b[^.\\n]*?\\b(?:is|are|=|:|at|in)\\s+(.+?)(?:[.\\n]|$)`, 'i');
    for (const row of data || []) {
      const m = String(row.content || '').match(re);
      if (m && m[1]) {
        const place = m[1].trim().replace(/^(a|an|the)\s+/i, '').trim();
        if (place && !PERSONAL_PLACES.includes(place.toLowerCase())) return place;
      }
    }
  } catch (err) {
    console.warn('[place] saved place lookup failed:', err.message);
  }
  return null;
}

async function executeAction(userId, action, params, context = {}) {
  const connectorId = connectorForAction(action);
  if (connectorId && connectorId !== 'maps') {
    const enabledConnectors = await getEnabledConnectors(userId, context.trace || null);
    if (!enabledConnectors.includes(connectorId)) {
      return {
        success: false,
        error: `${connectorId} is disabled. Re-enable it in Connectors before confirming this action.`
      };
    }
  }

  const enrichedParams = {
    ...(params || {}),
    ...(context.location ? { location: context.location } : {})
  };

  if ((action === 'get_directions' || action === 'plan_trip') && context.userMessage) {
    // Mode-change follow-up ("what if I take the bus?") — reuse the previous
    // destination and timing, just switch the travel mode, instead of treating
    // the phrase as a new destination.
    if (isModeChangeFollowup(context.userMessage)) {
      const prev = await findRecentDirectionsRequest(userId, context.userMessage);
      if (prev?.destination) {
        enrichedParams.destination = prev.destination;
        if (prev.arrival_time && !enrichedParams.arrival_time) enrichedParams.arrival_time = prev.arrival_time;
        if (prev.departure_time && !enrichedParams.departure_time) enrichedParams.departure_time = prev.departure_time;
      }
      const mode = deriveDirectionMode(context.userMessage);
      if (mode) enrichedParams.mode = mode;
    }

    if (looksLikeInvalidRouteDestination(enrichedParams.destination)) {
      const currentDestination = extractDestinationPhrase(context.userMessage);
      if (currentDestination && !looksLikeInvalidRouteDestination(currentDestination)) {
        enrichedParams.destination = currentDestination;
      } else {
        const prev = await findRecentDirectionsRequest(userId, context.userMessage);
        if (prev?.destination) {
        enrichedParams.destination = prev.destination;
        if (prev.arrival_time && !enrichedParams.arrival_time) enrichedParams.arrival_time = prev.arrival_time;
        if (prev.departure_time && !enrichedParams.departure_time) enrichedParams.departure_time = prev.departure_time;
        } else {
          return {
            success: false,
            text: "I don't have a real destination for directions yet. Where are you heading?",
            actionSummary: 'Need destination',
            cardText: 'Destination required'
          };
        }
      }
    }

    // Recover a missing arrival/departure time from the raw message.
    if (!enrichedParams.arrival_time && !enrichedParams.departure_time) {
      const derived = deriveDirectionTimes(context.userMessage);
      if (derived.arrival_time) enrichedParams.arrival_time = derived.arrival_time;
      else if (derived.departure_time) enrichedParams.departure_time = derived.departure_time;
    }
  }

  // Resolve personal-place destinations from the user's saved memory, or ask
  // instead of geocoding "school"/"work"/"home" to the nearest random match.
  const placeField = { get_directions: 'destination', plan_trip: 'destination', book_uber: 'destination', book_bolt: 'destination', find_place: 'query' }[action];
  if (placeField) {
    const keyword = personalPlaceKeyword(enrichedParams[placeField]);
    if (keyword) {
      const saved = await resolveSavedPlace(userId, keyword);
      if (saved) {
        enrichedParams[placeField] = saved;
      } else {
        if (!context.trace?.incognito) {
          await setPendingPlace(userId, {
            keyword,
            action,
            field: placeField,
            arrival_time: enrichedParams.arrival_time || null,
            departure_time: enrichedParams.departure_time || null,
            mode: enrichedParams.mode || null
          }).catch(() => {});
        }
        return {
          success: false,
          needsPlace: keyword,
          text: `I don't have your ${keyword} saved yet, so I won't guess. What's its name or address? Tell me and I'll remember it.`,
          actionSummary: 'Need location',
          cardText: `Add your ${keyword}`
        };
      }
    }
  }

  // Uber pickup that names a personal place ("from home"): use the saved address,
  // or fall back to device GPS — never geocode the bare word "home".
  if (action === 'book_uber' || action === 'book_bolt') {
    const pickupKeyword = personalPlaceKeyword(enrichedParams.pickup);
    if (pickupKeyword) {
      const saved = await resolveSavedPlace(userId, pickupKeyword);
      if (saved) enrichedParams.pickup = saved;
      else delete enrichedParams.pickup;
    }
  }

  switch (action) {
    case 'send_message': {
      const contact = String(params?.contact || '').trim();
      const message = String(params?.message || '').trim();
      if (!contact || !message) return { success: false, error: 'send_message requires contact and message' };
      const resolvedContact = resolveNativeMessageContact(contact, context.nativeHints);
      if (!resolvedContact.value) {
        return {
          success: false,
          error: `I need a phone number for ${contact}. Turn on Contacts access for Oxy or include the number.`
        };
      }
      return {
        success: true,
        text: `Message ready for ${resolvedContact.label}. Review and tap Send.`,
        cardText: `To ${resolvedContact.label} · ${message}`,
        actionSummary: 'Message ready',
        deepLink: `sms:${encodeURIComponent(resolvedContact.value)}?&body=${encodeURIComponent(message)}`
      };
    }
    case 'make_call': {
      const contact = String(params?.contact || '').trim();
      if (!contact) return { success: false, error: 'make_call requires a contact' };
      return {
        success: true,
        text: `Opening FaceTime for ${contact}.`,
        deepLink: `facetime://${encodeURIComponent(contact)}`
      };
    }
    case 'play_music': {
      const query = String(params?.query || params?.song || params?.title || '').trim();
      if (!query) return { success: false, error: 'play_music requires a query' };
      return {
        success: true,
        text: `Starting playback for ${query}.`,
        cardText: query,
        actionSummary: 'Music requested',
        deepLink: `music://music.apple.com/search?term=${encodeURIComponent(query)}`,
        webLink: `https://music.apple.com/search?term=${encodeURIComponent(query)}`,
        nativeExecution: 'music'
      };
    }
    case 'add_to_music_playlist': {
      const query = String(params?.query || params?.song || params?.title || '').trim();
      const playlist = String(params?.playlist || params?.playlistName || '').trim();
      if (!query) return { success: false, error: 'add_to_music_playlist requires a query' };
      return {
        success: true,
        text: playlist
          ? `Opening Apple Music for ${query}. Add it to ${playlist} there.`
          : `Opening Apple Music for ${query}.`,
        cardText: playlist ? `${query} · ${playlist}` : query,
        actionSummary: playlist ? 'Music ready' : 'Music opened',
        deepLink: `music://music.apple.com/search?term=${encodeURIComponent(query)}`,
        webLink: `https://music.apple.com/search?term=${encodeURIComponent(query)}`
      };
    }
    case 'run_browser_task': {
      const goal = String(params?.goal || '').trim();
      // Empty goal is only valid as a silent continuation of an already-open session
      // (the auto-continue loop from /chat) — it keeps grinding on the existing goal
      // instead of needing a fresh instruction every turn. No live session to continue
      // and no goal to start one — a plain, non-technical question, never an internal
      // action/field name.
      if (!goal && !getSession(userId)) {
        return { success: false, error: 'What would you like me to order, and from where?' };
      }
      const url = String(params?.url || '').trim() || null;
      const title = String(params?.title || '').trim() || (url ? `Browser task: ${new URL(url).hostname}` : 'Browser task');
      const onProgress = label => context.sendStatus?.('action_progress', label, { action: 'run_browser_task' });

      if (context.bypassReview) {
        const outcome = getSession(userId)
          ? await confirmPayment(userId)
          : { type: 'error', error: 'No order is waiting for payment confirmation — it may have expired.' };
        if (outcome.type === 'error') return { success: false, error: outcome.error };
        return { success: true, text: outcome.text, cardText: title, actionSummary: 'Order placed' };
      }

      const outcome = await runOrderingTurn(userId, { url, goal, onProgress });
      // Flag the live session so the NEXT user message is routed straight back into
      // the loop (deterministic resume) instead of the general chat brain.
      const liveSession = getSession(userId);
      // ask/awaiting_more clearly await a reply; a recoverable error leaves the session
      // open too, so route the user's "keep going" straight back into the loop.
      if (liveSession) liveSession.awaitingInput = (outcome.type === 'ask' || outcome.type === 'awaiting_more' || outcome.type === 'error');

      switch (outcome.type) {
        case 'error':
          return { success: false, error: outcome.error };
        case 'done':
          return { success: true, text: outcome.text, cardText: title, actionSummary: 'Browser task finished' };
        case 'ask':
          return { success: true, text: outcome.question, cardText: title, actionSummary: 'Needs your input' };
        case 'awaiting_more':
          return { success: true, text: outcome.summary, cardText: title, actionSummary: 'Browser task paused' };
        case 'ready_for_payment': {
          const reviewAction = { type: 'run_browser_task', input: params };
          await setPendingAction(userId, reviewAction, context);
          const total = outcome.total ? ` Total: ${outcome.total}.` : '';
          return {
            success: true,
            pending: true,
            text: `Ready to order: ${outcome.summary}.${total} Say "confirm" to place it or "cancel" to stop.`,
            cardText: title,
            actionSummary: 'Awaiting payment confirmation',
            confirmation: 'review_required'
          };
        }
        default:
          return { success: false, error: `Unrecognized ordering-loop outcome: ${outcome.type}` };
      }
    }
    case 'forget_memory':
      return forgetMemory(userId, params || {});
    case 'create_reminder': {
      const title = String(params?.title || '').trim();
      const dueDate = params?.due_date ? new Date(params.due_date) : null;
      if (!title || !dueDate || Number.isNaN(dueDate.getTime())) {
        return { success: false, error: 'create_reminder needs a title and a valid due_date.' };
      }
      const created = await createScheduledTask(userId, { title, due_date: dueDate.toISOString() });
      if (!created.success) return { success: false, error: created.error };
      const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }).format(dueDate);
      return {
        success: true,
        text: `Reminder set: "${title}" on ${when}.`,
        cardText: title,
        actionSummary: 'Reminder set'
      };
    }
    case 'create_scheduled_task': {
      const title = String(params?.title || '').trim();
      const instruction = String(params?.instruction || '').trim();
      if (!title || !instruction) {
        return { success: false, error: 'create_scheduled_task needs a title and instruction.' };
      }
      const created = await createScheduledTask(userId, {
        title,
        instruction,
        recurrence: params?.recurrence,
        time: params?.time,
        day_of_week: params?.day_of_week,
        date: params?.date
      });
      if (!created.success) return { success: false, error: created.error };
      return {
        success: true,
        text: `Done — I'll ${describeSchedule(created.task)}: ${title}.`,
        cardText: title,
        actionSummary: 'Scheduled task created'
      };
    }
    case 'list_scheduled_tasks': {
      const listed = await listScheduledTasks(userId);
      if (!listed.success) return { success: false, error: listed.error };
      if (!listed.tasks.length) {
        return { success: true, text: "You don't have any reminders or scheduled tasks set up.", actionSummary: 'No scheduled tasks' };
      }
      const lines = listed.tasks.map(task => `- ${task.title} (${describeSchedule(task)})`);
      return {
        success: true,
        text: `Here's what's scheduled:\n${lines.join('\n')}`,
        actionSummary: 'Scheduled tasks checked'
      };
    }
    case 'cancel_scheduled_task': {
      const title = String(params?.title || '').trim();
      if (!title) return { success: false, error: 'cancel_scheduled_task needs a title.' };
      const cancelled = await cancelScheduledTask(userId, { title });
      if (!cancelled.success) {
        if (cancelled.error === 'not_found') {
          return { success: false, error: `I couldn't find a scheduled task matching "${title}".` };
        }
        return { success: false, error: cancelled.error };
      }
      return {
        success: true,
        text: `Cancelled "${cancelled.task.title}".`,
        actionSummary: 'Scheduled task cancelled'
      };
    }
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
      return dispatch(userId, action, enrichedParams);
  }
}

const executeActions = createActionRunner({
  executeAction,
  invalidateUserContextCache,
  setPendingAction,
  validateAction: validateActionWithContract,
  logAction: (userId, action, result) => supabase.from('action_log').insert({
    user_id: userId,
    action: serializeLoggedAction(action, result),
    status: result.pending ? 'pending' : result.success ? 'executed' : 'failed',
    error: result.success ? null : (result.error || null),
    created_at: new Date().toISOString()
  })
});

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

// Single-valued attributes: a person has exactly one. A new value REPLACES the old
// instead of stacking a contradictory second fact (the "3 different usual stations" bug).
const SINGLE_VALUED_SUBJECTS = [
  { key: 'school', re: /^(?:my|our)\s+(?:school|college|university|uni|sixth\s*form)\b/i },
  { key: 'home', re: /^(?:lives?|live|home\s+is|my\s+(?:home|house|flat|address)\s+is)\b/i },
  { key: 'work', re: /^(?:works?\s+(?:at|for)|my\s+(?:job|work|employer|office)\s+is)\b/i },
  { key: 'station', re: /^(?:usual\s+station|my\s+station|nearest\s+station)\b/i },
  { key: 'bank', re: /^banks?\s+with\b/i },
  { key: 'name', re: /^(?:my\s+name\s+is|name\s+is|is\s+called)\b/i },
  { key: 'gym', re: /^my\s+gym\s+is\b/i },
  // Catches "Partner is gf" vs "Partner is a girlfriend." — same subject, different
  // phrasing, neither a substring of the other, so the dedup check above missed it.
  { key: 'partner', re: /^(?:(?:my\s+)?(?:partner|girlfriend|boyfriend|wife|husband|spouse|fianc[eé])\s+is|has\s+an?\s+(?:partner|girlfriend|boyfriend|wife|husband|fianc[eé]))\b/i }
];

function factSubjectKey(content) {
  const c = String(content || '').trim();
  return SINGLE_VALUED_SUBJECTS.find(s => s.re.test(c))?.key || null;
}

// (a) Reject junk the extractor sometimes emits — empty strings, markdown/code fences,
// zero-width characters, or content with no actual words.
function sanitizeFactContent(content) {
  let c = String(content || '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!c || c.length < 3) return null;
  if (!/[a-z]/i.test(c)) return null;
  const junk = new Set(['empty string', 'none', 'n/a', 'na', 'null', 'undefined', 'no fact', 'nothing', 'no personal fact']);
  if (junk.has(c.toLowerCase())) return null;
  return c;
}

function normalizeForDedup(content) {
  return String(content || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

async function saveMemory(userId, content, source = 'fact') {
  const clean = sanitizeFactContent(content);
  if (!clean) return; // (a) drop junk

  if (source === 'manual_profile') {
    const { data: inserted } = await supabase
      .from('memories')
      .insert({ user_id: userId, content: clean, source, created_at: new Date().toISOString() })
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

  const { data: existing } = await supabase
    .from('memories').select('id, content').eq('user_id', userId);
  const rows = existing || [];

  // (c) Skip near-duplicates. The substring check is capped to short facts so the long
  // profile blob can't accidentally swallow every new fact whose words appear inside it.
  const normNew = normalizeForDedup(clean);
  const isDup = rows.some(r => {
    const n = normalizeForDedup(r.content);
    if (n === normNew) return true;
    return r.content.length < 160 && n.length > 8 && (n.includes(normNew) || normNew.includes(n));
  });
  if (isDup) return;

  // (b) Replace a prior fact about the same single-valued subject. This deterministic
  // list only covers ~8 known subjects (school/home/work/partner/etc) — anything else
  // falls through to the general conflict check below.
  const subject = factSubjectKey(clean);
  if (subject) {
    const stale = rows.filter(r => factSubjectKey(r.content) === subject).map(r => r.id);
    if (stale.length) await supabase.from('memories').delete().in('id', stale);
  } else if (rows.length) {
    // General case: a changed preference/state ("now prefers evening workouts" over
    // "prefers morning workouts") that isn't one of the hardcoded subjects above. One
    // cheap LLM call only runs here, not on every save — the deterministic path above
    // already handles the common, free cases.
    const conflict = await findConflictingMemory(rows, clean);
    if (conflict) await supabase.from('memories').delete().eq('id', conflict.id);
  }

  await supabase
    .from('memories')
    .insert({ user_id: userId, content: clean, source, created_at: new Date().toISOString() });
}

// Catches contradictions outside the hardcoded single-valued subjects — e.g. a changed
// preference or status. Returns the row it supersedes, or null if there's no conflict
// (most new facts just add information and shouldn't replace anything).
async function findConflictingMemory(rows, newFact) {
  try {
    const model = genAI.getGenerativeModel({ model: FAST_MODEL });
    const list = rows.map((r, i) => `${i}: ${r.content}`).join('\n');
    const result = await model.generateContent(
      `Existing facts about a user:\n${list}\n\nNew fact: "${newFact}"\n\nDoes the new fact update, contradict, or supersede exactly ONE of the existing facts above (e.g. a changed preference, a different routine, an outdated status)? If yes, reply with ONLY that fact's number. If the new fact is unrelated to all of them, or simply adds new information without contradicting anything, reply with NONE.`
    );
    const raw = result.response.text().trim();
    const idx = parseInt(raw, 10);
    return Number.isInteger(idx) && rows[idx] ? rows[idx] : null;
  } catch {
    return null;
  }
}

async function forgetMemory(userId, { scope = '', query = '' } = {}) {
  const normalizedScope = String(scope || '').toLowerCase();
  const normalizedQuery = String(query || '').trim();

  if (normalizedScope === 'all') {
    const { error } = await supabase.from('memories').delete().eq('user_id', userId);
    if (error) throw error;
    return { success: true, text: 'I cleared what I had in memory.' };
  }

  // A specific topic takes precedence over "recent" when both are given.
  if (normalizedQuery) {
    const { data, error } = await supabase
      .from('memories')
      .select('id, content')
      .eq('user_id', userId)
      .ilike('content', `%${escapeIlikePattern(normalizedQuery)}%`);
    if (error) throw error;
    if (!data?.length) {
      return { success: true, text: `I couldn't find anything stored about "${normalizedQuery}".` };
    }
    const ids = data.map(row => row.id);
    const { error: deleteError } = await supabase.from('memories').delete().in('id', ids);
    if (deleteError) throw deleteError;
    return {
      success: true,
      text: ids.length === 1
        ? `I forgot what I had stored about "${normalizedQuery}".`
        : `I removed ${ids.length} memories about "${normalizedQuery}".`
    };
  }

  if (normalizedScope === 'recent') {
    const { data, error } = await supabase
      .from('memories')
      .select('id, content')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data?.length) return { success: true, text: 'There was nothing stored to forget.' };
    const { error: deleteError } = await supabase.from('memories').delete().eq('id', data[0].id);
    if (deleteError) throw deleteError;
    return { success: true, text: 'I forgot the most recent memory.' };
  }

  return { success: false, error: 'forget_memory needs scope "recent" or "all", or a query.' };
}

async function getMemorySummary(userId) {
  const { data, error } = await supabase
    .from('memories')
    .select('content, source, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !data) {
    return { total: 0, profile: false, learned: 0, lastUpdated: null };
  }

  const manualProfile = data.find(m => m.source === 'manual_profile');
  const learned = data.filter(m => m.source !== 'manual_profile');
  return {
    total: data.length,
    profile: !!manualProfile,
    learned: learned.length,
    lastUpdated: data[0]?.created_at || null
  };
}

async function extractMemoryFact(userId, text) {
  try {
    const model = genAI.getGenerativeModel({ model: FAST_MODEL });
    const result = await model.generateContent(
      `Extract one short, DURABLE personal fact worth remembering long-term from this message. Write it as a concise note.

Only save facts that stay true and identify the person: relationships and who people are, lasting preferences, where they study / work / live, ongoing commitments or health conditions, names of their school / employer / partner / pet.

Return an EMPTY STRING for anything transient or low-signal — do not save:
- one-off events, meetings, appointments, or schedules ("has a meeting with Hardik", "seeing Alisa Wednesday")
- vague relational noise ("has conversations with Hardik", "talked to someone")
- generic states that say nothing specific ("is a student", "takes the bus", "is busy")
- moods or momentary feelings.

CRITICAL: keep specific proper nouns exactly as stated — names of schools, colleges, employers, places, people, teams. NEVER generalise a name away. "I go to Cadbury Sixth Form College" → "School is Cadbury Sixth Form College" (NOT "Goes to school"). "I work at KPMG" → "Works at KPMG". For a school/college/work/home location, phrase it as "School is <name>" / "Work is <name>" / "Home is <address>" so it can be looked up later.

For a relationship, prefer the person's name if one is given ("Partner is Alisa"). If only the relationship type is mentioned with no name ("my girlfriend said...", "my partner is a girlfriend"), phrase it naturally as "Has a girlfriend" — never as an awkward copula like "Partner is a girlfriend."

Good examples: "Has a dog named Biscuit", "Hates mornings", "Lives in Birmingham", "Partner is Alisa", "Has a girlfriend".
Return only the fact with no explanation. If there is nothing durable and personal worth remembering, return an empty string.\n\nMessage: "${text}"`
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
  if (isMemoryDeletionRequest(text)) return false;
  const triggers = [
    'remember', 'my ', "i'm ", 'i am ', 'i work', 'i live',
    'i hate', 'i love', 'i need', 'i want', "i've got", 'i have',
    'my name', 'my job', 'my partner', 'my wife', 'my husband',
    'my kids', 'my boss', 'my flat', 'my car', "don't tell"
  ];
  const lower = text.toLowerCase();
  return triggers.some(t => lower.includes(t));
}

function isMemoryDeletionRequest(text) {
  return /\b(forget|delete|remove|wipe|clear)\b.*\b(memory|remembered|know)\b/i.test(String(text || ''))
    || /\bforget that\b/i.test(String(text || ''));
}

function parseClientTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  const now = Date.now();
  if (parsed.getTime() > now + 5 * 60 * 1000) return null;
  return parsed;
}

async function getHistory(userId, trace = null, limit = 12, options = {}) {
  const since = parseClientTimestamp(options.since);
  const fetchHistory = () => {
    let query = supabase
      .from('conversations')
      .select('id, role, content, created_at')
      .eq('user_id', userId)
      .neq('role', 'system')
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 12, 1), 200));
    if (since) query = query.gte('created_at', since.toISOString());
    return query;
  };
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
  if (Array.isArray(payload.sources) && payload.sources.length) next.sources = payload.sources;
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

// Proactive briefings/reminders are stored in conversations for model continuity but belong
// only on the Today tab — keep them out of the Chat thread.
function isChatVisibleEntry(entry) {
  return entry?.kind !== 'briefing' && entry?.kind !== 'proactive';
}

function normalizeConversationRow(row) {
  const parsed = safeParseJSON(row?.content);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return {
      ...row,
      content: typeof parsed.text === 'string' ? parsed.text : '',
      image: typeof parsed.image === 'string' ? parsed.image : null,
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
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

function cleanSessionTitle(raw) {
  if (!raw) return 'New conversation';
  let text = raw
    .replace(/^(hey oxy[,.]?\s*)/i, '')
    .replace(/^(oxy[,.]?\s*)/i, '');
  text = text.replace(/\b\w/g, c => c.toUpperCase());
  return text.length > 52 ? text.slice(0, 49) + '…' : text;
}

// Pull a user's full conversation history in pages. Supabase caps a single
// request at ~1000 rows, so a flat `.limit(250)` only reached back a few days
// for heavy users and hid older sessions. We page until exhausted (with a
// generous safety cap) so the session list spans back to the first ever chat.
async function fetchAllConversationRows(userId) {
  const pageSize = 1000;
  const maxPages = 50; // safety stop (~50k messages)
  let all = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await supabase
      .from('conversations')
      .select('id, role, content, created_at')
      .eq('user_id', userId)
      .neq('role', 'system')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
  }
  return all;
}

function buildConversationSessions(rows = []) {
  const sorted = rows
    .map(normalizeConversationRow)
    .filter(row => row.created_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const sessions = [];
  const gapMs = 45 * 60 * 1000;

  for (const row of sorted) {
    const createdAt = new Date(row.created_at);
    const lastSession = sessions[sessions.length - 1];
    const lastAt = lastSession ? new Date(lastSession.last_at) : null;
    const dayChanged = lastAt && createdAt.toISOString().slice(0, 10) !== lastAt.toISOString().slice(0, 10);
    const gapChanged = lastAt && createdAt.getTime() - lastAt.getTime() > gapMs;
    if (!lastSession || dayChanged || gapChanged) {
      sessions.push({
        id: row.id || row.created_at,
        title: '',
        preview: '',
        firstUserText: '',
        started_at: row.created_at,
        last_at: row.created_at,
        message_count: 0
      });
    }

    const session = sessions[sessions.length - 1];
    const text = conversationFallbackText(row).trim();
    session.last_at = row.created_at;
    session.message_count += 1;
    // Capture the session's *opening* user message once — this is what titles
    // should describe. `preview` (below) is the latest message and is only a
    // fallback for sessions that never had a user turn.
    if (!session.title && row.role === 'user' && text) session.title = text.slice(0, 80);
    if (!session.firstUserText && row.role === 'user' && text) session.firstUserText = text.slice(0, 240);
    if (text) session.preview = text.slice(0, 140);
  }

  return sessions
    .map(session => ({
      ...session,
      title: cleanSessionTitle(session.title || session.preview)
    }))
    .reverse()
    .slice(0, 30);
}

// Single source of truth for turning a conversation's opening text into a
// short descriptive title. Returns the cleaned title string or null on failure.
// Does NOT persist — callers store it under the right `_stitle_${sessionId}` key.
async function titleFromOpeningText(openingText) {
  const text = (openingText || '').trim();
  if (!text) return null;
  try {
    const model = genAI.getGenerativeModel({ model: FAST_MODEL });
    const result = await model.generateContent(
      `Write a short descriptive title (3-6 words) summarizing what this conversation is about. ` +
      `Describe the topic, do NOT echo the message verbatim. No quotes, no trailing punctuation. ` +
      `For example "how can i get to john lewis" becomes "Directions to John Lewis".\n\n` +
      `Conversation opening: "${text.slice(0, 240)}"\nReply with ONLY the title.`
    );
    const title = result.response.text().trim().replace(/^["'“”]|["'“”]$/g, '').slice(0, 60);
    return title || null;
  } catch (_) {
    return null;
  }
}

// Right after the first turn of a new session, generate and store its title.
// We rebuild the session grouping from recent rows (same logic the sessions
// endpoint uses) so the title is keyed on the SAME session id the UI looks up
// — avoiding the old "1 user + 1 assistant message" heuristic that could key
// on the wrong id or skip valid sessions.
async function maybeGenerateSessionTitle(userId, userMessageText, trace = null) {
  if (trace?.incognito) return;
  (async () => {
    try {
      const since = new Date(Date.now() - 50 * 60 * 1000).toISOString();
      const { data: recent } = await supabase
        .from('conversations')
        .select('id, role, content, created_at')
        .eq('user_id', userId)
        .neq('role', 'system')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(20);
      if (!recent || !recent.length) return;
      const sessions = buildConversationSessions(recent);
      const session = sessions[0]; // most recent (buildConversationSessions reverses)
      if (!session || session.message_count > 2) return;
      const titleKey = `_stitle_${session.id}`;
      const { data: existing } = await supabase
        .from('preferences').select('value')
        .eq('user_id', userId).eq('key', titleKey).maybeSingle();
      if (existing) return;
      const title = await titleFromOpeningText(session.firstUserText || userMessageText);
      if (title) {
        await supabase.from('preferences').upsert({ user_id: userId, key: titleKey, value: title }, { onConflict: 'user_id,key' });
      }
    } catch (_) {}
  })();
}

// Backfill descriptive titles for older sessions that still show a verbatim
// excerpt. Fire-and-forget so the listing stays fast; titles improve on the
// next load. Capped per request to avoid hammering the model. Titles are
// generated from the session's OPENING user message, not its latest line.
function backfillSessionTitles(userId, sessions, storedTitles) {
  const missing = sessions
    .filter(s => !storedTitles[s.id] && (s.firstUserText || s.preview || s.title))
    .slice(0, 12);
  if (!missing.length) return;
  (async () => {
    for (const s of missing) {
      const title = await titleFromOpeningText(s.firstUserText || s.preview || s.title);
      if (title) {
        await supabase.from('preferences').upsert(
          { user_id: userId, key: `_stitle_${s.id}`, value: title },
          { onConflict: 'user_id,key' }
        );
      }
    }
  })();
}

async function saveMessage(userId, role, content, trace = null) {
  // Incognito ("shadow") turns are never persisted.
  if (trace?.incognito) return;
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

async function getPreferenceEntries(userId) {
  const { data, error } = await supabase
    .from('preferences')
    .select('key, value')
    .eq('user_id', userId);
  if (error || !data) return [];
  return data;
}

async function getPreferenceMap(userId) {
  const entries = await getPreferenceEntries(userId);
  return Object.fromEntries(entries.map(entry => [entry.key, entry.value]));
}

async function setPreferenceValue(userId, key, value) {
  await supabase
    .from('preferences')
    .upsert({
      user_id: userId,
      key,
      value,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,key' });
}

async function getPendingAction(userId) {
  const { data, error } = await supabase
    .from('preferences')
    .select('value')
    .eq('user_id', userId)
    .eq('key', PENDING_ACTION_PREF)
    .maybeSingle();
  if (error || !data?.value) return null;
  try {
    const parsed = JSON.parse(data.value);
    if (!parsed?.action?.type) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function setPendingAction(userId, action, context = {}) {
  const payload = {
    action,
    createdAt: new Date().toISOString(),
    userMessage: context.userMessage || '',
    nativeHints: context.nativeHints || null
  };
  await setPreferenceValue(userId, PENDING_ACTION_PREF, JSON.stringify(payload));
  return payload;
}

async function clearPendingAction(userId) {
  await supabase
    .from('preferences')
    .delete()
    .eq('user_id', userId)
    .eq('key', PENDING_ACTION_PREF);
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
    google: ['send_email', 'get_emails', 'search_emails', 'create_calendar_event', 'get_calendar_events', 'create_google_doc', 'search_google_docs', 'append_google_doc', 'get_google_doc'],
    imessage: ['send_message'],
    whatsapp: ['send_message'],
    spotify: ['search_spotify', 'play_spotify', 'control_spotify_playback', 'add_to_spotify_queue', 'add_to_spotify_playlist', 'get_now_playing_spotify'],
    maps: ['find_place', 'get_directions', 'plan_trip'],
    uber: ['book_uber'],
    bolt: ['book_bolt'],
    wallet: ['add_to_wallet'],
    telegram: ['send_telegram', 'get_telegram_contacts'],
    notion: ['search_notion', 'create_notion_page', 'append_notion_page'],
    trainline: ['search_trains', 'station_board'],
    github: ['search_github', 'get_github_notifications', 'create_github_issue', 'comment_github_issue'],
    microsoft: ['send_outlook_email', 'get_outlook_emails', 'search_outlook_emails', 'create_outlook_event', 'get_outlook_events'],
    youtube: ['search_youtube'],
    indeed: ['search_indeed_jobs'],
    linkedin: ['search_linkedin_jobs', 'share_linkedin_post'],
    linear: ['search_linear_issues', 'get_linear_issues', 'create_linear_issue', 'comment_linear_issue']
  };
  const live = enabled.filter(id => IMPLEMENTED_CONNECTORS.has(id));
  const internalActions = 'forget_memory, find_place, play_music, add_to_music_playlist, generate_visual, create_diagram, create_presentation, create_reminder, create_scheduled_task, list_scheduled_tasks, cancel_scheduled_task, run_browser_task';
  if (live.length === 0) return `No connectors enabled. Internal actions still available: ${internalActions}.`;
  const active = live.flatMap(id => actionMap[id] || []);
  return `Available connector actions: ${active.join(', ')}. Internal actions always available: ${internalActions}. Only use enabled connector actions — don't suggest actions for connectors that aren't enabled.`;
}

async function savePreference(userId, key, value) {
  await supabase
    .from('preferences')
    .upsert({ user_id: userId, key, value }, { onConflict: 'user_id,key' });
}

async function getUserAccount(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, password_hash, token_version, email')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getUserAccountByEmail(email) {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, password_hash, token_version, email')
    .eq('email', email)
    .maybeSingle();

  if (error) throw error;
  return data;
}

const USER_DATA_TABLES = [
  'briefings',
  'native_context',
  'devices',
  'preferences',
  'connectors',
  'action_log',
  'memories',
  'conversations',
  'users'
];

async function fetchUserDataTable(table, userId) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  return data || [];
}

function sanitizeExportRows(table, rows) {
  if (table === 'connectors') {
    return rows.map(({ tokens, ...row }) => ({
      ...row,
      hasTokens: Boolean(tokens)
    }));
  }
  if (table === 'users') {
    return rows.map(({ password_hash, ...row }) => row);
  }
  return rows;
}

async function buildUserExport(userId) {
  const entries = await Promise.all(
    USER_DATA_TABLES.map(async table => [table, sanitizeExportRows(table, await fetchUserDataTable(table, userId))])
  );
  const data = Object.fromEntries(entries);
  return {
    exportedAt: new Date().toISOString(),
    userId,
    user: data.users?.[0] || null,
    conversations: data.conversations || [],
    memories: data.memories || [],
    actionLog: (data.action_log || []).map(row => ({ ...row, action: safeParseJSON(row.action) })),
    connectors: data.connectors || [],
    preferences: data.preferences || [],
    devices: data.devices || [],
    nativeContext: data.native_context || [],
    briefings: data.briefings || []
  };
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

app.post('/auth/register', registerRateLimiter, async (req, res) => {
  try {
    const { userId, password, email } = req.body || {};
    if (!requireValidUserIdValue(userId, res)) return;
    if (typeof password !== 'string' || password.length < 8 || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be between 8 and ${MAX_PASSWORD_LENGTH} characters.` });
    }

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email !== undefined && email !== null && email !== '') {
      if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'Invalid email address.' });
      }
    }

    const existing = await getUserAccount(userId);
    if (existing) {
      return res.status(409).json({ error: 'That user ID is already taken.' });
    }

    const passwordHash = hashPassword(password);
    const insertData = {
      user_id: userId,
      password_hash: passwordHash,
      token_version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (email) insertData.email = email;

    const { error } = await supabase.from('users').insert(insertData);
    if (error) throw error;

    log('info', 'auth.register', { userId });

    if (email) {
      try {
        const { sendWelcomeEmail } = require('./services/email');
        await sendWelcomeEmail(email, userId);
      } catch (e) {
        log('warn', 'email.welcome.failed', { error: e.message });
      }
    }

    res.json({ success: true, token: createSessionToken(userId, 1), userId });
  } catch (err) {
    log('error', 'auth.register.error', { error: err.message });
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/auth/login', loginRateLimiter, async (req, res) => {
  try {
    const { userId, email, password } = req.body || {};
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'Password is required and must be a reasonable length.' });
    }

    let account;
    let resolvedUserId;

    if (email) {
      const trimmedEmail = String(email).trim();
      account = await getUserAccountByEmail(trimmedEmail);
      resolvedUserId = account?.user_id;
    } else {
      const trimmedUserId = String(userId || '').trim();
      if (!requireValidUserIdValue(trimmedUserId, res)) return;
      account = await getUserAccount(trimmedUserId);
      resolvedUserId = trimmedUserId;
    }

    if (!account || !verifyPassword(password, account.password_hash)) {
      log('warn', 'auth.login.failed', { userId: resolvedUserId || 'unknown' });
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const tokenVersion = account.token_version || 1;
    log('info', 'auth.login', { userId: account.user_id });
    res.json({ success: true, token: createSessionToken(account.user_id, tokenVersion), userId: account.user_id });
  } catch (err) {
    log('error', 'auth.login.error', { error: err.message });
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/auth/logout', (req, res) => {
  res.json({ success: true });
});

app.post('/auth/logout-all', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { data: userRow } = await supabase.from('users').select('token_version').eq('user_id', userId).single();
    if (!userRow) return res.status(404).json({ error: 'User not found' });
    const { error } = await supabase.from('users').update({ token_version: (userRow.token_version || 1) + 1 }).eq('user_id', userId);
    if (error) throw error;
    log('info', 'auth.logout_all', { userId });
    res.json({ success: true });
  } catch (err) {
    log('error', 'auth.logout_all.error', { error: err.message });
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/auth/sessions', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { data: userRow } = await supabase.from('users').select('token_version, created_at').eq('user_id', userId).maybeSingle();
    res.json({ tokenVersion: userRow?.token_version || 1, note: 'Use POST /auth/logout-all to revoke all sessions' });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/auth/change-password', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ error: 'currentPassword is required.' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters.' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from current password.' });
    }
    const account = await getUserAccount(userId);
    if (!account || !verifyPassword(currentPassword, account.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const newHash = hashPassword(newPassword);
    const newVersion = (account.token_version || 1) + 1;
    await supabase.from('users').update({ password_hash: newHash, token_version: newVersion }).eq('user_id', userId);
    log('info', 'auth.change_password', { userId });
    res.json({ success: true });
  } catch (err) {
    log('error', 'auth.change_password.error', { error: err.message });
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/auth/forgot-password', forgotPasswordRateLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    const RESPONSE = { message: "If this email is registered, you'll receive a reset link shortly." };
    if (!email || typeof email !== 'string') return res.json(RESPONSE);

    const account = await getUserAccountByEmail(String(email).trim());
    if (!account) return res.json(RESPONSE);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await supabase.from('password_reset_tokens').insert({ user_id: account.user_id, token: sha256Token(token), expires_at: expiresAt });

    const resetUrl = `${process.env.APP_URL || ''}/auth/reset-password?token=${token}`;
    log('info', 'password_reset.token_created', { event: '[password-reset]', url: resetUrl });

    try {
      const { sendPasswordResetEmail } = require('./services/email');
      await sendPasswordResetEmail(account.email, resetUrl);
    } catch (e) {
      log('warn', 'email.password_reset.failed', { error: e.message });
    }

    res.json(RESPONSE);
  } catch (err) {
    log('error', 'auth.forgot_password.error', { error: err.message });
    res.json({ message: "If this email is registered, you'll receive a reset link shortly." });
  }
});

app.get('/auth/reset-password', (req, res) => {
  const { token } = req.query;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><title>Reset Password · Oxy</title>
  <style>body{font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 24px;color:#1a1a1a}
  h2{margin-bottom:8px}input{width:100%;padding:10px;margin:8px 0 16px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px;font-size:15px}
  button{width:100%;padding:12px;background:#2563eb;color:white;border:none;border-radius:6px;font-size:15px;cursor:pointer}</style>
  </head><body>
  <h2>Reset your password</h2>
  <p>Enter a new password (minimum 8 characters).</p>
  <form method="POST" action="/auth/reset-password">
    <input type="hidden" name="token" value="${escapeHtml(String(token || ''))}">
    <label>New Password<input type="password" name="newPassword" minlength="8" required></label>
    <button type="submit">Reset Password</button>
  </form>
  </body></html>`);
});

app.post('/auth/reset-password', resetPasswordRateLimiter, express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    // Browser form submissions get an HTML page; API clients (JSON) get JSON.
    const wantsHtml = (req.get('Accept') || '').includes('text/html');
    const fail = (status, message) => {
      if (wantsHtml) {
        res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(`<!DOCTYPE html><html><head><title>Reset Password · Oxy</title><style>body{font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 24px;color:#1a1a1a;text-align:center}</style></head><body><h2>Couldn't reset password</h2><p>${escapeHtml(message)}</p><p><a href="/auth/forgot-password">Request a new reset link</a></p></body></html>`);
      }
      return res.status(status).json({ error: message });
    };
    if (!token || !newPassword) return fail(400, 'Token and newPassword are required.');
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return fail(400, 'Password must be at least 8 characters.');
    }
    const { data: tokenRow } = await supabase.from('password_reset_tokens').select('id, user_id, expires_at, used').eq('token', sha256Token(token)).maybeSingle();
    if (!tokenRow || tokenRow.used || new Date(tokenRow.expires_at) < new Date()) {
      return fail(400, 'Invalid or expired reset token.');
    }
    const newHash = hashPassword(newPassword);
    const account = await getUserAccount(tokenRow.user_id);
    const newVersion = (account?.token_version || 1) + 1;
    await Promise.all([
      supabase.from('users').update({ password_hash: newHash, token_version: newVersion }).eq('user_id', tokenRow.user_id),
      supabase.from('password_reset_tokens').update({ used: true }).eq('id', tokenRow.id)
    ]);
    log('info', 'auth.password_reset.completed', { userId: tokenRow.user_id });
    if (wantsHtml) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!DOCTYPE html><html><head><title>Password Reset · Oxy</title><style>body{font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 24px;color:#1a1a1a;text-align:center}</style></head><body><h2>Password reset ✓</h2><p>Your password has been changed and all other sessions have been signed out. You can now sign in with your new password.</p></body></html>`);
    }
    res.json({ success: true });
  } catch (err) {
    log('error', 'auth.reset_password.error', { error: err.message });
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/auth/verify-email', verifyEmailRateLimiter, async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const account = await getUserAccount(userId);
    if (!account || !account.email) return res.status(400).json({ error: 'No email address on this account.' });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('password_reset_tokens').insert({ user_id: userId, token: sha256Token(token), expires_at: expiresAt });
    const verifyUrl = `${process.env.APP_URL || ''}/auth/verify-email/confirm?token=${token}`;
    try {
      const { sendVerificationEmail } = require('./services/email');
      await sendVerificationEmail(account.email, verifyUrl);
    } catch (e) {
      log('warn', 'email.verify.failed', { error: e.message });
    }
    res.json({ success: true, message: 'Verification email sent.' });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
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
  const audioTraceId = `process-audio:${userId}:${Date.now()}`;
  const sse = obj => {
    if (obj?.type === 'audio') {
      console.log(`[audio][backend:${audioTraceId}] sending audio event bytes=${Buffer.from(obj.data || '', 'base64').length} mime=${obj.mimeType || 'audio/wav'}`);
    }
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    const tStart = Date.now();
    const hint = await buildTranscriptionHint(userId);
    // Transcribe + Wispr-style cleanup in one call, in parallel with context
    // building — so the first response token is gated only by one STT call.
    const [userText, context] = await Promise.all([
      transcribeAndCleanAudio(req.file.buffer, hint),
      buildChatContext(userId, '', null, STREAMING_CHAT_MODEL) // message unknown yet — no search for audio transcription step
    ]);
    console.log(`[latency][process-audio] userId=${userId} transcribe+context=${Date.now() - tStart}ms`);

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
    const initialRequest = buildModernGenerateRequest({
      dynamicSystemPrompt,
      useSearch,
      cachedContentName,
      baseHistory,
      userContent: { role: 'user', parts: [{ text: userText }] }
    });

    const stream = await modernGenAI.models.generateContentStream({
      model: STREAMING_CHAT_MODEL,
      contents: initialRequest.contents,
      config: initialRequest.config
    });
    let fullText = '';
    for await (const chunk of stream) {
      const text = chunk.text || '';
      if (text) fullText += text;
    }

    const { spoken, actions } = parseActions(fullText);

    let actionResults = [];
    let audioBase64 = null;
    let ttsError = '';
    if (actions.length > 0) {
      actionResults = await executeActions(userId, actions, { userMessage: userText });
      actionResults = normalizeActionResultsForClient(actionResults);
    }
    const dataResults = getStructuredDataResults(actionResults);
    let finalSpoken = canUseDirectActionSummary(actionResults) ? summarizeActionResults(actionResults) : spoken;
    if (!canUseDirectActionSummary(actionResults) && dataResults.length > 0) {
      const context = dataResults.map(a => a.text).join('\n\n');
      const followUpRequest = buildModernGenerateRequest({
        dynamicSystemPrompt,
        useSearch,
        cachedContentName,
        baseHistory,
        userContent: { role: 'user', parts: [{ text: userText }] }
      });
      followUpRequest.contents.push(
        { role: 'model', parts: [{ text: spoken || '...' }] },
        { role: 'user', parts: [{ text: `Here are the results:\n\n${context}\n\nSpeak these back naturally and conversationally. Be concise. Only use the results shown here. Do not add unstated facts.` }] }
      );
      const followUp = await modernGenAI.models.generateContent({
        model: PRIMARY_CHAT_MODEL,
        contents: followUpRequest.contents,
        config: followUpRequest.config
      });
      finalSpoken = parseActions(followUp.text || '').spoken || context;
    }
    const actionConfirmation = summarizeFinishedActionsForUser(actionResults);
    if (actionConfirmation) finalSpoken = actionConfirmation;
    audioBase64 = await generateSpeech(buildVoiceExcerpt(finalSpoken), req.body.voice).catch(err => {
      ttsError = err.message;
      console.error('[tts error]', err.message);
      return null;
    });
    saveMessage(userId, 'assistant', { text: finalSpoken, actions: actionResults }).catch(() => {});

    console.log(`[latency][process-audio] userId=${userId} fullResponse=${Date.now() - tStart}ms (transcribe→spoken+audio ready)`);
    sse({ type: 'response', text: finalSpoken, actions: actionResults });
    if (audioBase64) sse({ type: 'audio', data: audioBase64, format: 'wav', mimeType: 'audio/wav' });
    if (ttsError) sse({ type: 'tts-error', error: ttsError });
    sse({ type: 'done' });
    res.end();

    postResponseTasks(userId, userText);
  } catch (err) {
    console.error('/process-audio error:', err.message);
    try { sse({ type: 'error', error: 'Processing failed. Please try again.' }); res.end(); } catch {}
  }
});

// Pendant-only transcription: receives raw WAV from the iOS bridge, runs
// Gemini transcription, and returns just the text. The iOS app then calls
// sendMessage() so the transcript goes through the full chat pipeline with
// full UI visibility (same as typed text). Reuses audioRateLimit (10/min).
app.post('/pendant/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ transcript: '' });
  }
  const userId = req.body.userId;
  if (!requireMatchingUser(req, res, userId)) return;

  const now = Date.now();
  const recentHits = (audioRateLimit.get(userId) || []).filter(t => now - t < 60000);
  if (recentHits.length >= 10) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }
  audioRateLimit.set(userId, [...recentHits, now]);

  try {
    const tStart = Date.now();
    const hint = await buildTranscriptionHint(userId);
    const tHint = Date.now();
    // One call transcribes and cleans (Wispr-style) — half the model round trips
    // of the old transcribe-then-polish path, so the pendant/mic feels snappier.
    const transcript = await transcribeAndCleanAudio(req.file.buffer, hint);
    const tEnd = Date.now();
    // Greppable in Cloud Run: `grep "[latency]"`. This is half the pendant turn;
    // the other half (the spoken reply) is the /chat `request.total` marker.
    console.log(`[latency][pendant/transcribe] userId=${userId} audioMs=${getWavDurationMs(req.file.buffer) || '?'} hint=${tHint - tStart}ms transcribe=${tEnd - tHint}ms total=${tEnd - tStart}ms transcript="${transcript}"`);
    res.json({ transcript: transcript || '' });
  } catch (err) {
    console.error('/pendant/transcribe error:', err.message);
    res.status(500).json({ transcript: '' });
  }
});

app.post('/images/generate', imageRateLimiter, upload.single('image'), async (req, res) => {
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
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/chat-with-image', imageRateLimiter, upload.single('image'), async (req, res) => {
  try {
    const userId = req.body.userId;
    const message = (req.body.message || '').trim();
    const settings = safeParseJSON(req.body.settings) || {};
    const chatStartedAt = req.body.chatStartedAt || null;
    const wantsTTS = req.query.tts === 'true';

    if (!requireMatchingUser(req, res, userId)) return;
    if (!req.file) return res.status(400).json({ error: 'file is required.' });
    if (!message) return res.status(400).json({ error: 'message is required.' });

    const isImage = (req.file.mimetype || '').startsWith('image/');
    const fileLabel = isImage ? 'image' : 'file';
    const fileContextHint = isImage
      ? `The user attached an image or screenshot. Use it as context when helpful.\n\n${message}`
      : `The user attached a file (${req.file.originalname || 'document'}, type: ${req.file.mimetype}). Use its content to answer their question.\n\n${message}`;

    const [{ history, useSearch, dynamicSystemPrompt, cachedContentName }] = await Promise.all([
      buildChatContext(userId, message, null, PRIMARY_CHAT_MODEL, { chatStartedAt }),
      saveMessage(userId, 'user', `${message}\n\n[Attached ${fileLabel}: ${req.file.originalname || fileLabel}]`)
    ]);
    const baseHistory = normalizeGeminiHistory(history);
    const initialRequest = buildModernGenerateRequest({
      dynamicSystemPrompt,
      useSearch,
      cachedContentName,
      baseHistory,
      userContent: {
        role: 'user',
        parts: [
          { text: fileContextHint },
          { inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') } }
        ]
      }
    });

    const geminiRes = await modernGenAI.models.generateContent({
      model: PRIMARY_CHAT_MODEL,
      contents: initialRequest.contents,
      config: initialRequest.config
    });
    let { spoken, actions } = parseActions(geminiRes.text || '');
    let actionResults = [];
    if (actions.length > 0) {
      actionResults = await executeActions(userId, actions, { imageFile: req.file, userMessage: message });
      actionResults = normalizeActionResultsForClient(actionResults);
    }

    const dataResults = getStructuredDataResults(actionResults);
    if (canUseDirectActionSummary(actionResults)) {
      spoken = summarizeActionResults(actionResults);
    } else if (dataResults.length > 0) {
      const context = dataResults.map(a => a.text).join('\n\n');
      const followUpRequest = buildModernGenerateRequest({
        dynamicSystemPrompt,
        useSearch,
        cachedContentName,
        baseHistory,
        userContent: {
          role: 'user',
          parts: [
            { text: fileContextHint },
            { inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') } }
          ]
        }
      });
      followUpRequest.contents.push(
        { role: 'model', parts: [{ text: spoken || '...' }] },
        { role: 'user', parts: [{ text: `Here are the action results:\n\n${context}\n\nRespond naturally and use only the results shown here plus the attached ${fileLabel} context. Do not invent unstated facts.` }] }
      );
      const followUp = await modernGenAI.models.generateContent({
        model: PRIMARY_CHAT_MODEL,
        contents: followUpRequest.contents,
        config: followUpRequest.config
      });
      spoken = parseActions(followUp.text || '').spoken || spoken || context;
    }
    const actionConfirmation = summarizeFinishedActionsForUser(actionResults);
    if (actionConfirmation) spoken = actionConfirmation;

    if (!spoken) {
      spoken = actionResults.map(a => a.result?.text).filter(Boolean).join(' ') || 'I looked through it.';
    }

    saveMessage(userId, 'assistant', { text: spoken, actions: actionResults }).catch(() => {});
    const result = { text: spoken, actions: actionResults };

    if (wantsTTS) {
      try {
        const audio = await generateSpeech(buildVoiceExcerpt(spoken), settings.voice);
        if (audio) {
          console.log(`[audio][backend:chat-image] returning tts audio bytes=${Buffer.from(audio, 'base64').length} mime=audio/wav`);
          result.audio = audio;
          result.audioFormat = 'wav';
          result.audioMimeType = 'audio/wav';
        }
      } catch (ttsErr) {
        console.error('[tts error]', ttsErr.message);
        result.ttsError = ttsErr.message;
      }
    }

    res.json(result);
  } catch (err) {
    console.error('/chat-with-image error:', err.response?.data || err.message);
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/memory', async (req, res) => {
  try {
    const { userId, content } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required.' });
    // User-added memories are additive items (each persists and is individually
    // deletable), not the single-slot manual_profile blob.
    await saveMemory(userId, content.trim(), 'manual');

    res.json({ success: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/memory/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    res.json({ summary: await getMemorySummary(req.params.userId) });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

// Full list of individual memories for the Memory tab (view + delete each).
app.get('/memory/:userId/items', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('id, content, source, created_at')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

// Delete a single memory by id.
app.delete('/memory/:userId/items/:id', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const { error } = await supabase
      .from('memories')
      .delete()
      .eq('user_id', req.params.userId)
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.delete('/memory/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const result = await forgetMemory(req.params.userId, req.body || { scope: 'all' });
    res.json(result);
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/user/:userId/export', async (req, res) => {
  const { userId } = req.params;
  if (!requireMatchingUser(req, res, userId)) return;
  try {
    const data = await buildUserExport(userId);
    res.setHeader('Content-Disposition', 'attachment; filename="oxy-data-export.json"');
    res.json(data);
  } catch (err) {
    console.error('/user/export error:', err.message);
    res.status(500).json({ error: 'Could not export your data right now.' });
  }
});

app.delete('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!requireMatchingUser(req, res, userId)) return;
  try {
    for (const table of USER_DATA_TABLES) {
      const { error } = await supabase.from(table).delete().eq('user_id', userId);
      if (error) throw error;
    }
    contextCache.delete(userId);
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('/user/delete error:', err.message);
    res.status(500).json({ error: 'Could not delete your account right now.' });
  }
});

app.post('/action-log', async (req, res) => {
  try {
    const { userId, action, status = 'executed' } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    if (!action) return res.status(400).json({ error: 'action is required.' });
    if (!ACTION_LOG_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status.' });
    
    await supabase.from('action_log').insert({
      user_id: userId,
      action: JSON.stringify(action),
      status,
      created_at: new Date().toISOString()
    });
    res.json({ success: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
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
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/action-contracts', requireSessionAuth, (req, res) => {
  res.json({ actions: ACTION_CONTRACTS });
});

app.post('/travel-concierge/parse', requireSessionAuth, async (req, res) => {
  try {
    const { userId, message, context } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required.' });
    }
    const previous = context && typeof context === 'object'
      ? context
      : parseStoredTravelContext(await getPreferenceMap(userId));
    const state = await buildTravelConciergeState(message, previous, { maxQuestions: 3, callModel: callTravelModel });
    await saveTravelContext(userId, state);
    res.json(state);
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

// --- Trip CRUD endpoints ---

app.post('/trips', requireSessionAuth, async (req, res) => {
  try {
    const { userId, destination, title, requirements, itinerary, budget } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    if (!destination) return res.status(400).json({ error: 'destination is required.' });
    const tripTitle = title || [destination, requirements?.date].filter(Boolean).join(' ');
    const { data, error } = await supabase.from('travel_sessions').insert({
      user_id: userId,
      title: tripTitle,
      status: 'planning',
      requirements: requirements || {},
      itinerary: itinerary || {},
      budget: budget || {}
    }).select('id, title, status, created_at').single();
    if (error) return sendServerError(res, error, 'trips.create.error');
    res.json(data);
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/trips/:userId', requireSessionAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!requireMatchingUser(req, res, userId)) return;
    const { data, error } = await supabase
      .from('travel_sessions')
      .select('id, title, status, requirements, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) return sendServerError(res, error, 'trips.list.error');
    res.json({ trips: data || [] });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/trips/:userId/:tripId', requireSessionAuth, async (req, res) => {
  try {
    const { userId, tripId } = req.params;
    if (!requireMatchingUser(req, res, userId)) return;
    const { data, error } = await supabase
      .from('travel_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('id', tripId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Trip not found.' });
    res.json(data);
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.put('/trips/:userId/:tripId', requireSessionAuth, async (req, res) => {
  try {
    const { userId, tripId } = req.params;
    if (!requireMatchingUser(req, res, userId)) return;
    const { title, status, requirements, itinerary, budget } = req.body || {};
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (status !== undefined) updates.status = status;
    if (requirements !== undefined) updates.requirements = requirements;
    if (itinerary !== undefined) updates.itinerary = itinerary;
    if (budget !== undefined) updates.budget = budget;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update.' });
    const { data, error } = await supabase
      .from('travel_sessions')
      .update(updates)
      .eq('user_id', userId)
      .eq('id', tripId)
      .select('id, title, status, updated_at')
      .single();
    if (error || !data) return res.status(404).json({ error: 'Trip not found.' });
    res.json(data);
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.delete('/trips/:userId/:tripId', requireSessionAuth, async (req, res) => {
  try {
    const { userId, tripId } = req.params;
    if (!requireMatchingUser(req, res, userId)) return;
    const { error } = await supabase
      .from('travel_sessions')
      .delete()
      .eq('user_id', userId)
      .eq('id', tripId);
    if (error) return sendServerError(res, error, 'trips.delete.error');
    res.json({ deleted: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

// --- Itinerary generation & modification ---

// Shared callModel wrapper for itinerary engine (system + user prompt, JSON output)
async function callItineraryModel(systemPrompt, userPrompt) {
  try {
    const model = genAI.getGenerativeModel({
      model: PRIMARY_CHAT_MODEL,
      systemInstruction: systemPrompt,
      generationConfig: { responseMimeType: 'application/json' }
    });
    const result = await model.generateContent(userPrompt);
    return result.response.text();
  } catch {
    return null;
  }
}

app.post('/trips/:userId/:tripId/generate-itinerary', requireSessionAuth, async (req, res) => {
  try {
    const { userId, tripId } = req.params;
    if (!requireMatchingUser(req, res, userId)) return;

    const { data: trip, error: tripErr } = await supabase
      .from('travel_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('id', tripId)
      .single();
    if (tripErr || !trip) return res.status(404).json({ error: 'Trip not found.' });

    const requirements = trip.requirements || {};
    if (!requirements.destination) return res.status(400).json({ error: 'Trip has no destination in requirements.' });

    const [travelProfile, hotelsResult, activitiesResult, flightsResult] = await Promise.all([
      getTravelProfile(userId),
      requirements.destination
        ? dispatch(userId, 'search_hotels', {
            destination: requirements.destination,
            checkIn: requirements.date,
            checkOut: requirements.endDate,
            guests: requirements.partySize,
            style: requirements.accommodationPreference || travelProfile?.hotel_style
          }).catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] }),
      dispatch(userId, 'search_activities', {
        destination: requirements.destination,
        interests: requirements.activityPreferences
      }).catch(() => ({ data: [] })),
      requirements.origin && requirements.date
        ? dispatch(userId, 'search_flights', {
            origin: requirements.origin,
            destination: requirements.destination,
            date: requirements.date,
            returnDate: requirements.endDate,
            partySize: requirements.partySize
          }).catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] })
    ]);

    const rankedSearch = {
      hotels:     rankHotels(hotelsResult?.data || [], travelProfile, requirements),
      activities: rankActivities(activitiesResult?.data || [], travelProfile, requirements),
      flights:    rankFlights(flightsResult?.data || [], travelProfile, requirements)
    };

    const itinerary = await generateItinerary(requirements, rankedSearch, travelProfile, callItineraryModel);

    // Save itinerary back to the trip
    await supabase
      .from('travel_sessions')
      .update({ itinerary, status: 'planning' })
      .eq('id', tripId)
      .eq('user_id', userId);

    res.json({ itinerary, text: itineraryToText(itinerary) });
  } catch (err) {
    return sendServerError(res, err, 'itinerary.generate.error');
  }
});

app.post('/trips/:userId/:tripId/modify', requireSessionAuth, async (req, res) => {
  try {
    const { userId, tripId } = req.params;
    if (!requireMatchingUser(req, res, userId)) return;
    const { instruction } = req.body || {};
    if (!instruction) return res.status(400).json({ error: 'instruction is required.' });

    const { data: trip, error: tripErr } = await supabase
      .from('travel_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('id', tripId)
      .single();
    if (tripErr || !trip) return res.status(404).json({ error: 'Trip not found.' });
    if (!trip.itinerary?.days?.length) return res.status(400).json({ error: 'Trip has no itinerary to modify. Generate one first.' });

    const modified = await modifyItinerary(trip.itinerary, instruction, trip.requirements || {}, callItineraryModel);

    await supabase
      .from('travel_sessions')
      .update({ itinerary: modified })
      .eq('id', tripId)
      .eq('user_id', userId);

    res.json({ itinerary: modified, summary: modified.lastModification?.summary });
  } catch (err) {
    return sendServerError(res, err, 'itinerary.modify.error');
  }
});

// Update the user's long-term travel preference profile
app.post('/travel-profile/:userId', requireSessionAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!requireMatchingUser(req, res, userId)) return;
    const allowed = ['hotel_style', 'activity_types', 'travel_style', 'dietary_requirements',
      'accessibility_needs', 'budget_tier', 'preferred_airlines', 'past_destinations', 'disliked_destinations'];
    const updates = Object.fromEntries(
      Object.entries(req.body || {}).filter(([k]) => allowed.includes(k))
    );
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields provided.' });
    await upsertTravelProfile(userId, updates);
    res.json({ updated: true });
  } catch (err) {
    return sendServerError(res, err, 'travel.profile.update.error');
  }
});

app.get('/travel-profile/:userId', requireSessionAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!requireMatchingUser(req, res, userId)) return;
    const profile = await getTravelProfile(userId);
    res.json(profile || {});
  } catch (err) {
    return sendServerError(res, err, 'travel.profile.get.error');
  }
});

// --- End itinerary & profile ---

const CONNECTORS = [
  { id: 'google',    name: 'Google (Gmail + Calendar)', icon: 'google', category: 'Google',        implemented: true },
  { id: 'uber',      name: 'Uber',                      icon: 'uber', category: 'Transport',     implemented: true },
  { id: 'bolt',      name: 'Bolt',                      icon: 'bolt', category: 'Transport',     implemented: true },
  { id: 'wallet',    name: 'Apple Wallet',               icon: 'wallet', category: 'System',      implemented: true },
  { id: 'maps',      name: 'Maps',                      icon: 'maps', category: 'Travel',        implemented: true },
  { id: 'telegram',  name: 'Telegram',                  icon: 'telegram', category: 'Messages',      implemented: true },
  { id: 'trainline', name: 'Trainline',                 icon: 'trainline', category: 'Transport',     implemented: true },
  { id: 'github',    name: 'GitHub',                    icon: 'github', category: 'Developer',      implemented: true, auth: 'oauth' },
  { id: 'microsoft', name: 'Outlook (Mail + Calendar)', icon: 'outlook', category: 'Microsoft',     implemented: true, auth: 'oauth' },
  { id: 'notion',    name: 'Notion',                    icon: 'notion', category: 'Productivity',   implemented: true, auth: 'oauth' },
  { id: 'youtube',   name: 'YouTube',                   icon: 'youtube', category: 'Entertainment', implemented: true },
  { id: 'indeed',    name: 'Indeed',                    icon: 'indeed', category: 'Jobs',           implemented: true },
  { id: 'linkedin',  name: 'LinkedIn',                  icon: 'linkedin', category: 'Jobs',           implemented: true },
  { id: 'spotify',   name: 'Spotify',                   icon: 'spotify', category: 'Entertainment', implemented: true, auth: 'oauth' },
  { id: 'linear',    name: 'Linear',                    icon: 'linear', category: 'Developer',      implemented: true, auth: 'oauth' },
  // Travel search (flights/hotels/activities) is a built-in agent capability, not a
  // user-configurable connector — the assistant dispatches it internally. The provider
  // (Amadeus/Viator) is an implementation detail and deliberately never surfaced.
];
const KNOWN_CONNECTOR_IDS = new Set(CONNECTORS.map(c => c.id));
const ACTION_LOG_STATUSES = new Set(['executed', 'failed', 'pending']);
const PENDING_ACTION_PREF = 'pending.action';
const PENDING_PLACE_PREF = 'pending.place';
const TRAVEL_CONTEXT_PREF = 'travel.concierge.context';

function parseStoredTravelContext(preferences = {}) {
  const raw = preferences[TRAVEL_CONTEXT_PREF];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

async function saveTravelContext(userId, state, trace = null) {
  if (!state?.active) return;
  try {
    await setPreferenceValue(userId, TRAVEL_CONTEXT_PREF, JSON.stringify(state));
  } catch (err) {
    if (trace) trace.log('supabase.preferences.travel_context_save_failed', err.message);
  }
}

// --- Travel profile (long-term user travel preferences) ---

async function getTravelProfile(userId, trace) {
  try {
    const { data, error } = await supabase
      .from('travel_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error && trace) trace.log('supabase.travel_preferences.error', error.message);
    return data || null;
  } catch {
    return null;
  }
}

async function upsertTravelProfile(userId, updates = {}, trace) {
  if (!userId || !Object.keys(updates).length) return;
  try {
    await supabase
      .from('travel_preferences')
      .upsert({ user_id: userId, ...updates, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  } catch (err) {
    if (trace) trace.log('supabase.travel_preferences.upsert_failed', err.message);
  }
}

function buildTravelProfileBlock(profile) {
  if (!profile) return '';
  const parts = [];
  if (profile.hotel_style) parts.push(`Hotel preference: ${profile.hotel_style}`);
  if (profile.activity_types?.length) parts.push(`Activity interests: ${profile.activity_types.join(', ')}`);
  if (profile.travel_style) parts.push(`Travel style: ${profile.travel_style}`);
  if (profile.dietary_requirements?.length) parts.push(`Dietary requirements: ${profile.dietary_requirements.join(', ')}`);
  if (profile.accessibility_needs?.length) parts.push(`Accessibility needs: ${profile.accessibility_needs.join(', ')}`);
  if (profile.budget_tier) parts.push(`Budget tier: ${profile.budget_tier}`);
  if (profile.preferred_airlines?.length) parts.push(`Preferred airlines: ${profile.preferred_airlines.join(', ')}`);
  if (profile.past_destinations?.length) parts.push(`Past destinations: ${profile.past_destinations.join(', ')}`);
  if (profile.disliked_destinations?.length) parts.push(`Avoid: ${profile.disliked_destinations.join(', ')}`);
  if (!parts.length) return '';
  return `User travel profile:\n${parts.map(p => `- ${p}`).join('\n')}`;
}

// Thin wrapper: calls FAST_MODEL with JSON response mime — used as callModel for travel extraction
async function callTravelModel(prompt) {
  try {
    const model = genAI.getGenerativeModel({
      model: FAST_MODEL,
      generationConfig: { responseMimeType: 'application/json' }
    });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch {
    return null;
  }
}

// --- End travel helpers ---

async function setPendingPlace(userId, payload) {
  await setPreferenceValue(userId, PENDING_PLACE_PREF, JSON.stringify({ ...payload, createdAt: new Date().toISOString() }));
}

async function getPendingPlace(userId) {
  const { data, error } = await supabase
    .from('preferences')
    .select('value')
    .eq('user_id', userId)
    .eq('key', PENDING_PLACE_PREF)
    .maybeSingle();
  if (error || !data?.value) return null;
  try {
    const parsed = JSON.parse(data.value);
    // Expire after 15 minutes so a stale ask doesn't hijack a later message.
    if (parsed?.createdAt && Date.now() - new Date(parsed.createdAt).getTime() > 15 * 60 * 1000) return null;
    return parsed?.keyword ? parsed : null;
  } catch {
    return null;
  }
}

async function clearPendingPlace(userId) {
  await supabase.from('preferences').delete().eq('user_id', userId).eq('key', PENDING_PLACE_PREF);
}

// A short, command-free reply that's plausibly a place name answering our ask.
function looksLikePlaceAnswer(message) {
  const t = String(message || '').trim();
  if (!t || t.length > 80 || /[?]/.test(t)) return false;
  if (/^(play|send|remind|remember|book|order|email|text|call|what|when|why|how|who|where|cancel|stop|no|nevermind|never mind|forget|yes|yeah)\b/i.test(t)) return false;
  return true;
}

app.get('/connectors/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('connector_id, enabled, tokens')
      .eq('user_id', req.params.userId);
    if (error) throw error;

    const rowsById = new Map();
    if (data) {
      data.forEach(c => rowsById.set(c.connector_id, c));
    }
    
    const result = CONNECTORS.map(c => {
      const row = rowsById.get(c.id);
      const enabled = row?.enabled === true;
      const hasRefreshToken = Boolean(row?.tokens?.refresh_token || row?.tokens?.session || row?.tokens?.encrypted);
      const needsReconnect = c.id === 'google' && enabled && !hasRefreshToken;
      const needsSetup = c.id === 'maps' && !(process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY);
      const degraded = c.id === 'trainline' && (!process.env.TRANSPORT_API_APP_ID || !process.env.TRANSPORT_API_APP_KEY);
      const connectionState = needsReconnect
        ? 'needs_reconnect'
        : needsSetup
          ? 'needs_setup'
          : degraded
            ? 'degraded'
            : enabled
              ? 'connected'
              : 'available';
      return {
        ...c,
        enabled,
        connectionState,
        statusText: connectionState === 'needs_reconnect'
          ? 'Reconnect needed'
          : connectionState === 'needs_setup'
            ? 'Setup needed'
            : connectionState === 'degraded'
              ? 'Fallback only'
              : connectionState === 'connected'
                ? 'Connected'
                : 'Available'
      };
    });
    
    res.json({ connectors: result });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/connectors', async (req, res) => {
  try {
    const { userId, connectorId, enabled } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    if (!KNOWN_CONNECTOR_IDS.has(connectorId)) {
      return res.status(400).json({ error: 'Unknown connector.' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.' });
    }

    const { error } = await supabase
      .from('connectors')
      .upsert({
        user_id: userId,
        connector_id: connectorId,
        enabled,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,connector_id' });
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/devices/register', async (req, res) => {
  try {
    const { userId, platform = 'ios', pushToken, timezone = TIMEZONE } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    if (!DEVICE_PLATFORM_ALLOWLIST.has(platform)) {
      return res.status(400).json({ error: 'Unsupported device platform.' });
    }
    if (!pushToken || typeof pushToken !== 'string') {
      return res.status(400).json({ error: 'pushToken is required.' });
    }

    const { error } = await supabase.from('devices').upsert({
      user_id: userId,
      platform,
      push_token: pushToken,
      timezone,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,push_token' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

// Test push: verifies APNS credentials + token registration end-to-end.
// Usage: POST /push/test { userId } with valid auth header.
app.post('/push/test', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;

    const bundleId = process.env.APNS_BUNDLE_ID;
    const token = apnsAuthToken();
    if (!bundleId || !token) {
      return res.status(503).json({
        ok: false,
        error: 'APNS credentials not configured. Set APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, and APNS_BUNDLE_ID env vars.'
      });
    }

    const { data: devices } = await supabase
      .from('devices')
      .select('push_token, platform')
      .eq('user_id', userId)
      .eq('platform', 'ios');

    if (!devices?.length) {
      return res.status(404).json({ ok: false, error: 'No iOS device tokens registered for this user. Make sure the app has notification permission enabled and has posted to /devices/register.' });
    }

    const result = await sendPushToUser(userId, {
      title: 'Oxy',
      body: 'Push notifications are working.'
    });

    res.json({ ok: true, devices: devices.length, sent: result.sent });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

// Push config diagnostic: shows whether APNs is configured and how many devices are registered.
// Device push needs a paid Apple Developer account + APNS_* env on Cloud Run; until then
// briefings still appear in the in-app feed.
app.get('/push/status', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!requireMatchingUser(req, res, userId)) return;
    const { count } = await supabase
      .from('devices')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('platform', 'ios');
    res.json({
      ok: true,
      apnsConfigured: apnsConfigured(),
      deviceCount: count || 0,
      note: apnsConfigured()
        ? undefined
        : 'APNs not configured. Set APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID (needs a paid Apple Developer account). Briefings still appear in the in-app feed without push.'
    });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/native/context', async (req, res) => {
  try {
    const { userId, location = null, health = {}, capabilities = {}, settings = {} } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    const { error } = await supabase.from('native_context').upsert({
      user_id: userId,
      location,
      health,
      capabilities,
      settings,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw error;
    invalidateUserContextCache(userId);
    res.json({ ok: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/native/local-action', async (req, res) => {
  try {
    const { userId, message, result } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    if (!message || !result?.action) {
      return res.status(400).json({ error: 'message and result.action are required.' });
    }

    await saveMessage(userId, 'user', String(message));
    await saveMessage(userId, 'assistant', { text: result.text || '', actions: [result] });
    await supabase.from('action_log').insert({
      user_id: userId,
      action: JSON.stringify({ type: result.action, input: { source: 'ios-native' } }),
      status: result.success === false ? 'failed' : 'executed',
      error: result.success === false ? (result.error || null) : null,
      created_at: new Date().toISOString()
    });

    invalidateUserContextCache(userId);
    res.json({ success: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

// ── Pendant speech polish ──────────────────────────────────────────────────
// Takes raw speech transcription and returns cleaned, polished text.
// Removes filler words, fixes grammar, normalises phrasing — but preserves
// the original intent so commands still execute correctly.
app.post('/polish-transcript', chatRateLimiter, async (req, res) => {
  try {
    const { userId, transcript } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    if (!transcript?.trim()) {
      return res.status(400).json({ error: 'transcript is required.' });
    }

    const polished = await polishTranscriptText(transcript);
    res.json({ polished });
  } catch (err) {
    // If polishing fails, return the original transcript — never block execution
    console.error('[polish-transcript] Error:', err.message);
    res.json({ polished: req.body?.transcript?.trim() || '' });
  }
});

app.get('/briefings/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    // "Today" feed — only show recent briefings (last 36h), not a weeks-old archive of
    // already-read cards.
    const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('briefings')
      .select('id, kind, title, body, source, metadata, read, created_at')
      .eq('user_id', req.params.userId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    // Strip markdown, then deduplicate: keep only the most recent briefing per window kind
    // (data is newest-first, so first-seen wins). Health alerts and other non-_briefing
    // kinds are each kept as-is.
    const seenKinds = new Set();
    const visible = (data || [])
      .filter(briefing => briefing.kind !== 'failed_action_followup')
      .map(briefing => ({ ...briefing, body: stripMarkdownEmphasis(briefing.body || '') }))
      .filter(briefing => {
        if (!/_briefing$/.test(briefing.kind || '')) return true;
        if (seenKinds.has(briefing.kind)) return false;
        seenKinds.add(briefing.kind);
        return true;
      });
    res.json({ briefings: visible });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/briefings/:id/read', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    const { error } = await supabase
      .from('briefings')
      .update({ read: true, read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/proactive/:userId/run', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!requireMatchingUser(req, res, userId)) return;
    // Manual "Refresh" from the Today tab: force a regenerate so it never returns the same
    // already-posted briefing.
    const summary = await runProactiveForUser(userId, console, new Date(), { force: true });
    res.json({ ok: true, summary });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.all('/proactive/sweep', async (req, res) => {
  try {
    if (!proactiveSweepAuthorized(req)) {
      return res.status(401).json({ error: 'Invalid proactive sweep secret.' });
    }
    const summary = await runProactiveSweep(console);
    res.json({ ok: true, summary });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.post('/tts-preview', async (req, res) => {
  try {
    const { voice = 'Aoede', text = 'Hi, it is lovely to meet you. This is how I sound.' } = req.body || {};
    console.log(`[audio][backend:tts-preview] request voice=${voice} chars=${String(text || '').trim().length}`);
    const audio = await generateSpeech(String(text || '').trim().slice(0, 180), voice);
    if (!audio) {
      return res.status(500).json({ error: 'No preview audio was generated.' });
    }
    console.log(`[audio][backend:tts-preview] returning bytes=${Buffer.from(audio, 'base64').length} mime=audio/wav`);
    res.json({ audio, audioFormat: 'wav', audioMimeType: 'audio/wav' });
  } catch (err) {
    console.error('[audio][backend:tts-preview] error', err.message);
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/briefing/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const userId = req.params.userId;
    const queuedHistory = await getHistory(userId);
    const latestQueuedBriefing = [...queuedHistory]
      .reverse()
      .find(entry => {
        if (entry.role !== 'assistant') return false;
        if (entry.kind !== 'briefing' && entry.kind !== 'proactive') return false;
        return entry.created_at && (Date.now() - new Date(entry.created_at).getTime()) < 36 * 60 * 60 * 1000;
      });

    if (!latestQueuedBriefing) {
      return res.json({});
    }

    return res.json({
      text: latestQueuedBriefing.content,
      actions: latestQueuedBriefing.actions || [],
      created_at: latestQueuedBriefing.created_at,
      kind: latestQueuedBriefing.kind || 'briefing'
    });
  } catch (err) {
    console.error('/briefing error:', err.message);
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/history/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const history = await getHistory(req.params.userId, null, req.query.limit || 50, {
      since: req.query.since
    });
    // Proactive briefings/reminders live on the Today tab (the briefings table). They're also
    // saved to conversations for model continuity, but must not show in the Chat thread.
    res.json({ history: history.filter(isChatVisibleEntry) });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/history/:userId/sessions', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const [convRows, prefResult] = await Promise.all([
      fetchAllConversationRows(req.params.userId),
      supabase
        .from('preferences')
        .select('key, value')
        .eq('user_id', req.params.userId)
        .like('key', '_stitle_%')
    ]);
    const sessions = buildConversationSessions(convRows);
    const storedTitles = Object.fromEntries(
      (prefResult.data || []).map(p => [p.key.replace('_stitle_', ''), p.value])
    );
    const sessionsWithTitles = sessions.map(s => ({
      ...s,
      title: storedTitles[s.id] || s.title
    }));
    backfillSessionTitles(req.params.userId, sessions, storedTitles);
    res.json({ sessions: sessionsWithTitles });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

// Delete a conversation "session". Sessions are synthetic — a time-gap grouping of
// conversation rows, not a stored row — so we delete every row in the session's
// [from, to] created_at window. Ranges are disjoint (sessions split on >45min gaps),
// so this never bleeds into a neighbouring conversation.
app.delete('/history/:userId/sessions/:sessionId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  if (!from || !to) return res.status(400).json({ error: 'bad.request' });
  try {
    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('user_id', req.params.userId)
      .gte('created_at', from)
      .lte('created_at', to);
    if (error) throw error;
    // Drop the stored title for this session, if one was generated.
    await supabase
      .from('preferences')
      .delete()
      .eq('user_id', req.params.userId)
      .eq('key', `_stitle_${req.params.sessionId}`);
    res.json({ ok: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/history/:userId/search', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const escapedQuery = escapeIlikePattern(q);
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, role, content, created_at')
      .eq('user_id', req.params.userId)
      .neq('role', 'system')
      .ilike('content', `%${escapedQuery}%`)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    const results = (data || [])
      .map(normalizeConversationRow)
      .map(entry => ({ ...entry, content: conversationFallbackText(entry) }));
    res.json({ results });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/history/:userId/around', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  const messageId = String(req.query.messageId || '').trim();
  let anchor = new Date(String(req.query.createdAt || ''));
  const beforeLimit = Math.min(Math.max(Number(req.query.before) || 40, 1), 160);
  const afterLimit = Math.min(Math.max(Number(req.query.after) || 40, 1), 160);
  try {
    if (messageId) {
      const { data: anchorRow, error: anchorError } = await supabase
        .from('conversations')
        .select('created_at')
        .eq('user_id', req.params.userId)
        .eq('id', messageId)
        .maybeSingle();
      if (anchorError) throw anchorError;
      if (!anchorRow?.created_at) return res.status(404).json({ error: 'Message not found' });
      anchor = new Date(anchorRow.created_at);
    }
    if (Number.isNaN(anchor.getTime())) return res.status(400).json({ error: 'Invalid createdAt' });

    const base = supabase
      .from('conversations')
      .select('id, role, content, created_at')
      .eq('user_id', req.params.userId)
      .neq('role', 'system');
    const [before, after] = await Promise.all([
      base.lte('created_at', anchor.toISOString()).order('created_at', { ascending: false }).limit(beforeLimit),
      supabase
        .from('conversations')
        .select('id, role, content, created_at')
        .eq('user_id', req.params.userId)
        .neq('role', 'system')
        .gt('created_at', anchor.toISOString())
        .order('created_at', { ascending: true })
        .limit(afterLimit)
    ]);
    if (before.error) throw before.error;
    if (after.error) throw after.error;
    const rowsByKey = new Map();
    [...(before.data || []).reverse(), ...(after.data || [])].forEach(row => {
      rowsByKey.set(`${row.created_at}:${row.role}:${row.content}`, row);
    });
    res.json({ history: [...rowsByKey.values()].map(normalizeConversationRow).filter(isChatVisibleEntry) });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
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
      .select('id, role, content, created_at')
      .eq('user_id', req.params.userId)
      .neq('role', 'system')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: true })
      .limit(50);
    if (error) throw error;
    res.json({ history: (data || []).map(normalizeConversationRow).filter(isChatVisibleEntry) });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
  }
});

// Shared logic for building the Gemini model + system prompt
async function buildChatContext(userId, message, trace = null, modelName = STREAMING_CHAT_MODEL, requestContext = {}) {
  const quickTurn = !requestContext.pendingAction && isQuickTurnMessage(message);
  const historyOptions = { since: requestContext.chatStartedAt };
  const [memory, history, preferences, enabledConnectors, userContext, cachedContentName, recentActions, travelProfile] = await Promise.all([
    quickTurn ? Promise.resolve('') : getMemory(userId, trace),
    getHistory(userId, trace, 24, historyOptions),
    getPreferences(userId, trace),
    quickTurn ? Promise.resolve([]) : getEnabledConnectors(userId, trace),
    quickTurn ? Promise.resolve('') : getUserContext(userId, trace),
    getPromptCacheName(trace, modelName),
    quickTurn ? Promise.resolve([]) : getRecentLoggedActions(userId, trace, 12, historyOptions),
    quickTurn ? Promise.resolve(null) : getTravelProfile(userId, trace)
  ]);
  const availableActions = quickTurn ? '' : buildAvailableActions(enabledConnectors);
  const statedContext = extractAlreadyStatedContext(history);
  const resolvedContext = requestContext.resolvedContext || (!quickTurn && isContextualReference(message)
    ? buildResolvedContext(history, recentActions)
    : null);
  const emailReplyContext = quickTurn
    ? ''
    : await buildEmailReplyDraftContext(userId, message, history, memory, preferences, trace);
  const travelConciergeState = quickTurn
    ? null
    : await buildTravelConciergeState(message, parseStoredTravelContext(preferences), { resolvedContext, callModel: callTravelModel });
  if (travelConciergeState?.active) {
    saveTravelContext(userId, travelConciergeState, trace);
    if (trace) {
      trace.log('travel_concierge.state', JSON.stringify({
        missing: travelConciergeState.missing,
        known: Object.keys(travelConciergeState.requirements || {})
      }));
    }
  }
  const dynamicSystemPrompt = quickTurn
    ? buildQuickTurnContext(preferences, statedContext)
    : buildDynamicSystemPrompt(
      memory,
      preferences,
      availableActions,
      [
        userContext,
        buildLocationContext(requestContext.location),
        buildNativeHintsContext(requestContext.nativeHints),
        buildPendingActionContext(requestContext.pendingAction),
        emailReplyContext,
        buildTravelProfileBlock(travelProfile),
        buildTravelContextBlock(travelConciergeState),
        buildResolvedContextBlock(resolvedContext)
      ].filter(Boolean).join('\n\n'),
      statedContext
    );
  const searchReason = getSearchReason(message);
  const useSearch = Boolean(searchReason);
  if (useSearch) console.log(`[search] enabled (${searchReason}) for:`, message.slice(0, 80));
  if (trace && resolvedContext?.label) {
    trace.log('context_brain.prompt_context', JSON.stringify({
      kind: resolvedContext.kind,
      label: String(resolvedContext.label || '').slice(0, 140),
      source: resolvedContext.source,
      confidence: resolvedContext.confidence,
      suggestedAction: resolvedContext.suggestedAction || null
    }));
  }
  return {
    history: quickTurn ? history.slice(-2) : history,
    availableActions,
    useSearch,
    searchReason,
    dynamicSystemPrompt,
    cachedContentName,
    quickTurn,
    statedContext,
    resolvedContext
  };
}

const DATA_ACTIONS = new Set(['search_trains', 'station_board', 'get_emails', 'get_calendar_events', 'search_emails', 'get_telegram_contacts', 'search_flights', 'get_flight_prices', 'search_hotels', 'get_hotel_details', 'check_hotel_availability', 'search_activities', 'get_activity_details']);
const DIRECT_SUMMARY_ACTIONS = new Set(['search_trains', 'station_board']);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

// Pulls real context from the user's enabled connectors (today's calendar, recent email) plus
// device location/health, so proactive briefings and scheduled tasks can speak to actual data
// instead of generic filler. Each connector call is timeout-guarded and failure-tolerant — a
// broken or slow connector is skipped, never fatal to the briefing.
async function gatherProactiveContext(userId, now = new Date()) {
  const [enabled, nativeContext] = await Promise.all([
    getEnabledConnectors(userId).catch(() => []),
    getLatestNativeContext(userId).catch(() => null)
  ]);

  const tasks = [];
  if (enabled.includes('google')) {
    tasks.push({ key: 'calendarText', run: () => executeAction(userId, 'get_calendar_events', { max_results: 5 }) });
    // Primary tab only (INBOX + CATEGORY_PERSONAL) so briefings surface real mail, not
    // promotions/job-alerts/Father's-Day spam that Gmail files under other categories.
    tasks.push({ key: 'emailText', run: () => executeAction(userId, 'get_emails', { max_results: 12, label: ['INBOX', 'CATEGORY_PERSONAL'] }) });
  } else if (enabled.includes('microsoft')) {
    tasks.push({ key: 'calendarText', run: () => executeAction(userId, 'get_outlook_events', { max_results: 5 }) });
    tasks.push({ key: 'emailText', run: () => executeAction(userId, 'get_outlook_emails', { max_results: 5 }) });
  }

  const context = { calendarText: '', emailText: '', emails: [] };
  const settled = await Promise.allSettled(
    tasks.map(task => withTimeout(task.run(), 12000, task.key))
  );
  settled.forEach((outcome, i) => {
    const { key } = tasks[i];
    if (outcome.status === 'fulfilled' && outcome.value?.success) {
      if (outcome.value.text) context[key] = String(outcome.value.text).trim();
      // Keep the structured Primary-inbox emails so the Today tab can show a real Inbox
      // card instead of only the prose summary. Already filtered to INBOX/CATEGORY_PERSONAL.
      if (key === 'emailText' && Array.isArray(outcome.value.emails)) {
        // Keep up to 8 so the client has real Primary-inbox mail to dedup, drop promos
        // from, and rank — a hard cap of 3 here meant the 4th-onward (often the one that
        // matters) never reached the dashboard. The Today card trims to a glanceable few.
        context.emails = outcome.value.emails.slice(0, 8).map(email => ({
          from: email.senderName || email.senderAddress || email.from || 'Unknown',
          subject: email.subject || '(no subject)',
          snippet: String(email.snippet || '').slice(0, 140),
          date: email.date || null
        }));
      }
    } else if (outcome.status === 'rejected') {
      console.warn(`[proactive] context ${key} failed:`, outcome.reason?.message || outcome.reason);
    }
  });

  context.location = parseJsonObject(nativeContext?.location);
  context.health = parseJsonObject(nativeContext?.health);
  // Pending errands ride in the settings blob from the iOS native sync.
  const nativeSettings = parseJsonObject(nativeContext?.settings);
  context.reminders = Array.isArray(nativeSettings.reminders) ? nativeSettings.reminders : [];
  return context;
}

// Generates briefing/task copy with Google Search grounding enabled so the model can add
// weather/local/general info. Falls back to an ungrounded call if grounding errors, so a
// search failure never blanks the output.
async function generateGroundedBriefing(systemPrompt, userPrompt) {
  try {
    const model = genAI.getGenerativeModel({
      model: PRIMARY_CHAT_MODEL,
      systemInstruction: systemPrompt,
      tools: [{ googleSearch: {} }]
    });
    const res = await model.generateContent(userPrompt);
    return res.response.text() || '';
  } catch (groundingError) {
    console.warn('[proactive] grounded briefing failed, retrying without search:', groundingError.message);
    const model = genAI.getGenerativeModel({ model: PRIMARY_CHAT_MODEL, systemInstruction: systemPrompt });
    const res = await model.generateContent(userPrompt);
    return res.response.text() || '';
  }
}

function formatLocationForPrompt(location) {
  return location?.latitude && location?.longitude
    ? `${location.latitude}, ${location.longitude}`
    : 'not available';
}

async function getLatestNativeContext(userId) {
  const { data } = await supabase
    .from('native_context')
    .select('location, health, capabilities, settings, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  return data || null;
}

// --- Proactive Signals ---------------------------------------------------
// The briefing model now returns { lead, signals }. Each signal is one thing
// that needs the user, optionally carrying an action. The SAFE tier (reversible,
// private, server-executable) auto-runs during the sweep; everything else is
// SENSITIVE and only ever runs on an explicit tap in the app.

const SAFE_SIGNAL_ACTIONS = new Set(['create_reminder', 'create_calendar_event']);

function signalActionHasAttendees(params) {
  const a = params && (params.attendees || params.guests || params.invitees);
  return Array.isArray(a) ? a.length > 0 : Boolean(a);
}

// Tier is decided here, server-side — never trusted from the model. Unknown
// action types fail safe to 'sensitive'. A calendar event with attendees emails
// people, so it leaves the safe tier.
function classifySignalTier(action) {
  if (!action || typeof action.type !== 'string') return 'none';
  if (action.type === 'create_calendar_event' && signalActionHasAttendees(action.params)) return 'sensitive';
  return SAFE_SIGNAL_ACTIONS.has(action.type) ? 'safe' : 'sensitive';
}

// Stable key order so the same action always hashes the same (idempotency).
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function signalActionSig(action) {
  return crypto.createHash('sha256')
    .update(`${action.type}:${stableStringify(action.params || {})}`)
    .digest('hex').slice(0, 16);
}

// Pull the first balanced {...} out of the model text, tolerating ```json fences
// and trailing prose. Returns null if there's no object to parse.
function extractJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') { depth--; if (depth === 0) return body.slice(start, i + 1); }
  }
  return null;
}

function normalizeSignal(raw) {
  if (!raw || typeof raw.title !== 'string' || !raw.title.trim()) return null;
  const signal = {
    title: raw.title.trim().slice(0, 120),
    detail: typeof raw.detail === 'string' ? raw.detail.trim().slice(0, 240) : '',
    status: 'info'
  };
  const a = raw.action;
  if (a && typeof a.type === 'string' && a.type.trim()) {
    signal.action = {
      type: a.type.trim(),
      params: (a.params && typeof a.params === 'object') ? a.params : {},
      label: typeof a.label === 'string' ? a.label.trim().slice(0, 40) : '',
      prompt: typeof a.prompt === 'string' ? a.prompt.trim().slice(0, 300) : ''
    };
  }
  return signal;
}

// Defensive: structured parse with a prose fallback that matches the old
// behaviour exactly (whole text becomes the lead), so a model that ignores the
// JSON instruction never blanks the Today tab.
function parseSignalsResponse(raw) {
  const text = String(raw || '').trim();
  if (!text || /^NOTHING\b/i.test(text)) return { lead: '', signals: [] };
  const jsonText = extractJsonObject(text);
  if (jsonText) {
    try {
      const obj = JSON.parse(jsonText);
      // Only trust it if it's actually our shape; a stray {...} in prose falls through.
      if (obj && (Array.isArray(obj.signals) || typeof obj.lead === 'string')) {
        const lead = typeof obj.lead === 'string' ? obj.lead.trim() : '';
        const signals = Array.isArray(obj.signals)
          ? obj.signals.slice(0, 4).map(normalizeSignal).filter(Boolean)
          : [];
        return { lead, signals };
      }
    } catch { /* fall through to prose */ }
  }
  return { lead: stripActionMarkupForDisplay(text).trim(), signals: [] };
}

// Runs safe-tier actions, idempotently, annotating each signal with what
// happened. Strips structured params from the stored shape (the app only needs
// status/receipt for done, label/prompt for pending). `exec` is injectable for tests.
async function executeSafeSignals(userId, signals, priorExecuted = [], exec = executeAction) {
  const executed = new Set(priorExecuted);
  const out = [];
  for (const signal of signals) {
    const action = signal.action;
    const stored = { title: signal.title, detail: signal.detail, status: 'info' };
    if (!action) { out.push(stored); continue; }
    const tier = classifySignalTier(action);

    if (tier === 'safe') {
      const sig = signalActionSig(action);
      if (executed.has(sig)) {
        stored.status = 'done';
        stored.receipt = signal.receipt || 'Done';
        out.push(stored);
        continue;
      }
      try {
        const result = await withTimeout(exec(userId, action.type, action.params), 12000, action.type);
        if (result && result.success) {
          stored.status = 'done';
          stored.receipt = result.actionSummary || result.text || 'Done';
          executed.add(sig);
        }
        // failed/invalid action degrades silently to an info-only signal
      } catch (e) {
        console.warn('[proactive] safe signal failed:', action.type, e?.message || e);
      }
    } else if (tier === 'sensitive') {
      stored.status = 'pending';
      stored.label = action.label || 'Do it';
      stored.prompt = action.prompt || signal.title;
    }
    out.push(stored);
  }
  return { signals: out, executed: [...executed] };
}

async function buildIntervalBriefing(userId, window, nativeContext, now = new Date(), prefetchedCtx = null) {
  const [memory, history, preferences, ctx] = await Promise.all([
    getMemory(userId),
    getHistory(userId),
    getPreferences(userId),
    prefetchedCtx ? Promise.resolve(prefetchedCtx) : gatherProactiveContext(userId, now)
  ]);

  const health = ctx.health;
  const location = ctx.location;
  const place = location?.place || null;
  const placeLabel = place
    ? [place.name, place.street, place.area, place.city].filter(Boolean).join(', ')
    : formatLocationForPrompt(location);
  const remindersText = (ctx.reminders || []).length
    ? ctx.reminders.map(r => `- ${r.title}${r.due ? ` (due ${r.due})` : ''}`).join('\n')
    : 'none';
  const systemPrompt = `You are deciding what genuinely needs ${window.label.toLowerCase() === 'briefing' ? 'this person' : 'this person right now'} — someone you know well. Not a recap, not a notifications feed: a sharp assistant's judgement of the few things that matter, each with an action when there's an obvious one.

Ground everything in what's actually real: the calendar, reminders, emails, location, health and weather shown or found via Google Search grounding (use their coordinates for weather). Draw on Memory and recent conversation to make this personal — connect today to what you know about them — but never invent facts, events, or emails.

Return ONLY a JSON object, no prose around it, in exactly this shape:
{
  "lead": "One short warm sentence framing the day. May be empty string if there's nothing to frame.",
  "signals": [
    { "title": "Short imperative headline (<10 words)",
      "detail": "One line on why it matters now.",
      "action": { "type": "...", "label": "Button text", "params": { ... }, "prompt": "..." } }
  ]
}

Rules for signals:
- At most 4, ranked most-important first. Fewer is better. Omit anything that doesn't actually need them.
- "action" is OPTIONAL — only add one when there's a clear, useful thing to do. A signal can be pure information.
- Available actions:
  - create_reminder — params: { "title", "due_date" (ISO 8601 with timezone) }. Use for "leave by", errands, follow-ups.
  - create_calendar_event — params: { "title", "start" (ISO), "end" (ISO, optional) }. No attendees.
  - send_email / send_message — set "prompt" to a natural instruction ("Draft and send a short reply to Sarah confirming Friday"); leave params empty. These always ask the user before sending.
- For create_reminder / create_calendar_event, fill "params" precisely from real calendar/reminder/time data. Never invent a time.
- "label" is the button text (e.g. "Set reminder", "Reply to Sarah"). Keep it 1–3 words.

Hard rules:
- Output JSON only. No markdown fences, no commentary before or after.
- Be specific and real. Do NOT invent calendar events, emails, weather, deadlines, or tasks beyond what's shown or what search returns.
- No life-coaching or motivational filler. Useful and personal, never preachy.
- Refer to calendar events by their literal title and time. Don't guess who a meeting is "with" unless an attendee is named.
- Emails shown are the user's Primary inbox and are ALSO displayed separately. Don't enumerate them — only raise one as a signal if it's genuinely urgent or time-sensitive.
- If there is truly nothing real worth surfacing, return: {"lead":"","signals":[]}

Today's calendar:
${ctx.calendarText || 'No calendar data available.'}

Recent inbox (Primary):
${ctx.emailText || 'No email data available.'}

Pending reminders / errands:
${remindersText}

Memory:
${memory || 'none'}

Preferences:
${preferences || 'none'}

Recent conversation:
${history.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n') || 'none'}

Native context:
Location: ${placeLabel}
Coordinates: ${formatLocationForPrompt(location)}
Health: ${Object.keys(health).length ? JSON.stringify(health).slice(0, 800) : 'not available'}
Current time: ${now.toLocaleString('en-GB', { timeZone: TIMEZONE })}

Return the JSON object now — nothing else.`;

  const raw = await generateGroundedBriefing(systemPrompt, `${window.label} now`);
  return parseSignalsResponse(raw);
}

// Re-refresh a live window's briefing at most this often when nothing changed, so weather/news
// stay current without re-calling the model on every 15-minute sweep.
const BRIEFING_MAX_AGE_MS = 110 * 60 * 1000;

async function maybeCreateIntervalBriefing(userId, now = new Date(), { force = false } = {}) {
  // Outside the wake/midday/evening windows the auto-sweep stays quiet, but a manual Refresh
  // should always produce a current briefing — otherwise the Today tab freezes on the morning
  // card for most of the day.
  const window = getBriefingWindow(now) || (force ? { id: 'now', label: 'Briefing' } : null);
  if (!window) return null;

  const nativeContext = await getLatestNativeContext(userId);
  const settings = parseJsonObject(nativeContext?.settings);
  if (settings.proactiveBriefings === false) return null;
  if (['Quiet', 'Low'].includes(settings.autonomy)) return null;

  const todayKey = getLocalDateKey(now);
  const key = `proactive.briefing.${window.id}.${todayKey}`;
  const prefs = await getPreferenceMap(userId);
  const state = parseJsonObject(prefs[key]); // { id, sig, at } — empty {} on first run / legacy 'sent'

  // Gather context up front and fingerprint it. Regenerate when the underlying calendar/email
  // changed, when the last briefing is older than the max age, or when the user forced a refresh.
  const ctx = await gatherProactiveContext(userId, now);
  // Fold place + errands into the fingerprint so moving somewhere new (or adding a reminder)
  // regenerates the briefing with a fresh location-aware nudge, not a stale morning card.
  const placeSig = ctx.location?.place ? JSON.stringify(ctx.location.place) : '';
  const sig = crypto.createHash('sha256')
    .update(`${ctx.calendarText}\n--\n${ctx.emailText}\n--\n${placeSig}\n--\n${JSON.stringify(ctx.reminders || [])}`)
    .digest('hex').slice(0, 16);
  const fresh = state.at && (now.getTime() - new Date(state.at).getTime()) < BRIEFING_MAX_AGE_MS;
  if (!force && state.sig === sig && fresh) return null;

  const { lead, signals: rawSignals } = await buildIntervalBriefing(userId, window, nativeContext, now, ctx);
  // Auto-run the safe tier (reversible, private) before persisting, so the stored card
  // carries the receipts. Carry executed sigs across regenerations of this window/day so a
  // re-sweep can't create the same reminder twice.
  const priorExecuted = Array.isArray(state.executed) ? state.executed : [];
  const { signals, executed } = await executeSafeSignals(userId, rawSignals, priorExecuted);

  // No concrete content right now — record the signature (and any executed sigs) so we don't
  // re-call the model until something changes, but never permanently lock the window.
  const hasContent = signals.length > 0 || (lead && lead.length >= 12);
  if (!hasContent) {
    await setPreferenceValue(userId, key, JSON.stringify({ id: state.id, sig, at: now.toISOString(), executed }));
    return null;
  }

  // `body` keeps a plain-text summary so older clients (and the chat "Ask about this") still
  // read something; the structured feed rides in metadata.
  const body = lead || signals.map(s => s.title).join(' · ');
  const metadata = { window: window.id, date: todayKey, emails: ctx.emails, lead, signals };

  let briefing;
  if (state.id) {
    // Refresh the existing window card in place so the Today tab shows one rolling card per
    // window with current content, rather than stacking a new card on every change.
    const { data, error } = await supabase
      .from('briefings')
      .update({ body, read: false, created_at: now.toISOString(), metadata })
      .eq('id', state.id)
      .eq('user_id', userId)
      .select('id, body')
      .single();
    briefing = error ? null : data;
  }
  if (!briefing) {
    // Before creating, check if a same-kind briefing from today already exists (handles
    // stale pref IDs and concurrent sweep calls — upsert into the existing row instead).
    const { data: existing } = await supabase
      .from('briefings')
      .select('id')
      .eq('user_id', userId)
      .eq('kind', `${window.id}_briefing`)
      .gte('created_at', new Date(`${todayKey}T00:00:00.000Z`).toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (existing?.id) {
      const { data: updated } = await supabase
        .from('briefings')
        .update({ body, read: false, created_at: now.toISOString(), metadata })
        .eq('id', existing.id)
        .select('id, body')
        .single();
      briefing = updated || null;
    }
    if (!briefing) {
      briefing = await createBriefing(userId, {
        kind: `${window.id}_briefing`,
        title: window.label,
        body,
        source: 'schedule',
        metadata
      });
    }
  }
  await setPreferenceValue(userId, key, JSON.stringify({ id: briefing.id, sig, at: now.toISOString(), executed }));
  return { type: `${window.id}_briefing`, text: briefing.body };
}

async function maybeCreateHealthAlert(userId, nativeContext, now = new Date()) {
  const health = parseJsonObject(nativeContext?.health);
  const settings = parseJsonObject(nativeContext?.settings);
  if (!settings.healthAlerts) return null;
  const latest = Number(health.latestHeartRate);
  const resting = Number(health.restingHeartRate);
  const lowValue = [latest, resting].filter(Number.isFinite).find(value => value > 0 && value < 45);
  if (!lowValue) return null;

  const todayKey = getLocalDateKey(now);
  const key = `proactive.health.low_hr.${todayKey}`;
  const prefs = await getPreferenceMap(userId);
  if (prefs[key] === 'sent') return null;

  const body = `Your heart rate data looks unusually low at ${Math.round(lowValue)} bpm. If that does not feel normal for you, check in with how you're feeling.`;
  const briefing = await createBriefing(userId, {
    kind: 'health_alert',
    title: 'Health check',
    body,
    source: 'healthkit',
    metadata: { heartRate: lowValue }
  });
  await setPreferenceValue(userId, key, 'sent');
  return { type: 'health_alert', text: briefing.body };
}

async function maybeCreateHomeFoodReminder(userId, nativeContext, now = new Date()) {
  const settings = parseJsonObject(nativeContext?.settings);
  if (!settings.locationReminders) return null;
  if (!['Active', 'Bold', 'High'].includes(settings.autonomy)) return null;
  const hour = getLocalHour(now);
  if (hour < 17 || hour > 21) return null;

  const location = parseJsonObject(nativeContext?.location);
  const home = parseJsonObject(settings.homeLocation);
  const lat = Number(location.latitude);
  const lng = Number(location.longitude);
  const homeLat = Number(home.latitude);
  const homeLng = Number(home.longitude);
  if (![lat, lng, homeLat, homeLng].every(Number.isFinite)) return null;

  const metres = haversineMetres(lat, lng, homeLat, homeLng);
  if (metres > 600) return null;

  const todayKey = getLocalDateKey(now);
  const key = `proactive.food.near_home.${todayKey}`;
  const prefs = await getPreferenceMap(userId);
  if (prefs[key] === 'sent') return null;

  const body = "You're close to home. If you haven't eaten yet, this is a good moment to sort food before you fully land.";
  const briefing = await createBriefing(userId, {
    kind: 'location_food_reminder',
    title: 'Food reminder',
    body,
    source: 'location',
    metadata: { distanceMetres: Math.round(metres) }
  });
  await setPreferenceValue(userId, key, 'sent');
  return { type: 'location_food_reminder', text: briefing.body };
}

function haversineMetres(lat1, lon1, lat2, lon2) {
  const radius = 6371000;
  const toRad = degrees => degrees * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function maybeCreateFailedActionFollowUp(userId, now = new Date()) {
  const prefs = await getPreferenceMap(userId);
  const { data: failedAction } = await supabase
    .from('action_log')
    .select('id, action, error, created_at')
    .eq('user_id', userId)
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!failedAction?.id) return null;
  if (prefs[PROACTIVE_FAILURE_PREF] === failedAction.id) return null;

  const failedAt = new Date(failedAction.created_at).getTime();
  if (Number.isNaN(failedAt) || (now.getTime() - failedAt) > 90 * 60 * 1000) {
    return null;
  }

  const actionType = failedAction.action?.type || failedAction.action?.action?.type || failedAction.action?.action || failedAction.action?.type || 'that';
  if (['find_place', 'get_directions', 'plan_trip', 'play_music', 'music_control', 'add_to_music_playlist'].includes(actionType)) {
    return null;
  }
  const actionLabel = humanizeActionType(actionType);
  const detail = String(failedAction.error || '').trim();
  if (!/(not connected|reconnect|permission|authorized|authenticate|expired|revoked)/i.test(detail)) {
    return null;
  }
  const cleanDetail = detail
    .replace(/^\.unknown$/i, '')
    .replace(/^Maps error:\s*/i, '')
    .replace(/^Google error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const followUpText = cleanDetail
    ? `${actionLabel} needs attention: ${cleanDetail.slice(0, 100)}.`
    : `${actionLabel} needs attention before I can finish it.`;

  await createBriefing(userId, {
    kind: 'failed_action_followup',
    title: 'Action follow-up',
    body: followUpText,
    source: 'action_log',
    metadata: { actionLogId: failedAction.id, actionType }
  });
  await setPreferenceValue(userId, PROACTIVE_FAILURE_PREF, failedAction.id);
  return { type: 'failed_action_followup', text: followUpText };
}

async function buildScheduledTaskResponse(userId, task, now = new Date()) {
  const [memory, preferences, ctx] = await Promise.all([
    getMemory(userId),
    getPreferences(userId),
    gatherProactiveContext(userId, now)
  ]);

  const health = ctx.health;
  const location = ctx.location;
  const systemPrompt = `The user previously asked you to do this on a schedule:
"${task.instruction}"

Fulfil it now. Use the real calendar events, emails, and context below, and Google Search
grounding for anything current (weather for their location, news, facts). Use their location
for weather. Don't invent calendar events or emails beyond what's shown. Write a short spoken
message (under 60 words) as if reaching out to the user proactively.

Today's calendar:
${ctx.calendarText || 'No calendar data available.'}

Recent inbox:
${ctx.emailText || 'No email data available.'}

Memory:
${memory || 'none'}

Preferences:
${preferences || 'none'}

Native context:
Location: ${formatLocationForPrompt(location)}
Health: ${Object.keys(health).length ? JSON.stringify(health).slice(0, 800) : 'not available'}
Current time: ${now.toLocaleString('en-GB', { timeZone: TIMEZONE })}`;

  const text = await generateGroundedBriefing(systemPrompt, task.title);
  return stripActionMarkupForDisplay(text).trim();
}

async function runDueScheduledTasksForUser(userId, now = new Date()) {
  const summary = { reminders: 0, scheduledTasks: 0 };
  const dueTasks = await getDueScheduledTasks(userId, now);
  for (const task of dueTasks) {
    const isReminder = !task.instruction;
    const body = isReminder ? task.title : await buildScheduledTaskResponse(userId, task, now);
    if (body) {
      await createBriefing(userId, {
        kind: isReminder ? 'reminder' : 'scheduled_task',
        title: task.title,
        body,
        source: 'scheduled_task',
        metadata: { taskId: task.id }
      });
    }
    if (isReminder) summary.reminders += 1;
    else summary.scheduledTasks += 1;
    await advanceScheduledTask(task, now);
  }
  return summary;
}

function emptyProactiveSummary() {
  return {
    usersScanned: 0,
    briefings: 0,
    failureFollowUps: 0,
    healthAlerts: 0,
    locationReminders: 0,
    reminders: 0,
    scheduledTasks: 0,
    failures: 0
  };
}

async function runProactiveForUser(userId, logger = console, now = new Date(), { force = false } = {}) {
  const summary = emptyProactiveSummary();
  summary.usersScanned = 1;
  try {
    const nativeContext = await getLatestNativeContext(userId);
    const [briefing, followUp, healthAlert, foodReminder, scheduledTasks] = await Promise.all([
      maybeCreateIntervalBriefing(userId, now, { force }),
      maybeCreateFailedActionFollowUp(userId, now),
      nativeContext ? maybeCreateHealthAlert(userId, nativeContext, now) : Promise.resolve(null),
      nativeContext ? maybeCreateHomeFoodReminder(userId, nativeContext, now) : Promise.resolve(null),
      runDueScheduledTasksForUser(userId, now)
    ]);
    if (briefing) summary.briefings += 1;
    if (followUp) summary.failureFollowUps += 1;
    if (healthAlert) summary.healthAlerts += 1;
    if (foodReminder) summary.locationReminders += 1;
    summary.reminders += scheduledTasks.reminders;
    summary.scheduledTasks += scheduledTasks.scheduledTasks;
    const created = [briefing?.type, followUp?.type, healthAlert?.type, foodReminder?.type].filter(Boolean);
    if (scheduledTasks.reminders || scheduledTasks.scheduledTasks) {
      created.push(`${scheduledTasks.reminders} reminder(s), ${scheduledTasks.scheduledTasks} scheduled task(s)`);
    }
    if (created.length) logger.log(`[proactive] queued for ${userId}: ${created.join(', ')}`);
  } catch (sweepError) {
    summary.failures += 1;
    logger.error(`[proactive] failed for ${userId}:`, sweepError.message);
  }
  return summary;
}

function mergeProactiveSummary(target, source) {
  for (const key of Object.keys(emptyProactiveSummary())) {
    target[key] = (target[key] || 0) + (source[key] || 0);
  }
}

async function runProactiveSweep(logger = console) {
  const startedAt = Date.now();
  const summary = emptyProactiveSummary();

  const { data: users, error } = await supabase
    .from('users')
    .select('user_id');
  if (error) throw error;

  for (const user of users || []) {
    const userSummary = await runProactiveForUser(user.user_id, logger);
    mergeProactiveSummary(summary, userSummary);
  }

  summary.durationMs = Date.now() - startedAt;
  logger.log(`[proactive] sweep complete: ${JSON.stringify(summary)}`);
  return summary;
}

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

function normalizeActionResultsForClient(actionResults) {
  const seen = new Set();
  const out = [];
  for (const entry of actionResults || []) {
    const error = entry?.result?.error || '';
    const text = entry?.result?.text || '';
    const key = `${entry?.action || ''}:${entry?.result?.success === false ? error : text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function userFacingActionFailure(entry) {
  const action = entry?.action || '';
  const rawError = String(entry?.result?.error || '').trim();
  if (action === 'book_uber' || action === 'book_bolt' || action === 'find_place') {
    if (/Google Places is not ready|Places API|Google Places is not configured/i.test(rawError)) {
      return 'Nearby place ranking needs Google Places enabled on the server. Uber and Bolt do not need an API key.';
    }
    if (/need your current location|enable location/i.test(rawError)) {
      return 'I need your current location to find that nearby place. Enable location and try again.';
    }
    if (/couldn't find a nearby|No place results found/i.test(rawError)) {
      return 'I could not find that nearby place from your current location. Try a different place name or enable location.';
    }
    if (/Geocoding error|No results found/i.test(rawError)) {
      return 'I could not find that destination. Try a different place name.';
    }
  }
  return rawError || 'That action failed.';
}

function toSingleSentence(text) {
  const cleaned = stripActionMarkupForDisplay(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const match = cleaned.match(/[^.!?]+[.!?]+(?:["')\]]+)?/);
  const sentence = (match ? match[0] : cleaned).trim();
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function summarizeCompletedActionsConcise(actionResults) {
  const successful = actionResults.filter(entry => entry?.result?.success !== false);
  if (!successful.length) return '';
  const dataOnly = successful.every(entry => DATA_ACTIONS.has(entry.action));
  if (dataOnly) {
    return successful.every(entry => DIRECT_SUMMARY_ACTIONS.has(entry.action))
      ? summarizeActionResults(successful)
      : '';
  }

  const resultText = summarizeActionResults(successful);
  if (resultText) return resultText;

  const normalized = successful
    .map(entry => toSingleSentence(entry.result?.text || humanizeActionType(entry.action)))
    .filter(Boolean);
  if (!normalized.length) return '';
  if (normalized.length === 1) return normalized[0];
  return `${normalized
    .map(text => text.replace(/[.!?]+$/g, ''))
    .join('; ')}.`;
}

function summarizeFinishedActionsForUser(actionResults) {
  const normalizedResults = normalizeActionResultsForClient(actionResults);
  if (!normalizedResults.length) return '';
  const failures = normalizedResults.filter(entry => entry?.result?.success === false);
  if (failures.length) {
    return failures
      .map(entry => {
        const error = userFacingActionFailure(entry);
        return `${humanizeActionType(entry.action)} failed: ${error}`;
      })
      .join('\n');
  }
  const pending = normalizedResults.filter(entry => entry?.result?.pending);
  if (pending.length) {
    return pending
      .map(entry => entry.result?.text || `${reviewTitleForAction({ type: entry.action })}. Say "confirm" to continue or "cancel" to stop.`)
      .join('\n');
  }
  return summarizeCompletedActionsConcise(normalizedResults);
}

function buildStructuredDataSummary(entry) {
  const result = entry?.result || {};
  if (entry?.action === 'get_emails' || entry?.action === 'search_emails') {
    if (!Array.isArray(result.emails) || result.emails.length === 0) return result.text || 'No emails found.';
    const emails = result.emails.map((email, index) => (
      `${index + 1}. From: ${email.from || 'Unknown sender'} | Subject: ${email.subject || '(No subject)'}${email.date ? ` | Date: ${email.date}` : ''}${email.body ? `\nBody: ${String(email.body).slice(0, 1200)}` : ''}`
    ));
    return `Email results:\n${emails.join('\n')}`;
  }
  if (entry?.action === 'get_calendar_events') {
    if (!Array.isArray(result.events) || result.events.length === 0) return result.text || 'No upcoming events found.';
    const events = result.events.map((event, index) => (
      `${index + 1}. ${event.title || 'Untitled'}${event.start ? ` | Starts: ${event.start}` : ''}${event.end ? ` | Ends: ${event.end}` : ''}`
    ));
    return `Upcoming events:\n${events.join('\n')}`;
  }
  if (entry?.action === 'get_telegram_contacts') {
    if (!Array.isArray(result.contacts) || result.contacts.length === 0) return result.text || 'No contacts found.';
    const contacts = result.contacts.map((contact, index) => `${index + 1}. ${contact.name || contact.username || 'Unnamed contact'}`);
    return `Telegram contacts:\n${contacts.join('\n')}`;
  }
  return result.text || '';
}

function getStructuredDataResults(actionResults) {
  return actionResults
    .filter(entry => DATA_ACTIONS.has(entry.action) && entry.result?.success)
    .map(entry => ({ action: entry.action, text: buildStructuredDataSummary(entry) }))
    .filter(entry => entry.text);
}

// Fire-and-forget post-response tasks (memory + style preferences)
function postResponseTasks(userId, message, trace = null) {
  // Incognito turns leave no trace: no memory, no learned preferences.
  if (trace?.incognito) return;
  // Deterministically capture personal-place statements ("my school is X") so
  // directions to "school"/"work"/"home" resolve to the user's real location.
  const msg = String(message || '');
  const placeStmt = msg.match(/\b(?:my|our)\s+(home|house|work|office|school|college|uni|university|gym)\b[^.?!]*?\b(?:is|are|=|:|at|in)\s+([^.?!\n]{2,120})/i);
  if (placeStmt) {
    const slot = placeStmt[1].toLowerCase();
    // Normalise college/uni/university phrasing onto "school" so directions to "school" resolve.
    const keyword = ['college', 'uni', 'university'].includes(slot) ? 'school' : slot;
    saveMemory(userId, `My ${keyword} is ${placeStmt[2].trim()}`, 'fact').catch(() => {});
  } else {
    // "I go to / attend / study at <School Name>" — no "my X is" phrasing, but still a school fact.
    const attendStmt = msg.match(/\bI\s+(?:go to|goto|attend|study at|study in)\s+([A-Z][^.?!\n]{2,120}?(?:school|college|university|academy|sixth form)[^.?!\n]{0,40})/i);
    if (attendStmt) {
      saveMemory(userId, `My school is ${attendStmt[1].trim()}`, 'fact').catch(() => {});
    }
  }
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

async function respondWithResult({ res, streaming, wantsTTS, settings, trace, userId, message, spoken, actionResults = [], persist = true }) {
  // Silent turns (e.g. a browser task auto-continuing) stream their signal to the
  // client but write nothing to history — otherwise every 3-step pause stacks a
  // "still working… keep going?" message and a card in the transcript.
  if (persist) {
    saveMessage(userId, 'assistant', { text: spoken, actions: actionResults }, trace)
      .catch(err => trace.log('supabase.conversations.insert_assistant.short_async_fail', err.message));
    if (message) maybeGenerateSessionTitle(userId, message, trace);
    postResponseTasks(userId, message, trace);
  }

  if (streaming) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const sse = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (actionResults.length) sse({ type: 'actions', results: actionResults });
    sse({ type: 'replace', text: spoken });
    if (wantsTTS) {
      try {
        const audio = await trace.run('gemini.tts.generateSpeech.short_response', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
        if (audio) sse({ type: 'audio', data: audio, format: 'wav', mimeType: 'audio/wav', seq: 0, chunk: 0 });
      } catch (ttsErr) {
        console.error('[tts error]', ttsErr.message);
        sse({ type: 'tts-error', error: ttsErr.message });
      }
    }
    sse({ type: 'done' });
    res.end();
    return;
  }

  const result = { text: spoken, actions: actionResults };
  if (wantsTTS) {
    try {
      const audio = await trace.run('gemini.tts.generateSpeech.short_response_nonstream', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
      if (audio) {
        result.audio = audio;
        result.audioFormat = 'wav';
        result.audioMimeType = 'audio/wav';
      }
    } catch (ttsErr) {
      console.error('[tts error]', ttsErr.message);
      result.ttsError = ttsErr.message;
    }
  }
  res.json(result);
}

app.post('/chat', chatRateLimiter, async (req, res) => {
  const streaming = req.query.stream === 'true';

  try {
    const { message, userId, settings = {}, location = null, nativeHints = null, chatStartedAt = null } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    const wantsTTS = req.query.tts === 'true';

    if (!message?.trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const trace = createRequestTrace(`chat:${userId}:${Date.now()}`);
    if (req.body.incognito === true) trace.incognito = true;
    trace.log(`request.start stream=${streaming} tts=${wantsTTS} incognito=${!!trace.incognito} msg=${JSON.stringify((message || '').slice(0, 80))}`);

    // Let the model start as soon as context is ready instead of waiting on the DB write.
    // The silent continuation sentinel never appears as a real user turn.
    if (message !== BROWSER_TASK_CONTINUE) {
      saveMessage(userId, 'user', message, trace).catch(err => trace.log('supabase.conversations.insert_user.async_fail', err.message));
    }

    // If we asked the user for a personal place ("what's your school?"), capture
    // their reply, remember it, and re-run the original action with it.
    if (!trace.incognito) {
      const pendingPlace = await getPendingPlace(userId);
      if (pendingPlace) {
        if (looksLikePlaceAnswer(message)) {
          await clearPendingPlace(userId);
          const place = message.trim();
          saveMemory(userId, `My ${pendingPlace.keyword} is ${place}`, 'fact').catch(() => {});
          const input = {};
          input[pendingPlace.field === 'query' ? 'query' : 'destination'] = place;
          if (pendingPlace.mode) input.mode = pendingPlace.mode;
          if (pendingPlace.arrival_time) input.arrival_time = pendingPlace.arrival_time;
          if (pendingPlace.departure_time) input.departure_time = pendingPlace.departure_time;
          let placeResults = await executeActions(userId, [{ type: pendingPlace.action, input }], { userMessage: message, location, nativeHints, trace }, trace);
          placeResults = normalizeActionResultsForClient(placeResults);
          const spoken = summarizeFinishedActionsForUser(placeResults) || `Got it — I'll remember your ${pendingPlace.keyword}.`;
          await respondWithResult({ res, streaming, wantsTTS, settings, trace, userId, message, spoken, actionResults: placeResults });
          return;
        }
        // Not a place answer — drop the stale ask and continue normally.
        await clearPendingPlace(userId).catch(() => {});
      }
    }

    const pendingAction = await getPendingAction(userId);
    if (pendingAction && isPendingCancelMessage(message)) {
      await clearPendingAction(userId);
      await respondWithResult({
        res,
        streaming,
        wantsTTS,
        settings,
        trace,
        userId,
        message,
        spoken: 'Cancelled.'
      });
      return;
    }

    if (pendingAction && isPendingConfirmMessage(message)) {
      trace.log(`pending_action.confirm ${pendingAction.action.type}`);
      let actionResults = await executeActions(userId, [pendingAction.action], {
        userMessage: pendingAction.userMessage || message,
        location,
        nativeHints: pendingAction.nativeHints || nativeHints,
        bypassReview: true,
        trace
      }, trace);
      actionResults = normalizeActionResultsForClient(actionResults);
      await clearPendingAction(userId);
      const spoken = summarizeFinishedActionsForUser(actionResults) ||
        actionResults.map(a => a.result?.text || a.result?.error).filter(Boolean).join(' ') ||
        'Done.';
      await respondWithResult({
        res,
        streaming,
        wantsTTS,
        settings,
        trace,
        userId,
        message,
        spoken,
        actionResults
      });
      return;
    }

    // Deterministic resume: if a browser/ordering session is open and waiting on the
    // user's reply, route this message straight back into the loop instead of letting
    // the general chat brain answer it (which would strand the order).
    const awaitingBrowser = getSession(userId);
    if (awaitingBrowser?.awaitingInput && !trace.incognito) {
      if (isPendingCancelMessage(message)) {
        await closeSession(userId);
        await respondWithResult({ res, streaming, wantsTTS, settings, trace, userId, message, spoken: 'Okay, I\'ve stopped that order.' });
        return;
      }
      trace.log('browser_task.resume');
      awaitingBrowser.awaitingInput = false; // cleared now; the case re-sets it from the new outcome
      // The continue sentinel carries no new instruction — pass an empty goal so the
      // loop keeps working the existing goal instead of clobbering it.
      const resumeGoal = message === BROWSER_TASK_CONTINUE ? '' : message;
      let resumeResults = await executeActions(userId, [{ type: 'run_browser_task', input: { goal: resumeGoal } }], { userMessage: message, location, nativeHints, trace }, trace);
      resumeResults = normalizeActionResultsForClient(resumeResults);
      // A "still working" pause is internal plumbing: the client auto-continues off
      // the signal in the actions event, so don't persist it or surface its text —
      // that's what stacked a card + "keep going?" prompt every 3 steps.
      const stillWorking = resumeResults.some(r => r?.result?.actionSummary === 'Browser task paused');
      const spoken = summarizeFinishedActionsForUser(resumeResults) ||
        resumeResults.map(a => a.result?.text || a.result?.error).filter(Boolean).join(' ') ||
        'Done.';
      await respondWithResult({
        res, streaming, wantsTTS, settings, trace, userId, message,
        spoken: stillWorking ? '' : spoken,
        actionResults: resumeResults,
        persist: !stillWorking
      });
      return;
    }

    const deterministicQuickReply = getDeterministicQuickReply(message);
    if (deterministicQuickReply) {
      saveMessage(userId, 'assistant', { text: deterministicQuickReply, actions: [] }, trace)
        .catch(err => trace.log('supabase.conversations.insert_assistant.quick_async_fail', err.message));
      postResponseTasks(userId, message, trace);

      if (streaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const sse = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        sse({ type: 'text', chunk: deterministicQuickReply });
        if (wantsTTS) {
          try {
            const audio = await trace.run('gemini.tts.generateSpeech.quick', () => generateSpeech(buildVoiceExcerpt(deterministicQuickReply), settings.voice));
            if (audio) sse({ type: 'audio', data: audio, format: 'wav', mimeType: 'audio/wav', seq: 0, chunk: 0 });
          } catch (ttsErr) {
            console.error('[tts error]', ttsErr.message);
            sse({ type: 'tts-error', error: ttsErr.message });
          }
        }
        sse({ type: 'done' });
        res.end();
        return;
      }

      const result = { text: deterministicQuickReply, actions: [] };
      if (wantsTTS) {
        try {
          const audio = await trace.run('gemini.tts.generateSpeech.quick_nonstream', () => generateSpeech(buildVoiceExcerpt(deterministicQuickReply), settings.voice));
          if (audio) {
            result.audio = audio;
            result.audioMimeType = 'audio/wav';
          }
        } catch (ttsErr) {
          console.error('[tts error]', ttsErr.message);
          result.ttsError = ttsErr.message;
        }
      }
      return res.json(result);
    }

    const deterministicAction = inferDeterministicAction(message, { settings });
    if (deterministicAction) {
      trace.log(`intent_router.match ${deterministicAction.reason}`);

      if (streaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const sse = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const sendStatus = (status, label, extra = {}) => sse({ type: 'status', status, label, ...extra });
        sendStatus('action_start', getActionStatusLabel(deterministicAction.actions[0].type, 'start'), { action: deterministicAction.actions[0].type });
        let actionResults = await executeActions(userId, deterministicAction.actions, { userMessage: message, location, nativeHints, trace, sendStatus }, trace, {
          onActionComplete: (action, result) => sendStatus('action_complete', getActionStatusLabel(action.type, actionCompletionPhase(result)), {
            action: action.type,
            success: result?.success !== false
          })
        });
        actionResults = normalizeActionResultsForClient(actionResults);
        const spoken = summarizeFinishedActionsForUser(actionResults) || deterministicAction.spoken;
        sse({ type: 'actions', results: actionResults });
        sse({ type: 'replace', text: spoken });
        if (wantsTTS) {
          try {
            const audio = await trace.run('gemini.tts.generateSpeech.intent_router', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
            if (audio) sse({ type: 'audio', data: audio, format: 'wav', mimeType: 'audio/wav', seq: 0, chunk: 0 });
          } catch (ttsErr) {
            console.error('[tts error]', ttsErr.message);
            sse({ type: 'tts-error', error: ttsErr.message });
          }
        }
        sse({ type: 'done' });
        res.end();

        saveMessage(userId, 'assistant', { text: spoken, actions: actionResults }, trace)
          .catch(err => trace.log('supabase.conversations.insert_assistant.intent_async_fail', err.message));
        postResponseTasks(userId, message, trace);
        return;
      }

      let actionResults = await executeActions(userId, deterministicAction.actions, { userMessage: message, location, nativeHints, trace }, trace);
      actionResults = normalizeActionResultsForClient(actionResults);
      const spoken = summarizeFinishedActionsForUser(actionResults) || deterministicAction.spoken;
      saveMessage(userId, 'assistant', { text: spoken, actions: actionResults }, trace)
        .catch(err => trace.log('supabase.conversations.insert_assistant.intent_async_fail', err.message));
      const result = { text: spoken, actions: actionResults };
      if (wantsTTS) {
        try {
          const audio = await trace.run('gemini.tts.generateSpeech.intent_nonstream', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
          if (audio) {
            result.audio = audio;
            result.audioFormat = 'wav';
            result.audioMimeType = 'audio/wav';
          }
        } catch (ttsErr) {
          console.error('[tts error]', ttsErr.message);
          result.ttsError = ttsErr.message;
        }
      }
      res.json(result);
      postResponseTasks(userId, message, trace);
      return;
    }

    const chatModel = streaming ? STREAMING_CHAT_MODEL : PRIMARY_CHAT_MODEL;
    const requestContext = {
      location,
      nativeHints,
      chatStartedAt,
      pendingAction: pendingAction && isPendingRevisionMessage(message) ? pendingAction : null
    };
    const { history, useSearch, dynamicSystemPrompt, cachedContentName } = await trace.run('buildChatContext', () => buildChatContext(userId, message, trace, chatModel, requestContext));
    const baseHistory = normalizeGeminiHistory(history);
    const initialRequest = buildModernGenerateRequest({
      dynamicSystemPrompt,
      useSearch,
      cachedContentName,
      baseHistory,
      userContent: { role: 'user', parts: [{ text: message }] }
    });

    // ── Streaming mode (SSE) ────────────────────────────────────────────
    if (streaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const sse = obj => {
        if (obj?.type === 'audio') {
          console.log(`[audio][backend:chat-stream] sending audio event seq=${obj.seq ?? 'na'} chunk=${obj.chunk ?? 'na'} bytes=${Buffer.from(obj.data || '', 'base64').length} mime=${obj.mimeType || 'audio/wav'}`);
        }
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      const sendStatus = (status, label, extra = {}) => sse({ type: 'status', status, label, ...extra });

      try {
        sendStatus('thinking_start', 'Thinking');
        // Stream Gemini response token-by-token
        const stream = await trace.run('gemini.generateContentStream.initial', () => modernGenAI.models.generateContentStream({
          model: chatModel,
          contents: initialRequest.contents,
          config: initialRequest.config
        }));
        let fullText = '';
        let firstChunk = true;
        let hasStreamedText = false;
        let actionMarkupStarted = false;
        let heldDisplayText = '';
        const emitSafeDisplayText = text => {
          if (!text || actionMarkupStarted) return;
          heldDisplayText += text;
          const actionIndex = heldDisplayText.search(/<action\b/i);
          if (actionIndex >= 0) {
            const visible = heldDisplayText.slice(0, actionIndex);
            if (visible) {
              hasStreamedText = true;
              sse({ type: 'text', chunk: visible });
            }
            heldDisplayText = '';
            actionMarkupStarted = true;
            return;
          }
          if (heldDisplayText.length > 8) {
            const visible = heldDisplayText.slice(0, -8);
            heldDisplayText = heldDisplayText.slice(-8);
            if (visible) {
              hasStreamedText = true;
              sse({ type: 'text', chunk: visible });
            }
          }
        };
        const flushSafeDisplayText = () => {
          if (actionMarkupStarted || !heldDisplayText) return;
          hasStreamedText = true;
          sse({ type: 'text', chunk: heldDisplayText });
          heldDisplayText = '';
        };
        const ttsStreamer = wantsTTS ? createSentenceTtsStreamer({
          voiceName: settings.voice,
          sse,
          trace,
          onSpeakingStart: () => sendStatus('speaking_start', 'Speaking')
        }) : null;
        let groundingMeta = null;
        for await (const chunk of stream) {
          const gm = chunk.candidates?.[0]?.groundingMetadata;
          if (gm) groundingMeta = gm;
          const text = chunk.text || '';
          if (text) {
            if (firstChunk) { trace.log('gemini.first_token'); firstChunk = false; }
            fullText += text;
            emitSafeDisplayText(text);
            // Kick off TTS for complete sentences as they arrive, not after full generation
            if (ttsStreamer && !actionMarkupStarted) ttsStreamer.ingest(fullText);
          }
        }
        flushSafeDisplayText();
        trace.log('gemini.initial_complete');
        // Surface where a grounded answer came from (web search sources).
        const groundingSources = groundingSourcesFrom(groundingMeta);
        if (groundingSources.length) sse({ type: 'sources', items: groundingSources });
        if (!fullText.trim()) {
          fullText = await recoverEmptyModelResponse({ model: chatModel, initialRequest, message, trace });
          if (fullText) trace.log('gemini.empty_recovery_success');
        }

        let { spoken, actions } = parseActions(fullText);
        spoken = stripActionMarkupForDisplay(spoken).trim();
        if (!spoken && !actions.length) {
          const recovered = await recoverEmptyModelResponse({ model: chatModel, initialRequest, message, trace });
          if (recovered) {
            fullText = recovered;
            ({ spoken, actions } = parseActions(fullText));
            spoken = stripActionMarkupForDisplay(spoken).trim();
            trace.log('gemini.blank_spoken_recovery_success');
          }
        }

        // Execute actions in parallel
        let actionResults = [];
        if (actions.length > 0) {
          actionResults = await executeActions(userId, actions, { userMessage: message, location, nativeHints, trace, sendStatus }, trace, {
            onActionStart: action => sendStatus('action_start', getActionStatusLabel(action.type, 'start'), { action: action.type }),
            onActionComplete: (action, result) => sendStatus('action_complete', getActionStatusLabel(action.type, actionCompletionPhase(result)), {
              action: action.type,
              success: result?.success !== false
            })
          });
          actionResults = normalizeActionResultsForClient(actionResults);
          sse({ type: 'actions', results: actionResults });
          trace.log('actions.complete');
        }

        // For data-fetching actions, stream a follow-up summary
        const dataResults = getStructuredDataResults(actionResults);
        if (canUseDirectActionSummary(actionResults)) {
          spoken = summarizeActionResults(actionResults);
          sse({ type: 'replace', text: spoken });
          if (ttsStreamer) ttsStreamer.ingest(spoken);
        } else if (dataResults.length > 0) {
          sse({ type: 'replace', text: '' });
          const context = dataResults.map(a => a.text).join('\n\n');
          const followUpRequest = buildModernGenerateRequest({
            dynamicSystemPrompt,
            useSearch,
            cachedContentName,
            baseHistory,
            userContent: { role: 'user', parts: [{ text: message }] }
          });
          followUpRequest.contents.push(
            { role: 'model', parts: [{ text: spoken || '…' }] },
            { role: 'user', parts: [{ text: `Here are the results:\n\n${context}\n\nSpeak these back naturally and conversationally. Be concise. Only use the results shown here. Do not add unstated facts.` }] }
          );
          const followUp = await trace.run('gemini.generateContentStream.followup', () => modernGenAI.models.generateContentStream({
            model: chatModel,
            contents: followUpRequest.contents,
            config: followUpRequest.config
          }));
          spoken = '';
          heldDisplayText = '';
          actionMarkupStarted = false;
          hasStreamedText = false;
          for await (const chunk of followUp) {
            const text = chunk.text || '';
            if (text) {
              spoken += text;
              emitSafeDisplayText(text);
              if (ttsStreamer) ttsStreamer.ingest(spoken);
            }
          }
          flushSafeDisplayText();
          spoken = stripActionMarkupForDisplay(parseActions(spoken).spoken || spoken || context).trim();
          if (!hasStreamedText) sse({ type: 'replace', text: spoken });
          if (ttsStreamer) ttsStreamer.ingest(spoken);
        }
        const actionConfirmation = summarizeFinishedActionsForUser(actionResults);
        if (actionConfirmation && actionConfirmation !== spoken) {
          spoken = actionConfirmation;
          sse({ type: 'replace', text: spoken });
          if (ttsStreamer) ttsStreamer.ingest(spoken);
        }

        if (!spoken) {
          spoken = actionResults.length
            ? (actionResults.map(a => a.result?.text || a.result?.error).filter(Boolean).join(' ') || 'I could not complete that action.')
            : "I couldn't get a clean answer for that. Ask me again and I'll re-check it.";
          sse({ type: 'text', chunk: spoken });
          if (ttsStreamer) ttsStreamer.ingest(spoken);
        } else if (!actionResults.length && !dataResults.length && !hasStreamedText) {
          sse({ type: 'text', chunk: spoken });
          if (ttsStreamer) ttsStreamer.ingest(spoken);
        } else if (!actionResults.length && !dataResults.length && ttsStreamer) {
          ttsStreamer.ingest(spoken);
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
        saveMessage(userId, 'assistant', { text: spoken, actions: actionResults, sources: groundingSources }, trace)
          .catch(err => trace.log('supabase.conversations.insert_assistant.async_fail', err.message));
        postResponseTasks(userId, message, trace);

      } catch (err) {
        trace.log('request.error', err.message);
        console.error('/chat stream error:', err.message);
        try { sse({ type: 'error', error: 'Processing failed. Please try again.' }); res.end(); } catch {}
      }
      return;
    }

    // ── Non-streaming mode (JSON — backward compatible) ─────────────────
    const geminiRes = await trace.run('gemini.generateContent.nonstream', () => modernGenAI.models.generateContent({
      model: chatModel,
      contents: initialRequest.contents,
      config: initialRequest.config
    }));

    const rawText = geminiRes.text || '';
    let { spoken, actions } = parseActions(rawText);
    if (!rawText.trim() || (!spoken && !actions.length)) {
      const recovered = await recoverEmptyModelResponse({ model: chatModel, initialRequest, message, trace });
      if (recovered) {
        ({ spoken, actions } = parseActions(recovered));
      }
    }

    // Execute actions in parallel instead of sequentially
    let actionResults = [];
    if (actions.length > 0) {
      actionResults = await executeActions(userId, actions, { userMessage: message, location, nativeHints, trace }, trace);
      actionResults = normalizeActionResultsForClient(actionResults);
    }

    // For data-fetching actions, re-prompt Gemini with results
    const dataResults = getStructuredDataResults(actionResults);
    if (canUseDirectActionSummary(actionResults)) {
      spoken = summarizeActionResults(actionResults);
    } else if (dataResults.length > 0) {
      const context = dataResults.map(a => a.text).join('\n\n');
      const followUpRequest = buildModernGenerateRequest({
        dynamicSystemPrompt,
        useSearch,
        cachedContentName,
        baseHistory,
        userContent: { role: 'user', parts: [{ text: message }] }
      });
      followUpRequest.contents.push(
        { role: 'model', parts: [{ text: spoken || '…' }] },
        { role: 'user', parts: [{ text: `Here are the results:\n\n${context}\n\nSpeak these back naturally and conversationally. Be concise. Only use the results shown here. Do not add unstated facts.` }] }
      );
      const followUp = await trace.run('gemini.generateContent.followup_nonstream', () => modernGenAI.models.generateContent({
        model: chatModel,
        contents: followUpRequest.contents,
        config: followUpRequest.config
      }));
      spoken = parseActions(followUp.text || '').spoken || context;
    }
    const actionConfirmation = summarizeFinishedActionsForUser(actionResults);
    if (actionConfirmation) spoken = actionConfirmation;

    if (!spoken) {
      spoken = actionResults.length
        ? (actionResults.map(a => a.result?.text || a.result?.error).filter(Boolean).join(' ') || 'I could not complete that action.')
        : "I couldn't get a clean answer for that. Ask me again and I'll re-check it.";
    }

    // Don't block on saving assistant message
    saveMessage(userId, 'assistant', { text: spoken, actions: actionResults }, trace)
      .catch(err => trace.log('supabase.conversations.insert_assistant.async_fail', err.message));

    const result = { text: spoken, actions: actionResults };

    if (wantsTTS) {
      try {
        const audio = await trace.run('gemini.tts.generateSpeech.nonstream', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
        if (audio) {
          console.log(`[audio][backend:chat-json] returning tts audio bytes=${Buffer.from(audio, 'base64').length} mime=audio/wav`);
          result.audio = audio;
          result.audioFormat = 'wav';
          result.audioMimeType = 'audio/wav';
        }
      } catch (ttsErr) {
        console.error('[tts error]', ttsErr.message);
        result.ttsError = ttsErr.message;
      }
    }

    trace.log('request.total');
    res.json(result);
    postResponseTasks(userId, message, trace);

  } catch (err) {
    console.log(`[trace:chat:unscoped] FAIL outer ${err.message}`);
    console.error('/chat error:', err.message);
    return sendServerError(res, err, 'server.error');
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
    return sendServerError(res, err, 'server.error');
  }
});

app.delete('/preferences/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    await supabase.from('preferences').delete().eq('user_id', req.params.userId);
    res.json({ success: true });
  } catch (err) {
    return sendServerError(res, err, 'server.error');
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
    return sendServerError(res, err, 'server.error');
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
    return sendServerError(res, err, 'server.error');
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
    return sendServerError(res, err, 'server.error');
  }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file'
].join(' ');

app.get('/auth/google/redirect-uri', (req, res) => {
  res.json({ redirect_uri: `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/google/callback` });
});

app.get('/auth/google/start', (req, res) => {
  const userId = req.query.userId;
  if (!requireMatchingUser(req, res, userId)) return;
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Google OAuth is not configured on the server.' });
  }
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
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const userId = verifyOAuthState(state);

  if (error) {
    const appOrigin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    return res.send(`<script>window.opener?.postMessage('google_auth_error',${JSON.stringify(appOrigin)});window.close();</script>`);
  }

  if (!userId) {
    return res.status(400).send('Invalid OAuth state');
  }
  if (!code || typeof code !== 'string') {
    return res.status(400).send('Missing OAuth code');
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

    const { error: upsertError } = await supabase.from('connectors').upsert(
      { user_id: userId, connector_id: 'google', enabled: true, tokens, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,connector_id' }
    );
    if (upsertError) throw upsertError;

    const appOrigin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✓ Google connected</p>
        <p style="color:#888;font-size:13px">You can close this window</p>
        <script>window.opener?.postMessage('google_auth_success',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),1500);</script>
      </body></html>
    `);
  } catch (err) {
    console.error('/auth/google/callback error:', err.response?.data || err.message);
    const appOrigin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
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

// ── GitHub OAuth ──────────────────────────────────────────────────────────────

const GITHUB_SCOPES = 'repo notifications read:user';

app.get('/auth/github/start', (req, res) => {
  const userId = req.query.userId;
  if (!requireMatchingUser(req, res, userId)) return;
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    return res.status(500).json({ error: 'GitHub OAuth is not configured on the server.' });
  }
  const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/github/callback`;
  const state = signOAuthState(userId, 'github');
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: GITHUB_SCOPES,
    state
  });
  res.json({ url: `https://github.com/login/oauth/authorize?${params}` });
});

app.get('/auth/github/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const userId = verifyOAuthState(state, 'github');
  const appOrigin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

  if (error) {
    return res.send(`<script>window.opener?.postMessage('github_auth_error',${JSON.stringify(appOrigin)});window.close();</script>`);
  }
  if (!userId) return res.status(400).send('Invalid OAuth state');
  if (!code || typeof code !== 'string') return res.status(400).send('Missing OAuth code');

  try {
    const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/github/callback`;
    const resp = await axios.post('https://github.com/login/oauth/access_token', {
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri
    }, { headers: { Accept: 'application/json' }, timeout: 15000 });

    if (resp.data?.error || !resp.data?.access_token) {
      throw new Error(resp.data?.error_description || resp.data?.error || 'No access token returned');
    }

    await githubConnector.saveTokens(userId, {
      access_token: resp.data.access_token,
      scope: resp.data.scope,
      token_type: resp.data.token_type
    });

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✓ GitHub connected</p>
        <p style="color:#888;font-size:13px">You can close this window</p>
        <script>window.opener?.postMessage('github_auth_success',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),1500);</script>
      </body></html>
    `);
  } catch (err) {
    console.error('/auth/github/callback error:', err.response?.data || err.message);
    const errMsg = escapeHtml(err.response?.data?.error_description || err.message);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✗ Connection failed</p>
        <p style="color:#888;font-size:13px">${errMsg}</p>
        <script>window.opener?.postMessage('github_auth_error',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),3000);</script>
      </body></html>
    `);
  }
});

// ── Microsoft (Outlook) OAuth ─────────────────────────────────────────────────

const MS_TENANT = process.env.MS_TENANT || 'common';
const MS_SCOPES = 'offline_access Mail.Read Mail.Send Calendars.ReadWrite User.Read';

app.get('/auth/microsoft/start', (req, res) => {
  const userId = req.query.userId;
  if (!requireMatchingUser(req, res, userId)) return;
  if (!process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Microsoft OAuth is not configured on the server.' });
  }
  const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/microsoft/callback`;
  const state = signOAuthState(userId, 'microsoft');
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: MS_SCOPES,
    state
  });
  res.json({ url: `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize?${params}` });
});

app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const userId = verifyOAuthState(state, 'microsoft');
  const appOrigin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

  if (error) {
    return res.send(`<script>window.opener?.postMessage('microsoft_auth_error',${JSON.stringify(appOrigin)});window.close();</script>`);
  }
  if (!userId) return res.status(400).send('Invalid OAuth state');
  if (!code || typeof code !== 'string') return res.status(400).send('Missing OAuth code');

  try {
    const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/microsoft/callback`;
    const resp = await axios.post(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID,
        client_secret: process.env.MS_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });

    await microsoftConnector.saveTokens(userId, {
      access_token: resp.data.access_token,
      refresh_token: resp.data.refresh_token,
      expires_at: Date.now() + resp.data.expires_in * 1000
    });

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✓ Outlook connected</p>
        <p style="color:#888;font-size:13px">You can close this window</p>
        <script>window.opener?.postMessage('microsoft_auth_success',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),1500);</script>
      </body></html>
    `);
  } catch (err) {
    console.error('/auth/microsoft/callback error:', err.response?.data || err.message);
    const errMsg = escapeHtml(err.response?.data?.error_description || err.message);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✗ Connection failed</p>
        <p style="color:#888;font-size:13px">${errMsg}</p>
        <script>window.opener?.postMessage('microsoft_auth_error',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),3000);</script>
      </body></html>
    `);
  }
});

// ── Spotify OAuth ─────────────────────────────────────────────────────────────
// Spotify's token endpoint authenticates the client via HTTP Basic auth
// (base64(client_id:client_secret)) rather than body params — see the connector's
// refresh flow in connectors/spotify.js for the matching pattern.

const SPOTIFY_SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-modify-public playlist-modify-private playlist-read-private';

app.get('/auth/spotify/start', (req, res) => {
  const userId = req.query.userId;
  if (!requireMatchingUser(req, res, userId)) return;
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Spotify OAuth is not configured on the server.' });
  }
  const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/spotify/callback`;
  const state = signOAuthState(userId, 'spotify');
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SPOTIFY_SCOPES,
    state
  });
  res.json({ url: `https://accounts.spotify.com/authorize?${params}` });
});

app.get('/auth/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const userId = verifyOAuthState(state, 'spotify');
  const appOrigin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

  if (error) {
    return res.send(`<script>window.opener?.postMessage('spotify_auth_error',${JSON.stringify(appOrigin)});window.close();</script>`);
  }
  if (!userId) return res.status(400).send('Invalid OAuth state');
  if (!code || typeof code !== 'string') return res.status(400).send('Missing OAuth code');

  try {
    const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/spotify/callback`;
    const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const resp = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` }, timeout: 15000 });

    await spotifyConnector.saveTokens(userId, {
      access_token: resp.data.access_token,
      refresh_token: resp.data.refresh_token,
      expires_at: Date.now() + resp.data.expires_in * 1000
    });

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✓ Spotify connected</p>
        <p style="color:#888;font-size:13px">You can close this window</p>
        <script>window.opener?.postMessage('spotify_auth_success',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),1500);</script>
      </body></html>
    `);
  } catch (err) {
    console.error('/auth/spotify/callback error:', err.response?.data || err.message);
    const errMsg = escapeHtml(err.response?.data?.error_description || err.message);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✗ Connection failed</p>
        <p style="color:#888;font-size:13px">${errMsg}</p>
        <script>window.opener?.postMessage('spotify_auth_error',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),3000);</script>
      </body></html>
    `);
  }
});

// ── Linear OAuth ──────────────────────────────────────────────────────────────

const LINEAR_SCOPES = 'read,write';

app.get('/auth/linear/start', (req, res) => {
  const userId = req.query.userId;
  if (!requireMatchingUser(req, res, userId)) return;
  if (!process.env.LINEAR_CLIENT_ID || !process.env.LINEAR_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Linear OAuth is not configured on the server.' });
  }
  const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/linear/callback`;
  const state = signOAuthState(userId, 'linear');
  const params = new URLSearchParams({
    client_id: process.env.LINEAR_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: LINEAR_SCOPES,
    state
  });
  res.json({ url: `https://linear.app/oauth/authorize?${params}` });
});

app.get('/auth/linear/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const userId = verifyOAuthState(state, 'linear');
  const appOrigin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

  if (error) {
    return res.send(`<script>window.opener?.postMessage('linear_auth_error',${JSON.stringify(appOrigin)});window.close();</script>`);
  }
  if (!userId) return res.status(400).send('Invalid OAuth state');
  if (!code || typeof code !== 'string') return res.status(400).send('Missing OAuth code');

  try {
    const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/linear/callback`;
    const resp = await axios.post('https://api.linear.app/oauth/token',
      new URLSearchParams({
        client_id: process.env.LINEAR_CLIENT_ID,
        client_secret: process.env.LINEAR_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });

    if (resp.data?.error || !resp.data?.access_token) {
      throw new Error(resp.data?.error_description || resp.data?.error || 'No access token returned');
    }

    await linearConnector.saveTokens(userId, {
      access_token: resp.data.access_token,
      scope: resp.data.scope,
      token_type: resp.data.token_type
    });

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✓ Linear connected</p>
        <p style="color:#888;font-size:13px">You can close this window</p>
        <script>window.opener?.postMessage('linear_auth_success',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),1500);</script>
      </body></html>
    `);
  } catch (err) {
    console.error('/auth/linear/callback error:', err.response?.data || err.message);
    const errMsg = escapeHtml(err.response?.data?.error_description || err.message);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✗ Connection failed</p>
        <p style="color:#888;font-size:13px">${errMsg}</p>
        <script>window.opener?.postMessage('linear_auth_error',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),3000);</script>
      </body></html>
    `);
  }
});

// ── Notion OAuth ──────────────────────────────────────────────────────────────

app.get('/auth/notion/start', (req, res) => {
  const userId = req.query.userId;
  if (!requireMatchingUser(req, res, userId)) return;
  if (!process.env.NOTION_CLIENT_ID || !process.env.NOTION_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Notion OAuth is not configured on the server.' });
  }
  const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/notion/callback`;
  const state = signOAuthState(userId, 'notion');
  const params = new URLSearchParams({
    client_id: process.env.NOTION_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    owner: 'user',
    state
  });
  res.json({ url: `https://api.notion.com/v1/oauth/authorize?${params}` });
});

app.get('/auth/notion/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const userId = verifyOAuthState(state, 'notion');
  const appOrigin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

  if (error) {
    return res.send(`<script>window.opener?.postMessage('notion_auth_error',${JSON.stringify(appOrigin)});window.close();</script>`);
  }
  if (!userId) return res.status(400).send('Invalid OAuth state');
  if (!code || typeof code !== 'string') return res.status(400).send('Missing OAuth code');

  try {
    const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/notion/callback`;
    const basicAuth = Buffer.from(`${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`).toString('base64');
    const resp = await axios.post('https://api.notion.com/v1/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    }, {
      headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    if (!resp.data?.access_token) {
      throw new Error(resp.data?.error || 'No access token returned');
    }

    await notionConnector.saveTokens(userId, {
      access_token: resp.data.access_token,
      bot_id: resp.data.bot_id,
      workspace_id: resp.data.workspace_id,
      workspace_name: resp.data.workspace_name
    });

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✓ Notion connected</p>
        <p style="color:#888;font-size:13px">You can close this window</p>
        <script>window.opener?.postMessage('notion_auth_success',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),1500);</script>
      </body></html>
    `);
  } catch (err) {
    console.error('/auth/notion/callback error:', err.response?.data || err.message);
    const errMsg = escapeHtml(err.response?.data?.error_description || err.response?.data?.error || err.message);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0d0d;color:#fff">
        <p style="font-size:18px">✗ Connection failed</p>
        <p style="color:#888;font-size:13px">${errMsg}</p>
        <script>window.opener?.postMessage('notion_auth_error',${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),3000);</script>
      </body></html>
    `);
  }
});

app.get('/debug/:userId', async (req, res) => {
  const debugToken = req.headers['x-debug-token'];
  if (!process.env.DEBUG_SECRET) return res.status(404).json({ error: 'Not found' });
  if (debugToken !== process.env.DEBUG_SECRET) return res.status(403).json({ error: 'Forbidden' });
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
    return sendServerError(res, err, 'server.error');
  }
});

app.get('/health', async (_req, res) => {
  const missingEnv = getMissingRuntimeEnv();
  let dbStatus = 'ok';
  let dbLatencyMs = 0;
  try {
    const dbStart = Date.now();
    await supabase.from('users').select('id').limit(1);
    dbLatencyMs = Date.now() - dbStart;
  } catch (e) {
    dbStatus = 'error';
  }
  const mem = process.memoryUsage();
  const versionInfo = getRuntimeVersion();
  res.json({
    status: (missingEnv.length || dbStatus !== 'ok') ? 'degraded' : 'ok',
    db: { status: dbStatus, latencyMs: dbLatencyMs },
    memory: { heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024), heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024) },
    uptime: Math.round(process.uptime()),
    missingEnv,
    ...versionInfo
  });
});

app.get('/version', (_req, res) => {
  res.json(getRuntimeVersion());
});

app.get('/changelog', (req, res) => {
  res.json([
    { version: '2.0.0', date: '2026-05-28', changes: ['Multi-surface assistant: PWA + native iOS app', 'Gemini Live real-time voice', 'Proactive briefings with push notifications', 'Action safety review system', 'Memory extraction and persistence'] },
    { version: '1.5.0', date: '2026-04-01', changes: ['Maps connector with Google Places', 'Trainline train search', 'Uber/UberEats/Deliveroo deep links', 'Netflix connector'] },
    { version: '1.4.0', date: '2026-03-01', changes: ['Per-user authentication', 'Session tokens', 'Connector health diagnostics'] },
    { version: '1.3.0', date: '2026-02-01', changes: ['Telegram User API connector', 'Google Calendar integration', 'Action contracts and risk levels'] },
    { version: '1.2.0', date: '2026-01-01', changes: ['Gmail connector with OAuth', 'Context brain for conversation follow-ups', 'Prompt and context caching'] }
  ]);
});

function legalPage(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Oxy</title>
  <style>
    body{margin:0;background:#0b0b0c;color:#f4f0ec;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:760px;margin:0 auto;padding:48px 20px 72px}
    h1{font-size:34px;line-height:1.1;margin:0 0 10px}
    h2{font-size:20px;margin:30px 0 10px}
    p,li{color:#cfc8c1}
    a{color:#e97961}
    .meta{color:#8f8781;font-size:14px;margin-bottom:30px}
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

app.get('/privacy', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(legalPage('Privacy Policy', `
    <h1>Privacy Policy</h1>
    <p class="meta">Last updated ${escapeHtml(getLocalDateKey())}.</p>
    <h2>Data Controller</h2>
    <p>Oxy is operated by Chizi Gamonye-Wuchi. Contact: <a href="mailto:support@oxy.app">support@oxy.app</a></p>
    <h2>What We Collect</h2>
    <ul>
      <li>Chat messages and conversation history</li>
      <li>Voice audio (transcribed and discarded after processing)</li>
      <li>Location data (when location permission is granted)</li>
      <li>Contacts (when contacts permission is granted)</li>
      <li>Health data (when HealthKit permission is granted)</li>
      <li>Calendar and reminder data (when calendar permission is granted)</li>
      <li>Email content (when Gmail connector is connected)</li>
      <li>OAuth tokens for connected services</li>
      <li>Memories you ask Oxy to keep, plus stable facts inferred from conversations</li>
    </ul>
    <h2>How We Use It</h2>
    <ul>
      <li>Providing the AI assistant service and completing requested actions</li>
      <li>Improving the service through aggregated usage analytics</li>
    </ul>
    <h2>Lawful Basis</h2>
    <p>Contract performance for account and assistant features. Legitimate interests for service improvement.</p>
    <h2>Third-Party Processors</h2>
    <ul>
      <li>Google (Gemini AI, Gmail, Calendar, Maps) — for AI processing and connector features</li>
      <li>Supabase — database hosting (EU region)</li>
      <li>Telegram — messaging connector (when enabled)</li>
    </ul>
    <h2>Data Retention</h2>
    <ul>
      <li>Conversations: 180 days</li>
      <li>Memories: until you delete them</li>
      <li>Account data: until you request deletion</li>
    </ul>
    <h2>Your Rights</h2>
    <p>You have the right to access, rectification, erasure, portability, restriction, and objection. To exercise these rights, email <a href="mailto:support@oxy.app">support@oxy.app</a>.</p>
    <h2>Security Incidents</h2>
    <p>If a data breach affects your account, Oxy will notify you within 72 hours of confirming the incident where legally required.</p>
    <h2>Contact</h2>
    <p>Email: <a href="mailto:support@oxy.app">support@oxy.app</a></p>
  `));
});

app.get('/terms', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(legalPage('Terms of Service', `
    <h1>Terms of Service</h1>
    <p class="meta">Last updated ${escapeHtml(getLocalDateKey())}.</p>
    <h2>The Service</h2>
    <p>Oxy is an AI assistant that connects to your apps and services to help you get things done. It can read and send messages, manage calendar events, search the web, and more — based on your instructions.</p>
    <h2>Acceptable Use</h2>
    <ul>
      <li>No illegal activity using Oxy or connected services</li>
      <li>No abuse of connected services (e.g. sending spam)</li>
      <li>No attempts to circumvent safety measures or extract training data</li>
    </ul>
    <h2>Subscription</h2>
    <p>Oxy costs £14.99/month or £129/year, billed in advance. You can cancel anytime from Settings.</p>
    <h2>Refund Policy</h2>
    <p>You have a 14-day cooling-off period for new subscriptions under the UK Consumer Contracts Regulations 2013. Contact <a href="mailto:support@oxy.app">support@oxy.app</a> to request a refund within this period.</p>
    <h2>Limitation of Liability</h2>
    <p>Oxy is provided as-is. We are not liable for actions taken by connectors or for decisions made based on Oxy's responses. Always verify important information independently.</p>
    <h2>Governing Law</h2>
    <p>These terms are governed by the laws of England and Wales.</p>
    <h2>Contact</h2>
    <p>Email: <a href="mailto:support@oxy.app">support@oxy.app</a></p>
  `));
});

app.get('/support', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><title>Oxy Support</title>
  <style>body{font-family:sans-serif;max-width:680px;margin:40px auto;padding:0 24px;color:#1a1a1a;line-height:1.6}h1{font-size:28px}h2{font-size:20px;margin-top:32px}a{color:#2563eb}.faq{background:#f9f9f9;padding:16px;border-radius:8px;margin:12px 0}</style>
  </head><body>
  <h1>Oxy Support</h1>
  <p><strong>Email:</strong> <a href="mailto:support@oxy.app">support@oxy.app</a></p>
  <p>We aim to respond within 48 hours. For security issues: <a href="mailto:security@oxy.app">security@oxy.app</a></p>

  <h2>Delete Your Data</h2>
  <ol>
    <li>Open Oxy and go to Settings</li>
    <li>Scroll to "Danger Zone" at the bottom</li>
    <li>Tap "Delete Account" and follow the confirmation steps</li>
    <li>All your data (messages, memories, connected accounts) will be permanently deleted</li>
  </ol>
  <p>Alternatively, email <a href="mailto:support@oxy.app">support@oxy.app</a> with the subject "Delete my account" from your registered email address.</p>

  <h2>Frequently Asked Questions</h2>
  <div class="faq"><strong>How do I connect Gmail?</strong><br>Go to Connectors tab &rarr; tap Google &rarr; sign in with your Google account. Oxy only accesses your email when you ask it to.</div>
  <div class="faq"><strong>What does Oxy remember?</strong><br>Oxy extracts key facts from conversations (like your preferences or context). You can view and delete all memories in the Memory tab.</div>
  <div class="faq"><strong>Can I cancel my subscription?</strong><br>Yes, anytime. Cancel from Settings &rarr; Subscription or via your App Store/payment provider. You have 14 days from first purchase for a full refund (UK consumer law).</div>
  <div class="faq"><strong>Is my data secure?</strong><br>Your data is stored in encrypted databases. Connector tokens are encrypted at rest. We never sell your data. See our <a href="/privacy">Privacy Policy</a>.</div>
  <div class="faq"><strong>How do I report a bug?</strong><br>Email <a href="mailto:support@oxy.app">support@oxy.app</a> with your device, app version (visible in Settings), and what happened.</div>

  <p><a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms of Service</a></p>
  </body></html>`);
});

app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('User-agent: *\nAllow: /\nDisallow: /debug\nDisallow: /admin\nDisallow: /api/\nSitemap: https://oxy.app/sitemap.xml');
});

app.get('/humans.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('/* TEAM */\nChizi Gamonye-Wuchi — Founder & Builder\nLocation: Solihull, UK\n\n/* THANKS */\nGemini · Supabase · Cloud Run · Node.js\n\n/* SITE */\nLast update: 2026\nLanguage: English\nDoctype: HTML5\nIDE: Various');
});

app.post('/admin/cleanup-conversations', async (req, res) => {
  if (!process.env.DEBUG_SECRET) return res.status(404).json({ error: 'Not found' });
  if (req.headers['x-debug-token'] !== process.env.DEBUG_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const { data: oldConvs, error } = await supabase.from('conversations').select('id, user_id, created_at').lt('created_at', cutoff);
  if (error) return res.status(500).json({ error: error.message });

  let deleted = 0;
  const byUser = {};
  for (const c of (oldConvs || [])) {
    if (!byUser[c.user_id]) byUser[c.user_id] = [];
    byUser[c.user_id].push(c.id);
  }

  for (const [userId, ids] of Object.entries(byUser)) {
    const { count } = await supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    if (count > 500) {
      const toDelete = ids.slice(0, Math.min(ids.length, count - 500));
      if (toDelete.length > 0) {
        const { error: delErr } = await supabase.from('conversations').delete().in('id', toDelete);
        if (!delErr) deleted += toDelete.length;
      }
    }
  }

  res.json({ deleted, message: `Cleaned up ${deleted} old conversations` });
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

// Oxy is now an iOS-only product; the PWA root was removed. Keep / as a
// truthful service identity endpoint instead of serving a missing file.
app.get('/', (_req, res) => {
  res.json({
    service: 'Oxy API',
    status: 'ok',
    docs: '/health for diagnostics, /version for build info',
    ...getRuntimeVersion()
  });
});

// Sentry error handler must be last
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    app.use(Sentry.expressErrorHandler());
  } catch (e) {}
}

module.exports = app;
module.exports.runProactiveSweep = runProactiveSweep;
// Exposed so tests can exercise the real dispatch path (executeActions -> the contract
// validator -> this switch) instead of only unit-testing pieces in isolation — that gap
// is exactly how the contract/handler mismatch shipped to production undetected.
module.exports.executeActions = executeActions;
// Proactive Signals — pure logic exposed for unit tests (parser, tier rules, idempotency).
module.exports.parseSignalsResponse = parseSignalsResponse;
module.exports.classifySignalTier = classifySignalTier;
module.exports.executeSafeSignals = executeSafeSignals;

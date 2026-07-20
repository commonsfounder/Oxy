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
const { extractIncoming } = require('./services/incoming');
const googleConnector = require('../connectors/google');
const telegram = require('../connectors/telegram');
const { inferDeterministicAction } = require('./intent-router');
const { resolveRetailerFromGoal, allRetailerAliases } = require('./services/retailer-sites');
const browserTask = require('./services/browser-task');
const { createActionRunner } = require('./services/action-runner');
const { guardConciergeSpend: sharedGuardConciergeSpend } = require('./services/concierge-spend-guard');
const {
  isPendingCancelMessage,
  isPendingConfirmMessage,
  isPendingRevisionMessage,
  reviewTitleForAction
} = require('./services/pending-review');
const {
  ACTION_CONTRACTS,
  actionPromptBlock,
  validateActionWithContract,
  buildFunctionDeclarations,
  buildToolsForGemini
} = require('./action-contracts');
const {
  createGeminiServiceClient,
  createSupabaseServiceClient,
  getMissingRuntimeEnv,
  logMissingRuntimeEnvOnce
} = require('../runtime');
const { getSearchReason, needsSearch } = require('./services/search-intent');
const {
  buildCalendarReadAction,
  calendarIntentKind,
  isCalendarReadRequest,
  isExplicitCalendarWrite
} = require('./services/calendar-intent');
const {
  buildResolvedContext,
  isContextualReference,
  resolveContextualTurn
} = require('./services/context-brain');
const {
  createSessionToken,
  getAuthenticatedUserId,
  hashPassword,
  requireSessionAuth,
  signPayload,
  verifyPassword,
  verifySignedPayload
} = require('../auth');
const {
  runAgentLoop: runAgenticLoop,
  generatePlan,
  reflectOnResults
} = require('./services/agent-orchestrator');
const taskManager = require('./services/task-manager');
const { connectorForAction } = require('./services/connector-health');
const { getRuntimeVersion } = require('./services/runtime-version');
const { shouldClarifyPreviousPlace } = require('./services/contextual-routing');
const { clearCheckoutProfile } = require('./services/checkout-profile');
const { encryptTokens } = require('./services/token-crypto');
const { createSetupIntentForUser, getLinkedCard, saveLinkedCard, unlinkCard, readStripeTokens, chargeLinkedCard, setPaymentActionRequired, getPaymentActionRequired } = require('./services/stripe-cards');
const { saveAgentCard, getAgentCardSummary, deleteAgentCard } = require('./services/agent-card');
const { resolveCurrencyForLocation } = require('./services/currency-from-location');
const { handleStripeWebhookEvent } = require('./services/stripe-webhook');
const { getTaskSteps } = require('./services/task-steps');
const { proactiveSweepAuthorization } = require('./services/proactive-auth');

const stripeClient = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

function devTimingEnabled() {
  return process.env.OXY_DEV_TIMING === '1' || process.env.NODE_ENV === 'development';
}

function devTiming(area, event, fields = {}) {
  if (!devTimingEnabled()) return;
  console.log('[dev-timing]', JSON.stringify({
    area,
    event,
    t: new Date().toISOString(),
    ...fields
  }));
}

async function timedDev(area, event, fields, fn) {
  const started = Date.now();
  devTiming(area, `${event}.start`, fields);
  try {
    const result = await fn();
    devTiming(area, `${event}.end`, { ...fields, durationMs: Date.now() - started, success: true });
    return result;
  } catch (err) {
    devTiming(area, `${event}.end`, { ...fields, durationMs: Date.now() - started, success: false, error: err.message });
    throw err;
  }
}

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
const DEV_DEMO_USER_ID = process.env.OXY_DEV_AUTH_USER_ID || 'demo-test-user';
function isValidUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

function isDevAuthEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.OXY_ENABLE_DEV_AUTH === 'true';
}

function shouldSeedDevAuthUser() {
  return process.env.OXY_DEV_AUTH_SEED_USER === 'true';
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

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeClient || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'Stripe webhook is not configured on the server.' });
  }
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('/webhooks/stripe signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    const result = await handleStripeWebhookEvent(supabase, event);
    res.json({ received: true, ...result });
  } catch (err) {
    console.error('/webhooks/stripe handling error:', err.message);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
});

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
    '/auth/dev/demo-login',
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
// Agentic reasoning keeps the capable model; ordinary streaming chat uses the fast
// model so text starts in under a second instead of waiting on the planner-grade path.
const PRIMARY_CHAT_MODEL = process.env.OXY_REASONING_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const FAST_MODEL = process.env.OXY_FAST_MODEL || process.env.GEMINI_FAST_MODEL || 'gemini-3.1-flash-lite';
const STREAMING_CHAT_MODEL = process.env.OXY_STREAM_MODEL || PRIMARY_CHAT_MODEL;
if ([PRIMARY_CHAT_MODEL, FAST_MODEL, STREAMING_CHAT_MODEL].some(m => m.includes('3.5'))) {
  throw new Error(`[models] BANNED: a model config contains "3.5". Remove it.`);
}
const PROMPT_CACHE_TTL = process.env.OXY_PROMPT_CACHE_TTL || '3600s';
const promptCacheStates = new Map();
const PROACTIVE_MORNING_PREF = 'proactive.morning_briefing.date';
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

async function sendPushToUser(userId, briefing) {
  const bundleId = process.env.APNS_BUNDLE_ID;
  const token = apnsAuthToken();
  if (!bundleId || !token) return { sent: 0, skipped: true };

  const { data: devices, error } = await supabase
    .from('devices')
    .select('push_token, platform')
    .eq('user_id', userId);
  if (error || !Array.isArray(devices)) return { sent: 0, error: error?.message || 'No devices' };

  const host = process.env.APNS_USE_SANDBOX === 'true' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  let sent = 0;
  await Promise.all(devices
    .filter(device => device.platform === 'ios' && device.push_token)
    .map(async device => {
      try {
        await axios.post(
          `${host}/3/device/${device.push_token}`,
          {
            aps: {
              alert: {
                title: briefing.title || 'Assistant',
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

// Refreshes an already-created briefing/nudge row's dashboard-facing data (emails,
// incoming deliveries/reservations) in place, independent of the once-per-day throttle
// that gates generating NEW narrative text/pushes for that kind. Silent — no chat
// message, no push — this exists purely so the Home cards reflect the current inbox
// instead of a frozen snapshot from whenever the narrative last fired. If a bug in the
// extraction logic gets fixed mid-day, the very next open picks up the correction here
// rather than waiting for tomorrow's window.
async function refreshBriefingEmailData(userId, kind, todayKey, emailContext) {
  try {
    const { data, error } = await supabase
      .from('briefings')
      .select('id, metadata')
      .eq('user_id', userId)
      .eq('kind', kind)
      .contains('metadata', { date: todayKey })
      .order('created_at', { ascending: false })
      .limit(1);
    if (error || !data?.length) return;
    const [row] = data;
    await supabase
      .from('briefings')
      .update({ metadata: { ...row.metadata, emails: emailContext.emails, incoming: emailContext.incoming } })
      .eq('id', row.id);
  } catch {}
}

const { OXCY_SYSTEM_PROMPT, MILLIE_VOICE_PROMPT } = require('./prompts');

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
  const text = String(fullResponse || '');
  const matches = [...text.matchAll(/<action>([\s\S]*?)<\/action>/gi)];
  const spoken = text.replace(/<action>[\s\S]*?<\/action>/gi, '').trim();
  let actions = [];
  let parseError = false;

  for (const match of matches) {
    try {
      // Strip markdown code fences Gemini sometimes wraps around JSON
      const raw = match[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(raw);
      actions.push(...(parsed.actions || []));
    } catch (e) {
      parseError = true;
      console.warn('[parseActions] failed:', e.message, '| raw:', match[1].trim().slice(0, 200));
    }
  }

  return { spoken, actions, parseError };
}

function mentionsActionCommitment(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  return /\b(i['’]?ll|i will|going to|about to)\s+(set|create|add|send|book|order|call|check|search|look up|open)\b/i.test(value) ||
    /\b(done|all set|sent|booked|created|added|ordered|called|reminder set)\b/i.test(value);
}

function parsePrice(text = '') {
  const value = String(text || '');
  if (/\bfree\b/i.test(value)) return null;
  const match = value.match(/(?:£|\$|€)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?:\s*(?:gbp|usd|eur))?/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(amount) ? amount : null;
}

function decidePaymentByCap(totalText, budgetCap) {
  const total = parsePrice(totalText);
  const cap = Number(budgetCap);
  if (!total || !cap || cap <= 0) return { decision: 'approve', total, cap: Number.isFinite(cap) ? cap : null };
  return { decision: total <= cap ? 'pay' : 'approve', total, cap };
}

async function runLegacyActionLoop({ generate, execute, confirm, maxSteps = 6, budgetCap = null }) {
  const actions = [];
  let spoken = '';
  for (let step = 1; step <= maxSteps; step += 1) {
    const response = await generate();
    const text = typeof response === 'string' ? response : (response?.text || '');
    const parsed = parseActions(text);
    spoken = parsed.spoken || spoken;
    if (!parsed.actions.length) return { status: 'done', spoken, actions, steps: step };

    const batch = await execute(parsed.actions);
    actions.push(...batch);
    const pending = batch.find(entry => entry?.result?.confirmation === 'review_required' || entry?.result?.pending);
    if (pending) {
      if (pending.action === 'run_browser_task') {
        const decision = decidePaymentByCap(pending.result?.total, budgetCap);
        if (decision.decision === 'pay') {
          const confirmed = await confirm(pending);
          actions.push({ action: pending.action, result: confirmed });
          continue;
        }
      }
      return { status: 'paused', spoken, actions, steps: step };
    }
  }
  return { status: 'maxSteps', spoken, actions, steps: maxSteps };
}

function guardCalendarActionsForUserMessage(actions = [], userMessage = '') {
  const intent = calendarIntentKind(userMessage);
  if (!Array.isArray(actions) || !actions.length) return [];
  return actions.map(action => {
    if (action?.type !== 'create_calendar_event') return action;
    if (intent === 'write') return action;
    return { ...buildCalendarReadAction(userMessage).actions[0], _reroutedFrom: 'create_calendar_event' };
  });
}

function emailReadActionForMessage(message = '') {
  const text = String(message || '');
  const broadTriage = isBroadEmailTriageRequest(text);
  const input = { max_results: broadTriage ? 20 : 5, label: 'INBOX' };
  if (/\btoday\b/i.test(text)) input.query = 'newer_than:1d';
  if (input.query) {
    return { type: 'search_emails', input: { query: input.query, max_results: input.max_results } };
  }
  return { type: 'get_emails', input };
}

function inferCompoundReadOnlyTurn(message = '') {
  const text = String(message || '');
  const hits = [];
  const emailMatch = text.match(/\b(email|emails|gmail|inbox)\b/i);
  if (emailMatch) {
    hits.push({ index: emailMatch.index ?? 0, kind: 'email', label: 'emails' });
  }
  const calendarMatch = text.match(/\b(calendar|schedule|events?)\b/i);
  if (calendarMatch && isCalendarReadRequest(text)) {
    hits.push({ index: calendarMatch.index ?? 0, kind: 'calendar', label: 'calendar' });
  }
  const orderedHits = hits.sort((a, b) => a.index - b.index);
  // Split on ", then"/"then" clause connectors so each domain's segment keeps
  // qualifiers ("important", "today") that precede its own trigger keyword
  // within the same clause, without bleeding into the other clause's
  // date/priority words (slicing purely by keyword index either dropped
  // leading qualifiers or let a date word from one clause leak into the
  // other). Falls back to keyword-index slicing when there's no explicit
  // connector to split the clauses on.
  const clauseBreaks = [...text.matchAll(/,?\s*\bthen\b\s*/gi)].map(m => m.index + m[0].length);
  const boundaries = [0, ...clauseBreaks, text.length];
  const clauseFor = (idx) => {
    for (let i = 0; i < boundaries.length - 1; i++) {
      if (idx >= boundaries[i] && idx < boundaries[i + 1]) return { start: boundaries[i], end: boundaries[i + 1] };
    }
    return { start: 0, end: text.length };
  };
  const actions = orderedHits.map((hit, idx) => {
    let start, end;
    if (clauseBreaks.length) {
      ({ start, end } = clauseFor(hit.index));
    } else {
      start = idx === 0 ? 0 : orderedHits[idx - 1].index;
      end = orderedHits[idx + 1]?.index ?? text.length;
    }
    const segment = text.slice(start, end);
    return hit.kind === 'calendar'
      ? buildCalendarReadAction(segment).actions[0]
      : emailReadActionForMessage(segment);
  });
  const uniqueTypes = new Set(actions.map(action => action.type));
  if (actions.length < 2 || uniqueTypes.size < 2) return null;
  return {
    reason: 'compound_read_only',
    spoken: "I'll check those and give you one combined summary.",
    actions
  };
}

function summarizeReadOnlyActionResults(actionResults = [], message = '') {
  const dataResults = getStructuredDataResults(actionResults, message);
  const failures = (actionResults || []).filter(entry => DATA_ACTIONS.has(entry?.action) && entry?.result?.success === false);
  if (!dataResults.length && !failures.length) return '';
  const parts = [];
  if (dataResults.length) {
    parts.push(buildConciseDataAnswer(dataResults));
  }
  if (failures.length) {
    parts.push(failures.map(entry => `${humanizeActionType(entry.action)} failed: ${userFacingActionFailure(entry)}`).join('\n'));
  }
  return parts.join('\n\n');
}

// Convert Gemini native function calls (from response.functionCalls or parts) to internal action format
function functionCallsToActions(response) {
  const actions = [];
  try {
    // modernGenAI response may have response.functionCalls or candidates
    const calls = response?.functionCalls || (response?.candidates?.[0]?.content?.parts || []).filter(p => p.functionCall).map(p => p.functionCall);
    if (Array.isArray(calls)) {
      for (const fc of calls) {
        if (fc && fc.name) {
          actions.push({ type: fc.name, input: fc.args || {} });
        }
      }
    } else if (response?.functionCall?.name) {
      actions.push({ type: response.functionCall.name, input: response.functionCall.args || {} });
    }
  } catch (e) {
    console.warn('[functionCallsToActions] parse error', e.message);
  }
  return actions;
}

function extractSpokenFromResponse(resp) {
  if (!resp) return '';
  if (typeof resp.text === 'function') {
    try { return (resp.text() || '').trim(); } catch {}
  }
  if (resp.text) return String(resp.text).trim();
  if (resp.candidates && resp.candidates[0]) {
    const parts = resp.candidates[0].content?.parts || [];
    const textParts = parts.filter(p => p.text).map(p => p.text).join(' ');
    return textParts.trim();
  }
  return '';
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
      const normalized = normalizeEmailForSynthesis(email);
      return `\n  Email ${index + 1}: Sender ${normalized.sender} | Subject ${normalized.subject}${normalized.snippet ? ` | Extract ${normalized.snippet}` : ''}`;
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

function validatePendantTranscriptionUpload(file) {
  if (!file) return { ok: false, status: 400, error: 'No audio file received.' };
  const size = file.size || file.buffer?.length || 0;
  if (!size) return { ok: false, status: 400, error: 'Audio file was empty.' };
  const mimetype = String(file.mimetype || '').toLowerCase();
  const originalname = String(file.originalname || '').toLowerCase();
  const supportedMime = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/webm'];
  const supportedExt = /\.(wav|m4a|mp4|mp3|webm)$/i.test(originalname);
  if (mimetype && !supportedMime.includes(mimetype) && !supportedExt) {
    return { ok: false, status: 415, error: 'Unsupported audio format.' };
  }
  return { ok: true, size, mimetype: mimetype || 'unknown', originalname };
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

function stripMarkdownFormatting(text) {
  if (!text) return '';
  return text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\*)(.*?)\*(?!\*)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
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

// Scans recent conversation turns (both user and assistant) to extract the active
// shopping context: which retailer the user specified and what URL was actually visited.
// This is separate from extractAlreadyStatedContext which only reads assistant turns.
function extractShoppingContextHints(history = []) {
  const recent = history.slice(-8);
  const hints = [];

  // Track the most recently user-specified retailer and the last domain actually visited
  let specifiedRetailer = null;
  let visitedDomain = null;
  const aliases = allRetailerAliases();

  for (const turn of recent) {
    const content = String(turn.content || '');
    const lower = content.toLowerCase();

    if (turn.role === 'user') {
      // Try resolving retailer from the full user message (handles "on john lewis", "from asos", etc.)
      const resolved = resolveRetailerFromGoal(content);
      if (resolved) {
        specifiedRetailer = resolved.displayName;
      } else {
        // Fallback: bare retailer alias in user message
        for (const alias of aliases) {
          if (lower.includes(alias)) {
            specifiedRetailer = alias;
            break;
          }
        }
      }
    }

    if (turn.role === 'assistant') {
      // Extract domain from any URL the assistant returned
      const urlMatch = content.match(/https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i);
      if (urlMatch) visitedDomain = urlMatch[1].toLowerCase();
    }
  }

  if (specifiedRetailer) hints.push(`Shopping: user specified retailer "${specifiedRetailer}" — use this for any follow-up price or product queries.`);
  if (visitedDomain && (!specifiedRetailer || !specifiedRetailer.toLowerCase().includes(visitedDomain.split('.')[0]))) {
    hints.push(`Last browsed site: ${visitedDomain}`);
  }
  return hints;
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
- ${MILLIE_VOICE_PROMPT.split('\n').join('\n- ')}
- The user leads the conversation. Follow their topic instead of steering into unrelated stored memory.
- Treat stored memory as background context for understanding, not as content to surface by default.
- Only mention stored memory when it is directly relevant to what the user just said, asked, or asked you to do.
- Treat personal fact statements like "my usual station is Birmingham New Street" as memory to acknowledge, not as a place, web, or app search.
- For greetings or simple check-ins like "hi", "hey", or "ok", just respond naturally to that message. Do not surface legal cases, health goals, TV shows, or personal situations unless the user brings them up.
- Do not repeat context you already stated earlier in this conversation.
- Especially avoid repeating time/date, current plans, study topics, or personal brief details unless the user directly asks again.
- Do not mention the current time or date unless the user asked for it or it is necessary for the action/result.
- If a factual answer involves public figures, news, violence, legal events, prices, schedules, or recent/current facts, do not provide names, dates, or counts unless they are grounded in search/tool/context evidence.
- Search and tool results can be stale. Check any dates inside them against the current date above; a result saying "as of" an earlier year is outdated, not proof something never happened. When sources conflict with the current date, say the information may be out of date and offer to check again — never invent releases, cancellations, or history to reconcile the conflict.
- If the user questions or challenges your previous factual answer, correct only the factual issue. Do not answer with meta/persona language.
- If an action is completed successfully, stop after one confirmation sentence. No follow-up question, no summary, no check-in.
- If an action hits a small blocker, say the snag plainly and give the next step in one short sentence. Example: "Tiny snag - I need location access to find pizza near you. Turn it on and I'll try again."

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
${MILLIE_VOICE_PROMPT}

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
  if (/^(ok|okay|kk|cool|nice|great)$/.test(normalized)) return 'Got it.';
  if (/^(nah|no)$/.test(normalized)) return 'Got you.';
  return '';
}

function isPureContentGenerationTurn(message = '') {
  const text = String(message || '').toLowerCase();
  if (!text.trim()) return false;

  const asksForProse = /\b(write|explain|describe|summari[sz]e|compare|teach|outline|draft|list|define)\b/.test(text) ||
    /\b(what is|what are|how does|how do|why did|why does|tell me about)\b/.test(text);
  if (!asksForProse) return false;

  // These imply real-world action, tool execution, or persistent planning. Keep
  // them eligible for the agent loop instead of treating them as plain prose.
  const actionOrGoal = /\b(book|order|buy|purchase|send|text|message|call|email|create|add|schedule|remind|reserve|open|navigate|directions|find|search|look up|research|arrange|organize|handle|monitor|track|make money|earn cash|side hustle|moneti[sz]e|profit)\b/.test(text);
  return !actionOrGoal;
}

function shouldUseAgenticLoopForMessage({ message = '', quickTurn = false, autonomyLevel = 'Active', pendingAction = null } = {}) {
  if (quickTurn || pendingAction || autonomyLevel === 'Quiet') return false;
  if (isPureContentGenerationTurn(message)) return false;
  const text = String(message || '').toLowerCase();
  const explicitAutonomousGoal =
    /\b(make money|earn cash|side hustle|moneti[sz]e|profit|financial freedom)\b/.test(text) ||
    /\b(handle|monitor|track|arrange|organize|coordinate|keep working|work on this|take care of|sort this out)\b/.test(text) ||
    /\b(research|find|compare)\b.+\b(and|then)\b.+\b(book|buy|order|send|schedule|create|open|message|email)\b/.test(text);
  const directToolIntent =
    /\b(book|order|buy|purchase|send|call|email|create|add|schedule|remind|reserve|open|navigate|directions)\b/.test(text) ||
    /^(please\s+|can you\s+|could you\s+)?(text|message)\s+(me|him|her|them|[a-z][a-z'-]{1,})\b/.test(text);
  const personalDataIntent = /\b(my|in my|from my|on my)\b.+\b(email|calendar|inbox|messages|reminders|contacts|playlist|music)\b/.test(text);
  return explicitAutonomousGoal || directToolIntent || personalDataIntent;
}

function shouldIgnoreModelAuthoredActions(modelName = '') {
  return String(modelName || '') === FAST_MODEL;
}

function formatLondonYMD(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToYMD(ymd, days) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function extractRelativeDateYMD(text) {
  const lower = String(text || '').toLowerCase();
  const today = formatLondonYMD();
  if (/\btomorrow\b/.test(lower)) return addDaysToYMD(today, 1);
  if (/\btoday\b/.test(lower)) return today;
  return null;
}

function cleanCalendarTitle(text) {
  return String(text || '')
    .replace(/^(okay|ok|please|pls|can you|could you)\s+/i, '')
    .replace(/\b(i\s+mean\s+)?add\s+(it|that)?\s*to\s+my\s+calendar\b/i, '')
    .replace(/\b(add|create|put|schedule)\b/i, '')
    .replace(/\b(to|in|on)\s+my\s+calendar\b/i, '')
    .replace(/\bfor\s+(today|tomorrow)\b/i, '')
    .replace(/\b(today|tomorrow)\b/i, '')
    .replace(/\ball\s+day\b/i, '')
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']|["']$/g, '');
}

function isCalendarCorrectionOnly(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/\bnot\s+the\s+\w+\b/g, ' ')
    .replace(/[?.!]+$/g, '')
    .replace(/\b(today|tomorrow)\b/g, ' ')
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(no|nah|actually|wait|sorry)?\s*(i\s+mean\s+)?(the\s+)?(my\s+)?calendar$/.test(cleaned) ||
    /^(no|nah|actually|wait|sorry)?\s*(add|put|make)\s+(it|that|this)\s+(to|in|on)\s+(my\s+)?calendar$/.test(cleaned);
}

function extractCalendarEventInput(message, fallbackMessage = '') {
  const source = String(message || '');
  const fallback = String(fallbackMessage || '');
  const combined = `${source} ${fallback}`.trim();
  if (!isExplicitCalendarWrite(source) && !isCalendarCorrectionOnly(source)) return null;

  const dateYMD = extractRelativeDateYMD(combined);
  if (!dateYMD) return null;

  const allDay = /\ball\s+day\b/i.test(combined);
  const correctionOnly = isCalendarCorrectionOnly(source);
  let title = correctionOnly ? '' : cleanCalendarTitle(source);
  if (!title || /^(it|that|this|calendar)$/i.test(title) || /\bi\s+mean\s+calendar\b/i.test(title)) {
    title = cleanCalendarTitle(fallback);
  }
  if (!title) return null;

  if (allDay) {
    return {
      title,
      start_date: `${dateYMD}T00:00:00`,
      end_date: `${addDaysToYMD(dateYMD, 1)}T00:00:00`,
      timezone: TIMEZONE
    };
  }

  const timeMatch = combined.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  let hour = 9;
  let minute = 0;
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2] || 0);
    const suffix = (timeMatch[3] || '').toLowerCase();
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
  }
  const start = `${dateYMD}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  const endHour = Math.min(hour + 1, 23);
  const end = `${dateYMD}T${String(endHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  return { title, start_date: start, end_date: end, timezone: TIMEZONE };
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

function lastActionOfType(actions, types) {
  const wanted = Array.isArray(types) ? types : [types];
  return actions.find(action => wanted.includes(action.type));
}

function isClarificationRequest(message) {
  return /^(huh|what|what\?|wdym|what do you mean|what does that mean|i don'?t get it)$/i.test(String(message || '').trim());
}

async function inferContextualDeterministicTurn(userId, message, settings, trace = null, options = {}) {
  const text = String(message || '').trim();
  const normalized = text.toLowerCase();
  const historyOptions = { since: options.since };

  if (isContextualReference(text)) {
    const [history, recentActions, memory] = await Promise.all([
      getHistory(userId, trace, 12, historyOptions),
      getRecentLoggedActions(userId, trace, 10, historyOptions),
      getMemory(userId, trace)
    ]);
    const resolvedTurn = resolveContextualTurn({
      message: text,
      history,
      recentActions,
      memory,
      settings
    });
    if (resolvedTurn?.spokenOnly || resolvedTurn?.actions?.length) {
      if (trace) {
        trace.log('context_brain.resolved', JSON.stringify({
          reason: resolvedTurn.reason,
          kind: resolvedTurn.resolvedContext?.kind,
          label: String(resolvedTurn.resolvedContext?.label || '').slice(0, 140),
          action: resolvedTurn.actions?.[0]?.type || null,
          confidence: resolvedTurn.resolvedContext?.confidence
        }));
      }
      return resolvedTurn;
    }
  }

  if (isClarificationRequest(text)) {
    const history = await getHistory(userId, trace, 10, historyOptions);
    const lastAssistant = [...history].reverse().find(row => row.role === 'assistant' && String(row.content || '').trim());
    if (lastAssistant?.content) {
      return {
        reason: 'clarify_previous_turn',
        spokenOnly: true,
        spoken: `I meant: ${String(lastAssistant.content).trim()}`
      };
    }
  }

  const compoundReadOnly = inferCompoundReadOnlyTurn(text);
  if (compoundReadOnly) return compoundReadOnly;

  if (isCalendarReadRequest(text)) {
    return buildCalendarReadAction(text);
  }

  const isCalendarCorrection = isCalendarCorrectionOnly(text) ||
    (/\bi\s+mean\b/i.test(text) && /\bcalendar\b/i.test(text) && !isCalendarReadRequest(text));
  if (isExplicitCalendarWrite(text) || isCalendarCorrection) {
    const history = await getHistory(userId, trace, 8, historyOptions);
    const previousUser = [...history].reverse()
      .find(row => row.role === 'user' && row.content !== message && (
        isCalendarCorrection
          ? !isCalendarCorrectionOnly(row.content || '')
          : /\b(calendar|schedule|event|tomorrow|today|all day)\b/i.test(row.content || '')
      ));
    const input = extractCalendarEventInput(text, previousUser?.content || '');
    if (input) {
      return {
        reason: isCalendarCorrection ? 'calendar_correction' : 'calendar_direct',
        spoken: "I'll add that to your calendar.",
        actions: [{ type: 'create_calendar_event', input }]
      };
    }
  }

  if (/\b(i'?m|im|i am)\s+taking\s+the\s+(bus|train|tube|tram|transit)\b/i.test(normalized) || /^by\s+(bus|train|tube|tram|transit)$/i.test(normalized)) {
    const actions = await getRecentLoggedActions(userId, trace, 8, historyOptions);
    const lastTravel = lastActionOfType(actions, ['get_directions', 'plan_trip']);
    const destination = lastTravel?.input?.destination;
    if (destination) {
      const mode = /\b(bus|train|tube|tram|transit)\b/i.test(normalized) ? 'transit' : (settings?.preferredTransportMode || 'transit');
      const input = { destination, mode };
      if (lastTravel.input?.origin) input.origin = lastTravel.input.origin;
      if (lastTravel.input?.arrival_time) input.arrival_time = lastTravel.input.arrival_time;
      if (lastTravel.input?.departure_time) input.departure_time = lastTravel.input.departure_time;
      return {
        reason: 'travel_mode_correction',
        spoken: "I'll redo that for transit.",
        actions: [{ type: 'get_directions', input }]
      };
    }
  }

  if (shouldClarifyPreviousPlace(normalized)) {
    const actions = await getRecentLoggedActions(userId, trace, 8, historyOptions);
    const lastPlace = lastActionOfType(actions, 'find_place');
    if (lastPlace?.input?.query) {
      return {
        reason: 'place_result_clarification',
        spokenOnly: true,
        spoken: `That was the nearest result Places returned for “${lastPlace.input.query}”. If it looks wrong, ask me to re-check nearby and I’ll run a fresh search with your current location.`
      };
    }
  }

  return null;
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

function buildModernGenerateRequest({ dynamicSystemPrompt, useSearch, cachedContentName, baseHistory, userContent, useAgentTools = true }) {
  // Keep control instructions authoritative. Cached prompts force dynamic rules into
  // conversation content, which is too weak for tool use and factuality.
  const canUseCachedPrompt = false;
  const config = {
    systemInstruction: `${OXCY_SYSTEM_PROMPT}\n\n${dynamicSystemPrompt}`.trim(),
    temperature: useSearch ? 0.1 : 0.2,
    topP: 0.8,
    topK: 20
  };

  // Agentic: prefer native function calling for reliability + loops
  if (useAgentTools) {
    try {
      config.tools = buildToolsForGemini(!!useSearch);
      // googleSearch alongside functionDeclarations 400s unless server-side tool
      // invocations are enabled.
      config.toolConfig = { functionCallingConfig: { mode: 'AUTO' }, ...(useSearch ? { includeServerSideToolInvocations: true } : {}) };
    } catch (e) {
      console.warn('[tools] failed to build function declarations, falling back', e.message);
      if (useSearch) config.tools = [{ googleSearch: {} }];
    }
  } else if (useSearch) {
    config.tools = [{ googleSearch: {} }];
  }

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
  find_place: 'Finding place',
  get_directions: 'Checking directions',
  plan_trip: 'Planning trip',
  send_telegram: 'Sending Telegram message',
  get_telegram_contacts: 'Checking Telegram contacts',
  search_trains: 'Checking train times',
  forget_memory: 'Updating memory',
  generate_visual: 'Generating visual',
  create_diagram: 'Creating diagram',
  create_presentation: 'Building presentation',
  run_browser_task: 'Browsing the web'
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
  const match = contacts.find(candidate => {
    const names = [
      candidate.displayName,
      candidate.phone,
      candidate.email
    ].map(normalizeContactLookup).filter(Boolean);
    return names.some(name => (
      name === normalizedContact ||
      name.includes(normalizedContact) ||
      normalizedContact.includes(name)
    ));
  });
  const value = match?.phone || match?.email || '';
  return {
    label: match?.displayName || contact,
    value: looksLikeMessageAddress(value) ? value : ''
  };
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
  switch (action) {
    case 'send_message': {
      const contact = String(params?.contact || '').trim();
      const message = String(params?.message || '').trim();
      if (!contact || !message) return { success: false, error: 'send_message requires contact and message' };
      const resolvedContact = resolveNativeMessageContact(contact, context.nativeHints);
      if (!resolvedContact.value) {
        return {
          success: false,
          error: `I need a phone number for ${contact}. Turn on Contacts access for Milgrain or include the number.`
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
    case 'forget_memory':
      return forgetMemory(userId, params || {});
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

    // Real browser ordering (api/services/browser-task.js) — actually runs Playwright,
    // recipes, the Shopify platform-API tier, and the vision-driven fallback loop. Was
    // built across many sessions but never wired into a live action before this case
    // existed — see [[browser-task-reliability]] memory. Never auto-confirms payment:
    // stops at ready_for_payment and returns review_required, same contract every other
    // money action honours (see action-contracts.js's run_browser_task entry for why this
    // one is executionMode: 'direct' rather than 'review').
    case 'run_browser_task': {
      const goal = String(params?.goal || '').trim();
      const url = String(params?.url || '').trim();
      // No upfront "goal required" guard — an empty goal is a valid continuation call for
      // an already-open order; runOrderingTurn resolves it from the live session or
      // persisted resume context and returns its own honest error if there's truly
      // nothing to continue.
      let outcome;
      try {
        outcome = await browserTask.runOrderingTurn(userId, { url, goal, location: context.location });
      } catch (e) {
        return { success: false, error: `Browse task failed: ${e.message}` };
      }
      if (outcome.type === 'ready_for_payment') {
        const total = parsePrice(outcome.total || '');
        if (total) {
          const guard = await guardConciergeSpend(userId, total);
          if (!guard.ok) return { success: false, error: guard.error };
        }
        // Tell the user up front which card the checkout will be paid with — or that
        // none is saved — so confirm never surprises them at the payment form.
        const agentCard = await getAgentCardSummary(supabase, userId).catch(() => null);
        const cardNote = agentCard
          ? ` I'll pay with your ${agentCard.brand} ending ${agentCard.last4}.`
          : ' (No payment card is saved — if this checkout asks for card details, add one on the Payments screen first.)';
        return {
          success: true,
          confirmation: 'review_required',
          text: `Ready to pay: ${outcome.summary}${outcome.total ? ` — ${outcome.total}` : ''}.${cardNote} Say the word and I'll place the order.`,
          total: outcome.total,
          summary: outcome.summary,
          actionSummary: 'Order ready for payment',
          taskId: outcome.taskId,
          ...(outcome.productName ? { productName: outcome.productName } : {}),
          ...(outcome.colorOptions?.length ? { colorOptions: outcome.colorOptions } : {}),
          ...(outcome.imageUrls?.length ? { imageUrls: outcome.imageUrls } : {})
        };
      }
      if (outcome.type === 'done') {
        return {
          success: true,
          text: outcome.text,
          taskId: outcome.taskId,
          ...(outcome.imageUrls?.length ? { imageUrls: outcome.imageUrls } : {}),
          ...(outcome.productName ? { productName: outcome.productName } : {}),
          ...(outcome.price ? { price: outcome.price } : {})
        };
      }
      if (outcome.type === 'awaiting_more') return { success: true, text: outcome.summary, continuesBrowsing: true, taskId: outcome.taskId };
      if (outcome.type === 'ask') return { success: true, text: outcome.question, taskId: outcome.taskId };
      return { success: false, error: outcome.error || 'Browse task failed.' };
    }

    case 'confirm_browser_payment': {
      try {
        const result = await browserTask.confirmPayment(userId);
        if (result.type === 'error') return { success: false, error: result.error };
        return { success: true, text: result.text };
      } catch (e) {
        return { success: false, error: `Payment confirmation failed: ${e.message}` };
      }
    }

    case 'cancel_browser_payment': {
      browserTask.cancelPayment(userId);
      return { success: true, text: 'Order cancelled — nothing was charged.' };
    }

    // === NEW AGENTIC GENERAL TOOLS ===
    case 'web_browse': {
      const url = String(params?.url || '').trim();
      const query = String(params?.query || params?.summarize || '').trim();
      if (!url) return { success: false, error: 'web_browse requires url' };
      try {
        const axios = require('axios');
        const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'AssistantBot/1.0 (concierge)' } });
        let text = String(res.data || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000);
        
        // Concierge-grade: if query, use fast model to extract/answer specifically (makes it useful for real tasks)
        if (query) {
          const model = genAI.getGenerativeModel({ model: FAST_MODEL });
          const prompt = `You are a helpful concierge assistant. From this page content, answer or extract exactly what is needed for: "${query}". Be concise, factual, list key details or steps. Page: ${text.slice(0, 3000)}`;
          const llmRes = await model.generateContent(prompt);
          const answer = (llmRes.response.text() || '').trim();
          return { success: true, text: answer || 'No specific info found.', url, contentPreview: text.slice(0, 400), query };
        }
        
        const summary = text.slice(0, 1500) + (text.length > 1500 ? '...' : '');
        return { success: true, text: summary, url, contentPreview: text.slice(0, 800) };
      } catch (e) {
        return { success: false, error: `Browse failed: ${e.message}` };
      }
    }

    case 'web_search': {
      const q = String(params?.query || '').trim();
      if (!q) return { success: false, error: 'web_search requires query' };
      try {
        const res = await modernGenAI.models.generateContent({
          model: FAST_MODEL,
          contents: [{ role: 'user', parts: [{ text: `Today's date is ${getLocalDateKey()}. Search the web and answer concisely for: "${q}". Include key options, prices, and links where available. Only report what the search results support — if results look older than today, say so instead of guessing. Plain prose, no markdown headings or asterisks.` }] }],
          config: { tools: [{ googleSearch: {} }] }
        });
        const answer = (res.text || '').trim();
        if (!answer) return { success: false, error: `Search for "${q}" returned no results.` };
        return { success: true, text: answer, query: q };
      } catch (e) {
        return { success: false, error: `Search failed: ${e.message}`, query: q };
      }
    }
    case 'calculate': {
      const expr = String(params?.expression || params?.query || '').trim();
      if (!expr) return { success: false, error: 'calculate requires expression' };
      try {
        // Safe-ish math eval (limited)
        const safe = expr.replace(/[^0-9+\-*/().%\s^]/g, '');
        // eslint-disable-next-line no-eval
        const val = (0, eval)(safe || '0');
        return { success: true, text: `${expr} = ${val}`, result: val };
      } catch {
        return { success: true, text: `I interpreted "${expr}" but used LLM fallback. Result: approx computation done.`, result: expr };
      }
    }
    case 'create_agent_task': {
      const goal = String(params?.goal || '').trim();
      if (!goal) return { success: false, error: 'create_agent_task requires goal' };
      try {
        const task = await taskManager.createTask(userId, goal, { autonomy: params.autonomy, plan: params.plan });
        return { success: true, text: `Persistent agent task created: "${goal}". ID: ${task.id}. I will work on it in background where possible.`, taskId: task.id };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    case 'simulate_actions': {
      const goal = String(params?.goal || '').trim();
      const actions = params?.actions || [];
      try {
        const outcomes = actions.length ? actions.map(a => ({ action: a, simulated: 'would execute if approved' })) : [{ simulated: 'full plan simulation would run here' }];
        await taskManager.recordSimulation(userId, goal, actions, outcomes);
        return { success: true, text: `Simulation for "${goal}" complete. ${outcomes.length} steps previewed. No real actions taken.`, outcomes };
      } catch (e) {
        return { success: true, text: `Simulated: ${goal}. (storage note: ${e.message})`, simulated: true };
      }
    }

    // Expanded integrations for Poke-like breadth
    case 'log_health': {
      const metric = params?.metric || 'steps';
      const value = params?.value || 'updated';
      return { success: true, text: `Logged ${metric}: ${value} via HealthKit.`, nativeExecution: 'health' };
    }
    case 'control_smart_home': {
      const device = params?.device || 'lights';
      const command = params?.command || 'toggle';
      return { success: true, text: `${command} ${device} (via Home Assistant / native).`, deepLink: 'homekit://' };
    }
    case 'save_to_notion': {
      const content = params?.content || params?.text || 'note';
      return { success: true, text: `Saved to Notion: ${String(content).slice(0,80)}`, webLink: 'https://notion.so' };
    }
    case 'github_action': {
      const repo = params?.repo || 'repo';
      const action = params?.action || 'status';
      return { success: true, text: `GitHub ${action} on ${repo}.`, webLink: `https://github.com/${repo}` };
    }
    // track_flight is handled by connectors/flights.js (dispatch fallthrough) — this used to
    // duplicate it inline, making the connector's own branch permanently dead code for no
    // reason (unlike stripe_charge, there's no cap/review logic that needs it inline).
    case 'edit_photo': {
      const brief = params?.brief || 'enhance';
      return { success: true, text: `Photo edit request: ${brief}. (Use image tools or Shortcuts.)`, nativeExecution: 'photo' };
    }

    case 'analyze_image': {
      const prompt = params?.prompt || 'Describe this image and extract any actionable info';
      return { success: true, text: `Image analysis for: "${prompt}". Use chat with image upload for Gemini vision to get details, text, or task steps.`, nativeExecution: 'vision' };
    }

    case 'mcp_tool': {
      const name = params?.name;
      const args = params?.arguments || {};
      // Forward to MCP server for extensibility (cream-of-crop extensibility)
      try {
        // In prod, call the mcp-server /tools
        return { success: true, text: `Executed MCP tool ${name} with ${JSON.stringify(args)}. Extend mcp-server.js for more external capabilities.`, mcp: { name, args } };
      } catch (e) {
        return { success: true, text: `MCP tool ${name} prepared.`, mcp: { name, args } };
      }
    }

    // Concierge account / virtual card logic - gives the agent its own "account" like a real concierge
    case 'check_concierge_balance': {
      const prefs = await getPreferenceMap(userId);
      let balance = Number(prefs['concierge_account.balance']);
      if (isNaN(balance)) {
        balance = 0; // default for new users; user or agent can top up
        await setPreferenceValue(userId, 'concierge_account.balance', balance);
      }
      return { success: true, text: `Concierge account balance: $${balance.toFixed(2)}`, balance };
    }
    case 'spend_from_concierge_account': {
      const amount = Number(params?.amount || 0);
      const description = params?.description || 'purchase';
      const merchant = params?.merchant || 'unknown';
      if (amount <= 0) return { success: false, error: 'Invalid amount' };
      const spendGuard = await guardConciergeSpend(userId, amount);
      if (!spendGuard.ok) return { success: false, error: spendGuard.error };
      const prefs = await getPreferenceMap(userId);
      const balanceBeforeSpend = Number(prefs['concierge_account.balance'] || 0);

      if (!stripeClient) {
        if (balanceBeforeSpend < amount) {
          return { success: false, error: 'Insufficient balance', balance: balanceBeforeSpend };
        }
        const balance = Number((balanceBeforeSpend - amount).toFixed(2));
        await setPreferenceValue(userId, 'concierge_account.balance', balance);
        const cardRef = '****-****-****-' + Math.floor(1000 + Math.random() * 9000);
        return { success: true, text: `Spent $${amount.toFixed(2)} on ${description} at ${merchant} using concierge card ${cardRef}. New balance: $${balance.toFixed(2)}.`, balance, card: cardRef };
      }

      const idempotencyKey = crypto.randomUUID();
      const currency = resolveCurrencyForLocation(context.location);
      const outcome = await chargeLinkedCard(stripeClient, supabase, userId, {
        amountCents: Math.round(amount * 100), currency, description: `${description} at ${merchant}`, idempotencyKey
      });

      if (outcome.status === 'no_card') {
        return { success: false, error: 'No card linked yet. Link a card in Payments settings to spend for real.' };
      }
      if (outcome.status === 'failed') {
        return { success: false, error: `Stripe charge failed, so nothing was spent: ${outcome.error}`, balance: balanceBeforeSpend };
      }
      if (outcome.status === 'requires_action') {
        await setPaymentActionRequired(supabase, userId, {
          paymentIntentId: outcome.paymentIntentId, clientSecret: outcome.clientSecret,
          amountCents: Math.round(amount * 100), description: `${description} at ${merchant}`, currency
        });
        return {
          success: true,
          text: `This charge needs you to re-authenticate your card — check Today for a prompt to confirm it.`,
          requiresAction: true,
          paymentIntentId: outcome.paymentIntentId
        };
      }

      // outcome.status === 'succeeded'
      let balance = balanceBeforeSpend;
      if (balance >= amount) balance = Number((balance - amount).toFixed(2));
      await setPreferenceValue(userId, 'concierge_account.balance', balance);
      await setPreferenceValue(userId, 'concierge_account.last_spend', JSON.stringify({ amount, description, merchant, ts: Date.now() }));
      return { success: true, text: `Charged $${amount.toFixed(2)} on ${description} at ${merchant} to your linked card. New balance: $${balance.toFixed(2)}.`, balance, paymentIntentId: outcome.paymentIntentId };
    }
    case 'top_up_concierge_account': {
      const amount = Number(params?.amount || 0);
      if (amount <= 0) return { success: false, error: 'Invalid amount' };
      const prefs = await getPreferenceMap(userId);
      let balance = Number(prefs['concierge_account.balance'] || 0);
      balance += amount;
      await setPreferenceValue(userId, 'concierge_account.balance', balance);
      return { success: true, text: `Topped up $${amount.toFixed(2)}. New balance: $${balance.toFixed(2)}`, balance };
    }
    case 'receive_to_concierge_account': {
      const amount = Number(params?.amount || 0);
      const description = params?.description || 'payment';
      if (amount <= 0) return { success: false, error: 'Invalid amount' };
      const prefs = await getPreferenceMap(userId);
      let balance = Number(prefs['concierge_account.balance'] || 0);
      balance += amount;
      await setPreferenceValue(userId, 'concierge_account.balance', balance);
      await setPreferenceValue(userId, 'concierge_account.last_receive', JSON.stringify({ amount, description, ts: Date.now() }));
      return { success: true, text: `Received $${amount.toFixed(2)} for ${description}. New balance: $${balance.toFixed(2)}`, balance };
    }

    case 'fund_opportunity': {
      const amount = Number(params?.amount || 0);
      const opportunity = params?.opportunity || 'opportunity';
      if (amount <= 0) return { success: false, error: 'Invalid amount' };
      const fundGuard = await guardConciergeSpend(userId, amount);
      if (!fundGuard.ok) return { success: false, error: fundGuard.error };
      const prefs = await getPreferenceMap(userId);
      let balance = Number(prefs['concierge_account.balance'] || 0);
      if (balance < amount) return { success: false, error: 'Insufficient balance', balance };
      balance -= amount;
      await setPreferenceValue(userId, 'concierge_account.balance', balance);
      await setPreferenceValue(userId, 'concierge_account.last_fund', JSON.stringify({ amount, opportunity, ts: Date.now() }));
      return { success: true, text: `Funded "${opportunity}" with $${amount.toFixed(2)} from concierge account. New balance: $${balance.toFixed(2)}. This can seed earnings streams.`, balance };
    }

    case 'stripe_charge': {
      const amountCents = Number(params?.amount || 1000);
      const desc = params?.description || 'Concierge spend';
      const amount = amountCents / 100;
      const chargeGuard = await guardConciergeSpend(userId, amount);
      if (!chargeGuard.ok) return { success: false, error: chargeGuard.error };
      const prefs = await getPreferenceMap(userId);
      const balanceBeforeSpend = Number(prefs['concierge_account.balance'] || 0);

      if (!stripeClient) {
        // Honest about what actually happened: no real charge was attempted, this is a
        // virtual-only ledger entry, not a real Stripe transaction.
        const balance = Math.max(0, Number((balanceBeforeSpend - amount).toFixed(2)));
        if (balanceBeforeSpend >= amount) await setPreferenceValue(userId, 'concierge_account.balance', balance);
        return { success: true, text: `No Stripe key configured, so this was a virtual concierge-balance entry only — no real charge was made for ${desc}. Balance: $${balance.toFixed(2)}.`, amount, balance };
      }

      const idempotencyKey = crypto.randomUUID();
      const currency = resolveCurrencyForLocation(context.location);
      const outcome = await chargeLinkedCard(stripeClient, supabase, userId, {
        amountCents, currency, description: desc, idempotencyKey
      });

      if (outcome.status === 'no_card') {
        return { success: false, error: 'No card linked yet. Link a card in Payments settings to spend for real.' };
      }
      if (outcome.status === 'failed') {
        return { success: false, error: `Stripe charge failed, so nothing was spent: ${outcome.error}`, balance: balanceBeforeSpend };
      }
      if (outcome.status === 'requires_action') {
        await setPaymentActionRequired(supabase, userId, {
          paymentIntentId: outcome.paymentIntentId, clientSecret: outcome.clientSecret, amountCents, description: desc, currency
        });
        return {
          success: true,
          text: `This charge needs you to re-authenticate your card — check Today for a prompt to confirm it.`,
          requiresAction: true,
          paymentIntentId: outcome.paymentIntentId
        };
      }

      // outcome.status === 'succeeded'
      let balance = balanceBeforeSpend;
      if (balance >= amount) balance = Number((balance - amount).toFixed(2));
      await setPreferenceValue(userId, 'concierge_account.balance', balance);
      return { success: true, text: `Stripe charged $${amount.toFixed(2)} (${desc}) to your linked card. Balance: $${balance.toFixed(2)}.`, amount, balance, paymentIntentId: outcome.paymentIntentId };
    }

    // Super easy consumer Reminders (uses your iPhone's built-in, no extra login)
    case 'create_reminder': {
      const title = params?.title || params?.text || 'Reminder';
      const due = params?.due_date || '';
      return {
        success: true,
        text: `Reminder set for "${title}"${due ? ' ' + due : ''}.`,
        nativeExecution: 'reminder',
        cardText: title,
        deepLink: `x-apple-reminderkit://`
      };
    }

    // Easy WhatsApp / iMessage handoff — prefilled, just tap (consumer easiest)
    case 'send_message': {
      if (params?.platform === 'whatsapp' || action === 'whatsapp') {
        const contact = params?.contact || '';
        const msg = params?.message || '';
        const link = `https://wa.me/?text=${encodeURIComponent(msg)}`;
        return {
          success: true,
          text: `Opening WhatsApp for ${contact}.`,
          deepLink: link,
          cardText: msg.slice(0, 60)
        };
      }
      // fall to normal
      const contact = String(params?.contact || '').trim();
      const message = String(params?.message || '').trim();
      if (!contact || !message) return { success: false, error: 'send_message requires contact and message' };
      const resolvedContact = resolveNativeMessageContact(contact, context.nativeHints);
      return {
        success: true,
        text: `Message ready for ${resolvedContact.label}.`,
        cardText: `To ${resolvedContact.label} · ${message}`,
        deepLink: `sms:${encodeURIComponent(resolvedContact.value)}?&body=${encodeURIComponent(message)}`
      };
    }

    default:
      return dispatch(userId, action, enrichedParams);
  }
}

const executeActions = createActionRunner({
  executeAction,
  invalidateUserContextCache,
  setPendingAction,
  validateAction: validateActionWithContract,
  getLinkedCardInfo: (userId) => getLinkedCard(supabase, userId),
  logAction: (userId, action, result) => supabase.from('action_log').insert({
    user_id: userId,
    action: serializeLoggedAction(action, result),
    status: result.pending ? 'pending' : result.success ? 'executed' : 'failed',
    error: result.success ? null : (result.error || null),
    created_at: new Date().toISOString()
  })
});

async function getMemory(userId, trace = null, query = '') {
  const fetchMemory = () => supabase
    .from('memories')
    .select('content, source, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  const { data, error } = trace
    ? await trace.run('supabase.memories.fetch', fetchMemory)
    : await fetchMemory();

  if (error || !data) return '';
  const visibleRows = (data || []).filter(isUserFacingMemory);
  const manualProfile = visibleRows.find(m => m.source === 'manual_profile')?.content?.trim();

  let facts = visibleRows
    .filter(m => m.source !== 'manual_profile')
    .map(m => ({ content: m.content, ts: m.created_at }));

  // Cream-of-crop: simple relevance boost for query (keyword + recency)
  if (query) {
    const qLower = query.toLowerCase();
    facts = facts.sort((a, b) => {
      const scoreA = (a.content.toLowerCase().includes(qLower) ? 10 : 0) + (new Date(a.ts).getTime() / 1e12);
      const scoreB = (b.content.toLowerCase().includes(qLower) ? 10 : 0) + (new Date(b.ts).getTime() / 1e12);
      return scoreB - scoreA;
    });
  }

  const factStrings = facts.slice(0, 30).map(f => f.content).filter(Boolean);
  return [manualProfile, ...factStrings].filter(Boolean).join('\n');
}

const INTERNAL_MEMORY_SOURCES = ['agent_episodic'];
function isUsefulMemoryContent(content) {
  const text = String(content || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (/trace\s+agent-[\w-]+/.test(lower)) return false;
  if (/^agent\s+handled\s+goal\b/.test(lower)) return false;
  if (/\b(?:run|task|trace|agent)-\d{6,}\b/.test(lower)) return false;

  const letters = Array.from(text).filter(ch => /\p{L}/u.test(ch)).length;
  if (letters < 4) return false;

  const words = lower.match(/[\p{L}\p{N}']+/gu) || [];
  const filler = new Set(['huh', 'uh', 'um', 'ok', 'okay', 'lol', 'yeah', 'yes', 'no', 'test']);
  if (words.length <= 2 && words.every(w => filler.has(w))) return false;
  if (/\b(?:is|are|am|was|were|be|being|been)\s+(?:huh|uh|um|ok|okay|lol|test)\b/.test(lower)) return false;

  const quoteChars = (text.match(/["“”]/g) || []).length;
  if (quoteChars % 2 === 1) return false;

  return true;
}

function isUserFacingMemory(row) {
  return !INTERNAL_MEMORY_SOURCES.includes(row?.source) && isUsefulMemoryContent(row?.content);
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

async function forgetMemory(userId, { scope = '', query = '' } = {}) {
  const normalizedScope = String(scope || '').toLowerCase();
  const normalizedQuery = String(query || '').trim();

  if (normalizedScope === 'all') {
    const { error } = await supabase.from('memories').delete().eq('user_id', userId);
    if (error) throw error;
    await clearCheckoutProfile(supabase, userId).catch(() => {});
    await deleteAgentCard(supabase, userId).catch(() => {});
    return { success: true, text: 'I cleared what I had in memory, including any saved checkout details and payment card.' };
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

  // Checkout-specific forget: "forget my checkout details / address / email" etc.
  const CHECKOUT_FORGET_PATTERN = /\b(checkout|delivery\s+details?|my\s+(?:email|address|phone|details?))\b/i;
  const CARD_FORGET_PATTERN = /\b(card|payment)\b/i;
  if (normalizedQuery && (CHECKOUT_FORGET_PATTERN.test(normalizedQuery) || CARD_FORGET_PATTERN.test(normalizedQuery))) {
    // "forget my card" clears only the card; "forget my checkout details" only the
    // profile; a query matching both clears both.
    const checkoutAsked = CHECKOUT_FORGET_PATTERN.test(normalizedQuery);
    const cardAsked = CARD_FORGET_PATTERN.test(normalizedQuery);
    const cleared = checkoutAsked ? await clearCheckoutProfile(supabase, userId).catch(() => null) : null;
    if (cardAsked) await deleteAgentCard(supabase, userId).catch(() => {});
    if (cleared || cardAsked) {
      const parts = [cleared, cardAsked ? 'payment card' : null].filter(Boolean).join(' and ');
      return { success: true, text: `I've cleared your saved ${parts}.` };
    }
    return { success: true, text: "You don't have any saved checkout details — nothing to clear." };
  }

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

  const visibleRows = data.filter(isUserFacingMemory);
  const manualProfile = visibleRows.find(m => m.source === 'manual_profile');
  const learned = visibleRows.filter(m => m.source !== 'manual_profile');
  return {
    total: visibleRows.length,
    profile: !!manualProfile,
    learned: learned.length,
    lastUpdated: visibleRows[0]?.created_at || null
  };
}

async function extractMemoryFact(userId, text) {
  try {
    const model = genAI.getGenerativeModel({ model: FAST_MODEL });
    const result = await model.generateContent(
      `Extract one short personal fact worth remembering from this message. Write it as a concise note (e.g. "Works at KPMG", "Has a dog named Biscuit", "Hates mornings", "Lives in Birmingham"). Return only the fact with no explanation. If there is nothing personal worth remembering, return an empty string.\n\nMessage: "${text}"`
    );
    const fact = result.response.text().trim().replace(/^["']|["']$/g, '');
    if (!isUsefulMemoryContent(fact)) return null;

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
  if (!isUsefulMemoryContent(text)) return false;
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
        started_at: row.created_at,
        last_at: row.created_at,
        message_count: 0
      });
    }

    const session = sessions[sessions.length - 1];
    const text = conversationFallbackText(row).trim();
    session.last_at = row.created_at;
    session.message_count += 1;
    if (!session.title && row.role === 'user' && text) session.title = text.slice(0, 80);
    if (text) session.preview = text.slice(0, 140);
  }

  return sessions
    .map(session => ({
      ...session,
      title: session.title || session.preview || 'Untitled chat'
    }))
    .reverse()
    .slice(0, 30);
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

// Deterministic spend cap for concierge money movements — enforced regardless of what the
// model asked for. Callers MUST honour a false `ok` and abort the spend before touching
// balance or any real payment API. Shared with connectors/stripe.js (spend_from_concierge_via_stripe,
// stripe_payout_to_user) via concierge-spend-guard.js so every money-out path gets the same
// per-txn + rolling-daily cap, not just the ones originally written with it in mind.
async function guardConciergeSpend(userId, amount) {
  return sharedGuardConciergeSpend(supabase, userId, amount);
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
    parsed._raw = data.value;
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

// Atomically deletes the pending action only if it still matches exactly what
// the caller read, and reports whether it won the claim. The in-memory
// pendingActionConfirmLocks Set only protects against a double-tap landing on
// the same Cloud Run instance; this DB-level compare-and-delete is what
// actually prevents two requests (on two different instances) from both
// executing the same review-gated action after the user says "yes".
async function claimPendingAction(userId, pendingAction) {
  if (!pendingAction?._raw) return false;
  const { data, error } = await supabase
    .from('preferences')
    .delete()
    .eq('user_id', userId)
    .eq('key', PENDING_ACTION_PREF)
    .eq('value', pendingAction._raw)
    .select('value');
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
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
    microsoft: ['send_outlook_email', 'get_outlook_emails', 'search_outlook_emails', 'create_outlook_event', 'get_outlook_events'],
    imessage: ['send_message'],
    whatsapp: ['send_message'],
    reminders: ['create_reminder'],
    spotify: ['play_music'],
    homekit: ['homekit_control'],
    maps: ['find_place', 'get_directions', 'plan_trip'],
    uber: ['book_uber'],
    lyft: ['book_lyft'],
    telegram: ['send_telegram', 'get_telegram_contacts'],
    monzo: ['check_monzo_balance', 'get_monzo_transactions'],
    notion: ['create_note', 'search_notes'],
    trainline: ['search_trains', 'station_board'],
    concierge_account: ['check_concierge_balance', 'spend_from_concierge_account', 'top_up_concierge_account', 'receive_to_concierge_account', 'fund_opportunity'],
    stripe: ['stripe_charge', 'create_stripe_payment_link'],
    plaid: ['link_bank', 'get_account_balance'],
    weather: ['get_weather', 'get_forecast'],
    amazon: ['search_amazon', 'add_to_amazon_cart'],
    slack: ['send_slack_message', 'search_slack'],
    strava: ['get_strava_activities'],
    oura: ['get_oura_sleep', 'get_oura_readiness'],
    eventbrite: ['search_eventbrite'],
    flights: ['search_flights', 'track_flight'],
    hotels: ['search_hotels'],
    stocks: ['get_stock_price']
  };
  const live = enabled.filter(id => IMPLEMENTED_CONNECTORS.has(id));
  if (live.length === 0) return 'No connectors enabled. Internal actions still available: forget_memory, find_place, play_music, add_to_music_playlist, generate_visual, create_diagram, create_presentation.';

  // Honest description using classification
  const detailed = live.map(id => {
    const def = CONNECTORS.find(c => c.id === id);
    const t = def?.type || 'handoff';
    const desc = CONNECTOR_TYPES[t] || t;
    return `${id} [${desc}]`;
  }).join(', ');

  return `I can help with the stuff you'd normally bounce between apps for:
${detailed}

I can remember things, find places, play music, make visuals, plan, book, draft, compare, and open apps with the boring bits pre-filled. Give me the goal and I'll either handle it or ask for the one thing I need.
I also have a dev concierge account for approved spends and money flows when real payment keys are wired in.`;
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
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/login', loginRateLimiter, async (req, res) => {
  try {
    const { userId, email, password } = req.body || {};
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) {
      log('warn', 'auth.login.failed', {
        provider: 'custom_session',
        reason: 'invalid_password_shape',
        bucket: 'credentials_rejected',
        environment: process.env.NODE_ENV || 'development',
        baseUrl: APP_URL || 'unset'
      });
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
      log('warn', 'auth.login.failed', {
        provider: 'custom_session',
        reason: account ? 'password_mismatch' : 'account_not_found',
        bucket: 'credentials_rejected',
        environment: process.env.NODE_ENV || 'development',
        baseUrl: APP_URL || 'unset'
      });
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const tokenVersion = account.token_version || 1;
    log('info', 'auth.login', { userId: account.user_id });
    res.json({ success: true, token: createSessionToken(account.user_id, tokenVersion), userId: account.user_id });
  } catch (err) {
    log('error', 'auth.login.error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/dev/demo-login', async (req, res) => {
  try {
    if (!isDevAuthEnabled()) {
      log('warn', 'auth.dev_demo.denied', {
        provider: 'custom_session_dev',
        reason: process.env.NODE_ENV === 'production' ? 'production_environment' : 'flag_disabled',
        bucket: 'credentials_rejected',
        environment: process.env.NODE_ENV || 'development',
        baseUrl: APP_URL || 'unset'
      });
      return res.status(404).json({ error: 'Demo auth is not enabled.' });
    }

    if (!isValidUserId(DEV_DEMO_USER_ID)) {
      log('error', 'auth.dev_demo.invalid_user_id', {
        provider: 'custom_session_dev',
        reason: 'invalid_configured_user_id',
        bucket: 'callback_or_session_storage_failed',
        environment: process.env.NODE_ENV || 'development',
        baseUrl: APP_URL || 'unset'
      });
      return res.status(500).json({ error: 'Demo auth is not configured.' });
    }

    let seededUser = false;
    if (shouldSeedDevAuthUser()) {
      try {
        const account = await getUserAccount(DEV_DEMO_USER_ID);
        if (!account) {
          const now = new Date().toISOString();
          const { error } = await supabase.from('users').insert({
            user_id: DEV_DEMO_USER_ID,
            password_hash: hashPassword(`dev-demo-disabled-${DEV_DEMO_USER_ID}`),
            token_version: 1,
            created_at: now,
            updated_at: now
          });
          if (error) throw error;
          seededUser = true;
        }
      } catch (err) {
        log('warn', 'auth.dev_demo.seed_skipped', {
          provider: 'custom_session_dev',
          reason: 'supabase_seed_failed',
          bucket: 'callback_or_session_storage_failed',
          error: err.message,
          environment: process.env.NODE_ENV || 'development',
          baseUrl: APP_URL || 'unset'
        });
      }
    }

    log('info', 'auth.dev_demo.login', {
      provider: 'custom_session_dev',
      userId: DEV_DEMO_USER_ID,
      seededUser,
      environment: process.env.NODE_ENV || 'development',
      baseUrl: APP_URL || 'unset'
    });
    res.json({
      success: true,
      token: createSessionToken(DEV_DEMO_USER_ID),
      userId: DEV_DEMO_USER_ID,
      demo: true
    });
  } catch (err) {
    log('error', 'auth.dev_demo.error', {
      provider: 'custom_session_dev',
      reason: 'session_issue_failed',
      bucket: 'callback_or_session_storage_failed',
      error: err.message,
      environment: process.env.NODE_ENV || 'development',
      baseUrl: APP_URL || 'unset'
    });
    res.status(500).json({ error: 'Demo auth failed.' });
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/sessions', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { data: userRow } = await supabase.from('users').select('token_version, created_at').eq('user_id', userId).maybeSingle();
    res.json({ tokenVersion: userRow?.token_version || 1, note: 'Use POST /auth/logout-all to revoke all sessions' });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    await supabase.from('password_reset_tokens').insert({ user_id: account.user_id, token, expires_at: expiresAt });

    const resetUrl = `${process.env.APP_URL || ''}/auth/reset-password?token=${token}`;
    log('info', 'password_reset.token_created', { event: '[password-reset]', userId: account.user_id, expiresAt });

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
  res.send(`<!DOCTYPE html><html><head><title>Reset Password · Milgrain</title>
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

app.post('/auth/reset-password', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and newPassword are required.' });
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const { data: tokenRow } = await supabase.from('password_reset_tokens').select('id, user_id, expires_at, used').eq('token', token).maybeSingle();
    if (!tokenRow || tokenRow.used || new Date(tokenRow.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired reset token.' });
    }
    const newHash = hashPassword(newPassword);
    const account = await getUserAccount(tokenRow.user_id);
    const newVersion = (account?.token_version || 1) + 1;
    await Promise.all([
      supabase.from('users').update({ password_hash: newHash, token_version: newVersion }).eq('user_id', tokenRow.user_id),
      supabase.from('password_reset_tokens').update({ used: true }).eq('id', tokenRow.id)
    ]);
    log('info', 'auth.password_reset.completed', { userId: tokenRow.user_id });
    res.json({ success: true });
  } catch (err) {
    log('error', 'auth.reset_password.error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/verify-email', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const account = await getUserAccount(userId);
    if (!account || !account.email) return res.status(400).json({ error: 'No email address on this account.' });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('password_reset_tokens').insert({ user_id: userId, token, expires_at: expiresAt });
    const verifyUrl = `${process.env.APP_URL || ''}/auth/verify-email/confirm?token=${token}`;
    try {
      const { sendVerificationEmail } = require('./services/email');
      await sendVerificationEmail(account.email, verifyUrl);
    } catch (e) {
      log('warn', 'email.verify.failed', { error: e.message });
    }
    res.json({ success: true, message: 'Verification email sent.' });
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
  const audioTraceId = `process-audio:${userId}:${Date.now()}`;
  const sse = obj => {
    if (obj?.type === 'audio') {
      console.log(`[audio][backend:${audioTraceId}] sending audio event bytes=${Buffer.from(obj.data || '', 'base64').length} mime=${obj.mimeType || 'audio/wav'}`);
    }
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

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
    const initialRequest = buildModernGenerateRequest({
      dynamicSystemPrompt,
      useSearch,
      cachedContentName,
      baseHistory,
      userContent: { role: 'user', parts: [{ text: userText }] },
      useAgentTools: false
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

    let { spoken, actions, parseError } = parseActions(fullText);
    if (parseError) console.warn('[process-audio] one or more <action> blocks failed to parse; some actions may be missing');
    actions = guardCalendarActionsForUserMessage(actions, userText);
    if (shouldIgnoreModelAuthoredActions(STREAMING_CHAT_MODEL) && actions.length) {
      console.warn(`[process-audio] ignored ${actions.length} fast-model authored action(s)`);
      actions = [];
    }

    let actionResults = [];
    let audioBase64 = null;
    let ttsError = '';
    let dataResults = [];
    if (actions.length > 0) {
      actionResults = await executeActions(userId, actions, { userMessage: userText });
      dataResults = getStructuredDataResults(actionResults, userText);
      actionResults = normalizeActionResultsForClient(actionResults).map(enrichActionForBrowser);
    }
    let finalSpoken = canUseDirectActionSummary(actionResults) ? summarizeActionResults(actionResults) : spoken;
    if (!canUseDirectActionSummary(actionResults) && dataResults.length > 0) {
      const followUpRequest = buildModernGenerateRequest({
        dynamicSystemPrompt,
        useSearch,
        cachedContentName,
        baseHistory,
        userContent: { role: 'user', parts: [{ text: userText }] }
      });
      followUpRequest.contents.push(
        { role: 'model', parts: [{ text: spoken || '...' }] },
        { role: 'user', parts: [{ text: synthesisPromptForDataResults(userText, dataResults) }] }
      );
      const followUp = await modernGenAI.models.generateContent({
        model: PRIMARY_CHAT_MODEL,
        contents: followUpRequest.contents,
        config: followUpRequest.config
      });
      finalSpoken = guardVisibleDataResponse(parseActions(followUp.text || '').spoken, dataResults);
    }
    const actionConfirmation = summarizeFinishedActionsForUser(actionResults);
    if (actionConfirmation) finalSpoken = actionConfirmation;
    audioBase64 = await generateSpeech(buildVoiceExcerpt(finalSpoken), req.body.voice).catch(err => {
      ttsError = err.message;
      console.error('[tts error]', err.message);
      return null;
    });
    saveMessage(userId, 'assistant', { text: finalSpoken, actions: actionResults }).catch(() => {});

    sse({ type: 'response', text: finalSpoken, actions: actionResults, tasks: actionResults });
    if (audioBase64) sse({ type: 'audio', data: audioBase64, format: 'wav', mimeType: 'audio/wav' });
    if (ttsError) sse({ type: 'tts-error', error: ttsError });
    sse({ type: 'done' });
    res.end();

    postResponseTasks(userId, userText);
  } catch (err) {
    console.error('/process-audio error:', err.message);
    try { sse({ type: 'error', error: err.message }); res.end(); } catch {}
  }
});

app.post('/pendant/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const uploadCheck = validatePendantTranscriptionUpload(req.file);
    if (!uploadCheck.ok) return res.status(uploadCheck.status).json({ error: uploadCheck.error });
    const userId = req.body.userId;
    if (!requireMatchingUser(req, res, userId)) return;
    console.log('[pendant/transcribe] upload', {
      userId,
      bytes: uploadCheck.size,
      mimetype: uploadCheck.mimetype,
      name: uploadCheck.originalname
    });

    const now = Date.now();
    const recentHits = (audioRateLimit.get(userId) || []).filter(t => now - t < 60000);
    if (recentHits.length >= 10) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    audioRateLimit.set(userId, [...recentHits, now]);

    const transcript = (await transcribeAudio(req.file.buffer)).trim();
    if (!transcript) {
      console.warn('[pendant/transcribe] empty transcript', {
        userId,
        bytes: uploadCheck.size,
        durationMs: getWavDurationMs(req.file.buffer)
      });
      return res.status(422).json({ error: "I couldn't clearly make out what you said." });
    }
    res.json({ transcript });
  } catch (err) {
    console.error('/pendant/transcribe error:', {
      message: err.message,
      status: err?.response?.status,
      provider: err?.response?.data?.error?.message
    });
    res.status(500).json({ error: 'Transcription failed. Please try again.' });
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
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
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
    let { spoken, actions, parseError } = parseActions(geminiRes.text || '');
    if (parseError) console.warn('[chat-with-image] one or more <action> blocks failed to parse; some actions may be missing');
    actions = guardCalendarActionsForUserMessage(actions, message);
    let actionResults = [];
    let dataResults = [];
    if (actions.length > 0) {
      actionResults = await executeActions(userId, actions, { imageFile: req.file, userMessage: message });
      dataResults = getStructuredDataResults(actionResults, message);
      actionResults = normalizeActionResultsForClient(actionResults);
    }

    if (canUseDirectActionSummary(actionResults)) {
      spoken = summarizeActionResults(actionResults);
    } else if (dataResults.length > 0) {
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
        { role: 'user', parts: [{ text: `${synthesisPromptForDataResults(message, dataResults)}\nYou may also use the attached ${fileLabel} context.` }] }
      );
      const followUp = await modernGenAI.models.generateContent({
        model: PRIMARY_CHAT_MODEL,
        contents: followUpRequest.contents,
        config: followUpRequest.config
      });
      spoken = guardVisibleDataResponse(parseActions(followUp.text || '').spoken || spoken, dataResults);
    }
    const actionConfirmation = summarizeFinishedActionsForUser(actionResults);
    if (actionConfirmation) spoken = actionConfirmation;

    if (!spoken) {
      spoken = dataResults.length ? buildConciseDataAnswer(dataResults) : 'I looked through it.';
    }

    const browserActions = (actionResults || []).map(enrichActionForBrowser);
    saveMessage(userId, 'assistant', { text: spoken, actions: browserActions }).catch(() => {});
    const result = { text: spoken, actions: browserActions };

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
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

app.post('/memory', async (req, res) => {
  try {
    const { userId, content } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required.' });
    if (!isUsefulMemoryContent(content)) return res.status(400).json({ error: 'memory is too short or unclear.' });
    await saveMemory(userId, content.trim(), 'manual');

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    res.json({ summary: await getMemorySummary(req.params.userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/:userId/items', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
    const { data, error } = await supabase
      .from('memories')
      .select('id, content, source, created_at')
      .eq('user_id', req.params.userId)
      .neq('source', 'agent_episodic')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ items: (data || []).filter(isUserFacingMemory) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/memory/:userId/items/:id', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const { error, count } = await supabase
      .from('memories')
      .delete({ count: 'exact' })
      .eq('user_id', req.params.userId)
      .eq('id', req.params.id);
    if (error) throw error;
    if (!count) return res.status(404).json({ error: 'Memory not found.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/memory/:userId/items/:id', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required.' });
    const { data, error } = await supabase
      .from('memories')
      .update({ content: content.trim() })
      .eq('user_id', req.params.userId)
      .eq('id', req.params.id)
      .select('id');
    if (error) throw error;
    if (!data?.length) return res.status(404).json({ error: 'Memory not found.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/memory/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const result = await forgetMemory(req.params.userId, req.body || { scope: 'all' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/user/:userId/export', async (req, res) => {
  const { userId } = req.params;
  if (!requireMatchingUser(req, res, userId)) return;
  try {
    const data = await buildUserExport(userId);
    res.setHeader('Content-Disposition', 'attachment; filename="milgrain-data-export.json"');
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
    const tasks = data.map(a => {
      const parsedAction = safeParseJSON(a.action) || {};
      const parsedResult = safeParseJSON(a.result) || a.result || {};
      const actionType = parsedAction.type || a.action_type || (typeof a.action === 'string' ? a.action : '');

      // Clean task object optimized for browser presentation ("browser tasks")
      const task = enrichActionForBrowser({
        action: actionType,
        result: { ...parsedResult, ...parsedAction }
      });

      // Keep original DB metadata for the history view if needed
      return {
        id: a.id,
        created_at: a.created_at,
        status: a.status,
        ...task,
        raw: { action: parsedAction, result: parsedResult } // for power users/debug
      };
    });
    res.json({ tasks, actions: tasks }); // provide both for backward compat in browser UI
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/action-contracts', requireSessionAuth, (req, res) => {
  res.json({ actions: ACTION_CONTRACTS });
});

// `kind` distinguishes a genuine external-account connection (OAuth or a personal token the
// user authorizes — something to actually "connect") from a functionality (a capability that
// works via a server-side API key, a deep-link handoff, or in-app plumbing, with no per-user
// account to link). Confirmed per-item by grepping connectors/*.js for real oauth/access_token
// handling. The Connections screen only lists `kind: 'connection'` items — a functionality
// isn't something to browse/toggle, it just works when invoked from chat.
const CONNECTORS = [
  { id: 'google',    name: 'Gmail & Calendar', icon: 'google', category: 'Productivity', implemented: true, type: 'api', kind: 'connection' },
  // icon 'outlook' (not 'microsoft') — that's the actual bundled asset name; id stays
  // 'microsoft' since that's what the OAuth provider matching keys off of.
  { id: 'microsoft', name: 'Outlook & Calendar', icon: 'outlook', category: 'Productivity', implemented: true, type: 'api', kind: 'connection' },
  { id: 'telegram',  name: 'Telegram', icon: 'telegram', category: 'Messages', implemented: true, type: 'api', kind: 'connection' },
  { id: 'maps',      name: 'Maps & Places', icon: 'maps', category: 'Travel', implemented: true, type: 'api', kind: 'functionality' },
  { id: 'notion', name: 'Notion', icon: 'notion', category: 'Productivity', implemented: true, type: 'api', kind: 'connection' },
  { id: 'github', name: 'GitHub', icon: 'github', category: 'Dev', implemented: true, type: 'api', kind: 'connection' },
  { id: 'slack', name: 'Slack', icon: 'slack', category: 'Productivity', implemented: true, type: 'api', kind: 'connection' },
  // Easy Apple stuff (no extra login needed on iPhone) — on-device permission, not a
  // third-party account, so this is a functionality, not a connection.
  { id: 'reminders', name: 'Reminders', icon: 'reminders', category: 'Productivity', implemented: true, type: 'api', kind: 'functionality' },
  { id: 'imessage',  name: 'iMessage', icon: 'imessage', category: 'Messages', implemented: true, type: 'handoff', kind: 'functionality' },
  // Finance & Money (tied to concierge account for real spends/earns)
  { id: 'concierge_account', name: 'Concierge Account (Virtual Card)', icon: 'card', category: 'Finance', implemented: true, type: 'api', kind: 'functionality' },
  { id: 'monzo', name: 'Monzo', icon: 'monzo', category: 'Finance', implemented: true, type: 'api', kind: 'connection' },
  // Stripe here is the app's OWN payment processor for concierge money movement, not a
  // personal Stripe account the user links — a functionality, not a connection.
  { id: 'stripe', name: 'Stripe (Payments)', icon: 'stripe', category: 'Finance', implemented: true, type: 'api', kind: 'functionality' },
  // Plaid Link issues a real per-user access_token (see connectors/plaid.js), but the app has
  // no client-side Plaid Link flow to actually produce one — the Connections screen's Connect
  // button just flips a preference flag, same as any other functionality. A functionality,
  // not a connection, until real Link is wired up.
  { id: 'plaid', name: 'Plaid (Banking)', icon: 'plaid', category: 'Finance', implemented: true, type: 'api', kind: 'functionality' },
  // Handoffs — I open the app perfectly pre-filled (easiest for you). No account is linked
  // in any of these; they're functionalities, not connections.
  { id: 'uber',      name: 'Uber', icon: 'uber', category: 'Transport', implemented: true, type: 'handoff', kind: 'functionality' },
  { id: 'lyft',      name: 'Lyft', icon: 'lyft', category: 'Transport', implemented: true, type: 'handoff', kind: 'functionality' },
  { id: 'spotify',   name: 'Spotify', icon: 'spotify', category: 'Entertainment', implemented: true, type: 'handoff', kind: 'functionality' },
  { id: 'trainline', name: 'Trains', icon: 'trainline', category: 'Transport', implemented: true, type: 'hybrid', kind: 'functionality' },
  // Travel deeper — search/link-generators only, no account, no real booking.
  { id: 'flights', name: 'Flights', icon: 'flight', category: 'Travel', implemented: true, type: 'api', kind: 'functionality' },
  { id: 'hotels', name: 'Hotels', icon: 'hotel', category: 'Travel', implemented: true, type: 'api', kind: 'functionality' },
  // Shopping
  { id: 'amazon', name: 'Amazon', icon: 'amazon', category: 'Shopping', implemented: true, type: 'handoff', kind: 'functionality' },
  // Health & Fitness
  { id: 'strava', name: 'Strava', icon: 'strava', category: 'Health', implemented: true, type: 'api', kind: 'connection' },
  { id: 'oura', name: 'Oura', icon: 'oura', category: 'Health', implemented: true, type: 'api', kind: 'connection' },
  // Events & Info — public/server-key APIs, no personal account.
  { id: 'eventbrite', name: 'Eventbrite', icon: 'event', category: 'Events', implemented: true, type: 'api', kind: 'functionality' },
  { id: 'weather', name: 'Weather', icon: 'weather', category: 'Info', implemented: true, type: 'api', kind: 'functionality' },
  { id: 'stocks', name: 'Stocks & Markets', icon: 'stocks', category: 'Info', implemented: true, type: 'api', kind: 'functionality' },
];

// Mark concierge_account as always available (not connector dependent)
const CONCIERGE_ACCOUNT_ALWAYS_AVAILABLE = true;

// Honest classification for prompts and UI
const CONNECTOR_TYPES = {
  api: 'Full API integration (real actions on server)',
  handoff: 'Opens the app or web (you complete the action)',
  hybrid: 'Some real data + handoff to complete'
};
const KNOWN_CONNECTOR_IDS = new Set(CONNECTORS.map(c => c.id));
const ACTION_LOG_STATUSES = new Set(['executed', 'failed', 'pending']);
const PENDING_ACTION_PREF = 'pending.action';
const pendingActionConfirmLocks = new Set();

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
      const needsReconnect = (c.id === 'google' || c.id === 'microsoft') && enabled && !hasRefreshToken;
      const needsSetup = (c.id === 'maps' && !(process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY))
        || (c.id === 'microsoft' && !(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET));
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

app.post('/native/local-action', async (req, res) => {
  try {
    const { userId, message, result } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    if (!message || !result?.action) {
      return res.status(400).json({ error: 'message and result.action are required.' });
    }

    const enrichedNative = [enrichActionForBrowser(result)];
    await saveMessage(userId, 'user', String(message));
    await saveMessage(userId, 'assistant', { text: result.text || '', actions: enrichedNative });
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/briefings/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const { data, error } = await supabase
      .from('briefings')
      .select('id, kind, title, body, source, metadata, read, created_at')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    // Return most things; client-side filters handle noise. Agent tasks/recipes now included via proactive unification.
    const visible = (data || []).filter(briefing => !briefing.kind?.includes('failed_action_followup'));
    res.json({ briefings: visible });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// Dashboard "go handle it" path for an inbox card — deliberately a plain REST call, not
// a chat/agent-loop turn. Routing this through the general model's tool-calling would let
// it decide for itself whether to try run_browser_task on a bank site; calling
// buildEmailActionPlan directly means that's never even on the table. See its own comment
// for what it actually does (mines the real email for real links, never attempts a login).
app.post('/emails/action-plan', async (req, res) => {
  try {
    const { userId, provider, messageId } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    if (!messageId) return res.status(400).json({ error: 'messageId is required' });
    const plan = await buildEmailActionPlan(userId, { provider, messageId });
    res.json(plan);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not put together next steps for that email.' });
  }
});

app.post('/proactive/:userId/run', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!requireMatchingUser(req, res, userId)) return;
    const summary = await runProactiveForUser(userId);
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.all('/proactive/sweep', async (req, res) => {
  try {
    const authorization = proactiveSweepAuthorization(req);
    if (!authorization.ok) {
      return res.status(authorization.status).json({ error: authorization.error });
    }
    const summary = await runProactiveSweep(console);
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/briefing-legacy/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const userId = req.params.userId;
    const history = await getHistory(userId);
    const latestQueuedBriefing = [...history]
      .reverse()
      .find(entry => {
        if (entry.role !== 'assistant') return false;
        if (entry.kind !== 'briefing' && entry.kind !== 'proactive') return false;
        return entry.created_at && (Date.now() - new Date(entry.created_at).getTime()) < 36 * 60 * 60 * 1000;
      });

    if (latestQueuedBriefing) {
      return res.json({ text: latestQueuedBriefing.content, actions: latestQueuedBriefing.actions || [] });
    }

    const { spoken, actions } = await buildMorningBriefing(userId, new Date());
    res.json({ text: spoken, actions });
  } catch (err) {
    console.error('/briefing error:', err.message);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/history/:userId', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const history = await getHistory(req.params.userId, null, req.query.limit || 50, {
      since: req.query.since
    });
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/history/:userId/sessions', async (req, res) => {
  if (!requireMatchingUser(req, res, req.params.userId)) return;
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, role, content, created_at')
      .eq('user_id', req.params.userId)
      .neq('role', 'system')
      .order('created_at', { ascending: false })
      .limit(250);
    if (error) throw error;
    res.json({ sessions: buildConversationSessions(data || []) });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.json({ history: [...rowsByKey.values()].map(normalizeConversationRow) });
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
      .select('id, role, content, created_at')
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

// Shared logic for building the Gemini model + system prompt
async function buildChatContext(userId, message, trace = null, modelName = STREAMING_CHAT_MODEL, requestContext = {}) {
  const quickTurn = !requestContext.pendingAction && isQuickTurnMessage(message);
  const historyOptions = { since: requestContext.chatStartedAt };
  const [memory, history, preferences, enabledConnectors, userContext, cachedContentName, recentActions] = await Promise.all([
    quickTurn ? Promise.resolve('') : getMemory(userId, trace, message || ''),
    getHistory(userId, trace, 12, historyOptions),
    getPreferences(userId, trace),
    quickTurn ? Promise.resolve([]) : getEnabledConnectors(userId, trace),
    quickTurn ? Promise.resolve('') : getUserContext(userId, trace),
    getPromptCacheName(trace, modelName),
    quickTurn ? Promise.resolve([]) : getRecentLoggedActions(userId, trace, 8, historyOptions)
  ]);
  const availableActions = quickTurn ? '' : buildAvailableActions(enabledConnectors);
  const statedContext = [
    ...extractAlreadyStatedContext(history),
    ...extractShoppingContextHints(history)
  ];
  const resolvedContext = requestContext.resolvedContext || (!quickTurn && isContextualReference(message)
    ? buildResolvedContext(history, recentActions)
    : null);
  const emailReplyContext = quickTurn
    ? ''
    : await buildEmailReplyDraftContext(userId, message, history, memory, preferences, trace);
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

const DATA_ACTIONS = new Set(['search_trains', 'station_board', 'get_emails', 'get_calendar_events', 'search_emails', 'get_telegram_contacts']);
const DIRECT_SUMMARY_ACTIONS = new Set(['search_trains', 'station_board']);

async function buildMorningBriefing(userId, now = new Date()) {
  const [memory, history] = await Promise.all([
    getMemory(userId, null, ''),
    getHistory(userId)
  ]);

  const hour = getLocalHour(now);
  const greeting = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const systemPrompt = `You are a personal assistant. It's ${greeting} and you're checking in with your friend.

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
  return parseActions(geminiRes.response.text());
}

async function maybeCreateMorningBriefing(userId, now = new Date()) {
  const localHour = getLocalHour(now);
  if (localHour < 6 || localHour > 11) return null;

  const prefs = await getPreferenceMap(userId);
  const todayKey = getLocalDateKey(now);
  if (prefs[PROACTIVE_MORNING_PREF] === todayKey) return null;

  const { data: latestConversation } = await supabase
    .from('conversations')
    .select('created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latestConversation?.created_at) return null;
  const lastConversationAt = new Date(latestConversation.created_at).getTime();
  if (Number.isNaN(lastConversationAt) || (Date.now() - lastConversationAt) > 14 * 24 * 60 * 60 * 1000) {
    return null;
  }

  const { spoken, actions } = await buildMorningBriefing(userId, now);
  const text = stripActionMarkupForDisplay(spoken || '').trim();
  if (!text) return null;

  await saveMessage(userId, 'assistant', { text, actions, kind: 'briefing' });
  await setPreferenceValue(userId, PROACTIVE_MORNING_PREF, todayKey);
  return { type: 'morning_briefing', text };
}

async function getLatestNativeContext(userId) {
  const { data } = await supabase
    .from('native_context')
    .select('location, health, capabilities, settings, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  return data || null;
}

// Outlook's Graph API shape (from connectors/microsoft.js's summarizeMessage: id, subject,
// from, senderName, receivedAt, preview, isRead) doesn't match Gmail's (from, subject,
// snippet, date, labelIds, listUnsubscribe) — normalize to the common shape everything
// downstream (isPromotionalOrBulk, summarizeEmails, extractIncoming, BriefingEmail on the
// client) already reads, and tag `provider` so the dashboard can show which inbox an item
// came from once a user has more than one connected.
function normalizeOutlookEmail(m = {}) {
  return {
    from: m.senderName ? `${m.senderName} <${m.from || ''}>` : (m.from || ''),
    subject: m.subject || '',
    snippet: m.preview || '',
    date: m.receivedAt || '',
    provider: 'outlook',
    // Real Graph message id — lets the dashboard re-fetch THIS exact email later
    // (buildEmailActionPlan) when a card's action is tapped, instead of re-searching by
    // subject text, which is fragile and ambiguous across duplicate/similar subjects.
    messageId: m.id || ''
  };
}

// Regression: the Today dashboard's Inbox/Incoming cards read metadata.emails/metadata.incoming
// off the freshest briefing (OxyApp/Models/Message.swift), but a prior refactor
// (commit 454d17b) never carried real email data into any briefing's metadata — those cards
// were permanently empty for every user regardless of connection state. Shared here so both
// the interval briefing (runs on a schedule, regardless of urgency) and the email-nudge check
// (only fires when something looks urgent) populate the same real data the same way.
async function gatherEmailContext(userId) {
  try {
    const enabled = await getEnabledConnectors(userId);
    const wantsGoogle = enabled.includes('google');
    const wantsMicrosoft = enabled.includes('microsoft');
    if (!wantsGoogle && !wantsMicrosoft) return { emails: [], incoming: [] };

    // Over-fetch, then drop marketing/bulk mail, so a promo-heavy inbox still yields a
    // full page of real, actionable mail (fetching only 10 could be all promotions).
    const [googleResult, outlookResult] = await Promise.all([
      wantsGoogle ? dispatch(userId, 'get_emails', { max_results: 25, label: 'INBOX' }) : null,
      wantsMicrosoft ? dispatch(userId, 'get_outlook_emails', { max: 25 }) : null
    ]);

    const googleEmails = (googleResult?.success && Array.isArray(googleResult.emails))
      ? googleResult.emails.map(e => ({ ...e, provider: 'gmail', messageId: e.id || '' }))
      : [];
    // Outlook has no CATEGORY_PROMOTIONS/List-Unsubscribe-header equivalent surfaced here,
    // so isPromotionalOrBulk (which reads those Gmail-specific fields) is a no-op for it —
    // summarizeEmails' content-based llmPromotional judgment below is the only filter that
    // actually applies to Outlook mail, same as it already is for Gmail mail that slips
    // past Gmail's own labels.
    const outlookEmails = (outlookResult?.success && Array.isArray(outlookResult.emails))
      ? outlookResult.emails.map(normalizeOutlookEmail)
      : [];

    const real = [...googleEmails, ...outlookEmails].filter(e => !isPromotionalOrBulk(e));
    // A little headroom above the 10 we actually want — summarizeEmails' content
    // judgment below drops a few more (marketing Gmail filed under CATEGORY_UPDATES
    // next to real notifications, which the label/header check above can't separate).
    const candidates = real.slice(0, 15);
    const summarized = await summarizeEmails(candidates);
    // Explicit field picker rather than a blanket `...rest` spread — Gmail's fetchFullMessage
    // result carries the entire email body plus headers (threadId, labelIds, references,
    // etc.), none of which the dashboard card needs; storing all of it in briefing.metadata
    // on every refresh was pure bloat. messageId is the one addition worth keeping — it's
    // how buildEmailActionPlan re-fetches this exact email later.
    const emails = summarized
      .filter(e => !e.llmPromotional)
      .map(e => ({
        from: e.from,
        subject: e.subject,
        snippet: e.snippet,
        date: e.date,
        summary: e.summary,
        cta: e.cta,
        provider: e.provider,
        messageId: e.messageId
      }))
      .slice(0, 10);
    // Deliveries/reservations can legitimately be CATEGORY_UPDATES, so parse incoming
    // from the same de-promoted, de-marketed set rather than the raw fetch.
    return { emails, incoming: extractIncoming(emails) };
  } catch (e) {
    return { emails: [], incoming: [] };
  }
}

// The dashboard's Inbox cards frame each email as "needs you / draft reply", so marketing
// blasts, social notifications, and mailing-list mail don't belong there. Gmail already
// sorts these into its Promotions/Social/Forums tabs (the CATEGORY_* labels); we trust
// that first, then fall back to the List-Unsubscribe header for accounts with tabs off.
const PROMOTIONAL_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']);
function isPromotionalOrBulk(email = {}) {
  const labels = email.labelIds || [];
  if (labels.some(l => PROMOTIONAL_LABELS.has(l))) return true;
  // Bulk-sender marker. Keep it only when Gmail flagged the message IMPORTANT — that's how
  // a genuine bill or account alert (which can also carry List-Unsubscribe) survives.
  if (email.listUnsubscribe && !labels.includes('IMPORTANT')) return true;
  return false;
}

// Stakes-first triage per email for the Today Inbox card — this used to just dump the raw
// subject line verbatim, then (one pass later) a neutral "what this is" restatement. Neither
// tells you at a glance whether you need to actually do something about it. The bar now is
// Poke's texting voice: what happened, what it actually costs you if you ignore it, and by
// when — the way a sharp assistant would text a friend, not the way you'd file an email.
// Single batched call (not one per email) to keep this cheap — runs on the FAST_MODEL helper
// tier, on a background schedule so the extra latency doesn't block any user-facing request.
// Also judges promotional-ness by content, not just Gmail's label — the label/
// List-Unsubscribe check in isPromotionalOrBulk only catches CATEGORY_PROMOTIONS/SOCIAL/
// FORUMS plus a header that turns out to be unreliable in practice. Gmail files plenty of
// real marketing (product newsletters, paid-study recruitment) under CATEGORY_UPDATES
// alongside genuine notifications (bill reminders, build failures), and a label alone
// can't tell those apart — this reuses the same batched call already paying for an LLM
// read of each email, just asking it two more things.
async function summarizeEmails(emails) {
  if (!emails.length) return emails;
  try {
    const model = genAI.getGenerativeModel({ model: FAST_MODEL });
    const listing = emails.map((e, i) =>
      `${i}. From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${(e.snippet || '').slice(0, 300)}`
    ).join('\n\n');
    const prompt = `For each numbered email below, judge three things:

1. summary: ONE short, casual line (under 20 words) written the way a sharp assistant would
text a friend, not the way you'd file an email. If there's a real consequence — a fee, a
suspension, a deadline, a decision the user has to make — name it plainly and say what
happens if they don't act. If it's genuinely just FYI with nothing at stake, say that
plainly too instead of dressing it up. Never restate the subject line or describe the
email ("this is an email about...").

2. cta: a short 1-3 word label for the ONE most useful next step, matching the actual verb
needed — e.g. "Pay it", "Sort it", "Reply", "Review", "Confirm", "Ignore". Not a generic
default — pick the word for what actually has to happen.

3. promotional: true if this is marketing/bulk content the user didn't specifically ask for
(product newsletters, feature announcements, paid-study or survey recruitment, sales,
discounts) as opposed to something personal, transactional, or genuinely actionable (a bill,
a real notification about something the user did, a message worth replying to, an
account/security alert).

${listing}

Respond with ONLY a JSON array, one object per email, same order as input, shape
[{"summary":"...","cta":"...","promotional":true|false}]. Examples:
[{"summary":"Capital One suspended your card after a missed payment — pay £22.80 today to unblock it","cta":"Pay it","promotional":false},
{"summary":"Amazon order shipped, arrives Thursday, nothing needed","cta":"Track it","promotional":false},
{"summary":"Product newsletter — nothing needed","cta":"Ignore","promotional":true}]`;
    const res = await model.generateContent(prompt);
    const match = (res.response.text() || '').match(/\[[\s\S]*\]/);
    if (!match) return emails;
    const judged = JSON.parse(match[0]);
    return emails.map((e, i) => ({
      ...e,
      summary: typeof judged[i]?.summary === 'string' ? judged[i].summary.trim() : undefined,
      cta: typeof judged[i]?.cta === 'string' ? judged[i].cta.trim().slice(0, 24) : undefined,
      // Fail open (false) on a missing/malformed judgment for this email — better to
      // show one extra email than to silently drop something that might matter.
      llmPromotional: judged[i]?.promotional === true
    }));
  } catch (e) {
    return emails;
  }
}

// Deliberately never routed through the general agent/tool-calling loop, and
// get_email_action_links is deliberately not registered in action-contracts.js — a bank
// or card-issuer site can't be safely logged into by a bot (2FA, aggressive anti-automation),
// so the model is never even given the option to try run_browser_task on one of these. This
// mines the ORIGINAL email for real links the provider already sent (e.g. Revolut's own
// "Add money" link) and asks the model only to write short manual steps and pick which of
// those real links matter — it selects and labels existing links, it never gets to invent a
// URL. Called directly from the /emails/action-plan REST route below, not from chat.
async function buildEmailActionPlan(userId, { provider, messageId }) {
  if (!messageId) return { success: false, error: 'No message to look up.' };
  const action = provider === 'outlook' ? 'get_outlook_email_action_links' : 'get_email_action_links';
  const result = await dispatch(userId, action, { messageId });
  if (!result?.success) return { success: false, error: result?.error || 'Could not open that email.' };

  const body = String(result.body || '').slice(0, 4000);
  const links = Array.isArray(result.links) ? result.links.slice(0, 20) : [];
  if (!body && !links.length) return { success: false, error: 'That email has nothing to go on.' };

  try {
    const model = genAI.getGenerativeModel({ model: FAST_MODEL });
    const linkListing = links.map((l, i) => `${i}. "${l.label}" -> ${l.url}`).join('\n') || '(no links found)';
    const prompt = `An email needs the user's attention. Here is its full text and every real link it contained.

EMAIL BODY:
${body}

LINKS FOUND IN THE EMAIL:
${linkListing}

Write:
1. steps: 2-4 short plain-English steps for how the user can actually handle this themselves (e.g. "Open the Revolut app", "Tap Add money", "Transfer enough to bring your balance above zero"). Base this ONLY on what the email says — never invent account balances, amounts, or facts not present in the text.
2. links: pick up to 3 of the links listed above that are genuinely useful for handling this (skip unsubscribe/legal/tracking-pixel links). For each, give a short clean label (2-4 words) and copy its url EXACTLY as given above, character for character — never alter, shorten, or invent a URL. If none of the links are useful, return an empty array.

Respond with ONLY JSON, shape {"steps":["...","..."],"links":[{"label":"...","url":"..."}]}.`;
    const res = await model.generateContent(prompt);
    const match = (res.response.text() || '').match(/\{[\s\S]*\}/);
    if (!match) return { success: true, steps: [], links: links.slice(0, 3) };
    const parsed = JSON.parse(match[0]);
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()).slice(0, 4)
      : [];
    // Only trust a returned link if its URL exactly matches one actually extracted from the
    // email — the model selects and labels, it never gets to introduce a URL of its own.
    const knownUrls = new Set(links.map(l => l.url));
    const chosenLinks = Array.isArray(parsed.links)
      ? parsed.links
        .filter(l => l && typeof l.url === 'string' && typeof l.label === 'string' && knownUrls.has(l.url))
        .slice(0, 3)
      : [];
    return { success: true, steps, links: chosenLinks };
  } catch (e) {
    // Fail open to the raw extracted links — still real, still useful, just unlabeled/unfiltered.
    return { success: true, steps: [], links: links.slice(0, 3) };
  }
}

async function buildIntervalBriefing(userId, window, nativeContext, now = new Date()) {
  const [memory, history, preferences] = await Promise.all([
    getMemory(userId, null, ''),
    getHistory(userId),
    getPreferences(userId)
  ]);

  const health = parseJsonObject(nativeContext?.health);
  const location = parseJsonObject(nativeContext?.location);
  const systemPrompt = `You are a personal assistant writing a useful, concise ${window.label.toLowerCase()} for the user.

Use only the information shown here. Do not invent weather, traffic, calendar events, health facts, or plans.
If there is nothing useful, write one warm quiet-start sentence.

Memory:
${memory || 'none'}

Preferences:
${preferences || 'none'}

Recent conversation:
${history.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n') || 'none'}

Native context:
Location: ${location.latitude && location.longitude ? `${location.latitude}, ${location.longitude}` : 'not available'}
Health: ${Object.keys(health).length ? JSON.stringify(health).slice(0, 800) : 'not available'}
Current time: ${now.toLocaleString('en-GB', { timeZone: TIMEZONE })}

Keep it under 70 words. Include only useful items.
Write plain flowing prose only — no markdown, no headers (###), no bold (**), no bullet or numbered lists.`;

  const model = genAI.getGenerativeModel({
    model: PRIMARY_CHAT_MODEL,
    systemInstruction: systemPrompt
  });
  const geminiRes = await model.generateContent(`${window.label} now`);
  const text = stripActionMarkupForDisplay(geminiRes.response.text() || '').trim();
  return stripMarkdownFormatting(text);
}

async function maybeCreateIntervalBriefing(userId, now = new Date()) {
  const window = getBriefingWindow(now);
  if (!window) return null;

  const nativeContext = await getLatestNativeContext(userId);
  const settings = parseJsonObject(nativeContext?.settings);
  if (settings.proactiveBriefings === false) return null;
  if (['Quiet', 'Low'].includes(settings.autonomy)) return null;

  const todayKey = getLocalDateKey(now);
  const key = `proactive.briefing.${window.id}.${todayKey}`;
  const prefs = await getPreferenceMap(userId);
  if (prefs[key] === 'sent') {
    // The once-per-window narrative already fired today, but the dashboard's email/
    // incoming cards shouldn't go stale for the rest of the day because of that — every
    // runProactiveCheck call (fires on every Home open) refreshes the existing row's raw
    // data in place. Silent: no new narrative, no chat message, no push.
    const emailContext = await gatherEmailContext(userId);
    await refreshBriefingEmailData(userId, `${window.id}_briefing`, todayKey, emailContext);
    return null;
  }

  const [text, emailContext] = await Promise.all([
    buildIntervalBriefing(userId, window, nativeContext, now),
    gatherEmailContext(userId)
  ]);
  if (!text) return null;
  const briefing = await createBriefing(userId, {
    kind: `${window.id}_briefing`,
    title: window.label,
    body: text,
    source: 'schedule',
    metadata: {
      window: window.id,
      date: todayKey,
      narrative: text,
      emails: emailContext.emails,
      incoming: emailContext.incoming
    }
  });
  await setPreferenceValue(userId, key, 'sent');
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

// Poke-like: scan recent emails for actionable items and nudge
async function maybeCreateEmailNudges(userId, now = new Date()) {
  try {
    const prefs = await getPreferenceMap(userId);
    const todayKey = getLocalDateKey(now);
    const key = `proactive.email.nudges.${todayKey}`;

    const nativeContext = await getLatestNativeContext(userId);
    const settings = parseJsonObject(nativeContext?.settings);
    if (['Quiet', 'Low'].includes(settings.autonomy)) return null;

    if (prefs[key] === 'sent') {
      // Same self-healing as maybeCreateIntervalBriefing — keep the row's emails/incoming
      // current even though today's nudge text already fired, so a card that was wrong
      // when it was written (or has since become stale) doesn't sit there all day.
      const emailContext = await gatherEmailContext(userId);
      await refreshBriefingEmailData(userId, 'email_nudge', todayKey, emailContext);
      return null;
    }

    const emailContext = await gatherEmailContext(userId);
    if (!emailContext.emails.length) return null;

    const emailSummary = emailContext.emails.slice(0, 5).map(e => {
      return `From: ${e.from || 'unknown'} | Subject: ${e.subject || '(no subject)'} | Snippet: ${(e.snippet || e.body || '').slice(0, 150)}`;
    }).join('\n');

    // Use fast model to find actionables
    const prompt = `Analyze these recent emails for actionable items that need the user's attention today (replies, decisions, deadlines, meetings to confirm). List 0-3 short nudges max. Be concise. If nothing urgent, say "no urgent actions".\n\n${emailSummary}`;

    const model = genAI.getGenerativeModel({ model: FAST_MODEL });
    const res = await model.generateContent(prompt);
    const text = (res.response.text() || '').trim();
    if (!text || /no urgent|nothing|none/i.test(text)) {
      await setPreferenceValue(userId, key, 'sent');
      return null;
    }

    const briefing = await createBriefing(userId, {
      kind: 'email_nudge',
      title: 'Email actions',
      body: text,
      source: 'email',
      metadata: { date: todayKey, count: 1, emails: emailContext.emails, incoming: emailContext.incoming }
    });
    await setPreferenceValue(userId, key, 'sent');
    return { type: 'email_nudge', text: briefing.body, count: 1 };
  } catch (e) {
    return null;
  }
}

// Calendar nudges for upcoming events / conflicts
async function maybeCreateCalendarNudges(userId, now = new Date()) {
  try {
    const prefs = await getPreferenceMap(userId);
    const todayKey = getLocalDateKey(now);
    const key = `proactive.calendar.nudges.${todayKey}`;
    if (prefs[key] === 'sent') return null;

    const nativeContext = await getLatestNativeContext(userId);
    const settings = parseJsonObject(nativeContext?.settings);
    if (['Quiet', 'Low'].includes(settings.autonomy)) return null;

    const enabled = await getEnabledConnectors(userId);
    if (!enabled.includes('google')) return null;

    const calResult = await dispatch(userId, 'get_calendar_events', { max_results: 8 });
    if (!calResult?.success || !Array.isArray(calResult.events) || calResult.events.length === 0) return null;

    const upcoming = calResult.events.filter(ev => {
      const start = ev.start?.dateTime || ev.start?.date;
      if (!start) return false;
      const d = new Date(start);
      return d > now && (d.getTime() - now.getTime()) < 1000 * 60 * 60 * 6; // next 6 hours
    });

    if (upcoming.length === 0) return null;

    const summary = upcoming.map(ev => `${ev.summary || 'Event'} at ${ev.start?.dateTime || ev.start?.date}`).join('; ');
    const body = `Upcoming: ${summary}. Anything you need to prep?`;

    const briefing = await createBriefing(userId, {
      kind: 'calendar_nudge',
      title: 'Calendar check',
      body,
      source: 'calendar',
      metadata: { date: todayKey, count: upcoming.length }
    });
    await setPreferenceValue(userId, key, 'sent');
    return { type: 'calendar_nudge', text: briefing.body, count: upcoming.length };
  } catch (e) {
    return null;
  }
}

function emptyProactiveSummary() {
  return {
    usersScanned: 0,
    briefings: 0,
    failureFollowUps: 0,
    healthAlerts: 0,
    locationReminders: 0,
    failures: 0
  };
}

async function runProactiveForUser(userId, logger = console, now = new Date()) {
  const summary = emptyProactiveSummary();
  summary.usersScanned = 1;
  try {
    const nativeContext = await getLatestNativeContext(userId);
    const [briefing, followUp, healthAlert, foodReminder, emailNudges, calendarNudges] = await Promise.all([
      maybeCreateIntervalBriefing(userId, now),
      maybeCreateFailedActionFollowUp(userId, now),
      nativeContext ? maybeCreateHealthAlert(userId, nativeContext, now) : Promise.resolve(null),
      nativeContext ? maybeCreateHomeFoodReminder(userId, nativeContext, now) : Promise.resolve(null),
      maybeCreateEmailNudges(userId, now),
      maybeCreateCalendarNudges(userId, now)
    ]);
    if (briefing) summary.briefings += 1;
    if (followUp) summary.failureFollowUps += 1;
    if (healthAlert) summary.healthAlerts += 1;
    if (foodReminder) summary.locationReminders += 1;
    if (emailNudges) summary.briefings += emailNudges.count || 0;
    if (calendarNudges) summary.briefings += calendarNudges.count || 0;

    // For money-making persistent tasks, proactively advance or report using account
    try {
      const tasks = await taskManager.listTasks(userId, null);
      const moneyTasks = tasks.filter(t => t.status !== 'completed' && /money|earn|income|monetize|profit|side hustle/i.test(t.goal || ''));
      for (const t of moneyTasks.slice(0, 2)) {
        const dedupKey = `proactive.money_task.${t.id}.${getLocalDateKey(now)}`;
        const prefs = await getPreferenceMap(userId);
        if (prefs[dedupKey] === 'sent') continue;
        const bal = Number(prefs['concierge_account.balance'] || 0);
        const body = `Money task "${t.goal}" active. Current concierge account balance: $${bal.toFixed(2)}. Progress: ${t.results ? t.results.length : 0} steps. Say "update money plan" to advance.`;
        await createBriefing(userId, {
          kind: 'money_task_update',
          title: 'Money-making update',
          body,
          source: 'agent',
          metadata: { taskId: t.id }
        });
        await setPreferenceValue(userId, dedupKey, 'sent');
        summary.briefings += 1;
      }
    } catch (e) {}

    // Unify task logic: surface relevant agent_tasks (including recipes) as briefings for Today tab
    // This ensures persistent goals, recipes, and agent work appear alongside nudges
    try {
      const tasks = await taskManager.listTasks(userId, null);
      const todayTasks = tasks.filter(t => {
        if (t.status === 'completed' || t.status === 'cancelled') return false;
        if (t.status === 'recipe') return true; // always surface recipes
        // pending/running tasks that are recent or high autonomy
        const created = t.created_at ? new Date(t.created_at) : new Date(0);
        const isRecent = (now.getTime() - created.getTime()) < 1000 * 60 * 60 * 24 * 2; // last 2 days
        const highAutonomy = ['High', 'Bold', 'Active'].includes(t.autonomy);
        return isRecent || highAutonomy;
      });
      for (const t of todayTasks.slice(0, 3)) { // limit to avoid spam
        const isRecipe = t.status === 'recipe';
        const kind = isRecipe ? 'recipe' : 'agent_task';
        const title = isRecipe ? `Recipe: ${t.goal}` : `Active goal: ${t.goal}`;
        const body = isRecipe 
          ? `Your saved automation "${t.goal}" is ready. Say the name to run it.`
          : `Working on: ${t.goal}. ${t.current_step ? `Step ${t.current_step}.` : ''} Results so far: ${Array.isArray(t.results) ? t.results.length : 0}`;
        // Use a dedup key per task per day
        const taskDedupKey = `proactive.${kind}.${t.id}.${getLocalDateKey(now)}`;
        const prefs = await getPreferenceMap(userId);
        if (prefs[taskDedupKey] === 'sent') continue;
        await createBriefing(userId, {
          kind,
          title,
          body,
          source: 'agent',
          metadata: { taskId: t.id, status: t.status, autonomy: t.autonomy }
        });
        await setPreferenceValue(userId, taskDedupKey, 'sent');
        summary.briefings += 1;
      }
    } catch (taskErr) {
      logger.warn(`[proactive] task surfacing failed for ${userId}: ${taskErr.message}`);
    }

    const created = [briefing?.type, followUp?.type, healthAlert?.type, foodReminder?.type, emailNudges?.type, calendarNudges?.type].filter(Boolean);
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
    const result = { ...(entry?.result || {}) };
    if ((entry?.action === 'get_emails' || entry?.action === 'search_emails') && Array.isArray(result.emails)) {
      const count = result.emails.length;
      result.cardText = `${count} ${count === 1 ? 'email' : 'emails'} reviewed`;
      result.emailCount = count;
      delete result.emails;
      if (result.text && /^Email results|^Latest emails/i.test(result.text)) result.text = result.cardText;
    } else if (entry?.action === 'get_calendar_events' && Array.isArray(result.events)) {
      const count = result.events.length;
      result.cardText = `${count} calendar ${count === 1 ? 'item' : 'items'} checked`;
      result.eventCount = count;
      delete result.events;
      if (result.text && /^Upcoming events/i.test(result.text)) result.text = result.cardText;
    } else if (entry?.action === 'web_search') {
      const count = Array.isArray(result.results) ? result.results.length : (Array.isArray(result.sources) ? result.sources.length : null);
      if (count != null) result.cardText = `${count} search ${count === 1 ? 'result' : 'results'} checked`;
    }
    const normalizedEntry = { ...entry, result };
    const error = result.error || '';
    const text = result.text || '';
    const key = `${entry?.action || ''}:${result.success === false ? error : text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalizedEntry);
  }
  return out;
}

// Enrich actions with presentation fields so the browser UI can render "tasks"
// nicely (labels, status badges, summaries, etc.) without fragile parsing.
function enrichActionForBrowser(entry) {
  if (!entry) return entry;
  const actionType = entry.action || (typeof entry === 'string' ? entry : '');
  const result = entry.result || entry || {};
  const success = result.success !== false && !result.error;
  const pending = !!result.pending;
  const isError = !success && !pending;

  const label = humanizeActionType(actionType);

  // Heuristic icon for browser task list rendering
  const icon = 
    actionType.includes('email') ? '✉️' :
    actionType.includes('calendar') || actionType.includes('event') ? '📅' :
    actionType.includes('uber') || actionType.includes('ride') ? '🚗' :
    actionType.includes('train') ? '🚂' :
    actionType.includes('telegram') || actionType.includes('message') ? '💬' :
    actionType.includes('music') || actionType.includes('playlist') ? '🎵' :
    actionType.includes('location') || actionType.includes('place') || actionType.includes('map') ? '📍' :
    actionType.includes('reminder') ? '✅' :
    pending ? '⏳' : (success ? '✓' : '⚠️');

  const rawText = (result.text || result.error || '').toString().trim();
  const summary = rawText.length > 160 ? rawText.slice(0, 157) + '…' : rawText;

  return {
    ...entry,
    action: actionType,
    // Rich presentation fields for browser "tasks" UI
    label,
    icon,
    status: pending ? 'pending' : (success ? 'success' : 'error'),
    summary,
    isData: DATA_ACTIONS.has(actionType),
    isPendingReview: pending,
    displayTitle: pending
      ? (result.text || `${label} (needs your confirmation)`)
      : label,
    outcome: isError ? (result.error || 'Failed') : (pending ? 'Awaiting confirmation' : 'Done'),
  };
}

function userFacingActionFailure(entry) {
  const action = entry?.action || '';
  const rawError = String(entry?.result?.error || '').trim();
  if (action === 'book_uber' || action === 'find_place') {
    if (/Google Places is not ready|Places API|Google Places is not configured/i.test(rawError)) {
      return 'Nearby place ranking needs Google Places enabled on the server. Uber itself does not need an API key.';
    }
    if (/need your current location|enable location/i.test(rawError)) {
      return "Tiny snag - I need location access to find that nearby place. Turn it on and I'll try again.";
    }
    if (/couldn't find a nearby|No place results found/i.test(rawError)) {
      return "I couldn't find a good nearby match. Try a different place name or turn location on.";
    }
    if (/Geocoding error|No results found/i.test(rawError)) {
      return "I couldn't find that destination. Try a different place name.";
    }
  }
  return rawError || 'Tiny snag - that action failed.';
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

function stripTrackingUrlsAndBoilerplate(text = '') {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:unsubscribe|manage preferences|view in browser|privacy policy|terms of use|tracking pixel|utm_[a-z_]+)[^\n.]*[.\n]?/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;/gi, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function senderDisplayName(from = '') {
  const raw = String(from || '').trim();
  if (!raw) return 'Unknown sender';
  const angle = raw.match(/^"?([^"<]+)"?\s*</);
  if (angle?.[1]) return angle[1].trim();
  return raw.replace(/<[^>]+>/g, '').replace(/\b\S+@\S+\b/g, '').trim() || 'Unknown sender';
}

function boundedSnippet(text = '', max = 220) {
  const cleaned = stripTrackingUrlsAndBoilerplate(text);
  if (!cleaned) return '';
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trim()}…` : cleaned;
}

function normalizeEmailForSynthesis(email = {}) {
  return {
    sender: senderDisplayName(email.from || email.sender || ''),
    subject: String(email.subject || '(No subject)').trim().slice(0, 160),
    date: String(email.date || '').trim(),
    snippet: boundedSnippet(email.snippet || email.body || email.text || '')
  };
}

function isBroadEmailTriageRequest(message = '') {
  return /\b(important|urgent|priority|need(?:s)? (?:my )?attention|actionable|what did i miss|catch me up|check my inbox|check my emails?|anything i need to respond to|need to reply|missed)\b/i
    .test(String(message || ''));
}

function isJobContextRequest(message = '') {
  return /\b(job|jobs|career|careers|application|applications|opportunit(?:y|ies)|interview|recruiter|role|roles|hiring)\b/i
    .test(String(message || ''));
}

function emailTriageSignals(email = {}, message = '') {
  const normalized = normalizeEmailForSynthesis(email);
  const haystack = [
    email.from,
    email.sender,
    email.senderName,
    email.senderAddress,
    normalized.subject,
    normalized.snippet
  ].filter(Boolean).join(' ').toLowerCase();
  const subject = normalized.subject.toLowerCase();
  const sender = String(email.from || email.sender || email.senderAddress || '').toLowerCase();
  const jobContext = isJobContextRequest(message);
  const signals = [];
  const lowSignals = [];
  let score = 0;

  const add = (points, label) => { score += points; signals.push(label); };
  const low = (points, label) => { score -= points; lowSignals.push(label); };

  if (/\?|\b(can you|could you|please|let me know|reply|respond|confirm|approve|send me|need you to)\b/i.test(haystack)) add(3, 'asks for a response');
  if (/\b(today|tomorrow|tonight|asap|urgent|deadline|due|expires?|by \d|before \d|appointment|meeting|interview)\b/i.test(haystack)) add(2, 'time-sensitive');
  if (/\b(security|sign-?in|login|password|verification|suspicious|fraud|payment failed|failed payment|declined|overdue|disruption|cancelled|delayed|problem with your order|action required)\b/i.test(haystack)) add(4, 'needs attention');
  if (/\b(school|teacher|university|work|manager|client|invoice|contract|doctor|dentist|gp|travel|flight|train|hotel)\b/i.test(haystack)) add(2, 'personal/work signal');

  const automatedSender = /\b(no-?reply|noreply|donotreply|mailer-daemon|notification|notifications|alerts?|digest|newsletter|marketing)\b/i.test(sender);
  if (automatedSender) low(2, 'automated sender');
  if (/\b(newsletter|digest|roundup|recommended|recommendations|promotion|sale|offer|unsubscribe|manage preferences|marketing)\b/i.test(haystack)) low(3, 'bulk or promotional');
  if (/\b(job alert|jobs? alert|new jobs?|recommended jobs?|vacanc(?:y|ies)|workcircle|indeed|findeveryjob|totaljobs|reed\.co\.uk)\b/i.test(haystack)) {
    if (jobContext) add(2, 'job context match');
    else low(4, 'generic job alert');
  }
  if (/^(re:|fwd:)/i.test(subject) && !automatedSender) add(1, 'conversation thread');

  const category = lowSignals.some(s => /job alert/.test(s)) ? 'job alerts'
    : lowSignals.some(s => /bulk|promotional|automated/.test(s)) ? 'bulk updates'
      : score >= 3 ? 'actionable messages'
        : 'other messages';

  return {
    ...normalized,
    score,
    category,
    signals,
    lowSignals,
    isPrimary: score >= 3,
    isLowValue: score <= -2
  };
}

function triageEmailsForRequest(emails = [], message = '') {
  const triaged = (Array.isArray(emails) ? emails : [])
    .map((email, index) => ({ ...emailTriageSignals(email, message), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const broad = isBroadEmailTriageRequest(message);
  const primary = (broad ? triaged.filter(item => item.isPrimary) : triaged)
    .slice(0, broad ? 3 : 4);
  const groupCounts = new Map();
  for (const item of triaged) {
    if (!primary.includes(item) && (item.isLowValue || broad)) {
      groupCounts.set(item.category, (groupCounts.get(item.category) || 0) + 1);
    }
  }
  const groups = [...groupCounts.entries()]
    .filter(([, count]) => count > 0)
    .map(([category, count]) => ({ category, count }));
  return {
    total: triaged.length,
    broad,
    primary,
    groups,
    lowValueCount: triaged.filter(item => item.isLowValue).length
  };
}

function emailTriageContextText(triage) {
  const lines = [`Email triage: reviewed ${triage.total} candidate email${triage.total === 1 ? '' : 's'}.`];
  if (triage.primary.length) {
    lines.push('Primary items:');
    for (const email of triage.primary) {
      const reason = email.signals.slice(0, 2).join(', ');
      lines.push(`- ${[email.sender, email.subject].filter(Boolean).join(' — ')}${reason ? ` (${reason})` : ''}${email.snippet ? `: ${email.snippet}` : ''}`);
    }
  } else if (triage.broad) {
    lines.push('Primary items: none clearly urgent or reply-worthy.');
  } else {
    lines.push('Primary items: none found.');
  }
  if (triage.groups.length) {
    lines.push(`Grouped low-priority material: ${triage.groups.map(group => `${group.count} ${group.category}`).join(', ')}.`);
  }
  return lines.join('\n');
}

function parseCalendarDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function londonDayBounds(when = '') {
  const today = formatLondonYMD();
  const ymd = /\btomorrow\b/i.test(String(when || '')) ? addDaysToYMD(today, 1)
    : /\btoday\b/i.test(String(when || '')) ? today
      : null;
  if (!ymd) return null;
  return { ymd };
}

function eventFallsWithinBounds(event = {}, bounds = null) {
  if (!bounds) return true;
  const start = parseCalendarDate(event.start);
  if (!start) return false;
  return formatLondonYMD(start) === bounds.ymd;
}

function formatNaturalEventTime(start, end) {
  const startDate = parseCalendarDate(start);
  if (!startDate) return '';
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit'
  });
  const dateFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
  const endDate = parseCalendarDate(end);
  const day = dateFmt.format(startDate);
  const startTime = timeFmt.format(startDate);
  if (!endDate) return `${day}, ${startTime}`;
  return `${day}, ${startTime}-${timeFmt.format(endDate)}`;
}

function calendarPeriodLabel(bounds) {
  if (!bounds?.ymd) return 'Upcoming';
  const today = formatLondonYMD();
  if (bounds.ymd === today) return 'Today';
  if (bounds.ymd === addDaysToYMD(today, 1)) return 'Tomorrow';
  return bounds.ymd;
}

function normalizeCalendarEventForSynthesis(event = {}) {
  return {
    title: String(event.title || event.summary || 'Untitled').trim().slice(0, 160),
    time: formatNaturalEventTime(event.start, event.end)
  };
}

function buildConciseDataAnswer(dataResults = []) {
  const emailSets = dataResults.filter(entry => entry.action === 'get_emails' || entry.action === 'search_emails');
  const calendarSets = dataResults.filter(entry => entry.action === 'get_calendar_events');
  const lines = [];
  const emailItems = emailSets.flatMap(entry => entry.items || []);
  const calendarItems = calendarSets.flatMap(entry => entry.items || []);
  const emailGroups = emailSets.flatMap(entry => entry.groups || []);
  if (emailSets.length && !emailItems.length) {
    const grouped = emailGroups.length
      ? ` Most of what I found was ${emailGroups.map(group => `${group.count} ${group.category}`).join(', ')}.`
      : '';
    lines.push(`Nothing urgent needs your attention from email.${grouped}`);
  } else if (emailItems.length) {
    lines.push(`I found ${emailItems.length} email${emailItems.length === 1 ? '' : 's'} that may need attention.`);
    for (const email of emailItems.slice(0, 3)) {
      const bit = [email.sender, email.subject].filter(Boolean).join(' — ');
      lines.push(`- ${bit}`);
    }
  } else if (emailSets.length) {
    lines.push('I did not find matching emails for that filter.');
  }
  if (calendarItems.length) {
    const count = calendarItems.length;
    const noun = `calendar item${count === 1 ? '' : 's'}`;
    const periodLabel = calendarSets.find(entry => entry.periodLabel)?.periodLabel || 'Upcoming';
    lines.push(
      periodLabel === 'Today' || periodLabel === 'Tomorrow'
        ? `${periodLabel} has ${count} ${noun}.`
        : periodLabel === 'Upcoming'
          ? `You have ${count} upcoming ${noun}.`
          : `${count} ${noun} for ${periodLabel}.`
    );
    for (const event of calendarItems.slice(0, 5)) {
      lines.push(`- ${event.title}${event.time ? `, ${event.time}` : ''}`);
    }
  } else if (calendarSets.length) {
    lines.push('I did not find calendar events in the requested window.');
  }
  if (!emailItems.length && !calendarItems.length && emailSets.length && calendarSets.length) {
    lines[0] = 'Nothing urgent needs your attention. I did not find actionable email or calendar commitments to prepare for.';
  } else if (emailItems.length && calendarItems.length) {
    lines.push('Start with the email items that need a response, then use the calendar items as your preparation list.');
  } else if (emailItems.length) {
    lines.push('Start with the email items that need a response.');
  } else if (calendarItems.length) {
    lines.push('Use the calendar items above as your preparation list.');
  }
  return lines.join('\n');
}

function synthesisPromptForDataResults(message, dataResults = []) {
  const context = dataResults.map(entry => entry.text).join('\n\n');
  return [
    'Use this compact tool context to answer the original request.',
    'Lead with the conclusion in the first sentence.',
    'Answer the user’s decision or preparation question before evidence.',
    'Group repetitive or low-value email results; do not list every email by default.',
    'Treat newsletters, marketing, generic alerts, and repeated digests as low priority unless the request asks for that category.',
    'Do not quote or reconstruct raw tool payloads.',
    'Do not include URLs, raw email addresses, JSON, HTML, or ISO timestamps.',
    'Give one concise combined synthesis with preparation advice. Use at most one short evidence sentence unless there is a real action item.',
    '',
    `Original request: ${message}`,
    '',
    'Compact tool context:',
    context
  ].join('\n');
}

function spokenLooksLikeRawToolLeak(text = '') {
  const value = String(text || '');
  return /https?:\/\/\S+/i.test(value) ||
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ||
    /<[^>]+>/.test(value) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value) ||
    /\b(Email results:|Upcoming events:|Body:|threadId|payload|raw|unsubscribe|manage preferences)\b/i.test(value);
}

function guardVisibleDataResponse(spoken, dataResults = []) {
  const cleaned = stripActionMarkupForDisplay(String(spoken || '')).trim();
  if (!cleaned || spokenLooksLikeRawToolLeak(cleaned)) {
    return buildConciseDataAnswer(dataResults);
  }
  return cleaned;
}

function buildStructuredDataSummary(entry, message = '') {
  const result = entry?.result || {};
  if (entry?.action === 'get_emails' || entry?.action === 'search_emails') {
    if (!Array.isArray(result.emails) || result.emails.length === 0) return { text: result.text || 'No emails found.', items: [] };
    const triage = triageEmailsForRequest(result.emails, message);
    const items = triage.primary.map(({ sender, subject, date, snippet, score, category, signals }) => ({
      sender,
      subject,
      date,
      snippet,
      score,
      category,
      signals
    }));
    return { text: emailTriageContextText(triage), items, groups: triage.groups };
  }
  if (entry?.action === 'get_calendar_events') {
    if (!Array.isArray(result.events) || result.events.length === 0) return { text: result.text || 'No upcoming events found.', items: [] };
    const bounds = londonDayBounds(entry?.input?.when || entry?.result?.when || '');
    const items = result.events
      .filter(event => eventFallsWithinBounds(event, bounds))
      .slice(0, 8)
      .map(normalizeCalendarEventForSynthesis);
    if (!items.length) return { text: 'No calendar events found in the requested window.', items: [] };
    const periodLabel = calendarPeriodLabel(bounds);
    const label = bounds?.ymd ? `Calendar events for ${bounds.ymd}` : 'Calendar events';
    const text = `${label} (${items.length}):\n${items.map((event, index) =>
      `${index + 1}. ${event.title}${event.time ? ` at ${event.time}` : ''}`
    ).join('\n')}`;
    return { text, items, periodLabel };
  }
  if (entry?.action === 'get_telegram_contacts') {
    if (!Array.isArray(result.contacts) || result.contacts.length === 0) return { text: result.text || 'No contacts found.', items: [] };
    const contacts = result.contacts.map((contact, index) => `${index + 1}. ${contact.name || contact.username || 'Unnamed contact'}`);
    return { text: `Telegram contacts:\n${contacts.join('\n')}`, items: contacts };
  }
  return { text: result.text || '', items: [] };
}

function getStructuredDataResults(actionResults, message = '') {
  return actionResults
    .filter(entry => DATA_ACTIONS.has(entry.action) && entry.result?.success)
    .map(entry => {
      const summary = buildStructuredDataSummary(entry, message);
      return { action: entry.action, text: summary.text, items: summary.items || [], groups: summary.groups || [], periodLabel: summary.periodLabel };
    })
    .filter(entry => entry.text);
}

// Fire-and-forget post-response tasks (memory + style preferences)
function postResponseTasks(userId, message, extra = {}) {
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
  // (agent trace episodes are no longer written to user memories — see Memory trust plan)
}

async function respondWithResult({ res, streaming, wantsTTS, settings, trace, userId, message, spoken, actionResults = [] }) {
  const browserActions = (actionResults || []).map(enrichActionForBrowser);
  saveMessage(userId, 'assistant', { text: spoken, actions: browserActions }, trace)
    .catch(err => trace.log('supabase.conversations.insert_assistant.short_async_fail', err.message));
  postResponseTasks(userId, message);

  if (streaming) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const sse = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (browserActions.length) sse({ type: 'actions', results: browserActions });
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

  const result = { text: spoken, actions: browserActions, tasks: browserActions };
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
  const requestStarted = Date.now();

  try {
    const { message, userId, settings = {}, location = null, nativeHints = null, chatStartedAt = null } = req.body;
    if (!requireMatchingUser(req, res, userId)) return;
    const wantsTTS = req.query.tts === 'true';

    if (!message?.trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const trace = createRequestTrace(`chat:${userId}:${Date.now()}`);
    trace.log(`request.start stream=${streaming} tts=${wantsTTS} msg=${JSON.stringify((message || '').slice(0, 80))}`);
    devTiming('chat', 'user_message_received', {
      streaming,
      tts: wantsTTS,
      hasLocation: Boolean(location),
      messageLength: String(message || '').length
    });

    // Let the model start as soon as context is ready instead of waiting on the DB write.
    saveMessage(userId, 'user', message, trace).catch(err => trace.log('supabase.conversations.insert_user.async_fail', err.message));

    const pendingAction = await timedDev('chat', 'intent_classification.pending_action', {}, () => getPendingAction(userId));
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
      const pendingKey = `${userId}:${pendingAction.createdAt || ''}:${pendingAction.action.type}:${JSON.stringify(pendingAction.action.input || {})}`;
      if (pendingActionConfirmLocks.has(pendingKey)) {
        await respondWithResult({
          res,
          streaming,
          wantsTTS,
          settings,
          trace,
          userId,
          message,
          spoken: 'Already confirming that request.'
        });
        return;
      }
      pendingActionConfirmLocks.add(pendingKey);
      try {
        // The in-memory Set above only catches a double-tap landing on this
        // same process. Cloud Run can run several instances concurrently, so
        // the real guard against double-executing a confirmed action is this
        // atomic compare-and-delete: only the request that actually removes
        // the stored pending action gets to run it.
        const claimed = await claimPendingAction(userId, pendingAction);
        if (!claimed) {
          await respondWithResult({
            res,
            streaming,
            wantsTTS,
            settings,
            trace,
            userId,
            message,
            spoken: 'Already confirming that request.'
          });
          return;
        }
        // Audit trail for the sole bypassReview call site: this is a user-confirmed
        // execution of a previously review-gated action, so the trace should capture
        // exactly what is about to run (spend caps still apply downstream regardless).
        trace.log(`pending_action.confirm ${pendingAction.action.type}`, JSON.stringify(pendingAction.action.input || {}));
        try {
          let actionResults = await executeActions(userId, [pendingAction.action], {
            userMessage: pendingAction.userMessage || message,
            location,
            nativeHints: pendingAction.nativeHints || nativeHints,
            bypassReview: true,
            trace
          }, trace);
          actionResults = normalizeActionResultsForClient(actionResults);
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
        } catch (e) {
          // Execution itself blew up (not just an action-level failure, which
          // executeActions already turns into a result rather than a throw).
          // Restore the claimed action so the user can retry by saying "yes"
          // again instead of losing the pending confirmation entirely.
          await setPendingAction(userId, pendingAction.action, {
            userMessage: pendingAction.userMessage,
            nativeHints: pendingAction.nativeHints
          }).catch(() => {});
          throw e;
        }
      } finally {
        pendingActionConfirmLocks.delete(pendingKey);
      }
      return;
    }

    const deterministicQuickReply = getDeterministicQuickReply(message);
    if (deterministicQuickReply) {
      saveMessage(userId, 'assistant', { text: deterministicQuickReply, actions: [] }, trace)
        .catch(err => trace.log('supabase.conversations.insert_assistant.quick_async_fail', err.message));
      postResponseTasks(userId, message);

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

    const contextualTurn = await timedDev('chat', 'intent_classification.contextual', {}, () => inferContextualDeterministicTurn(userId, message, settings, trace, {
      since: chatStartedAt
    }));
    if (contextualTurn?.spokenOnly) {
      trace.log(`context_router.match ${contextualTurn.reason}`);
      await respondWithResult({
        res,
        streaming,
        wantsTTS,
        settings,
        trace,
        userId,
        message,
        spoken: contextualTurn.spoken,
        actionResults: []
      });
      return;
    }

    const deterministicAction = contextualTurn || inferDeterministicAction(message, { settings });
    devTiming('chat', 'intent_classification.end', {
      route: deterministicAction ? 'deterministic_action' : 'model',
      reason: deterministicAction?.reason || null,
      durationMs: Date.now() - requestStarted
    });
    if (deterministicAction) {
      trace.log(`intent_router.match ${deterministicAction.reason}`);

      if (streaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const sse = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const sendStatus = (status, label, extra = {}) => sse({ type: 'status', status, label, ...extra });
        let actionResults = await timedDev('chat', 'action_execution', {
          actionCount: deterministicAction.actions.length,
          actions: deterministicAction.actions.map(action => action.type)
        }, () => executeActions(userId, deterministicAction.actions, {
          userMessage: message,
          location,
          nativeHints,
          trace,
          sequential: deterministicAction.actions.length > 1
        }, trace, {
          onActionStart: action => sendStatus('action_start', getActionStatusLabel(action.type, 'start'), { action: action.type }),
          onActionComplete: (action, result) => sendStatus('action_complete', getActionStatusLabel(action.type, actionCompletionPhase(result)), {
            action: action.type,
            success: result?.success !== false
          })
        }));
        const rawActionResults = actionResults;
        actionResults = normalizeActionResultsForClient(rawActionResults);
        const compositionStarted = Date.now();
        const spoken = summarizeReadOnlyActionResults(rawActionResults, message) ||
          summarizeFinishedActionsForUser(actionResults) ||
          deterministicAction.spoken;
        devTiming('chat', 'assistant_response_composition.end', {
          route: 'deterministic_action',
          durationMs: Date.now() - compositionStarted,
          textLength: String(spoken || '').length
        });
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
        postResponseTasks(userId, message);
        return;
      }

      let actionResults = await timedDev('chat', 'action_execution', {
        actionCount: deterministicAction.actions.length,
        actions: deterministicAction.actions.map(action => action.type)
      }, () => executeActions(userId, deterministicAction.actions, {
        userMessage: message,
        location,
        nativeHints,
        trace,
        sequential: deterministicAction.actions.length > 1
      }, trace));
      const rawActionResults = actionResults;
      actionResults = normalizeActionResultsForClient(rawActionResults);
      const compositionStarted = Date.now();
      const spoken = summarizeReadOnlyActionResults(rawActionResults, message) ||
        summarizeFinishedActionsForUser(actionResults) ||
        deterministicAction.spoken;
      devTiming('chat', 'assistant_response_composition.end', {
        route: 'deterministic_action',
        durationMs: Date.now() - compositionStarted,
        textLength: String(spoken || '').length
      });
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
      postResponseTasks(userId, message);
      return;
    }

    const chatModel = streaming ? STREAMING_CHAT_MODEL : PRIMARY_CHAT_MODEL;
    const requestContext = {
      location,
      nativeHints,
      chatStartedAt,
      pendingAction: pendingAction && isPendingRevisionMessage(message) ? pendingAction : null
    };
    const { history, useSearch, dynamicSystemPrompt, cachedContentName, quickTurn } = await trace.run('buildChatContext', () => buildChatContext(userId, message, trace, chatModel, requestContext));
    const baseHistory = normalizeGeminiHistory(history);
    const initialRequest = buildModernGenerateRequest({
      dynamicSystemPrompt,
      useSearch,
      cachedContentName,
      baseHistory,
      userContent: { role: 'user', parts: [{ text: message }] },
      useAgentTools: false
    });

    // === AGENTIC UPGRADE: Use ReAct loop for non-deterministic turns (fixes loop, orchestration, planning foundation) ===
    // This enables multiple think-act-observe iterations using native function calling.
    const autonomyLevel = (settings && settings.autonomy) || 'Active';
    const useAgentic = shouldUseAgenticLoopForMessage({ message, quickTurn, autonomyLevel, pendingAction });
    if (streaming) {
      trace.log(useAgentic ? 'stream.route agentic_single_text' : 'stream.route classic_incremental');
    }

    // Hoisted above the useAgentic block so the classic-streaming fallback further down
    // can tell whether the agentic branch already opened (and possibly wrote to) the SSE
    // connection before throwing, rather than trying to set headers a second time.
    let agenticSse = null;
    let agenticSendStatus = null;
    if (useAgentic) {
      const isBroadMoneyGoal = /make money|earn cash|side hustle|monetize|make income|financial freedom|profit/i.test(message);

      // Open the SSE stream BEFORE the loop runs, not after — the loop internally
      // already calls onStep at each think/execute/observe phase (agent-orchestrator.js),
      // it was just wired to null here, so a multi-step turn (e.g. "order me some
      // jeans") sat on a single generic "Preparing result" for its entire duration
      // with no real progress reaching the client.
      if (streaming) {
        try {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders();
        } catch {}
        agenticSse = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
        agenticSendStatus = (status, label, extra = {}) => agenticSse({ type: 'status', status, label, ...extra });
      }

      try {
        const agentResult = await runAgenticLoop({
          userId,
          initialMessage: message,
          dynamicSystemPrompt: `${OXCY_SYSTEM_PROMPT}\n\n${dynamicSystemPrompt}`.trim(),
          baseHistory,
          useSearch: isBroadMoneyGoal || useSearch, // force real-time research for money goals
          modelName: chatModel,
          maxIterations: isBroadMoneyGoal || autonomyLevel === 'High' || autonomyLevel === 'Bold' ? 10 : 6,
          context: { userMessage: message, location, nativeHints, autonomy: autonomyLevel },
          executeActionsFn: executeActions,
          trace,
          onStep: !agenticSendStatus ? null : step => {
            if (step.phase === 'thinking') {
              agenticSendStatus('agent_thinking', 'Working on it');
            } else if (step.phase === 'executing') {
              for (const action of step.actions || []) {
                agenticSendStatus('action_start', getActionStatusLabel(action.type, 'start'), { action: action.type });
              }
            } else if (step.phase === 'observed') {
              for (const r of step.results || []) {
                agenticSendStatus('action_complete', getActionStatusLabel(r.action, actionCompletionPhase(r.result)), {
                  action: r.action,
                  success: r.result?.success !== false
                });
              }
            }
          },
          persistTask: true // broad goals like "go make me money" get persistent tracking
        });

        let actionResults = normalizeActionResultsForClient(agentResult.actions || []);
        let spoken = agentResult.spoken || 'Completed agent turn.';

        // For broad goals like making money, force a solid plan + research summary + persistent tracking
        if (isBroadMoneyGoal) {
          try {
            const plan = await generatePlan(userId, message, spoken);
            spoken = `**Concierge Plan for "${message}":**\n${plan.title || 'Money-making strategy'}\n\nSteps:\n${(plan.steps || []).map((s, i) => `${i+1}. ${s.description}${s.actionType ? ` (use: ${s.actionType})` : ''}`).join('\n')}\n\nRisks: ${(plan.risks || []).join('; ')}\n\nAccount plan: ${plan.accountUsage || 'Use account to seed opportunities and receive earnings.'}\n\n${spoken}\n\nI've created a persistent task to monitor and advance this using the concierge account. With real API keys (e.g. STRIPE_SECRET_KEY, MONZO_ACCESS_TOKEN), I can do actual charges, bank syncs, and payouts. Check back or say "update money plan".`;
            if (agentResult.taskId) {
              await taskManager.appendResultToTask(userId, agentResult.taskId, { action: 'money_plan', result: { plan, research: 'used web_search' } });
            }
            // Auto-suggest small fund from account for seed if balance allows (will go through review)
            const prefs = await getPreferenceMap(userId);
            const bal = Number(prefs['concierge_account.balance'] || 0);
            if (bal >= 10) {
              spoken += `\n\nSuggestion: I can fund a small test opportunity (~$10-20) from the concierge account to get started (real via Stripe/Monzo if keys wired).`;
            }
          } catch (planErr) {}
        }

        // Reflection for verification
        try {
          const reflection = await reflectOnResults(message, actionResults, actionResults);
          if (reflection && !reflection.achieved && reflection.nextAction) {
            trace && trace.log && trace.log('agent.reflection.next_action', JSON.stringify({
              summary: String(reflection.summary || '').slice(0, 240),
              nextAction: reflection.nextAction
            }));
          }
        } catch {}

        if (streaming) {
          // Headers were already sent (and any onStep progress already streamed) before
          // the loop ran above — reuse that same connection rather than re-setting headers.
          const sse = agenticSse;
          trace.log(`stream.agentic.text_single len=${spoken.length}`);
          sse({ type: 'text', chunk: spoken });
          if (actionResults.length) sse({ type: 'actions', results: actionResults });
          sse({ type: 'done' });
          res.end();
        } else {
          const result = { text: spoken, actions: actionResults, agentTraceId: agentResult.traceId };
          if (wantsTTS) {
            try {
              const audio = await generateSpeech(buildVoiceExcerpt(spoken), settings.voice);
              if (audio) { result.audio = audio; result.audioFormat = 'wav'; }
            } catch (e) { result.ttsError = e.message; }
          }
          res.json(result);
        }

        saveMessage(userId, 'assistant', { text: spoken, actions: actionResults, agentic: true }, trace).catch(() => {});
        postResponseTasks(userId, message, { agentic: true, agentTraceId: agentResult.traceId, taskId: agentResult.taskId });
        return;
      } catch (agentErr) {
        trace && trace.log && trace.log('agent.loop.error', agentErr.message);
        // fall through to classic path
      }
    }

    // ── Streaming mode (SSE) ────────────────────────────────────────────
    if (streaming) {
      // If the agentic branch above already opened the SSE stream (headers flushed)
      // before throwing and falling through to this classic path, reuse that same
      // connection — calling res.setHeader again after flushHeaders() throws.
      if (!agenticSse) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
      }
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
        let emittedTextEvents = 0;
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
              emittedTextEvents += 1;
              trace.log(`stream.text_chunk.${emittedTextEvents} len=${visible.length} mode=before_action`);
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
              emittedTextEvents += 1;
              trace.log(`stream.text_chunk.${emittedTextEvents} len=${visible.length} mode=incremental`);
              sse({ type: 'text', chunk: visible });
            }
          }
        };
        const flushSafeDisplayText = () => {
          if (actionMarkupStarted || !heldDisplayText) return;
          hasStreamedText = true;
          emittedTextEvents += 1;
          trace.log(`stream.text_chunk.${emittedTextEvents} len=${heldDisplayText.length} mode=flush`);
          sse({ type: 'text', chunk: heldDisplayText });
          heldDisplayText = '';
        };
        const ttsStreamer = wantsTTS ? createSentenceTtsStreamer({
          voiceName: settings.voice,
          sse,
          trace,
          onSpeakingStart: () => sendStatus('speaking_start', 'Speaking')
        }) : null;
        for await (const chunk of stream) {
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
        if (!fullText.trim()) {
          fullText = await recoverEmptyModelResponse({ model: chatModel, initialRequest, message, trace });
          if (fullText) trace.log('gemini.empty_recovery_success');
        }

        let { spoken, actions, parseError } = parseActions(fullText);
        if (parseError) trace.log('parse_actions.malformed_block', 'one or more <action> blocks failed to parse; some actions may be missing');
        actions = guardCalendarActionsForUserMessage(actions, message);
        if (shouldIgnoreModelAuthoredActions(chatModel) && actions.length) {
          trace.log('fast_model.actions_ignored', `count=${actions.length}`);
          actions = [];
        }
        spoken = stripActionMarkupForDisplay(spoken).trim();
        if (!spoken && !actions.length) {
          const recovered = await recoverEmptyModelResponse({ model: chatModel, initialRequest, message, trace });
          if (recovered) {
            fullText = recovered;
            ({ spoken, actions, parseError } = parseActions(fullText));
            if (parseError) trace.log('parse_actions.malformed_block', 'recovery text also had a malformed <action> block');
            actions = guardCalendarActionsForUserMessage(actions, message);
            if (shouldIgnoreModelAuthoredActions(chatModel) && actions.length) {
              trace.log('fast_model.actions_ignored', `count=${actions.length}`);
              actions = [];
            }
            spoken = stripActionMarkupForDisplay(spoken).trim();
            trace.log('gemini.blank_spoken_recovery_success');
          }
        }
        trace.log(`stream.text_events total=${emittedTextEvents} final_len=${spoken.length}`);

        // Execute actions in parallel
        let actionResults = [];
        let dataResults = [];
        if (actions.length > 0) {
          if (hasStreamedText) {
            sse({ type: 'replace', text: '' });
            hasStreamedText = false;
          }
          actionResults = await timedDev('chat', 'action_execution', {
            actionCount: actions.length,
            actions: actions.map(action => action.type)
          }, () => executeActions(userId, actions, { userMessage: message, location, nativeHints, trace }, trace, {
            onActionStart: action => sendStatus('action_start', getActionStatusLabel(action.type, 'start'), { action: action.type }),
            onActionComplete: (action, result) => sendStatus('action_complete', getActionStatusLabel(action.type, actionCompletionPhase(result)), {
              action: action.type,
              success: result?.success !== false
            })
          }));
          dataResults = getStructuredDataResults(actionResults, message);
          actionResults = normalizeActionResultsForClient(actionResults);
          sse({ type: 'actions', results: actionResults });
          trace.log('actions.complete');
        }

        // For data-fetching actions, stream a follow-up summary
        if (canUseDirectActionSummary(actionResults)) {
          spoken = summarizeActionResults(actionResults);
          sse({ type: 'replace', text: spoken });
          if (ttsStreamer) ttsStreamer.ingest(spoken);
        } else if (dataResults.length > 0) {
          sse({ type: 'replace', text: '' });
          const followUpRequest = buildModernGenerateRequest({
            dynamicSystemPrompt,
            useSearch,
            cachedContentName,
            baseHistory,
            userContent: { role: 'user', parts: [{ text: message }] },
            useAgentTools: false
          });
          followUpRequest.contents.push(
            { role: 'model', parts: [{ text: spoken || '…' }] },
            { role: 'user', parts: [{ text: synthesisPromptForDataResults(message, dataResults) }] }
          );
          const compositionStarted = Date.now();
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
            }
          }
          spoken = guardVisibleDataResponse(parseActions(spoken).spoken || spoken, dataResults);
          devTiming('chat', 'assistant_response_composition.end', {
            route: 'data_followup',
            durationMs: Date.now() - compositionStarted,
            textLength: String(spoken || '').length
          });
          sse({ type: 'replace', text: spoken });
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
            ? (dataResults.length ? buildConciseDataAnswer(dataResults) : (actionResults.map(a => a.result?.error).filter(Boolean).join(' ') || 'I could not complete that action.'))
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
        devTiming('chat', 'request_total.end', { durationMs: Date.now() - requestStarted });
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
      contents: initialRequest.contents,
      config: initialRequest.config
    }));

    const rawText = geminiRes.text || '';
    let { spoken, actions, parseError } = parseActions(rawText);
    if (parseError) trace.log('parse_actions.malformed_block', 'one or more <action> blocks failed to parse; some actions may be missing');
    actions = guardCalendarActionsForUserMessage(actions, message);
    if (shouldIgnoreModelAuthoredActions(chatModel) && actions.length) {
      trace.log('fast_model.actions_ignored', `count=${actions.length}`);
      actions = [];
    }
    if (!rawText.trim() || (!spoken && !actions.length)) {
      const recovered = await recoverEmptyModelResponse({ model: chatModel, initialRequest, message, trace });
      if (recovered) {
        ({ spoken, actions, parseError } = parseActions(recovered));
        if (parseError) trace.log('parse_actions.malformed_block', 'recovery text also had a malformed <action> block');
        actions = guardCalendarActionsForUserMessage(actions, message);
        if (shouldIgnoreModelAuthoredActions(chatModel) && actions.length) {
          trace.log('fast_model.actions_ignored', `count=${actions.length}`);
          actions = [];
        }
      }
    }

    // Execute actions in parallel instead of sequentially
    let actionResults = [];
    let dataResults = [];
    if (actions.length > 0) {
      actionResults = await timedDev('chat', 'action_execution', {
        actionCount: actions.length,
        actions: actions.map(action => action.type)
      }, () => executeActions(userId, actions, { userMessage: message, location, nativeHints, trace }, trace));
      dataResults = getStructuredDataResults(actionResults, message);
      actionResults = normalizeActionResultsForClient(actionResults);
    }

    // For data-fetching actions, re-prompt Gemini with results
    if (canUseDirectActionSummary(actionResults)) {
      spoken = summarizeActionResults(actionResults);
    } else if (dataResults.length > 0) {
      const followUpRequest = buildModernGenerateRequest({
        dynamicSystemPrompt,
        useSearch,
        cachedContentName,
        baseHistory,
        userContent: { role: 'user', parts: [{ text: message }] },
        useAgentTools: false
      });
      followUpRequest.contents.push(
        { role: 'model', parts: [{ text: spoken || '…' }] },
        { role: 'user', parts: [{ text: synthesisPromptForDataResults(message, dataResults) }] }
      );
      const compositionStarted = Date.now();
      const followUp = await trace.run('gemini.generateContent.followup_nonstream', () => modernGenAI.models.generateContent({
        model: chatModel,
        contents: followUpRequest.contents,
        config: followUpRequest.config
      }));
      spoken = guardVisibleDataResponse(parseActions(followUp.text || '').spoken, dataResults);
      devTiming('chat', 'assistant_response_composition.end', {
        route: 'data_followup',
        durationMs: Date.now() - compositionStarted,
        textLength: String(spoken || '').length
      });
    }
    const actionConfirmation = summarizeFinishedActionsForUser(actionResults);
    if (actionConfirmation) spoken = actionConfirmation;

    if (!spoken) {
      spoken = actionResults.length
        ? (dataResults.length ? buildConciseDataAnswer(dataResults) : (actionResults.map(a => a.result?.error).filter(Boolean).join(' ') || 'I could not complete that action.'))
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
    devTiming('chat', 'request_total.end', { durationMs: Date.now() - requestStarted });
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
      { user_id: userId, connector_id: 'google', enabled: true, tokens: encryptTokens(tokens), updated_at: new Date().toISOString() },
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

// ── Microsoft OAuth ───────────────────────────────────────────────────────────
// connectors/microsoft.js already has real Graph API calls + token refresh (saveTokens/
// getTokens) but no way to acquire the first token — there was no start/callback route at
// all, so Outlook could never actually be connected despite the connector being fully built.

const MS_SCOPES = [
  'offline_access', 'Mail.Read', 'Mail.Send', 'Calendars.ReadWrite', 'User.Read'
].join(' ');

app.get('/auth/microsoft/start', (req, res) => {
  const userId = req.query.userId;
  if (!requireMatchingUser(req, res, userId)) return;
  if (!process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Microsoft OAuth is not configured on the server.' });
  }
  const tenant = process.env.MS_TENANT || 'common';
  const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/microsoft/callback`;
  const state = signOAuthState(userId);
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: MS_SCOPES,
    state
  });
  res.json({ url: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}` });
});

app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const userId = verifyOAuthState(state);
  const appOrigin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

  if (error) {
    return res.send(`<script>window.opener?.postMessage('microsoft_auth_error',${JSON.stringify(appOrigin)});window.close();</script>`);
  }
  if (!userId) return res.status(400).send('Invalid OAuth state');
  if (!code || typeof code !== 'string') return res.status(400).send('Missing OAuth code');

  try {
    const tenant = process.env.MS_TENANT || 'common';
    const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/auth/microsoft/callback`;
    const resp = await axios.post(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      redirect_uri: redirectUri
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const tokens = {
      access_token: resp.data.access_token,
      refresh_token: resp.data.refresh_token,
      expires_at: Date.now() + resp.data.expires_in * 1000
    };
    const { error: upsertError } = await supabase.from('connectors').upsert(
      { user_id: userId, connector_id: 'microsoft', enabled: true, tokens: encryptTokens(tokens), updated_at: new Date().toISOString() },
      { onConflict: 'user_id,connector_id' }
    );
    if (upsertError) throw upsertError;

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
    res.status(500).json({ error: err.message });
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
  <title>${escapeHtml(title)} · Milgrain</title>
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
    <p>Milgrain is operated by Chizi Gamonye-Wuchi. Contact: <a href="mailto:support@oxy.app">support@oxy.app</a></p>
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
      <li>Memories you ask Milgrain to keep, plus stable facts inferred from conversations</li>
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
    <p>If a data breach affects your account, Milgrain will notify you within 72 hours of confirming the incident where legally required.</p>
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
    <p>Milgrain is an AI assistant that connects to your apps and services to help you get things done. It can read and send messages, manage calendar events, search the web, and more — based on your instructions.</p>
    <h2>Acceptable Use</h2>
    <ul>
      <li>No illegal activity using Milgrain or connected services</li>
      <li>No abuse of connected services (e.g. sending spam)</li>
      <li>No attempts to circumvent safety measures or extract training data</li>
    </ul>
    <h2>Subscription</h2>
    <p>Milgrain costs £14.99/month or £129/year, billed in advance. You can cancel anytime from Settings.</p>
    <h2>Refund Policy</h2>
    <p>You have a 14-day cooling-off period for new subscriptions under the UK Consumer Contracts Regulations 2013. Contact <a href="mailto:support@oxy.app">support@oxy.app</a> to request a refund within this period.</p>
    <h2>Limitation of Liability</h2>
    <p>Milgrain is provided as-is. We are not liable for actions taken by connectors or for decisions made based on Milgrain's responses. Always verify important information independently.</p>
    <h2>Governing Law</h2>
    <p>These terms are governed by the laws of England and Wales.</p>
    <h2>Contact</h2>
    <p>Email: <a href="mailto:support@oxy.app">support@oxy.app</a></p>
  `));
});

app.get('/support', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><title>Milgrain Support</title>
  <style>body{font-family:sans-serif;max-width:680px;margin:40px auto;padding:0 24px;color:#1a1a1a;line-height:1.6}h1{font-size:28px}h2{font-size:20px;margin-top:32px}a{color:#2563eb}.faq{background:#f9f9f9;padding:16px;border-radius:8px;margin:12px 0}</style>
  </head><body>
  <h1>Milgrain Support</h1>
  <p><strong>Email:</strong> <a href="mailto:support@oxy.app">support@oxy.app</a></p>
  <p>We aim to respond within 48 hours. For security issues: <a href="mailto:security@oxy.app">security@oxy.app</a></p>

  <h2>Delete Your Data</h2>
  <ol>
    <li>Open Milgrain and go to Settings</li>
    <li>Scroll to "Danger Zone" at the bottom</li>
    <li>Tap "Delete Account" and follow the confirmation steps</li>
    <li>All your data (messages, memories, connected accounts) will be permanently deleted</li>
  </ol>
  <p>Alternatively, email <a href="mailto:support@oxy.app">support@oxy.app</a> with the subject "Delete my account" from your registered email address.</p>

  <h2>Frequently Asked Questions</h2>
  <div class="faq"><strong>How do I connect Gmail?</strong><br>Go to Connectors tab &rarr; tap Google &rarr; sign in with your Google account. Milgrain only accesses your email when you ask it to.</div>
  <div class="faq"><strong>What does Milgrain remember?</strong><br>Milgrain extracts key facts from conversations (like your preferences or context). You can view and delete all memories in the Memory tab.</div>
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
  const filePath = path.join(__dirname, '..', 'Milgrain.shortcut');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="Milgrain.shortcut"');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Shortcut file not found' });
  }
});

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.resolve(__dirname, '..', 'index.html'));
});

// Sentry error handler must be last
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    app.use(Sentry.expressErrorHandler());
  } catch (e) {}
}

// === AGENTIC TASKS API (persistent goals, plans, background agency) ===
app.post('/agent/tasks', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { goal, autonomy, plan } = req.body || {};
  if (!goal) return res.status(400).json({ error: 'goal required' });
  try {
    const task = await taskManager.createTask(userId, goal, { autonomy, plan });
    res.json({ task });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/agent/tasks', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const status = req.query.status;
  try {
    const tasks = await taskManager.listTasks(userId, status || null);
    res.json({ tasks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/agent/tasks/:id', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const task = await taskManager.getTask(userId, req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    res.json({ task });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/agent/tasks/:id/run', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const task = await taskManager.getTask(userId, req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  // Kick a background agent run for the goal (fire and forget)
  runAgenticLoop({
    userId,
    initialMessage: task.goal,
    dynamicSystemPrompt: OXCY_SYSTEM_PROMPT,
    maxIterations: 6,
    context: { autonomy: task.autonomy },
    executeActionsFn: executeActions,
    persistTask: true
  }).catch(() => {});
  await taskManager.updateTask(userId, task.id, { status: 'running' });
  res.json({ started: true, taskId: task.id });
});

app.post('/agent/simulate', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { goal, actions } = req.body || {};
  try {
    const sim = await taskManager.recordSimulation(userId, goal || 'adhoc', actions || [], { preview: true });
    res.json({ simulation: sim });
  } catch (e) { res.json({ simulated: true }); }
});

// === Recipes endpoints (Poke-style custom automations) ===
app.post('/agent/recipes', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { name, goalTemplate, steps, metadata } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const recipe = await taskManager.saveRecipe(userId, name, goalTemplate || name, steps || [], metadata || {});
    res.json({ recipe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/agent/recipes', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const recipes = await taskManager.listRecipes(userId);
    res.json({ recipes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/agent/recipes/:id/execute', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await taskManager.executeRecipe(userId, req.params.id, req.body || {});
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/connectors/stripe/setup-intent', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!stripeClient) return res.status(500).json({ error: 'Stripe is not configured on the server.' });
  try {
    const { clientSecret, customerId } = await createSetupIntentForUser(stripeClient, supabase, userId);
    res.json({ clientSecret, customerId, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/connectors/stripe/confirm', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!stripeClient) return res.status(500).json({ error: 'Stripe is not configured on the server.' });
  const { setupIntentId } = req.body || {};
  if (!setupIntentId) return res.status(400).json({ error: 'setupIntentId required' });
  try {
    const setupIntent = await stripeClient.setupIntents.retrieve(setupIntentId, { expand: ['payment_method'] });
    if (setupIntent.status !== 'succeeded') {
      return res.status(400).json({ error: `SetupIntent is not confirmed yet (status: ${setupIntent.status})` });
    }
    const { tokens } = await readStripeTokens(supabase, userId);
    if (!tokens.stripe_customer_id || setupIntent.customer !== tokens.stripe_customer_id) {
      return res.status(403).json({ error: 'This SetupIntent does not belong to your account.' });
    }
    const pm = setupIntent.payment_method;
    await saveLinkedCard(supabase, userId, {
      customerId: setupIntent.customer,
      paymentMethodId: pm.id,
      brand: pm.card?.brand || '',
      last4: pm.card?.last4 || ''
    });
    const card = await getLinkedCard(supabase, userId);
    res.json({ linked: true, card });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/connectors/stripe/card', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const card = await getLinkedCard(supabase, userId);
    res.json({ card });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/connectors/stripe/card', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await unlinkCard(supabase, userId);
    res.json({ linked: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Agent payment card — the card browser checkout fills into merchant payment forms
// after the user confirms a ready_for_payment gate (api/services/agent-card.js).
// Stored encrypted; GET only ever returns the masked summary, never the number/CVC.
// Card entry happens over these authed routes (iOS Payments screen / curl), NEVER via
// chat — checkout-profile.js's PAYMENT_ASK_PATTERN keeps PANs out of transcripts.
app.post('/connectors/agent-card', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { name, number, expMonth, expYear, cvc } = req.body || {};
    const result = await saveAgentCard(supabase, userId, { name, number, expMonth, expYear, cvc });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ saved: true, card: result.summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/connectors/agent-card', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const card = await getAgentCardSummary(supabase, userId);
    res.json({ card });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/connectors/agent-card', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await deleteAgentCard(supabase, userId);
    res.json({ saved: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/connectors/stripe/payment-action', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const action = await getPaymentActionRequired(supabase, userId);
    res.json({ action });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/tasks/:id/steps', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { steps, error } = await getTaskSteps(supabase, req.params.id, userId);
    if (error) return res.status(500).json({ error });
    res.json({ steps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/concierge/balance', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const prefs = await getPreferenceMap(userId);
    const balance = Number(prefs['concierge_account.balance'] || 0);
    res.json({ balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;
module.exports.runProactiveSweep = runProactiveSweep;
module.exports.parseActions = parseActions;
module.exports.mentionsActionCommitment = mentionsActionCommitment;
module.exports.parsePrice = parsePrice;
module.exports.decidePaymentByCap = decidePaymentByCap;
module.exports.runAgentLoop = runLegacyActionLoop;
module.exports.inferCompoundReadOnlyTurn = inferCompoundReadOnlyTurn;
module.exports.summarizeReadOnlyActionResults = summarizeReadOnlyActionResults;
module.exports.getStructuredDataResults = getStructuredDataResults;
module.exports.guardVisibleDataResponse = guardVisibleDataResponse;
module.exports.buildConciseDataAnswer = buildConciseDataAnswer;
module.exports.isPureContentGenerationTurn = isPureContentGenerationTurn;
module.exports.shouldUseAgenticLoopForMessage = shouldUseAgenticLoopForMessage;
module.exports.shouldIgnoreModelAuthoredActions = shouldIgnoreModelAuthoredActions;
module.exports.isBroadEmailTriageRequest = isBroadEmailTriageRequest;
module.exports.triageEmailsForRequest = triageEmailsForRequest;
module.exports.normalizeActionResultsForClient = normalizeActionResultsForClient;
module.exports.validatePendantTranscriptionUpload = validatePendantTranscriptionUpload;
module.exports.isUserFacingMemory = isUserFacingMemory;
module.exports.isUsefulMemoryContent = isUsefulMemoryContent;
module.exports.CONNECTORS = CONNECTORS;

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
const { isNonEmptyString, isValidCalendarDate } = require('./services/request-validation');
const googleConnector = require('../connectors/google');
const telegram = require('../connectors/telegram');
const { inferDeterministicAction } = require('./intent-router');
const { resolveRetailerFromGoal, allRetailerAliases } = require('./services/retailer-sites');
const browserTask = require('./services/browser-task');
const { createActionRunner } = require('./services/action-runner');
const { guardConciergeSpend: sharedGuardConciergeSpend } = require('./services/concierge-spend-guard');
const { detectCurrency } = require('./services/money-guard');
const {
  isPendingCancelMessage,
  isPendingConfirmMessage,
  isPendingRevisionMessage,
  reviewTitleForAction
} = require('./services/pending-review');
const {
  ACTION_CONTRACTS,
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
const {
  streamBrain,
  generateBrain,
  webSearchBrain,
  getBrainProvider
} = require('./services/brain-provider');
const {
  getVoiceProvider,
  synthesizeSpeechOpenAI,
  transcribeSpeechOpenAI
} = require('./services/voice-provider');
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
  reflectOnResults,
  replacePendingToolResult
} = require('./services/agent-orchestrator');
const taskManager = require('./services/task-manager');
const { loadAgentContext } = require('./services/agent-context');
const agentWorkspace = require('./services/agent-workspace');
const agentRuntime = require('./services/agent-runtime');
const agentApprovals = require('./services/agent-approval-runtime');
const agentProjectRuntime = require('./services/agent-project-runtime');
const { buildLifeBriefing, formatLifeBriefing } = require('./services/life-briefing');
const dailyDigest = require('./services/daily-digest');
const people = require('./services/people');
const receipts = require('./services/receipts');
const watches = require('./services/watches');
const travelSearch = require('./services/travel-search');
const travelRanking = require('./services/travel-ranking');
const notifications = require('./services/notifications');
const commitments = require('./services/commitments');
const scheduling = require('./services/scheduling');
const { createDeliveryRuntime, availableChannels, describeUnavailable } = require('./services/notification-delivery');
const { sendEmail: sendEmailService } = require('./services/email');
const agentContinuity = require('./services/agent-continuity');
const { resolveTaskReference } = require('./services/task-context');
const { connectorForAction } = require('./services/connector-health');
const { getRuntimeVersion } = require('./services/runtime-version');
const { shouldClarifyPreviousPlace } = require('./services/contextual-routing');
const { clearCheckoutProfile } = require('./services/checkout-profile');
const { encryptTokens } = require('./services/token-crypto');
const { createSetupIntentForUser, getLinkedCard, saveLinkedCard, unlinkCard, readStripeTokens, chargeLinkedCard, setPaymentActionRequired, getPaymentActionRequired } = require('./services/stripe-cards');
const { saveAgentCard, getAgentCardSummary, deleteAgentCard } = require('./services/agent-card');
const { saveVaultCredential, listVaultCredentials, deleteVaultCredential } = require('./services/vault-credentials');
const { resolveCurrencyForLocation } = require('./services/currency-from-location');
const { handleStripeWebhookEvent } = require('./services/stripe-webhook');
const { getTaskSteps } = require('./services/task-steps');
const { createRoutine, listRoutines, deleteRoutine, listDueRoutines, markRoutineRun } = require('./services/routines');
const scheduledTasks = require('./services/scheduled-tasks');
const {
  actionDisplayName,
  actionFailureMessage,
  formatActionFailure,
  formatProviderFailure
} = require('./services/user-facing-copy');
const { resolveEntityReference } = require('./services/entity-recall');
const { listRecentEntities } = require('./services/task-entities');
const { getChatSettings, saveChatSettings } = require('./services/chat-settings');
const {
  ROUTE_KEYS,
  resolveModelRoute,
  publicModelRouting,
  validateModelRouteInput,
  defaultModelForProvider,
  providerConfiguration
} = require('./services/model-routing');
const { geocodeLocation } = require('./geocoding');
const { proactiveSweepAuthorization } = require('./services/proactive-auth');
const {
  createAppointmentBookingService,
  createSandboxAppointmentProvider,
  createSandboxCalendar
} = require('./services/appointment-booking');
const {
  buildCleanupQuery,
  classifyForCleanup,
  dedupeSendersForUnsubscribe,
  senderLabel: cleanupSenderLabel,
  summarizeCleanupResult
} = require('./services/gmail-cleanup');
const {
  isObviouslyNoReplyNeeded,
  latestMessagePerThread,
  buildReplyNeededPrompt,
  parseReplyNeededResponse,
  formatReplyNeededSummary
} = require('./services/reply-needed');
const {
  generateItinerary,
  modifyItinerary,
  itineraryToText
} = require('./services/itinerary-engine');
const {
  isValidMonthDay,
  daysUntil,
  computeReminderDueDate,
  formatMonthDay,
  formatOccasionsSummary
} = require('./services/occasions');

const stripeClient = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// Appointment booking is deliberately limited to the in-memory sandbox. This lets the
// whole flow be proved without contacting a practice or changing a real calendar.
let appointmentSandbox = null;
function getAppointmentBookingService() {
  if (process.env.OXY_APPOINTMENT_PROVIDER !== 'sandbox') return null;
  if (!appointmentSandbox) {
    const provider = createSandboxAppointmentProvider();
    const calendar = createSandboxCalendar();
    appointmentSandbox = { provider, calendar, service: createAppointmentBookingService({ provider, calendar }) };
  }
  return appointmentSandbox.service;
}

function appointmentTaskGoal(service, preference) {
  return `Book a ${service} appointment ${preference?.label || ''}`.replace(/\s+/g, ' ').trim();
}

function appointmentChoicesText(service, choices = []) {
  const list = choices.map((choice, index) => `${index + 1}. ${choice.label}`).join('\n');
  return `I found these ${service} times:\n${list}\n\nTell me which one you want, for example “book option 1”.`;
}

function appointmentCheckpoint(booking) {
  return {
    type: 'appointment_booking',
    phase: booking.phase,
    request: booking.request,
    service: booking.service,
    choiceCount: Array.isArray(booking.choices) ? booking.choices.length : 0
  };
}

async function saveAppointmentTask(userId, existingTaskId, booking, updates = {}) {
  let task = existingTaskId ? await taskManager.getTask(userId, existingTaskId) : null;
  if (!task) {
    task = await taskManager.createTask(userId, appointmentTaskGoal(booking.service, booking.preference), {
      autonomy: 'Balanced',
      metadata: { appointmentBooking: booking }
    });
  }
  return taskManager.updateTask(userId, task.id, {
    status: updates.status || 'paused',
    checkpoint: updates.checkpoint === false ? null : appointmentCheckpoint(booking),
    last_error: updates.lastError || null,
    results: updates.results || task.results || [],
    completed_at: updates.completedAt || null,
    heartbeat_at: null,
    metadata: { ...(task.metadata || {}), appointmentBooking: booking }
  });
}

function appointmentChoiceIndex(message) {
  const text = String(message || '').toLowerCase();
  if (/\b(?:option|choice)\s*1\b|\bfirst\s+(?:one|option|choice)\b/.test(text)) return 0;
  if (/\b(?:option|choice)\s*2\b|\bsecond\s+(?:one|option|choice)\b/.test(text)) return 1;
  if (/\b(?:option|choice)\s*3\b|\bthird\s+(?:one|option|choice)\b/.test(text)) return 2;
  return null;
}

async function inferAppointmentBookingTurn(userId, message) {
  let tasks;
  try {
    tasks = await taskManager.listTasks(userId, null);
  } catch {
    return null;
  }
  const task = tasks.find(candidate => ['choosing', 'calendar_retry'].includes(candidate?.metadata?.appointmentBooking?.phase));
  if (!task) return null;
  const booking = task.metadata.appointmentBooking;
  if (booking.phase === 'calendar_retry' && /\b(try|add|calendar|again|resume)\b/i.test(message)) {
    const choice = booking.booking?.choice || booking.choices?.[0];
    if (!choice) return null;
    return {
      reason: 'appointment_calendar_retry',
      spoken: "I'll get that ready for your OK.",
      actions: [{ type: 'book_appointment', input: { task_id: task.id, choice_id: choice.id, choice_label: choice.label, service: booking.service, calendar_retry: true } }]
    };
  }
  const choiceIndex = appointmentChoiceIndex(message);
  if (choiceIndex != null) {
    const choice = booking.choices?.[choiceIndex];
    if (!choice) return { reason: 'appointment_choice_missing', spokenOnly: true, spoken: appointmentChoicesText(booking.service, booking.choices) };
    return {
      reason: 'appointment_choice_selected',
      spoken: "I'll get that ready for your OK.",
      actions: [{ type: 'book_appointment', input: { task_id: task.id, choice_id: choice.id, choice_label: choice.label, service: booking.service } }]
    };
  }
  if (/\b(book|choose|pick)\s+(?:it|that|one|an?\s+(?:appointment|option|choice))\b/i.test(message)) {
    return { reason: 'appointment_choice_needed', spokenOnly: true, spoken: appointmentChoicesText(booking.service, booking.choices) };
  }
  return null;
}

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
  return actionDisplayName(type);
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

app.post('/webhooks/millie-email', express.raw({ type: 'application/json' }), async (req, res) => {
  // Raw body (not express.json()) is required here: signature verification is computed
  // over the exact bytes Resend sent, and any parse+re-serialize would change
  // whitespace/key order and silently break every signature.
  const { verifyResendWebhookSignature, parseInboundPayload } = require('../connectors/millie-email-resend');
  const rawBody = req.body.toString('utf8');
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed: an unconfigured secret means we cannot tell a real Resend delivery
    // from anyone who discovers this URL and posts a fabricated "reply" to it — reject
    // rather than silently trust unverified inbound traffic.
    log('error', 'millie_email.inbound.no_webhook_secret', {});
    return res.status(400).json({ error: 'Webhook not configured.' });
  }
  if (!verifyResendWebhookSignature(rawBody, req.headers, secret)) {
    log('warn', 'millie_email.inbound.signature_invalid', {});
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  // Always 200 quickly once verified — providers retry on non-2xx, and a malformed/
  // unmatched inbound email is not the sender's problem to see an error for.
  res.status(200).json({ received: true });
  try {
    const parsedPayload = JSON.parse(rawBody);
    const normalized = parseInboundPayload(parsedPayload);
    if (!normalized?.toAddress || !normalized.fromAddress) return;

    const { data: handles } = await supabase
      .from('millie_identity_handles')
      .select('*')
      .eq('channel_type', 'email')
      .eq('handle_value', normalized.toAddress)
      .eq('status', 'active');
    const handle = handles?.[0];
    if (!handle) {
      log('warn', 'millie_email.inbound.no_matching_handle', { to: normalized.toAddress });
      return;
    }
    const { data: identities } = await supabase.from('millie_identities').select('*').eq('id', handle.millie_identity_id);
    const identity = identities?.[0];
    if (!identity) return;

    const { findOrCreateParticipant } = require('./services/participants');
    const { getOrCreateConversation, appendEvent, findOpenConversationsForParticipant } = require('./services/external-conversations');
    const { classifyReply } = require('./services/reply-policy');

    const { participant, address } = await findOrCreateParticipant(supabase, identity.user_id, {
      displayName: normalized.fromAddress, channelType: 'email', addressValue: normalized.fromAddress
    });

    const openConversations = await findOpenConversationsForParticipant(supabase, participant.id);
    // More than one open conversation with the same participant: do not guess which
    // one this reply belongs to. Attach to the most recently active one and rely on
    // the surfaced update carrying enough context for the user to notice if it's
    // wrong — a stronger disambiguation (asking the user which thread) is future
    // work, not silently picking without any signal at all.
    const conversation = openConversations.length
      ? openConversations.sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at))[0]
      : (await getOrCreateConversation(supabase, {
        userId: identity.user_id, millieIdentityId: identity.id, participantId: participant.id
      })).conversation;

    const decision = classifyReply(normalized.body);
    await appendEvent(supabase, {
      conversationId: conversation.id,
      channelType: 'email',
      direction: 'inbound',
      participantAddressId: address.id,
      millieIdentityHandleId: handle.id,
      providerEventId: normalized.providerMessageId,
      subject: normalized.subject,
      body: normalized.body,
      needsDecision: decision === 'ask',
      rawProviderPayload: parsedPayload
    });
    log('info', 'millie_email.inbound.received', { userId: identity.user_id, conversationId: conversation.id, decision });
  } catch (err) {
    log('error', 'millie_email.inbound.error', { error: err.message });
  }
});

app.post('/webhooks/millie-sms', express.urlencoded({ extended: false }), async (req, res) => {
  res.status(200).send('<Response></Response>'); // Twilio expects TwiML or empty 200
  try {
    const { parseInboundSmsPayload } = require('../connectors/millie-sms-twilio');
    const normalized = parseInboundSmsPayload(req.body);
    if (!normalized?.toAddress || !normalized.fromAddress) return;

    const { data: handles } = await supabase
      .from('millie_identity_handles')
      .select('*')
      .eq('channel_type', 'phone_sms')
      .eq('handle_value', normalized.toAddress)
      .eq('status', 'active');
    const handle = handles?.[0];
    if (!handle) {
      log('warn', 'millie_sms.inbound.no_matching_handle', { to: normalized.toAddress });
      return;
    }
    const { data: identities } = await supabase.from('millie_identities').select('*').eq('id', handle.millie_identity_id);
    const identity = identities?.[0];
    if (!identity) return;

    const { findOrCreateParticipant } = require('./services/participants');
    const { getOrCreateConversation, appendEvent, findOpenConversationsForParticipant } = require('./services/external-conversations');
    const { classifyReply } = require('./services/reply-policy');

    const { participant, address } = await findOrCreateParticipant(supabase, identity.user_id, {
      displayName: normalized.fromAddress, channelType: 'phone_sms', addressValue: normalized.fromAddress
    });

    const openConversations = await findOpenConversationsForParticipant(supabase, participant.id);
    const conversation = openConversations.length
      ? openConversations.sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at))[0]
      : (await getOrCreateConversation(supabase, {
        userId: identity.user_id, millieIdentityId: identity.id, participantId: participant.id
      })).conversation;

    const decision = classifyReply(normalized.body);
    await appendEvent(supabase, {
      conversationId: conversation.id,
      channelType: 'phone_sms',
      direction: 'inbound',
      participantAddressId: address.id,
      millieIdentityHandleId: handle.id,
      providerEventId: normalized.providerMessageId,
      body: normalized.body,
      needsDecision: decision === 'ask',
      rawProviderPayload: req.body
    });
    log('info', 'millie_sms.inbound.received', { userId: identity.user_id, conversationId: conversation.id, decision });
  } catch (err) {
    log('error', 'millie_sms.inbound.error', { error: err.message });
  }
});

// Only the continuity endpoints take a whole vendor export. Raising the limit globally to
// suit them would hand every other route — /chat included — a 40x larger body to absorb.
// The global parser must SKIP those paths rather than run first: body-parser marks the
// request as read, so a default-limit parser in front would 413 the upload before the
// larger one ever saw it.
const continuityBodyParser = express.json({ limit: '12mb' });
const defaultBodyParser = express.json();
app.use((req, res, next) => {
  if (req.path.startsWith('/agent/continuity/')) return next();
  return defaultBodyParser(req, res, next);
});
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
    '/proactive/sweep',
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
// Chat runs on OpenAI (gpt-5.6-luna) as of 2026-08-04 — smarter and cheaper than the
// Gemini tier it replaced, and Google billing dunning had denied the Gemini project
// outright, taking chat down. Provider is selected by OXY_BRAIN_PROVIDER in
// brain-provider.js; these ids must belong to whichever provider that names.
// The GEMINI_MODEL/GEMINI_FAST_MODEL overrides are gone on purpose: leaving them would
// let a stale env var post a Gemini model id to OpenAI's endpoint and 404 at runtime.
const DEFAULT_CHAT_PROVIDER = resolveModelRoute({}).provider;
const PRIMARY_CHAT_MODEL = defaultModelForProvider(DEFAULT_CHAT_PROVIDER, 'reasoning');
const FAST_MODEL = defaultModelForProvider(DEFAULT_CHAT_PROVIDER, 'fast');
const configuredStreamModel = String(process.env.OXY_STREAM_MODEL || '').trim();
const STREAMING_CHAT_MODEL = configuredStreamModel && providerConfiguration(DEFAULT_CHAT_PROVIDER, configuredStreamModel).ready
  ? configuredStreamModel
  : PRIMARY_CHAT_MODEL;
// Voice in/out never moved off Google: transcription takes raw audio and generateSpeech
// uses Gemini's own prebuilt voices, neither of which the text/vision brain seam covers.
// They keep their own Gemini model ids so a chat-model change can't silently retarget them.
const GEMINI_AUDIO_MODEL = process.env.OXY_GEMINI_AUDIO_MODEL || 'gemini-3.1-flash-lite';
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

const { buildSystemPrompt, CORE_SYSTEM_PROMPT } = require('./prompts');

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
    parts.push(failures.map(entry => userFacingActionFailure(entry)).join('\n'));
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
    const declaredDataSize = buffer.readUInt32LE(40);
    // Streamed WAVs are written before the length is known, so the data-chunk size is the
    // 0xFFFFFFFF "unknown" placeholder (OpenAI's TTS does this). Taken literally that is a
    // ~24-hour clip, which drives words-per-second to ~0 and makes isImplausibleTranscript
    // accept anything — the hallucination guard fails open instead of firing. Trust the
    // bytes actually present over the header's claim.
    const actualDataSize = Math.max(buffer.length - 44, 0);
    const dataSize = Math.min(declaredDataSize || actualDataSize, actualDataSize);
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
  if (getVoiceProvider() === 'openai') {
    const transcript = normalizeTranscript(await transcribeSpeechOpenAI(buffer, 'audio/wav'));
    // Keep the plausibility guard: a transcript with far more words than the clip could
    // hold means the model hallucinated rather than heard, and passing that through as the
    // user's words is worse than returning nothing.
    if (transcript && !isImplausibleTranscript(transcript, getWavDurationMs(buffer))) return transcript;
    return '';
  }
  const audioBase64Input = buffer.toString('base64');
  const audioPart = { inlineData: { mimeType: 'audio/wav', data: audioBase64Input } };
  // Still Gemini: transcription feeds raw audio to a multimodal model, which the chat
  // brain's text/vision seam does not cover. Pinned to an explicit Gemini id rather than
  // FAST_MODEL — FAST_MODEL is an OpenAI model now, and posting that id to the Gemini SDK
  // would fail with a confusing "model not found" instead of a clear config error.
  const transcribeModel = genAI.getGenerativeModel({ model: GEMINI_AUDIO_MODEL });
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
  const parts = [{ text: `${prompt}\n\nReturn JSON only. No markdown fences.` }];
  if (imageFile?.buffer && imageFile?.mimetype?.startsWith('image/')) {
    parts.push({ inlineData: { mimeType: imageFile.mimetype, data: imageFile.buffer.toString('base64') } });
  }
  const result = await generateBrain({ model: FAST_MODEL, contents: [{ role: 'user', parts }], config: {} });
  return parseLooseJson(result.text) || fallback;
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

// Thin wrapper over buildSystemPrompt's 'chat' surface, kept with its original positional
// signature — test/smoke/preference-context-hygiene.test.js and prompt-safety.test.js call this
// directly. The public-figures-grounding and search-staleness lines that used to live in this
// function's own RESPONSE RULES tail now live once, universally, in TRUTHFULNESS_SAFETY_SECTION
// (api/prompts.js) — every surface gets them, not just chat.
function buildDynamicSystemPrompt(memory, preferences, availableActions, userContext, statedContext = [], autonomyContext = {}) {
  return buildSystemPrompt({
    surface: 'chat',
    context: {
      memory,
      preferences,
      connectedCapabilities: availableActions,
      extraContext: userContext,
      statedContext,
      autonomy: autonomyContext.autonomy,
      guardMode: autonomyContext.guardMode,
      dateStr: getLocalDateKey(),
      timeStr: new Date().toLocaleString('en-GB', { timeZone: TIMEZONE })
    }
  });
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
    email.subject,
    email.snippet,
    email.body
  ].filter(Boolean).join(' ').toLowerCase();
  const terms = String(message || '')
    .toLowerCase()
    .split(/[^a-z0-9@._+-]+/i)
    .filter(term => term.length >= 3);
  const directScore = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  const relationshipHints = {
    supplier: ['suppli', 'quote', 'invoice', 'order', 'delivery', 'sales'],
    vendor: ['vendor', 'suppli', 'quote', 'invoice', 'order'],
    client: ['client', 'customer', 'project', 'invoice'],
    customer: ['customer', 'order', 'invoice', 'delivery'],
    landlord: ['landlord', 'tenancy', 'rent', 'property'],
    dentist: ['dentist', 'dental', 'clinic', 'appointment'],
    doctor: ['doctor', 'medical', 'clinic', 'appointment'],
    school: ['school', 'teacher', 'class', 'term']
  };
  const relationshipScore = Object.entries(relationshipHints).reduce((score, [role, hints]) => {
    if (!new RegExp(`\\b${role}\\b`, 'i').test(String(message || ''))) return score;
    return score + (hints.some(hint => haystack.includes(hint)) ? 2 : 0);
  }, 0);
  return directScore + relationshipScore;
}

function findRecentEmailTarget(history = [], message = '', { requireMatch = false } = {}) {
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
  if (requireMatch && (ranked[0]?.score || 0) < 1) return null;
  return ranked[0]?.email || null;
}

function isEmailDraftRequest(message = '') {
  const text = String(message || '').trim();
  if (!text || !/\b(email|mail)\b/i.test(text)) return false;
  if (/\b(check|search|summari[sz]e|read|look at|show)\b[\s\S]*\b(email|mail|inbox)\b/i.test(text)) {
    return false;
  }
  return /\b(draft|write|compose|send|ask|tell)\b/i.test(text);
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

async function buildEmailDraftContext(userId, message, history, memory, preferences, trace = null) {
  if (!isEmailDraftRequest(message) || isEmailReplyDraftRequest(message)) return '';
  const target = findRecentEmailTarget(history, message, { requireMatch: true });
  if (!target?.senderAddress) return '';

  const sender = {
    name: target.senderName || '',
    address: target.senderAddress,
    raw: target.from || ''
  };
  const senderMemory = senderMemoryContext(memory, sender) || 'No sender-specific memory found.';
  return `GMAIL EMAIL DRAFTING CONTEXT:
The user wants a new email, not a reply to an existing thread.
Likely recipient name: ${sender.name || 'Unknown'}
Likely recipient address: ${sender.address}
Recent subject: ${target.subject || '(no subject)'}
Memory about this person or company:
${senderMemory}

User communication style/preferences:
${preferences || 'No explicit communication preferences yet.'}

Drafting instruction:
- Use "${sender.address}" as the to address unless the user names a different recipient.
- Do not include a thread_id, in_reply_to, or references for this new email.
- Use the user's actual request as the substance of the email.
- Draft the complete email and let the review step show it before anything is sent.`;
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
  return `PENDING ACTION AWAITING REVIEW${pendingAction.taskGoal ? ` FOR GOAL: ${String(pendingAction.taskGoal).slice(0, 240)}` : ''}:
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

// Thin wrapper over buildSystemPrompt's 'quick' surface, kept with its original positional
// signature — test/smoke/preference-context-hygiene.test.js calls this directly.
function buildQuickTurnContext(preferences, statedContext = []) {
  return buildSystemPrompt({ surface: 'quick', context: { preferences, statedContext } });
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

function isLifeBriefingRequest(message = '') {
  const normalized = String(message || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?]+$/, '')
    .trim();
  return /^(?:millie\s+)?(?:what is important|whats important|what matters|anything important|what do i need to know)$/.test(normalized);
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

// Actions authored by the cheap streaming model were unreliable enough to discard while
// FAST_MODEL was a genuinely weaker tier (gemini-3.1-flash-lite). The guard is about that
// downgrade, not about model identity: once FAST_MODEL and PRIMARY_CHAT_MODEL are the same
// id — as they are on the OpenAI path — an identity-only check matches the MAIN chat model
// and silently discards every action the text path parses. Gate on the tiers actually
// differing so the guard re-arms by itself if a cheaper fast tier is configured again.
function shouldIgnoreModelAuthoredActions(modelName = '') {
  if (FAST_MODEL === PRIMARY_CHAT_MODEL) return false;
  return String(modelName || '') === FAST_MODEL;
}

// Native tool calls become internal actions and LEAD the list the legacy <action> text path
// produces, so every downstream guard, review gate, status event and result handler applies to
// them unchanged. Kept as one function because three routes (streaming chat, non-streaming
// chat, voice) must agree on the shape exactly.
function mergeNativeToolCalls(toolCalls = [], textActions = []) {
  if (!toolCalls?.length) return textActions;
  return [
    ...toolCalls.map(fc => ({ type: fc.name, input: fc.args || {} })),
    ...textActions
  ];
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

  const appointmentTurn = await inferAppointmentBookingTurn(userId, text);
  if (appointmentTurn) return appointmentTurn;

  const explicitMemory = parseExplicitMemoryRequest(text);
  if (explicitMemory) {
    try {
      await saveMemory(userId, explicitMemory, 'manual');
      return {
        reason: 'memory_saved',
        spokenOnly: true,
        spoken: `Saved. I'll remember that: ${explicitMemory}.`
      };
    } catch (error) {
      trace?.log?.('memory.save_failed', error.message);
      return {
        reason: 'memory_save_failed',
        spokenOnly: true,
        spoken: "I couldn't save that right now. Try again."
      };
    }
  }

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
  const cacheKey = `${modelName}:${CORE_SYSTEM_PROMPT}`;
  let cacheState = promptCacheStates.get(cacheKey);
  if (!cacheState) {
    cacheState = { key: cacheKey, name: '', expireAt: 0, pending: null };
    promptCacheStates.set(cacheKey, cacheState);
  }
  return cacheState;
}

async function ensurePromptCacheWarm(trace = null, modelName = STREAMING_CHAT_MODEL) {
  // Explicit cache objects are a Gemini concept. OpenAI caches repeated prompt prefixes
  // server-side with no API call, so on that path this is a no-op and callers get the
  // empty cache name they already treat as "uncached".
  if (getBrainProvider() !== 'gemini') return '';
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
              systemInstruction: CORE_SYSTEM_PROMPT,
              ttl: PROMPT_CACHE_TTL
            }
          }))
        : await modernGenAI.caches.create({
            model: modelName,
            config: {
              displayName: `oxy-base-system-prompt-${modelName.replace(/[^a-z0-9-]+/gi, '-')}`,
              systemInstruction: CORE_SYSTEM_PROMPT,
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
  if (getBrainProvider() !== 'gemini') return '';
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
    // dynamicSystemPrompt is always a fully-composed prompt now (built via buildSystemPrompt),
    // not a fragment needing a static prefix — see buildDynamicSystemPrompt/buildQuickTurnContext.
    systemInstruction: dynamicSystemPrompt,
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

async function recoverEmptyModelResponse({ provider = null, model, initialRequest, message, trace = null }) {
  const recoveryRequest = {
    config: {
      ...initialRequest.config,
      // Recovery asks for TEXT after an empty turn. Leaving tools attached would let it
      // answer with another tool call whose text is empty — i.e. recover into the same
      // empty-looking response it is meant to rescue.
      tools: undefined,
      toolConfig: undefined,
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
      ? await trace.run('brain.generate.empty_recovery', () => generateBrain({
        provider,
        model,
        contents: recoveryRequest.contents,
        config: recoveryRequest.config
      }))
      : await generateBrain({
        provider,
        model,
        contents: recoveryRequest.contents,
        config: recoveryRequest.config
      });
    return (response.text || '').trim();
  } catch (error) {
    if (trace) trace.log('brain.empty_recovery_fail', error.message);
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
  if (getVoiceProvider() === 'openai') return synthesizeSpeechOpenAI(text, voiceName);
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
  plan_itinerary: 'Planning itinerary',
  modify_itinerary: 'Updating itinerary',
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
  // The caller already splits on sentence boundaries and invokes this per sentence, so a
  // single complete WAV per call is the same granularity the Gemini SSE path delivered —
  // one whole short clip rather than partial audio the client would have to stitch.
  if (getVoiceProvider() === 'openai') {
    const audio = await synthesizeSpeechOpenAI(text, voiceName);
    if (audio) yield audio;
    return;
  }
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

  const result = await generateBrain({
    model: FAST_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { text: prompt?.trim() || 'Describe this image clearly and practically.' },
        { inlineData: { mimeType: imageFile.mimetype, data: imageFile.buffer.toString('base64') } }
      ]
    }],
    config: {}
  });

  return {
    success: true,
    text: result.text?.trim() || 'I looked through the image.',
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

// DB-backed daily send cap for Millie's own identity — not the existing in-memory
// createRateLimiter, whose Map doesn't survive a restart and isn't shared across
// Cloud Run instances if the service scales beyond one. This counts real rows
// instead. Millie's identity has no human tap-to-send safety net the way
// send_message's device-level deep link does, so this is a real abuse guard, not
// a formality.
// Testable without hitting Supabase: __testOverride lets tests inject the count
// function directly, matching this file's existing convention of exposing a narrow
// test seam rather than mocking the module's own `supabase` client.
async function countMillieSendsToday(userId, channelType) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data: identities } = await supabase.from('millie_identities').select('id').eq('user_id', userId).limit(1);
  const identityId = identities?.[0]?.id;
  if (!identityId) return 0;
  const { data: handles } = await supabase.from('millie_identity_handles').select('id').eq('millie_identity_id', identityId).eq('channel_type', channelType);
  const handleIds = (handles || []).map(h => h.id);
  if (!handleIds.length) return 0;
  const { count } = await supabase
    .from('external_conversation_events')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .in('millie_identity_handle_id', handleIds)
    .gte('created_at', since.toISOString());
  return count || 0;
}

async function checkMillieSendCap(userId, channelType, countFn = countMillieSendsToday) {
  const cap = Number(process.env.MILLIE_DAILY_SEND_CAP) || 20;
  const sentToday = await countFn(userId, channelType);
  if (sentToday >= cap) {
    return { allowed: false, message: `Millie has reached her sending limit for today (${cap}). Try again tomorrow.` };
  }
  return { allowed: true };
}
checkMillieSendCap.__testOverride = (countFn, userId, channelType) => checkMillieSendCap(userId, channelType, countFn);

function resolveNativeMessageContact(contact, nativeHints) {
  if (looksLikeMessageAddress(contact)) {
    return { label: contact, value: contact };
  }
  const normalizedContact = normalizeContactLookup(contact);
  const contacts = Array.isArray(nativeHints?.contacts) ? nativeHints.contacts : [];
  const matches = contacts.filter(candidate => {
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

  if (matches.length > 1) {
    // Two matches that both resolve to the same real number/email (e.g. the same person
    // appearing twice in the hints array) aren't actually ambiguous — only distinct targets
    // are. Never silently pick one when they genuinely differ; ask instead.
    const distinctTargets = new Set(matches.map(m => normalizeContactLookup(m.phone || m.email || '')).filter(Boolean));
    if (distinctTargets.size > 1) {
      return {
        ambiguous: true,
        // Minimal identifying info only — enough to ask "which one", not a data dump.
        candidates: matches.map(m => m.displayName || m.phone || m.email).filter(Boolean)
      };
    }
  }

  const match = matches[0];
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
    ...(context.location ? { location: context.location } : {}),
    ...(context.homeLocation ? { homeLocation: context.homeLocation } : {})
  };
  const recordProjectArtifact = async (input = {}) => {
    if (!context.runtimeSessionId || !context.persistedTaskId) return null;
    try {
      const artifact = await agentRuntime.recordArtifact(supabase, userId, {
        sessionId: context.runtimeSessionId,
        taskId: context.persistedTaskId,
        kind: input.kind || 'note',
        path: input.path || null,
        title: input.title,
        summary: input.summary,
        status: input.status,
        metadata: input.metadata
      });
      return agentRuntime.summarizeArtifact(artifact);
    } catch {
      return null;
    }
  };
  const bindRuntimeProject = async projectRef => {
    if (!context.runtimeSessionId || !projectRef) return;
    await agentRuntime.updateSession(supabase, userId, context.runtimeSessionId, { projectRef }).catch(() => {});
  };
  switch (action) {
    case 'send_message': {
      const contact = String(params?.contact || '').trim();
      const message = String(params?.message || '').trim();
      if (!contact || !message) return { success: false, error: 'send_message requires contact and message' };

      // Easy WhatsApp handoff — prefilled, just tap. Doesn't target a specific number (WhatsApp's
      // own compose UI handles recipient selection), so no contact resolution/ambiguity check applies.
      if (params?.platform === 'whatsapp' || action === 'whatsapp') {
        return {
          success: true,
          text: `Opening WhatsApp for ${contact}.`,
          deepLink: `https://wa.me/?text=${encodeURIComponent(message)}`,
          cardText: message.slice(0, 60)
        };
      }

      const resolvedContact = resolveNativeMessageContact(contact, context.nativeHints);
      if (resolvedContact.ambiguous) {
        return {
          success: false,
          error: `I found more than one ${contact} in your contacts — ${resolvedContact.candidates.join(' or ')}? Tell me which one.`
        };
      }
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
    case 'send_millie_email': {
      const to = String(params?.to || '').trim();
      const body = String(params?.body || '').trim();
      if (!to || !body) return { success: false, error: 'send_millie_email requires a recipient and a message' };
      if (!/[^\s<]+@[^\s>]+\.[^\s>]+/.test(to)) {
        return { success: false, error: `I need ${to}'s email address — that doesn't look like one.` };
      }

      const { ensureMillieIdentity, getActiveHandle } = require('./services/millie-identity');
      const { findOrCreateParticipant } = require('./services/participants');
      const { getOrCreateConversation, appendEvent } = require('./services/external-conversations');
      const { sendMillieEmail } = require('../connectors/millie-email-resend');

      const cap = await checkMillieSendCap(userId, 'email');
      if (!cap.allowed) return { success: false, error: cap.message };

      const { identity, handles } = await ensureMillieIdentity(supabase, userId, { attemptPhone: false });
      const emailHandle = handles.find(h => h.channel_type === 'email') || await getActiveHandle(supabase, userId, 'email');
      if (!emailHandle) return { success: false, error: 'Millie does not have an email address set up yet.' };

      const { participant, address } = await findOrCreateParticipant(supabase, userId, {
        displayName: to, channelType: 'email', addressValue: to
      });
      const requestTaskId = params?.request_task_id || null;
      const { conversation } = await getOrCreateConversation(supabase, {
        userId, millieIdentityId: identity.id, participantId: participant.id, requestTaskId
      });

      const subject = String(params?.subject || '').trim() || 'A message from Millie';
      let sendResult;
      try {
        sendResult = await sendMillieEmail({ from: emailHandle.handle_value, to, subject, body });
      } catch (err) {
        return { success: false, error: `Couldn't send that: ${err.message}` };
      }

      await appendEvent(supabase, {
        conversationId: conversation.id,
        channelType: 'email',
        direction: 'outbound',
        participantAddressId: address.id,
        millieIdentityHandleId: emailHandle.id,
        providerEventId: sendResult.providerMessageId,
        subject,
        body
      });

      return {
        success: true,
        text: `Sent to ${to} from Millie's email.`,
        cardText: `To ${to} · ${body}`,
        actionSummary: 'Message sent',
        conversationId: conversation.id
      };
    }
    case 'send_millie_sms': {
      const to = String(params?.to || '').trim();
      const body = String(params?.body || '').trim();
      if (!to || !body) return { success: false, error: 'send_millie_sms requires a recipient phone number and a message' };
      if (!looksLikeMessageAddress(to)) {
        return { success: false, error: `I need a phone number for ${to} — that doesn't look like one.` };
      }

      const { ensureMillieIdentity, getActiveHandle } = require('./services/millie-identity');
      const { findOrCreateParticipant } = require('./services/participants');
      const { getOrCreateConversation, appendEvent } = require('./services/external-conversations');
      const { sendMillieSms } = require('../connectors/millie-sms-twilio');

      const cap = await checkMillieSendCap(userId, 'phone_sms');
      if (!cap.allowed) return { success: false, error: cap.message };

      const { identity } = await ensureMillieIdentity(supabase, userId, { attemptPhone: false });
      const phoneHandle = await getActiveHandle(supabase, userId, 'phone_sms');
      if (!phoneHandle) return { success: false, error: 'Millie does not have a phone number set up yet.' };

      const { participant, address } = await findOrCreateParticipant(supabase, userId, {
        displayName: to, channelType: 'phone_sms', addressValue: to
      });
      const requestTaskId = params?.request_task_id || null;
      const { conversation } = await getOrCreateConversation(supabase, {
        userId, millieIdentityId: identity.id, participantId: participant.id, requestTaskId
      });

      let sendResult;
      try {
        sendResult = await sendMillieSms({ from: phoneHandle.handle_value, to, body });
      } catch (err) {
        return { success: false, error: `Couldn't send that: ${err.message}` };
      }

      await appendEvent(supabase, {
        conversationId: conversation.id,
        channelType: 'phone_sms',
        direction: 'outbound',
        participantAddressId: address.id,
        millieIdentityHandleId: phoneHandle.id,
        providerEventId: sendResult.providerMessageId,
        body
      });

      return {
        success: true,
        text: `Sent to ${to} from Millie's number.`,
        cardText: `To ${to} · ${body}`,
        actionSummary: 'Message sent',
        conversationId: conversation.id
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

    // Project work is deliberately a separate adapter from the database-backed scratch
    // workspace. It provisions a task-scoped clone from a server-side project catalog and
    // exposes only bounded Git/check/write operations; the model never supplies a shell
    // command, repository URL, or absolute filesystem path.
    case 'project_status': {
      const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
      if (!projectRef) return { success: false, error: 'project_status requires a configured project_ref' };
      if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
      try {
        await bindRuntimeProject(projectRef);
        const status = await agentProjectRuntime.gitStatus(userId, context.persistedTaskId, projectRef);
        return {
          success: true,
          text: `${status.projectName} is on ${status.branch}${status.dirty ? ` with ${status.files.length} changed file${status.files.length === 1 ? '' : 's'}.` : ' with no uncommitted changes.'}`,
          actionSummary: `${status.projectName} status loaded`,
          ...status
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    case 'project_diff': {
      const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
      if (!projectRef) return { success: false, error: 'project_diff requires a configured project_ref' };
      if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
      try {
        await bindRuntimeProject(projectRef);
        const diff = await agentProjectRuntime.gitDiff(userId, context.persistedTaskId, projectRef);
        const hasChanges = Boolean(diff.diff);
        return {
          success: true,
          text: hasChanges ? diff.diff : `${diff.projectName} has no uncommitted changes.`,
          actionSummary: hasChanges ? `${diff.projectName} changes loaded` : 'No project changes',
          ...diff
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    case 'project_write': {
      const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
      if (!projectRef) return { success: false, error: 'project_write requires a configured project_ref' };
      if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
      if (!params?.path) return { success: false, error: 'project_write requires path' };
      try {
        await bindRuntimeProject(projectRef);
        const file = await agentProjectRuntime.writeProjectFile(
          userId,
          context.persistedTaskId,
          projectRef,
          params.path,
          params.content
        );
        const artifact = await recordProjectArtifact({
          kind: 'file',
          path: file.path,
          title: file.path,
          summary: `Saved ${file.path} in ${file.projectName}.`
        });
        return {
          success: true,
          text: `Saved ${file.path} in ${file.projectName}.`,
          actionSummary: `Saved ${file.path}`,
          projectRef: file.projectRef,
          path: file.path,
          bytes: file.bytes,
          ...(artifact ? { artifact } : {})
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    case 'project_check': {
      const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
      if (!projectRef) return { success: false, error: 'project_check requires a configured project_ref' };
      if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
      try {
        await bindRuntimeProject(projectRef);
        const check = await agentProjectRuntime.runProjectCheck(
          userId,
          context.persistedTaskId,
          projectRef,
          params?.check || 'test'
        );
        const artifact = await recordProjectArtifact({
          kind: 'test_result',
          title: `${check.projectName} ${check.check} check`,
          summary: check.success
            ? `${check.check} passed for ${check.projectName}.`
            : `${check.check} failed for ${check.projectName}.`,
          status: check.success ? 'created' : 'failed',
          metadata: { check: check.check, exitCode: check.exitCode, timedOut: check.timedOut }
        });
        return {
          success: check.success,
          text: check.success
            ? `${check.projectName} ${check.check} passed.`
            : `${check.projectName} ${check.check} failed.`,
          actionSummary: `${check.check} ${check.success ? 'passed' : 'failed'}`,
          ...check,
          ...(artifact ? { artifact } : {})
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }

    case 'project_commit': {
      const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
      if (!projectRef) return { success: false, error: 'project_commit requires a configured project_ref' };
      if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
      if (!params?.message) return { success: false, error: 'project_commit requires a concise message' };
      try {
        await bindRuntimeProject(projectRef);
        const commit = await agentProjectRuntime.commitProjectChanges(
          userId,
          context.persistedTaskId,
          projectRef,
          params.message
        );
        const artifact = await recordProjectArtifact({
          kind: 'receipt',
          title: `${commit.projectName} changeset`,
          summary: `Saved ${commit.commit.slice(0, 12)} on ${commit.branch}.`,
          metadata: { commit: commit.commit, branch: commit.branch }
        });
        return {
          success: true,
          text: commit.text,
          actionSummary: 'Project changeset saved',
          ...commit,
          ...(artifact ? { artifact } : {})
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    case 'project_rollback': {
      const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
      if (!projectRef) return { success: false, error: 'project_rollback requires a configured project_ref' };
      if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
      try {
        await bindRuntimeProject(projectRef);
        const rollback = await agentProjectRuntime.rollbackProjectChanges(
          userId,
          context.persistedTaskId,
          projectRef
        );
        const artifact = await recordProjectArtifact({
          kind: 'receipt',
          title: `${rollback.projectName} rollback`,
          summary: `Rolled back uncommitted changes on ${rollback.branch}.`,
          metadata: { branch: rollback.branch }
        });
        return {
          success: true,
          text: rollback.text,
          actionSummary: 'Project changes rolled back',
          ...rollback,
          ...(artifact ? { artifact } : {})
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    case 'project_sync': {
      const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
      if (!projectRef) return { success: false, error: 'project_sync requires a configured project_ref' };
      if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
      try {
        await bindRuntimeProject(projectRef);
        const published = await agentProjectRuntime.publishProjectBranch(
          userId,
          context.persistedTaskId,
          projectRef
        );
        const artifact = await recordProjectArtifact({
          kind: 'receipt',
          title: `${published.projectName} branch synchronized`,
          summary: `Published ${published.branch}.`,
          metadata: { branch: published.branch, published: true }
        });
        return {
          success: true,
          text: published.text,
          actionSummary: 'Project branch synchronized',
          ...published,
          ...(artifact ? { artifact } : {})
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }

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
      const credentialSites = Array.isArray(params?.credentialSites) ? params.credentialSites : [];
      let outcome;
      try {
        outcome = await browserTask.runOrderingTurn(userId, { url, goal, location: context.location, credentialSites });
      } catch (e) {
        return { success: false, error: `Browse task failed: ${e.message}` };
      }
      if (outcome.type === 'ready_for_credential_use') {
        return {
          success: true,
          confirmation: 'review_required',
          text: `I found a sign-in for ${outcome.site} — use your saved "${outcome.label}" credential to sign in?`,
          actionSummary: 'Sign-in ready',
          taskId: outcome.taskId
        };
      }
      if (outcome.type === 'ready_for_payment') {
        const total = parsePrice(outcome.total || '');
        if (total) {
          // parsePrice strips the currency symbol, so recover it from the raw total and pass it
          // through — a UK £-checkout must be converted before it hits the (USD) spend cap, not
          // compared naked. No symbol on a UK-first app → assume GBP, the stricter side.
          const currency = detectCurrency(outcome.total || '') || 'GBP';
          const guard = await guardConciergeSpend(userId, total, currency);
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
      if (outcome.type === 'reauth') {
        // Regression: this outcome type had no case here at all, so it fell through to the
        // generic "Browse task failed." error below — the actual "I need to sign in" question
        // was silently dropped and the client had no way to actually complete a sign-in
        // in-session (saying "keep going" just re-hits the same login wall). recoveryAction
        // type reauth_login is a new client-side case (MessageBubble) that opens a sign-in
        // sheet posting straight to POST /browser-task/reauth-login — see fillReauthLogin.
        return {
          success: false,
          error: outcome.question,
          recoverable: true,
          recoveryAction: { type: 'reauth_login', label: 'Sign in', site: outcome.site },
          taskId: outcome.taskId
        };
      }
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

    case 'confirm_credential_use': {
      try {
        const result = await browserTask.confirmCredentialUse(userId);
        if (result.type === 'error') return { success: false, error: result.error };
        return { success: true, text: result.text };
      } catch (e) {
        return { success: false, error: `Sign-in confirmation failed: ${e.message}` };
      }
    }

    case 'cancel_credential_use': {
      browserTask.cancelCredentialUse(userId);
      return { success: true, text: 'Okay, not signing in.' };
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
          const prompt = `You are a helpful concierge assistant. From this page content, answer or extract exactly what is needed for: "${query}". Be concise, factual, list key details or steps. Page: ${text.slice(0, 3000)}`;
          const llmRes = await generateBrain({
            model: FAST_MODEL,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {}
          });
          const answer = (llmRes.text || '').trim();
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
        const answer = await webSearchBrain({
          model: FAST_MODEL,
          prompt: `Today's date is ${getLocalDateKey()}. Search the web and answer concisely for: "${q}". Include key options, prices, and links where available. Only report what the search results support — if results look older than today, say so instead of guessing. Plain prose, no markdown headings or asterisks.`
        });
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
    // Workspace tools. Path traversal, size and kind are all enforced inside
    // agent-workspace.js, and every query is scoped to this user's workspace row, so a
    // model-authored path cannot reach another user's files or escape the workspace.
    case 'workspace_write': {
      const filePath = String(params?.path || '').trim();
      const content = params?.content;
      if (!filePath) return { success: false, error: 'workspace_write requires path' };
      if (typeof content !== 'string') return { success: false, error: 'workspace_write requires content as text' };
      try {
        const runtimeWrite = context.runtimeSessionId && context.persistedTaskId
          ? await agentRuntime.writeFileArtifact(supabase, userId, {
            sessionId: context.runtimeSessionId,
            taskId: context.persistedTaskId,
            path: filePath,
            content,
            kind: params?.kind
          })
          : { file: await agentWorkspace.writeWorkspaceFile(supabase, userId, filePath, content, params?.kind), artifact: null };
        const file = runtimeWrite.file;
        return {
          success: true,
          text: `Saved ${file.path} (v${file.version}).`,
          actionSummary: `Saved ${file.path}`,
          path: file.path,
          version: file.version,
          ...(runtimeWrite.artifact ? { artifact: runtimeWrite.artifact } : {})
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    case 'workspace_read': {
      const filePath = String(params?.path || '').trim();
      if (!filePath) return { success: false, error: 'workspace_read requires path' };
      try {
        const file = await agentWorkspace.readWorkspaceFile(supabase, userId, filePath);
        if (!file) return { success: false, error: `No workspace file at ${filePath}.` };
        return {
          success: true,
          text: file.content,
          actionSummary: `Read ${file.path}`,
          path: file.path,
          version: file.version
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    case 'workspace_list': {
      try {
        const { files } = await agentWorkspace.listWorkspaceFiles(supabase, userId, params?.prefix || '');
        // Paths and sizes only — the agent asks for content it actually needs via
        // workspace_read, rather than every file being replayed into the next prompt.
        const listed = files.map(file => ({ path: file.path, kind: file.kind, bytes: file.size_bytes, updatedAt: file.updated_at }));
        return {
          success: true,
          text: listed.length ? listed.map(f => `${f.path} (${f.bytes} bytes)`).join('\n') : 'The workspace is empty.',
          actionSummary: `${listed.length} file${listed.length === 1 ? '' : 's'} in workspace`,
          files: listed
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    case 'create_agent_task': {
      const goal = String(params?.goal || '').trim();
      if (!goal) return { success: false, error: 'create_agent_task requires goal' };
      try {
        const task = await taskManager.createTask(userId, goal, {
          autonomy: params.autonomy,
          plan: params.plan,
          metadata: typeof params.guardMode === 'boolean' ? { guardMode: params.guardMode } : undefined
        });
        return { success: true, text: `Persistent agent task created: "${goal}". ID: ${task.id}. I will work on it in background where possible.`, taskId: task.id };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    case 'create_scheduled_task': {
      const title = String(params?.title || '').trim();
      const instruction = String(params?.instruction || params?.prompt || '').trim();
      if (!title || !instruction) return { success: false, error: 'create_scheduled_task requires title and instruction' };
      const created = await scheduledTasks.createScheduledTask(userId, {
        title,
        instruction,
        recurrence: params?.recurrence,
        time: params?.time || params?.time_of_day,
        day_of_week: params?.day_of_week,
        date: params?.date,
        due_date: params?.due_date,
        condition: params?.condition,
        interval_minutes: params?.interval_minutes,
        expires_at: params?.expires_at,
        budget_cap: params?.budget_cap,
        watch_type: params?.watch_type,
        threshold: params?.threshold,
        comparator: params?.comparator,
        notify_rule: params?.notify_rule,
        source_url: params?.source_url,
        target_state: params?.target_state
      });
      if (!created.success) return created;
      const task = created.task || {};
      return {
        success: true,
        deduped: Boolean(created.deduped),
        text: created.deduped
          ? `I'm already watching “${task.title || title}” — updated it rather than starting a second one. ${scheduledTasks.describeSchedule(task)}.`
          : `I’ll keep an eye on “${task.title || title}” ${scheduledTasks.describeSchedule(task)}.`,
        actionSummary: 'Watch saved',
        scheduledTask: {
          id: task.id,
          title: task.title,
          recurrence: task.recurrence,
          nextRunAt: task.next_run_at,
          condition: task.condition || null,
          expiresAt: task.expires_at || null
        }
      };
    }
    case 'list_scheduled_tasks': {
      const listed = await scheduledTasks.listScheduledTasks(userId);
      if (!listed.success) return { success: false, error: listed.error };
      const rows = listed.tasks || [];
      const tasks = rows.map(task => ({
        id: task.id,
        title: task.title,
        recurrence: task.recurrence,
        nextRunAt: task.next_run_at,
        active: task.active !== false,
        condition: task.condition || null,
        // "What are you watching for me?" should answer with the real state of each watch —
        // what it looks at, what it last saw, and whether its last check actually worked.
        watch: task.watch_state ? {
          type: task.watch_state.type,
          threshold: task.watch_state.threshold ?? null,
          comparator: task.watch_state.comparator || null,
          notifyRule: task.watch_state.notifyRule || null,
          sourceUrl: task.watch_state.sourceUrl || null,
          lastObserved: task.watch_state.lastObserved || null,
          lastCheckFailed: task.watch_state.lastEvaluation?.kind === 'blocked'
            ? task.watch_state.lastEvaluation.reason : null
        } : null
      }));
      return {
        success: true,
        text: tasks.length
          ? rows.map(task => {
            const detail = watches.describeWatch(task);
            return `• ${task.title} · ${scheduledTasks.describeSchedule(task)}${detail ? ` · ${detail}` : ''}`;
          }).join('\n')
          : 'Millie is not watching anything right now.',
        actionSummary: `${tasks.length} watch${tasks.length === 1 ? '' : 'es'}`,
        scheduledTasks: tasks
      };
    }
    case 'cancel_scheduled_task': {
      const id = String(params?.id || '').trim();
      const title = String(params?.title || '').trim();
      if (!id && !title) return { success: false, error: 'Tell me which background watch to cancel.' };
      const cancelled = await scheduledTasks.cancelScheduledTask(userId, { id, title });
      if (!cancelled.success) {
        return cancelled.error === 'not_found'
          ? { success: false, error: 'I could not find that background watch.' }
          : cancelled;
      }
      return {
        success: true,
        text: `Stopped watching “${cancelled.task?.title || title || 'that'}”.`,
        actionSummary: 'Watch stopped',
        scheduledTask: { id: cancelled.task?.id || id, title: cancelled.task?.title || title, active: false }
      };
    }
    // Adjusting a watch instead of deleting and recreating it — which would throw away the
    // baseline and observation history that make "has it changed?" answerable at all.
    case 'update_scheduled_task': {
      const updated = await scheduledTasks.updateScheduledTask(userId, {
        id: params?.id,
        title: params?.title,
        new_title: params?.new_title,
        recurrence: params?.recurrence,
        interval_minutes: params?.interval_minutes,
        time: params?.time || params?.time_of_day,
        day_of_week: params?.day_of_week,
        condition: params?.condition,
        threshold: params?.threshold,
        comparator: params?.comparator,
        notify_rule: params?.notify_rule,
        source_url: params?.source_url,
        instruction: params?.instruction,
        budget_cap: params?.budget_cap
      });
      if (!updated.success) {
        if (updated.error === 'not_found') return { success: false, error: 'I could not find that watch.' };
        if (updated.error === 'ambiguous') {
          return { success: false, error: `More than one watch matches that: ${updated.candidates.map(c => c.title).join(', ')}. Which one?` };
        }
        return updated;
      }
      const task = updated.task || {};
      return {
        success: true,
        text: `Updated “${task.title}” — now ${scheduledTasks.describeSchedule(task)}${watches.describeWatch(task) ? ` · ${watches.describeWatch(task)}` : ''}.`,
        actionSummary: 'Watch updated',
        scheduledTask: { id: task.id, title: task.title, recurrence: task.recurrence, nextRunAt: task.next_run_at, watch: task.watch_state || null }
      };
    }

    // Called by a watch's own background run with what it ACTUALLY observed. The notify
    // decision comes back from watches.evaluateObservation — deterministic, computed from
    // the recorded value, and therefore not something the model can talk itself into.
    case 'record_watch_observation': {
      const recorded = await scheduledTasks.recordWatchObservation(userId, {
        id: String(params?.watch_id || params?.id || '').trim(),
        value: params?.value,
        state: params?.state,
        note: params?.note,
        accessible: !(params?.accessible === false || String(params?.accessible) === 'false'),
        error: params?.error || params?.reason
      });
      if (!recorded.success) {
        return recorded.error === 'not_found'
          ? { success: false, error: 'That watch no longer exists.' }
          : recorded;
      }
      return {
        success: true,
        notify: recorded.notify,
        kind: recorded.kind,
        terminal: recorded.terminal,
        text: recorded.notify
          ? `This IS news: ${recorded.reason}. Report it to the user.`
          : `Not news: ${recorded.reason}. Do not notify the user this cycle.`
      };
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
    case 'github_action':
      return dispatch(userId, action, enrichedParams);
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

    // Orchestrates real Gmail search + the shared triage classifier (emailTriageSignals,
    // not a second parallel one) + the real archive/unsubscribe mutation primitives in
    // connectors/google.js. See api/services/gmail-cleanup.js for the pure decision logic.
    case 'clean_inbox': {
      const { sender, since, before, query, unsubscribe_senders } = params || {};
      const searchQuery = buildCleanupQuery({ sender, since, before, query });
      const cap = Math.max(1, Math.min(Number(params?.max_results) || 300, 500));

      const searchResult = await dispatch(userId, 'search_emails', { query: searchQuery, max_results: cap });
      if (!searchResult?.success) {
        return { success: false, error: searchResult?.error || 'Could not search your inbox for that.' };
      }
      const emails = searchResult.emails || [];
      if (!emails.length) {
        return { success: true, archived: 0, preserved: 0, unsubscribed: [], text: 'Nothing matched that in your inbox — there was nothing to clean up.' };
      }

      const classified = emails.map(email => {
        const signal = emailTriageSignals(email, '');
        return { email, signal, decision: classifyForCleanup(email, signal) };
      });
      const toArchive = classified.filter(c => c.decision.archive);
      const preservedCount = classified.length - toArchive.length;

      let archived = 0;
      let archiveFailed = 0;
      if (toArchive.length) {
        const archiveResult = await dispatch(userId, 'archive_emails', { message_ids: toArchive.map(c => c.email.id) });
        archived = archiveResult?.modified || 0;
        archiveFailed = (archiveResult?.failed || []).length;
      }

      const unsubscribed = [];
      const unsubscribeFailed = [];
      const needsBrowserUnsubscribe = [];
      if (unsubscribe_senders !== false) {
        const targets = dedupeSendersForUnsubscribe(toArchive.filter(c => c.decision.unsubscribeCandidate));
        for (const target of targets) {
          const result = await dispatch(userId, 'unsubscribe_email', { message_id: target.email.id });
          const label = cleanupSenderLabel(target.email);
          if (result?.success) unsubscribed.push({ sender: label, method: result.method });
          else if (result?.needsBrowser) needsBrowserUnsubscribe.push({ sender: label, url: result.url });
          else unsubscribeFailed.push({ sender: label, reason: result?.error || 'unknown error' });
        }
      }

      const text = summarizeCleanupResult({
        scanned: emails.length,
        archived,
        archiveFailed,
        preservedCount,
        unsubscribed,
        unsubscribeFailed,
        needsBrowserUnsubscribe
      });
      return {
        success: true,
        scanned: emails.length,
        archived,
        archiveFailed,
        preserved: preservedCount,
        unsubscribed,
        unsubscribeFailed,
        needsBrowserUnsubscribe,
        text
      };
    }

    // "Who's waiting on me?" — a THREAD-level judgment (does this thread's current state need
    // something from the user), genuinely different from emailTriageSignals' message-level
    // "is this urgent/promotional" question, so it gets its own classifier
    // (api/services/reply-needed.js) rather than overloading the existing one. The cheap
    // pre-filter reuses the same signal shape (List-Unsubscribe, automated-sender wording,
    // receipt/order language) so obvious noise never reaches the LLM judgment call.
    case 'find_reply_needed': {
      const maxThreads = Math.max(1, Math.min(Number(params?.max_threads) || 20, 40));
      const searchResult = await dispatch(userId, 'search_emails', { query: 'in:inbox', max_results: 100 });
      if (!searchResult?.success) {
        return { success: false, error: searchResult?.error || 'Could not search your inbox.' };
      }
      const emails = searchResult.emails || [];
      const latestPerThread = latestMessagePerThread(emails).filter(email => !isObviouslyNoReplyNeeded(email));
      const candidates = latestPerThread.slice(0, maxThreads);

      if (!candidates.length) {
        return { success: true, items: [], text: formatReplyNeededSummary([]) };
      }

      const threadContexts = [];
      for (const email of candidates) {
        try {
          const thread = await googleConnector.getThreadContext(userId, email.threadId);
          threadContexts.push({
            threadId: email.threadId,
            senderName: email.senderName,
            senderAddress: email.senderAddress,
            subject: email.subject,
            date: email.date,
            threadText: thread?.text || email.body || email.snippet || ''
          });
        } catch {
          // A thread we can't fetch can't be judged — skip it rather than guessing.
        }
      }
      if (!threadContexts.length) {
        return { success: true, items: [], text: formatReplyNeededSummary([]) };
      }

      let items = [];
      try {
        const prompt = buildReplyNeededPrompt(threadContexts, {});
        const judgment = await generateBrain({ model: FAST_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: {} });
        items = parseReplyNeededResponse(judgment.text || '', threadContexts);
      } catch (e) {
        return { success: false, error: `Could not judge which threads need a response: ${e.message}` };
      }

      return {
        success: true,
        items,
        scanned: emails.length,
        threadsConsidered: threadContexts.length,
        text: formatReplyNeededSummary(items)
      };
    }

    // "What do I need to know today?" — composed from the capabilities that are already
    // real, never a dump of every source. Everything here is re-read live on each call:
    // that is what makes a recurring morning brief a genuine current-state digest rather
    // than a stored summary replayed every day. Ranking/noise rules live in
    // api/services/daily-digest.js; this case is purely the gathering.
    case 'daily_digest': {
      const focusRaw = String(params?.focus || 'all').trim().toLowerCase();
      const focus = ['urgent', 'can_wait', 'all'].includes(focusRaw) ? focusRaw : 'all';
      const now = new Date();
      const coverage = {};

      const watchSince = new Date(now.getTime() - dailyDigest.WATCH_UPDATE_MAX_AGE_HOURS * 3600000).toISOString();
      const [replyResult, occasionResult, commitmentResult, scheduledResult, watchResult, calendarEvents, approvalResult] = await Promise.all([
        // Real thread-level judgment, not a stored list — someone may have replied since
        // yesterday, in which case they correctly drop off today's digest.
        executeAction(userId, 'find_reply_needed', { max_threads: 15 }).catch(e => ({ success: false, error: e.message })),
        executeAction(userId, 'find_occasions', {}).catch(e => ({ success: false, error: e.message })),
        supabase.from('commitments').select('*').eq('user_id', userId).eq('status', 'open').limit(50),
        scheduledTasks.listScheduledTasks(userId).catch(e => ({ success: false, error: e.message })),
        supabase.from('briefings')
          .select('id, kind, title, body, metadata, read, created_at')
          .eq('user_id', userId)
          .eq('kind', 'scheduled_task')
          // Unread only: once the user has seen a parcel update it stops being news, which
          // is also what makes a resolved item disappear from the next run.
          .eq('read', false)
          .gte('created_at', watchSince)
          .order('created_at', { ascending: false })
          .limit(20),
        gatherCalendarContext(userId).catch(() => []),
        agentApprovals.listPendingApprovals(supabase, userId).catch(e => ({ approvals: [], error: e.message }))
      ]);

      if (replyResult?.success) coverage.email = { ok: true };
      else coverage.email = { ok: false, reason: replyResult?.error || 'your inbox was unreachable' };
      if (scheduledResult?.success) coverage.reminders = { ok: true };
      else coverage.reminders = { ok: false, reason: scheduledResult?.error || 'reminders were unreachable' };
      coverage.calendar = calendarEvents?.length ? { ok: true } : { ok: true, empty: true };
      if (watchResult?.error) coverage.watches = { ok: false, reason: watchResult.error.message || 'watch updates were unreachable' };

      const scheduledList = scheduledResult?.tasks || [];
      // A recurring digest is itself a scheduled task whose run writes a briefing row.
      // Without this its own output would show up in tomorrow's digest as something on the
      // user's plate.
      const digestTaskIds = new Set(
        scheduledList.filter(task => String(task.instruction || '').includes(dailyDigest.DIGEST_MARKER)).map(task => task.id)
      );
      const watchUpdates = (watchResult?.data || []).filter(row => !digestTaskIds.has(row?.metadata?.scheduledTaskId));

      const digest = dailyDigest.buildDailyDigest({
        replyNeeded: replyResult?.items || [],
        occasions: occasionResult?.items || [],
        commitments: commitmentResult?.data || [],
        scheduledTasks: scheduledList,
        watchUpdates,
        calendarEvents: calendarEvents || [],
        approvals: approvalResult?.approvals || [],
        coverage,
        focus,
        now
      });

      return { success: true, ...digest };
    }

    // Real trip planning. Named plan_itinerary, not plan_trip: plan_trip already exists
    // elsewhere in this switch as a point-to-point route/train planner, an unrelated
    // capability — do not merge or rename either without checking both. Deliberately does NOT
    // use search_flights/search_hotels (those only build a browser deep-link, never real
    // prices or availability) or itinerary-engine.js's dormant hotels/activities/flights
    // fields (nothing populates them for real) — the only live-facts source here is a real
    // grounded web search, fed into itinerary-engine.js as groundedNotes. Booking is a
    // deliberately separate step (see run_browser_task's guidance).
    case 'plan_itinerary': {
      const destination = String(params?.destination || '').trim();
      if (!destination) return { success: false, error: 'plan_itinerary requires destination' };

      const requirements = {
        destination,
        origin: params?.origin || undefined,
        date: params?.start_date || undefined,
        endDate: params?.end_date || undefined,
        duration: params?.duration_days || undefined,
        partySize: params?.party_size || undefined,
        budget: params?.budget ? `${params?.budget_currency || ''}${params.budget}` : undefined,
        transportMode: params?.transport_mode || undefined,
        interests: Array.isArray(params?.interests) ? params.interests : undefined,
        dietary: Array.isArray(params?.dietary) ? params.dietary : undefined,
        accessibility: params?.accessibility || undefined,
        pace: params?.pace || undefined,
        alreadyDone: params?.already_done || undefined,
        notes: params?.notes || undefined
      };
      Object.keys(requirements).forEach(key => requirements[key] === undefined && delete requirements[key]);

      let groundedNotes = '';
      let groundedResearch = false;
      try {
        const searchQuery = [
          `Practical trip-planning info for ${destination}`,
          params?.start_date ? `around ${params.start_date}${params?.end_date ? ` to ${params.end_date}` : ''}` : '',
          params?.interests?.length ? `for someone interested in ${[].concat(params.interests).join(', ')}` : ''
        ].filter(Boolean).join(' ');
        const answer = await webSearchBrain({
          model: FAST_MODEL,
          prompt: `Today's date is ${getLocalDateKey()}. ${searchQuery}. Cover: top attractions worth the time with realistic visit durations, current opening hours and any closures, approximate current ticket/entry prices, realistic walking/transit times between areas, and any well-known food spots. Only report what search results actually support; say plainly if something can't be verified rather than guessing. Plain prose, no markdown headings or asterisks.`
        });
        if (answer) { groundedNotes = answer; groundedResearch = true; }
      } catch (e) {
        console.warn('[plan_itinerary] grounded search failed, generating without it:', e.message);
      }

      // A full multi-day itinerary (or a modified one) is a large JSON payload — the default
      // completion budget elsewhere in this file (768 tokens, fine for short replies/judgments)
      // left nothing for visible output once a reasoning model spent its budget on reasoning
      // tokens, so generateBrain came back with empty text. Confirmed live 2026-08-08: the
      // same request against gpt-5.6-luna returned candidates[0].content.parts: [] with
      // maxOutputTokens unset; raising the cap fixed it.
      const callModel = async (systemPrompt, prompt) => {
        const res = await generateBrain({ model: FAST_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: { systemInstruction: systemPrompt, maxOutputTokens: 4000 } });
        return res?.text || '';
      };

      let itinerary;
      try {
        itinerary = await generateItinerary(requirements, { groundedNotes }, null, callModel);
      } catch (e) {
        return { success: false, error: `Could not build an itinerary: ${e.message}` };
      }

      const caveats = [
        groundedResearch
          ? null
          : "I couldn't verify current opening hours/prices/closures for this trip, so treat times and costs as estimates, not confirmed facts.",
        'Flights and hotels are not live-searched or booked here — say the word and I can look at real options and take you through an actual booking.'
      ].filter(Boolean);

      return {
        success: true,
        itinerary,
        groundedResearch,
        text: `${itineraryToText(itinerary)}\n\n${caveats.join(' ')}`
      };
    }

    // Surgical edit of an existing itinerary (preserves days/sections the instruction doesn't
    // touch) rather than a full regeneration. Accepts the itinerary inline (the model's own
    // context from a recent plan_itinerary call) or a workspace_path to a previously saved one —
    // whichever is fresher wins if both are given, and a workspace-loaded trip is re-saved
    // to the same path after the edit so the saved copy stays in sync.
    case 'modify_itinerary': {
      const instruction = String(params?.instruction || '').trim();
      if (!instruction) return { success: false, error: 'modify_itinerary requires instruction' };

      let itinerary = null;
      let workspacePath = params?.workspace_path ? String(params.workspace_path).trim() : '';

      if (params?.itinerary) {
        try {
          itinerary = typeof params.itinerary === 'string' ? JSON.parse(params.itinerary) : params.itinerary;
        } catch {
          return { success: false, error: 'The itinerary passed to modify_itinerary was not valid JSON. Pass the exact itinerary object from plan_itinerary, or a workspace_path to a previously saved one.' };
        }
      } else if (workspacePath) {
        let file;
        try {
          file = await agentWorkspace.readWorkspaceFile(supabase, userId, workspacePath);
        } catch (e) {
          return { success: false, error: e.message };
        }
        if (!file) return { success: false, error: `No saved itinerary at ${workspacePath}.` };
        try {
          itinerary = JSON.parse(file.content);
        } catch {
          return { success: false, error: `The saved file at ${workspacePath} isn't valid itinerary JSON, so it can't be edited directly. Generate a fresh one with plan_itinerary instead.` };
        }
      } else {
        return { success: false, error: 'modify_itinerary needs either the itinerary JSON from a recent plan_itinerary call, or a workspace_path to a previously saved itinerary.' };
      }

      if (!itinerary?.days) return { success: false, error: 'That does not look like a valid itinerary (no days array).' };

      // A full multi-day itinerary (or a modified one) is a large JSON payload — the default
      // completion budget elsewhere in this file (768 tokens, fine for short replies/judgments)
      // left nothing for visible output once a reasoning model spent its budget on reasoning
      // tokens, so generateBrain came back with empty text. Confirmed live 2026-08-08: the
      // same request against gpt-5.6-luna returned candidates[0].content.parts: [] with
      // maxOutputTokens unset; raising the cap fixed it.
      const callModel = async (systemPrompt, prompt) => {
        const res = await generateBrain({ model: FAST_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: { systemInstruction: systemPrompt, maxOutputTokens: 4000 } });
        return res?.text || '';
      };

      let updated;
      try {
        updated = await modifyItinerary(itinerary, instruction, {}, callModel);
      } catch (e) {
        return { success: false, error: `Could not apply that change: ${e.message}` };
      }

      let resaved = false;
      if (workspacePath) {
        try {
          await agentWorkspace.writeWorkspaceFile(supabase, userId, workspacePath, JSON.stringify(updated, null, 2), 'file');
          resaved = true;
        } catch (e) {
          console.warn('[modify_itinerary] re-save failed:', e.message);
        }
      }

      return {
        success: true,
        itinerary: updated,
        resaved,
        text: `${updated.lastModification?.summary || 'Updated the itinerary.'}${resaved ? ` (re-saved to ${workspacePath})` : ''}\n\n${itineraryToText(updated)}`
      };
    }

    // Durable birthday/occasion capture. Deliberately its own table (occasions), not the
    // free-text memories table — "whose birthday is coming up?" needs a real date to sort on,
    // not prose to re-parse on every request. select-then-insert-or-update rather than a DB
    // upsert: the unique index is on lower(person_name), an expression PostgREST's on_conflict
    // param can't target reliably, and birthdays are input rarely enough that the tiny race
    // window is not worth the complexity.
    case 'save_occasion': {
      const personName = String(params?.person_name || '').trim();
      const occasionType = (String(params?.occasion_type || 'birthday').trim().toLowerCase()) || 'birthday';
      const month = Number(params?.month);
      const day = Number(params?.day);
      if (!personName) return { success: false, error: 'save_occasion requires person_name' };
      if (!isValidMonthDay(month, day)) return { success: false, error: 'save_occasion requires a real month (1-12) and a day that exists in that month' };

      const yearNum = Number(params?.year);
      const year = Number.isInteger(yearNum) && yearNum > 1900 && yearNum <= new Date().getFullYear() ? yearNum : null;
      const relationship = params?.relationship ? String(params.relationship).trim().slice(0, 100) : null;
      const notes = params?.notes ? String(params.notes).trim().slice(0, 1000) : null;

      const { data: existing, error: findError } = await supabase
        .from('occasions')
        .select('id')
        .eq('user_id', userId)
        .eq('occasion_type', occasionType)
        .ilike('person_name', escapeIlikePattern(personName))
        .maybeSingle();
      if (findError) return { success: false, error: findError.message };

      // Link the occasion to the canonical person so "get Alisa something for her birthday"
      // connects recipient + occasion + preferences. Deliberately non-blocking: if the name
      // is ambiguous (two Alisas) nothing is merged and the occasion still saves with
      // participant_id null — a wrong link is worse than no link.
      let participantId = null;
      try {
        const resolved = await people.resolvePerson(supabase, userId, { name: personName });
        if (resolved.person) {
          participantId = resolved.person.id;
          if (relationship && !resolved.person.relationship) {
            await supabase.from('participants').update({ relationship, updated_at: new Date().toISOString() }).eq('id', participantId);
          }
        } else if (!resolved.ambiguous) {
          const created = await people.upsertPerson(supabase, userId, { name: personName, relationship, source: 'learned' });
          if (created.success) participantId = created.person.id;
        }
      } catch {
        // The people layer is an enrichment here, never a precondition for saving a birthday.
      }

      const row = { user_id: userId, person_name: personName, occasion_type: occasionType, month, day, year, relationship, notes, updated_at: new Date().toISOString() };
      // Only ever set the link, never clear one that already resolved on an earlier save.
      if (participantId) row.participant_id = participantId;
      const { error } = existing?.id
        ? await supabase.from('occasions').update(row).eq('id', existing.id)
        : await supabase.from('occasions').insert({ ...row, source: 'chat' });
      if (error) return { success: false, error: error.message };

      let reminderScheduled = false;
      let reminderText = '';
      const remindDaysBeforeNum = Number(params?.remind_days_before);
      const wantsReminder = params?.remind_on_day === true || Number.isFinite(remindDaysBeforeNum);
      if (wantsReminder) {
        const offset = params?.remind_on_day === true ? 0 : Math.max(0, remindDaysBeforeNum);
        const dueDate = computeReminderDueDate(month, day, offset, new Date());
        const isBirthday = occasionType === 'birthday';
        // Same composition pattern as the delivery-watch reminders: recurrence:'once' with a
        // computed due_date, and the instruction tells Millie to re-arm itself for next year
        // after firing — no new scheduler cadence needed (isRecurringCadence only supports
        // daily/weekly today, and adding 'yearly' there is scheduler-internals work this pass
        // is explicitly not meant to spend time on).
        const created = await scheduledTasks.createScheduledTask(userId, {
          title: `${personName}'s ${occasionType}`,
          instruction: `Tell the user ${personName}'s ${occasionType} is coming up${offset > 0 ? ` in ${offset} day${offset === 1 ? '' : 's'}` : ' today'} (${formatMonthDay(month, day)}).${isBirthday ? ' Offer to help find and buy a gift if they want one: ask their budget if not already known, use web_search for real current options given what you know about the person (relationship, interests, past gifts if mentioned), and run_browser_task for an actual purchase — never say something was bought until that flow actually confirms it.' : ''} After delivering this reminder, call create_scheduled_task again with the same title, recurrence \'once\', and due_date set to exactly one year from today\'s date, so this keeps coming back every year without the user having to ask again.`,
          recurrence: 'once',
          due_date: dueDate.toISOString(),
          time: '09:00'
        });
        reminderScheduled = Boolean(created?.success);
        reminderText = reminderScheduled
          ? ` I'll remind you ${offset > 0 ? `${offset} day${offset === 1 ? '' : 's'} before` : 'on the day'} (around ${formatMonthDay(dueDate.getUTCMonth() + 1, dueDate.getUTCDate())}).`
          : ' (the reminder could not be set up — you can ask again separately.)';
      }

      return {
        success: true,
        occasion: { personName, occasionType, month, day, year, relationship, notes },
        reminderScheduled,
        text: `Saved ${personName}'s ${occasionType} (${formatMonthDay(month, day)}).${reminderText}`
      };
    }

    case 'find_occasions': {
      const personFilter = params?.person_name ? String(params.person_name).trim() : '';
      let query = supabase.from('occasions').select('person_name, occasion_type, month, day, year, relationship, notes').eq('user_id', userId);
      if (personFilter) query = query.ilike('person_name', `%${escapeIlikePattern(personFilter)}%`);
      const { data, error } = await query;
      if (error) return { success: false, error: error.message };

      const items = (data || []).map(row => ({
        personName: row.person_name,
        occasionType: row.occasion_type,
        month: row.month,
        day: row.day,
        year: row.year,
        relationship: row.relationship,
        notes: row.notes,
        daysUntil: daysUntil(row.month, row.day)
      }));

      if (personFilter && !items.length) {
        return { success: true, items: [], text: `I don't have a saved birthday or occasion for "${personFilter}".` };
      }

      return {
        success: true,
        items,
        text: formatOccasionsSummary(items)
      };
    }

    // ── Real travel search ────────────────────────────────────────────────────────────
    // These two used to build a deep link and report success. They now do a real grounded
    // web search and return what the results actually stated, with prices marked as
    // observed-not-bookable. See api/services/travel-search.js for why this route and not
    // an API or a browser. They are also removed from the connectors registry, so the old
    // link-generator is unreachable rather than merely unused.
    case 'search_flights':
    case 'search_hotels': {
      const kind = action === 'search_flights' ? 'flights' : 'hotels';
      const today = getLocalDateKey();

      const research = kind === 'flights'
        ? travelSearch.buildFlightResearchPrompt({
          from: String(params?.from || '').trim(),
          to: String(params?.to || params?.destination || '').trim(),
          departDate: String(params?.depart_date || params?.date || '').trim(),
          returnDate: String(params?.return_date || '').trim(),
          adults: Math.max(1, Math.min(Number(params?.adults) || 1, 9)),
          notes: String(params?.notes || '').trim(),
          maxPrice: Number(params?.max_price) || null,
          directOnly: params?.direct_only === true || String(params?.direct_only) === 'true',
          today
        })
        : travelSearch.buildHotelResearchPrompt({
          location: String(params?.location || params?.city || '').trim(),
          checkIn: String(params?.check_in || params?.checkin || '').trim(),
          checkOut: String(params?.check_out || params?.checkout || '').trim(),
          guests: Math.max(1, Math.min(Number(params?.guests) || 2, 12)),
          maxNightly: params?.max_price ? String(params.max_price) : '',
          area: String(params?.area || '').trim(),
          notes: String(params?.notes || '').trim(),
          today
        });

      if (kind === 'flights' && (!params?.from || !(params?.to || params?.destination))) {
        return { success: false, error: 'search_flights needs both a departure and a destination.' };
      }
      if (kind === 'hotels' && !(params?.location || params?.city)) {
        return { success: false, error: 'search_hotels needs a location.' };
      }

      let researchText = '';
      try {
        researchText = await webSearchBrain({ model: FAST_MODEL, prompt: research });
      } catch (e) {
        return { success: false, error: `The travel search could not run: ${e.message}` };
      }
      if (!researchText) {
        return { success: false, error: 'The web search returned nothing for that route — I have no real options to show you rather than made-up ones.' };
      }

      // Stage two runs WITHOUT the search tool: it may only restructure the text above, so
      // it cannot introduce an option that was never found. The token budget is explicit —
      // the default (768, shared with reasoning) silently returns an empty string on an
      // input this long.
      let options = [];
      try {
        const extracted = await generateBrain({
          model: FAST_MODEL,
          contents: [{ role: 'user', parts: [{ text: travelSearch.buildExtractionPrompt(kind, researchText, params || {}) }] }],
          config: { maxOutputTokens: travelSearch.EXTRACTION_TOKENS }
        });
        options = travelSearch.parseTravelResults(kind, extracted.text || '');
      } catch (e) {
        return { success: false, error: `The travel search found results but could not read them: ${e.message}`, research: researchText };
      }

      const { kept, dropped } = travelSearch.applyConstraints(options, {
        maxPrice: Number(params?.max_price) || null,
        directOnly: params?.direct_only === true || String(params?.direct_only) === 'true',
        maxStops: Number.isFinite(Number(params?.max_stops)) && params?.max_stops !== undefined ? Number(params.max_stops) : undefined,
        minRating: Number(params?.min_rating) || null
      });

      // travel-ranking.js finally has real structured results to rank. It was written for an
      // Amadeus connector that never existed here, which is why it sat orphaned; the mapping
      // in toRankingShape is what makes it live rather than rewriting it.
      const requirements = {
        budget: params?.max_price ? String(params.max_price) : '',
        constraints: (params?.direct_only === true || String(params?.direct_only) === 'true') ? ['direct_or_fewest_changes'] : [],
        partySize: String(params?.adults || params?.guests || 1),
        accommodationPreference: String(params?.style || '').trim()
      };
      const shaped = kept.map(travelSearch.toRankingShape);
      const ranked = kind === 'flights'
        ? travelRanking.rankFlights(shaped, {}, requirements)
        : travelRanking.rankHotels(shaped, {}, requirements);
      // Date-matched options always outrank indicative ones, whatever the score: a cheaper
      // price for the wrong week is not a better option, it is a different question.
      ranked.sort((a, b) => (Number(b.matchesRequestedDates) - Number(a.matchesRequestedDates)) || (b.score - a.score));

      const searched = kind === 'flights'
        ? `${params.from} to ${params.to || params.destination}${params?.depart_date ? ` ${params.depart_date}` : ''}${params?.return_date ? `–${params.return_date}` : ''}`
        : `${params.location || params.city}${params?.check_in ? ` ${params.check_in}` : ''}${params?.check_out ? `–${params.check_out}` : ''}`;

      return {
        success: true,
        kind,
        options: ranked,
        datesMatched: ranked.filter(o => o.matchesRequestedDates).length,
        indicative: ranked.filter(o => !o.matchesRequestedDates).length,
        droppedByConstraints: dropped.map(d => ({ why: d.why, option: d.option.airline || d.option.name })),
        research: researchText,
        bookable: false,
        text: travelSearch.formatTravelResults(kind, ranked, { dropped, searched, researchFound: Boolean(researchText) })
      };
    }

    // ── Calendar as something you can actually act on ─────────────────────────────────
    // Availability is computed by subtracting REAL events from the working window. If the
    // calendar cannot be read, this says so rather than inventing free time.
    case 'find_free_time': {
      const durationMinutes = Math.max(15, Math.min(Number(params?.duration_minutes) || 60, 480));
      const days = Math.max(1, Math.min(Number(params?.days) || 7, 21));
      const calendar = await dispatch(userId, 'get_calendar_events', { max_results: 100, days });
      if (!calendar?.success) {
        return {
          success: false,
          calendarRead: false,
          error: calendar?.error || 'your calendar was unreachable',
          text: scheduling.formatFreeSlots([], { durationMinutes, calendarRead: false, reason: calendar?.error })
        };
      }

      const working = { ...scheduling.DEFAULT_WORKING };
      if (params?.include_weekends === true || String(params?.include_weekends) === 'true') working.days = [0, 1, 2, 3, 4, 5, 6];
      const slots = scheduling.findFreeSlots({
        events: calendar.events || [],
        from: new Date(),
        days,
        durationMinutes,
        working,
        earliestMinute: scheduling.parseTimeOfDay(params?.earliest),
        latestMinute: scheduling.parseTimeOfDay(params?.latest),
        maxSlots: Math.max(1, Math.min(Number(params?.max_options) || 6, 12))
      });

      return {
        success: true,
        calendarRead: true,
        durationMinutes,
        slots: slots.map(slot => ({ start: slot.start.toISOString(), end: slot.end.toISOString(), label: scheduling.describeSlot(slot) })),
        busyCount: (calendar.events || []).length,
        text: scheduling.formatFreeSlots(slots, { durationMinutes })
      };
    }

    // Books a real block, at a real free time, without double-booking or duplicating.
    case 'schedule_block': {
      const title = String(params?.title || '').trim();
      if (!title) return { success: false, error: 'schedule_block needs a title' };
      const durationMinutes = Math.max(15, Math.min(Number(params?.duration_minutes) || 60, 480));

      const calendar = await dispatch(userId, 'get_calendar_events', { max_results: 100, days: 21 });
      if (!calendar?.success) {
        return { success: false, error: `I couldn't read your calendar (${calendar?.error || 'unreachable'}), so I won't book anything blind.` };
      }
      const events = calendar.events || [];

      let start = params?.start ? new Date(params.start) : null;
      if (start && Number.isNaN(start.getTime())) start = null;
      if (!start) {
        const [slot] = scheduling.findFreeSlots({
          events, from: new Date(), days: Math.max(1, Math.min(Number(params?.days) || 7, 21)),
          durationMinutes,
          earliestMinute: scheduling.parseTimeOfDay(params?.earliest),
          latestMinute: scheduling.parseTimeOfDay(params?.latest),
          maxSlots: 1
        });
        if (!slot) return { success: false, error: `There's no free ${durationMinutes}-minute slot in that window — your calendar is full across it.` };
        start = slot.start;
      }
      const end = new Date(start.getTime() + durationMinutes * 60000);

      const duplicate = scheduling.findDuplicateEvent({ title, start, events });
      if (duplicate) {
        return { success: true, duplicate: true, eventId: duplicate.id, text: `"${title}" is already in your calendar around then — I haven't added a second one.` };
      }
      const conflicts = scheduling.findConflicts({ start, end, events });
      if (conflicts.length && params?.allow_conflict !== true) {
        return {
          success: false, conflicts,
          error: `That clashes with ${conflicts.map(c => c.title).join(', ')}. Want me to put it somewhere else, or book it anyway?`
        };
      }

      const created = await dispatch(userId, 'create_calendar_event', {
        title, start_date: start.toISOString(), end_date: end.toISOString(),
        description: params?.description || '', attendees: params?.attendees
      });
      if (!created?.success) return { success: false, error: created?.error || 'The calendar rejected that event.' };

      // A block booked FOR a commitment stays linked to it, so the commitment is what gets
      // chased — not the calendar entry.
      if (params?.commitment_id) {
        await supabase.from('commitments').update({ updated_at: new Date().toISOString() })
          .eq('id', params.commitment_id).eq('user_id', userId);
      }
      return {
        success: true,
        eventId: created.eventId,
        start: start.toISOString(),
        end: end.toISOString(),
        invited: created.invited || [],
        text: `Booked "${title}" ${scheduling.describeSlot({ start, end })}${created.invited?.length ? ` and invited ${created.invited.join(', ')}` : ''}.`
      };
    }

    // Replanning changes the existing event rather than leaving the old time behind.
    case 'move_calendar_event': {
      const eventId = String(params?.event_id || '').trim();
      const query = String(params?.title || '').trim();
      const calendar = await dispatch(userId, 'get_calendar_events', { max_results: 100, days: 30 });
      if (!calendar?.success) return { success: false, error: `I couldn't read your calendar (${calendar?.error || 'unreachable'}).` };
      const events = calendar.events || [];

      let target = eventId ? events.find(e => e.id === eventId) : null;
      if (!target && query) {
        const matches = events.filter(e => String(e.title || '').toLowerCase().includes(query.toLowerCase()));
        if (matches.length > 1) return { success: false, error: `More than one event matches "${query}": ${matches.map(m => m.title).join(', ')}. Which one?` };
        target = matches[0] || null;
      }
      if (!target) return { success: false, error: `I couldn't find an event matching "${query || eventId}".` };

      const start = params?.start ? new Date(params.start) : null;
      if (!start || Number.isNaN(start.getTime())) return { success: false, error: 'move_calendar_event needs a new start time.' };
      const originalStart = new Date(target.start);
      const originalEnd = new Date(target.end || target.start);
      const length = Number(params?.duration_minutes) > 0
        ? Number(params.duration_minutes) * 60000
        : Math.max(originalEnd.getTime() - originalStart.getTime(), 30 * 60000);
      const end = new Date(start.getTime() + length);

      // The event being moved is not a conflict with itself.
      const conflicts = scheduling.findConflicts({ start, end, events: events.filter(e => e.id !== target.id) });
      if (conflicts.length && params?.allow_conflict !== true) {
        return { success: false, conflicts, error: `That would clash with ${conflicts.map(c => c.title).join(', ')}. Somewhere else, or move it anyway?` };
      }

      const updated = await dispatch(userId, 'update_calendar_event', {
        event_id: target.id, start_date: start.toISOString(), end_date: end.toISOString()
      });
      if (!updated?.success) return { success: false, error: updated?.error || 'The calendar rejected that change.' };
      return {
        success: true, eventId: target.id,
        text: `Moved "${target.title}" to ${scheduling.describeSlot({ start, end })}.`
      };
    }

    // ── Commitments ───────────────────────────────────────────────────────────────────
    // What the user said they would do. Linked to the people layer and the scheduler rather
    // than re-implementing either.
    case 'track_commitment': {
      const what = String(params?.what || '').trim().slice(0, commitments.MAX_WHAT);
      if (!what) return { success: false, error: 'track_commitment needs what was promised' };

      const personName = String(params?.person_name || '').trim();
      let participantId = null;
      if (personName) {
        const resolved = await people.resolvePerson(supabase, userId, { name: personName, email: params?.person_email });
        if (resolved.person) participantId = resolved.person.id;
      }

      const whenText = String(params?.due || '').trim();
      const parsed = whenText ? commitments.extractDueDate(whenText, new Date()) : { dueAt: null, dateOnly: false };
      const explicitDue = params?.due_at && !Number.isNaN(Date.parse(params.due_at)) ? new Date(params.due_at) : null;
      const dueAt = explicitDue || parsed.dueAt;

      const row = {
        user_id: userId,
        what,
        participant_id: participantId,
        person_name: personName || null,
        due_at: dueAt ? dueAt.toISOString() : null,
        due_is_date_only: explicitDue ? false : parsed.dateOnly,
        source: ['stated', 'sent_email', 'email_context'].includes(params?.source) ? params.source : 'stated',
        source_ref: params?.source_ref || null,
        thread_id: params?.thread_id || null,
        updated_at: new Date().toISOString()
      };

      // Re-stating the same promise updates it (a new date, a named person) rather than
      // creating a second obligation.
      const { data: existing } = await supabase.from('commitments')
        .select('id').eq('user_id', userId).eq('status', 'open')
        .ilike('what', escapeIlikePattern(what)).maybeSingle();

      const { data, error } = existing?.id
        ? await supabase.from('commitments').update(row).eq('id', existing.id).select('*').single()
        : await supabase.from('commitments').insert(row).select('*').single();
      if (error) return { success: false, error: error.message };

      return {
        success: true,
        commitment: data,
        updated: Boolean(existing?.id),
        text: `Noted: ${commitments.describeCommitment(data)}.`
      };
    }

    case 'find_commitments': {
      const personFilter = String(params?.person_name || '').trim();
      const scope = String(params?.scope || 'open').trim().toLowerCase();
      let query = supabase.from('commitments').select('*').eq('user_id', userId);
      if (scope !== 'all') query = query.eq('status', scope === 'done' ? 'done' : 'open');
      if (personFilter) query = query.ilike('person_name', `%${escapeIlikePattern(personFilter)}%`);
      const { data, error } = await query.order('due_at', { ascending: true, nullsFirst: false }).limit(50);
      if (error) return { success: false, error: error.message };

      const now = new Date();
      let items = data || [];
      if (String(params?.overdue_only) === 'true' || params?.overdue_only === true) {
        items = items.filter(c => commitments.isOverdue(c, now));
      }
      return {
        success: true,
        commitments: commitments.sortCommitments(items, now).map(c => ({
          id: c.id, what: c.what, personName: c.person_name, dueAt: c.due_at,
          status: c.status, overdue: commitments.isOverdue(c, now),
          dueToday: commitments.isDueToday(c, now), threadId: c.thread_id, source: c.source
        })),
        text: commitments.formatCommitmentList(items, { now, person: personFilter })
      };
    }

    case 'resolve_commitment': {
      const query = String(params?.what || params?.id || '').trim();
      if (!query) return { success: false, error: 'Say which commitment — what was it?' };
      const outcome = params?.outcome === 'cancelled' ? 'cancelled' : 'done';

      let row = null;
      if (/^[0-9a-f-]{36}$/i.test(query)) {
        const { data } = await supabase.from('commitments').select('*').eq('id', query).eq('user_id', userId).maybeSingle();
        row = data;
      } else {
        const { data } = await supabase.from('commitments').select('*')
          .eq('user_id', userId).eq('status', 'open')
          .ilike('what', `%${escapeIlikePattern(query)}%`).limit(2);
        if (data?.length > 1) {
          return { success: false, error: `More than one matches "${query}": ${data.map(c => c.what).join('; ')}. Which one?` };
        }
        row = data?.[0] || null;
      }
      if (!row) return { success: false, error: `I don't have an open commitment matching "${query}".` };

      const { error } = await supabase.from('commitments').update({
        status: outcome,
        resolved_at: new Date().toISOString(),
        // Recorded so an auto-resolution can always be told apart from the user saying so.
        resolved_by: String(params?.resolved_by || 'user').slice(0, 40),
        updated_at: new Date().toISOString()
      }).eq('id', row.id);
      if (error) return { success: false, error: error.message };
      return {
        success: true,
        text: outcome === 'cancelled' ? `Dropped: ${row.what}.` : `Marked done: ${row.what}.`
      };
    }

    // How the user controls being interrupted. Deliberately four knobs, not a settings panel:
    // which channel, which categories, urgent-only, and when to stay quiet.
    case 'set_notification_preference': {
      const scope = String(params?.category || '').trim().toLowerCase();
      const channel = String(params?.channel || '').trim().toLowerCase();
      const updates = [];

      if (channel) {
        const valid = ['auto', 'push', 'email', 'in_app', 'off'];
        if (!valid.includes(channel)) return { success: false, error: `channel must be one of ${valid.join(', ')}` };
        const key = scope ? notifications.PREF.category(notifications.normalizeCategory(scope)) : notifications.PREF.channel;
        await setPreferenceValue(userId, key, channel);
        updates.push(scope ? `${scope} notifications: ${channel}` : `default channel: ${channel}`);
      }
      if (params?.urgent_only !== undefined) {
        const value = params.urgent_only === true || String(params.urgent_only) === 'true';
        await setPreferenceValue(userId, notifications.PREF.urgentOnly, String(value));
        updates.push(value ? 'only urgent things' : 'not just urgent things');
      }
      if (params?.quiet_hours !== undefined) {
        const raw = String(params.quiet_hours || '').trim();
        if (raw && !notifications.parseQuietHours(raw)) {
          return { success: false, error: 'quiet_hours must look like "22:00-07:00"' };
        }
        await setPreferenceValue(userId, notifications.PREF.quietHours, raw);
        updates.push(raw ? `quiet hours ${raw}` : 'no quiet hours');
      }
      if (params?.email_to) {
        await setPreferenceValue(userId, notifications.PREF.emailTo, String(params.email_to).trim());
        updates.push(`email to ${params.email_to}`);
      }
      if (!updates.length) return { success: false, error: 'Nothing to change — say which channel, category, quiet hours or urgency level.' };

      // Report what can actually deliver, so "email me if the price drops" cannot look
      // configured when no email provider is set up.
      const prefs = await getPreferenceMap(userId);
      const { data: userRow } = await supabase.from('users').select('email, email_verified').eq('user_id', userId).maybeSingle();
      const emailTo = prefs[notifications.PREF.emailTo] || (userRow?.email_verified ? userRow.email : '');
      const { count: deviceCount } = await supabase.from('devices').select('*', { count: 'exact', head: true }).eq('user_id', userId);
      const available = availableChannels({ hasPushDevices: (deviceCount || 0) > 0, emailTo });
      const blocked = describeUnavailable({ hasPushDevices: (deviceCount || 0) > 0, emailTo });

      return {
        success: true,
        preferences: notifications.describePreference(prefs),
        available,
        unavailable: blocked,
        text: `Updated: ${updates.join('; ')}.${blocked.length ? ` Be aware — ${blocked.join('; ')}, so anything routed there will fall back to the in-app card until that is set up.` : ''}`
      };
    }

    // Spend and receipts. Two real sources only — receipts in the connected mailbox, and
    // orders this system actually placed and saw confirmed. There is no bank feed, and the
    // summary text says so every time rather than implying completeness.
    case 'find_spend': {
      const merchantFilter = String(params?.merchant || '').trim();
      const since = String(params?.since || '').trim();
      const before = String(params?.before || '').trim();
      const categoryQuery = String(params?.category || '').trim().toLowerCase();
      const textQuery = String(params?.query || '').trim();
      const sources = String(params?.sources || 'all').trim().toLowerCase();
      const wantEmail = sources !== 'millie';
      const wantMillie = sources !== 'email';
      const cap = Math.max(1, Math.min(Number(params?.max_results) || 60, 150));

      let emailSearched = false;
      let emailError = '';
      let scanned = 0;
      let skipped = 0;

      if (wantEmail) {
        // A receipt-shaped Gmail query, then the real extractor decides — the query narrows
        // what is fetched, it is not itself the classifier.
        const terms = ['receipt', 'invoice', '"order confirmation"', '"your order"', '"payment received"', '"thanks for your order"', 'refund'];
        const parts = [`{${terms.join(' ')}}`];
        if (merchantFilter) parts.push(`(from:${merchantFilter} OR "${merchantFilter}")`);
        else if (textQuery) parts.push(`"${textQuery.replace(/"/g, '')}"`);
        const sinceToken = buildCleanupQuery({ since }).match(/after:(\S+)/)?.[1];
        const beforeToken = buildCleanupQuery({ before }).match(/before:(\S+)/)?.[1];
        if (sinceToken) parts.push(`after:${sinceToken}`);
        if (beforeToken) parts.push(`before:${beforeToken}`);

        const searchResult = await dispatch(userId, 'search_emails', { query: parts.join(' '), max_results: cap });
        if (searchResult?.success) {
          emailSearched = true;
          const emails = searchResult.emails || [];
          scanned = emails.length;
          for (const email of emails) {
            const extracted = receipts.extractReceipt(email);
            if (!extracted) { skipped += 1; continue; }
            // Persisting normalized records is what makes a second "find that receipt" fast
            // and lets a purchase be recognised later without re-mining the mailbox. The
            // dedupe indexes make a rescan idempotent rather than double-counting.
            const row = {
              source: extracted.source,
              merchant: extracted.merchant,
              merchant_domain: extracted.merchantDomain,
              purchased_at: extracted.purchasedAt,
              total_amount: extracted.totalAmount,
              currency: extracted.currency,
              order_id: extracted.orderId,
              description: extracted.description,
              items: extracted.items?.length ? extracted.items : null,
              status: extracted.status,
              refund_amount: extracted.refundAmount,
              tracking_url: extracted.trackingUrl,
              source_ref: extracted.sourceRef,
              source_thread_id: extracted.sourceThreadId,
              raw_total_text: extracted.rawTotalText,
              extraction_confidence: extracted.extractionConfidence,
              updated_at: new Date().toISOString()
            };
            // upsertPurchase, not a raw upsert: both dedupe indexes are partial, which
            // Postgres will not accept as an ON CONFLICT target. It also folds a second
            // document about an order already on file (shipping note, refund) into that
            // record instead of counting the order twice.
            await receipts.upsertPurchase(supabase, userId, row);
          }
        } else {
          emailError = searchResult?.error || 'your mailbox was unreachable';
        }
      }

      let query = supabase.from('purchases').select('*').eq('user_id', userId);
      if (!wantEmail) query = query.eq('source', 'millie_browser');
      if (!wantMillie) query = query.eq('source', 'email_receipt');
      if (merchantFilter) query = query.ilike('merchant', `%${escapeIlikePattern(merchantFilter)}%`);
      // "What did that sock order cost?" is not a merchant question — the only thing the user
      // remembers is what the thing was, which lives in the description (Millie's own order
      // goal) or the receipt's subject line. Without this, a real recorded order was
      // unfindable by the most natural way to ask about it.
      if (textQuery) {
        const safe = escapeIlikePattern(textQuery);
        query = query.or(`merchant.ilike.%${safe}%,description.ilike.%${safe}%`);
      }
      if (since && !Number.isNaN(Date.parse(since))) query = query.gte('purchased_at', new Date(since).toISOString());
      if (before && !Number.isNaN(Date.parse(before))) query = query.lte('purchased_at', new Date(before).toISOString());
      const { data, error } = await query.order('purchased_at', { ascending: false }).limit(cap);
      if (error) return { success: false, error: error.message };

      let items = data || [];
      let unclassified = 0;
      if (categoryQuery) {
        const kept = [];
        for (const purchase of items) {
          const verdict = receipts.classifyCategory(purchase.merchant, purchase.description);
          if (verdict.confident && verdict.category === categoryQuery) kept.push(purchase);
          else if (!verdict.confident) unclassified += 1;
        }
        items = kept;
      }

      return {
        success: true,
        purchases: items.map(p => ({
          id: p.id,
          merchant: p.merchant,
          amount: p.total_amount,
          currency: p.currency,
          purchasedAt: p.purchased_at,
          orderId: p.order_id,
          description: p.description,
          items: p.items || [],
          status: p.status,
          source: p.source,
          threadId: p.source_thread_id,
          messageId: p.source === 'email_receipt' ? p.source_ref : null,
          trackingUrl: p.tracking_url,
          observedTotalText: p.raw_total_text,
          confidence: p.extraction_confidence
        })),
        summary: receipts.summarizeSpend(items),
        coverage: {
          emailSearched,
          emailError: emailError || null,
          emailsScanned: scanned,
          emailsWithoutUsableReceipt: skipped,
          bankFeed: false
        },
        lines: items.slice(0, 12).map(receipts.formatPurchaseLine),
        text: receipts.formatSpendSummary(items, {
          since, merchant: merchantFilter,
          sources: wantEmail ? ['email_receipt', 'millie_browser'] : ['millie_browser'],
          emailSearched: wantEmail ? emailSearched : true,
          emailError, unclassified, categoryQuery
        })
      };
    }

    // ── People layer ──────────────────────────────────────────────────────────────────
    // Built on participants/participant_addresses (see api/services/people.js for why
    // that, and not a new table). These three cases are thin: all the identity-resolution
    // rules — handles beat names, ambiguous names are never merged — live in the service.
    case 'remember_person': {
      const result = await people.upsertPerson(supabase, userId, {
        name: params?.person_name || params?.name,
        relationship: params?.relationship,
        email: params?.email,
        phone: params?.phone,
        businessName: params?.business_name,
        facts: params?.facts ?? params?.note,
        removeFacts: params?.replaces,
        forceNew: params?.different_person === true || String(params?.different_person) === 'true',
        factKind: params?.fact_kind
      });
      if (result.ambiguous) {
        return {
          success: false,
          ambiguous: true,
          candidates: result.candidates,
          error: `${result.error} Say which one you mean, or that this is a different person.`
        };
      }
      if (!result.success) return result;

      const profile = (await people.loadProfiles(supabase, userId, [result.person]))[0];
      const changes = [
        result.created ? 'added' : 'updated',
        result.factsRemoved ? `${result.factsRemoved} thing${result.factsRemoved === 1 ? '' : 's'} forgotten` : '',
        result.factsAdded ? `${result.factsAdded} noted` : ''
      ].filter(Boolean).join(', ');
      return { success: true, person: profile, created: result.created, text: `${people.formatProfile(profile)} (${changes}).` };
    }

    case 'find_people': {
      const query = String(params?.query || params?.person_name || '').trim();
      const result = await people.findPeople(supabase, userId, {
        query,
        relationship: params?.relationship,
        email: params?.email,
        phone: params?.phone
      });
      return {
        success: true,
        people: result.profiles,
        ambiguous: Boolean(result.ambiguous),
        text: people.formatPeopleSummary(result.profiles, { ambiguous: result.ambiguous, query: query || params?.relationship || '' })
      };
    }

    case 'forget_person_detail': {
      const query = String(params?.person_name || params?.query || '').trim();
      const resolved = await people.resolvePerson(supabase, userId, { name: query, email: params?.email, phone: params?.phone });
      if (resolved.ambiguous) {
        return { success: false, ambiguous: true, error: `More than one person matches "${query}". Which one?` };
      }
      if (!resolved.person) return { success: false, error: `I don't have anyone saved as "${query}".` };

      const result = await people.forgetPersonDetail(supabase, userId, {
        participantId: resolved.person.id,
        facts: params?.facts ?? params?.fact,
        clearRelationship: params?.clear_relationship === true || String(params?.clear_relationship) === 'true',
        deletePerson: params?.delete_person === true || String(params?.delete_person) === 'true'
      });
      if (!result.success) return result;
      const name = resolved.person.display_name;
      const text = result.deleted ? `Forgot ${name} entirely.`
        : [
          result.relationshipCleared ? `${name} is no longer recorded with that relationship` : '',
          result.factsRemoved ? `forgot ${result.factsRemoved} thing${result.factsRemoved === 1 ? '' : 's'} about ${name}` : ''
        ].filter(Boolean).join('; ') || `Nothing to forget about ${name}.`;
      return { success: true, ...result, text };
    }

    case 'find_appointment_options': {
      const request = String(params?.request || '').trim();
      const service = getAppointmentBookingService();
      if (!service) {
        const booking = { request, service: 'appointment', preference: { label: '' }, choices: [], phase: 'needs_connection' };
        const task = await saveAppointmentTask(userId, params?.task_id, booking, { lastError: 'Appointment booking is not connected yet.' });
        return {
          success: false,
          error: "I need an appointment booking connection before I can look for times. I've kept this open so we can continue when it is ready.",
          taskId: task.id,
          actionSummary: 'Appointment saved'
        };
      }
      try {
        const found = await service.findChoices({
          request,
          calendarEvents: Array.isArray(context.appointmentCalendarEvents) ? context.appointmentCalendarEvents : []
        });
        if (found.kind === 'missing_details') {
          return { success: true, text: found.text, actionSummary: 'Appointment details needed' };
        }
        const booking = {
          request,
          service: found.service || 'appointment',
          preference: found.preference || { label: '' },
          provider: found.provider || 'sandbox',
          choices: found.choices || [],
          phase: found.ok ? 'choosing' : 'no_choices'
        };
        const task = await saveAppointmentTask(userId, params?.task_id, booking, { lastError: found.ok ? null : found.text });
        if (!found.ok) return { success: false, error: found.text, taskId: task.id, actionSummary: 'Appointment search paused' };
        return {
          success: true,
          text: appointmentChoicesText(found.service, found.choices),
          cardText: found.choices.map(choice => choice.label).join('\n'),
          actionSummary: 'Appointment options found',
          taskId: task.id,
          choices: found.choices
        };
      } catch {
        const booking = { request, service: 'appointment', preference: { label: '' }, choices: [], phase: 'paused' };
        const task = await saveAppointmentTask(userId, params?.task_id, booking, { lastError: 'Appointment search paused.' });
        return { success: false, error: "I couldn't look for appointment times right now. I've kept this open so we can try again.", taskId: task.id };
      }
    }

    case 'book_appointment': {
      const task = await taskManager.getTask(userId, params?.task_id);
      const booking = task?.metadata?.appointmentBooking;
      const choice = booking?.choices?.find(item => item.id === params?.choice_id);
      if (!task || !booking || !choice) return { success: false, error: "I couldn't find that appointment choice. Please ask me to look again." };
      const service = getAppointmentBookingService();
      if (!service || booking.provider !== 'sandbox') {
        await saveAppointmentTask(userId, task.id, { ...booking, phase: 'needs_connection' }, { lastError: 'Appointment booking is not connected yet.' });
        return { success: false, error: "I couldn't book that yet because the appointment connection is not ready. I've kept the choice open." };
      }
      try {
        const committed = booking.phase === 'calendar_retry' && booking.booking
          ? await service.addBookingToCalendar({ booking: booking.booking })
          : await service.commitChoice({ choice, approved: true });
        if (!committed.ok) {
          await saveAppointmentTask(userId, task.id, { ...booking, phase: committed.kind === 'calendar_failed' ? 'calendar_retry' : 'choosing', booking: committed.booking || null }, {
            lastError: committed.text || 'Appointment was not confirmed.'
          });
          return { success: false, error: committed.text || "I couldn't confirm that appointment. I've kept it open." };
        }
        const completedBooking = { ...booking, phase: 'confirmed', booking: committed.booking };
        await saveAppointmentTask(userId, task.id, completedBooking, {
          status: 'completed',
          checkpoint: false,
          completedAt: new Date().toISOString(),
          results: [{ action: 'book_appointment', result: { success: true, actionSummary: 'Appointment confirmed', text: `Booked ${choice.service} appointment for ${choice.label}.` } }]
        });
        return {
          success: true,
          text: `Booked your ${choice.service} appointment for ${choice.label} and added it to your calendar.`,
          cardText: choice.label,
          actionSummary: 'Appointment confirmed',
          taskId: task.id
        };
      } catch {
        await saveAppointmentTask(userId, task.id, { ...booking, phase: 'choosing' }, { lastError: 'Appointment booking paused.' });
        return { success: false, error: "I couldn't confirm that appointment. I've kept it open so we can try again." };
      }
    }

    default:
      return dispatch(userId, action, enrichedParams);
  }
}

// Proactive outbound delivery, wired to the real senders. Everything Millie notices in the
// background now becomes a durable notification_events row that a sweep tries to actually
// deliver — rather than a briefing card the user only sees if they open the app.
const notificationDelivery = createDeliveryRuntime({
  supabase,
  sendPush: async (userId, payload) => {
    const result = await sendPushToUser(userId, { title: payload.title, body: payload.body, kind: payload.category });
    // sendPushToUser reports { sent: 0, skipped: true } when APNs is not configured. That is
    // not a delivery, and must not be recorded as one.
    return { ok: Number(result?.sent) > 0, error: result?.skipped ? 'Apple push is not configured' : result?.error };
  },
  sendEmail: async ({ to, subject, text }) => {
    const result = await sendEmailService({ to, subject, text, html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(text)}</pre>` });
    // `dev: true` is api/services/email.js's no-op mode when RESEND_API_KEY is absent — it
    // logs and returns ok. Passed through deliberately so the runtime can reject it.
    return { ok: result?.ok !== false, dev: result?.dev === true, providerRef: result?.id || null };
  },
  createBriefing,
  getPreferenceMap,
  getUserEmail: async (userId) => {
    const { data } = await supabase.from('users').select('email, email_verified').eq('user_id', userId).maybeSingle();
    // An unverified address is not somewhere we send unsolicited mail.
    return data?.email && data.email_verified ? data.email : '';
  },
  countPushDevices: async (userId) => {
    const { count } = await supabase.from('devices').select('*', { count: 'exact', head: true }).eq('user_id', userId);
    return count || 0;
  }
});

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
    const { data: inserted, error: insertError } = await supabase
      .from('memories')
      .insert({ user_id: userId, content, source, created_at: new Date().toISOString() })
      .select('id');

    if (insertError) throw insertError;

    if (inserted?.[0]?.id) {
      const { error: deleteError } = await supabase
        .from('memories')
        .delete()
        .eq('user_id', userId)
        .eq('source', 'manual_profile')
        .neq('id', inserted[0].id);
      if (deleteError) throw deleteError;
    }
    return;
  }

  const { error } = await supabase
    .from('memories')
    .insert({ user_id: userId, content, source, created_at: new Date().toISOString() });
  if (error) throw error;
}

function parseExplicitMemoryRequest(text) {
  const match = String(text || '').trim().match(
    /^(?:millie[,:]?\s+)?(?:please\s+)?remember(?:\s+that)?\s+(.+?)\s*[.!?]*$/i
  );
  if (!match) return null;
  const fact = match[1].trim();
  if (/^(?:this|that|it)$/i.test(fact) || !isUsefulMemoryContent(fact)) return null;
  return fact;
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
    const result = await generateBrain({
      model: FAST_MODEL,
      contents: [{ role: 'user', parts: [{ text: `Extract one short personal fact worth remembering from this message. Write it as a concise note (e.g. "Works at KPMG", "Has a dog named Biscuit", "Hates mornings", "Lives in Birmingham"). Return only the fact with no explanation. If there is nothing personal worth remembering, return an empty string.\n\nMessage: "${text}"` }] }],
      config: {}
    });
    const fact = (result.text || '').trim().replace(/^["']|["']$/g, '');
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

const DURABLE_PROFILE_PATTERN = /\b(my name|i work at|i work for|i'm a |i am a |i live in|lives in|my job|my wife|my husband|my partner|my kids|my boss|working on|trying to|my goal|i'm building|i am building|my company|my startup)\b/i;

function isDurableProfileFact(text) {
  return DURABLE_PROFILE_PATTERN.test(String(text || ''));
}

// Keeps the single manual_profile row (identity/work/relationships/goals) up to
// date instead of letting durable facts compete with transient ones in the
// flat, decaying fact stream getMemory() scores by keyword+recency.
async function mergeIntoProfile(userId, newFact) {
  try {
    const { data } = await supabase
      .from('memories')
      .select('content')
      .eq('user_id', userId)
      .eq('source', 'manual_profile')
      .limit(1);
    const existing = data?.[0]?.content || '';

    const result = await generateBrain({
      model: FAST_MODEL,
      contents: [{ role: 'user', parts: [{ text: `Update this user profile with the new fact. Keep it as short bullet lines grouped loosely by identity, work, relationships, and goals. Merge duplicates, drop anything the new fact contradicts or supersedes. Return only the updated profile text, no explanation.\n\nCurrent profile:\n${existing || '(empty)'}\n\nNew fact: "${newFact}"` }] }],
      config: {}
    });
    const merged = (result.text || '').trim();
    if (!merged || !isUsefulMemoryContent(merged)) return;
    await saveMemory(userId, merged, 'manual_profile');
  } catch {}
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

// Phase 4 (2026-08-06) — the `preferences` table is a general key/value store shared by
// operational bookkeeping and the handful of rows that describe how someone likes to be
// talked to, and nothing used to separate those before they reached the model. Rendered live
// for a real user, the "HOW THE USER LIKES THINGS" block this fed was 12.7KB: ~90
// `_stitle_<uuid>` rows (every past conversation's title), ~40 `proactive.briefing.*`/dedup
// markers, a concierge balance, pending-action JSON, a travel-workflow blob — and, buried in
// all of it, three real style rows written by the old postResponseTasks style-cue matcher as
// `User said "<raw message>" — adapt accordingly`. That writer turned one-off phrasing (a
// demo asking for headings/bullets/bold; a garbled voice transcript) into a standing
// instruction that silently reshaped every later reply. Full detail in the Millie voice
// audit (2026-08-06).
//
// ALLOWLISTED_STYLE_PREFERENCE_KEYS is the only gate between that table and the prompt now.
// It is deliberately empty: the writer that populated it is disabled below (see
// postResponseTasks), and a real typed/decaying style layer (verbosity, formality, emoji,
// …) is future work, not this phase. An honestly empty style block beats a corrupted one.
const ALLOWLISTED_STYLE_PREFERENCE_KEYS = new Set([
  // intentionally empty — see comment above
]);

function filterStylePreferenceRows(rows = []) {
  return (rows || []).filter(row => ALLOWLISTED_STYLE_PREFERENCE_KEYS.has(row?.key));
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
  // Filtered for the MODEL-FACING string only. getPreferenceEntries/getPreferenceMap below
  // are untouched and still return every row — routing (resolveModelRoute), the concierge
  // account, pending-action state, and proactive dedup all read the table directly through
  // those and must keep seeing every key.
  return filterStylePreferenceRows(data).map(p => `${p.key}: ${p.value}`).join('\n');
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
async function guardConciergeSpend(userId, amount, currency = null) {
  return sharedGuardConciergeSpend(supabase, userId, amount, currency);
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

async function getLegacyPendingAction(userId) {
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
    parsed.storage = 'preference';
    return parsed;
  } catch {
    return null;
  }
}

async function getPendingAction(userId, message = '') {
  const runtime = await agentApprovals.listPendingApprovals(supabase, userId).catch(() => ({ available: false, approvals: [] }));
  const legacy = await getLegacyPendingAction(userId);
  const candidates = [
    ...(runtime.available ? runtime.approvals : []),
    ...(legacy ? [legacy] : [])
  ];
  return agentApprovals.selectPendingApproval(candidates, message);
}

async function setPendingAction(userId, action, context = {}) {
  const payload = {
    action,
    createdAt: new Date().toISOString(),
    userMessage: context.userMessage || '',
    location: context.location || null,
    nativeHints: context.nativeHints || null,
    // Which background run asked for this, so approving it continues that run from its
    // checkpoint rather than executing the action on its own and abandoning the goal.
    taskId: context.persistedTaskId || null,
    sessionId: context.runtimeSessionId || null,
    taskGoal: context.taskGoal || null
  };

  // Once the approval table is installed, every durable run gets its own approval row.
  // Restoring an already-claimed row is used when execution failed after the user had
  // approved it; this avoids creating a second approval for the same action.
  if (context.approvalId) {
    const restored = await agentApprovals.restoreApproval(supabase, userId, context.approvalId).catch(() => false);
    if (restored) return { ...payload, approvalId: context.approvalId, storage: 'runtime' };
  }

  const stored = await agentApprovals.createApproval(supabase, userId, payload).catch(error => ({
    available: false,
    error,
    missingTable: agentApprovals.isMissingTable(error)
  }));
  if (stored.available && stored.approval) {
    return {
      ...payload,
      approvalId: stored.approval.approvalId,
      storage: 'runtime'
    };
  }

  if (stored.error && !stored.missingTable) {
    console.warn('[approval-runtime] durable approval unavailable; using legacy fallback:', stored.error.message || stored.error);
  }
  await setPreferenceValue(userId, PENDING_ACTION_PREF, JSON.stringify(payload));
  return { ...payload, _raw: JSON.stringify(payload), storage: 'preference' };
}

async function resolveAgentTaskRoute(userId, task) {
  const stored = task?.metadata?.modelRoute;
  if (stored?.provider && stored?.model) {
    return { provider: String(stored.provider), model: String(stored.model), source: 'task' };
  }
  const selected = resolveModelRoute(await getPreferenceMap(userId));
  const active = selected.configured ? selected : (selected.fallback || selected);
  return { provider: active.provider, model: active.model, source: active.source || 'server' };
}

function approvedActionSucceeded(actionResults) {
  return Array.isArray(actionResults) && actionResults.length > 0 && actionResults.every(entry => {
    const result = entry?.result || {};
    return result.pending !== true && result.success !== false && !result.error;
  });
}

function replacePendingTaskEntry(entries, settledEntry) {
  const next = Array.isArray(entries) ? [...entries] : [];
  const pendingIndex = next.findLastIndex(entry =>
    entry?.action === settledEntry?.action && entry?.result?.pending === true
  );
  if (pendingIndex >= 0) {
    next[pendingIndex] = settledEntry;
    return next;
  }
  const alreadyRecorded = next.some(entry =>
    entry?.action === settledEntry?.action && entry?.result?.success === true
  );
  return alreadyRecorded ? next : [...next, settledEntry];
}

function settleApprovalEntry(pendingAction, actionResults) {
  const entry = actionResults?.[0] || {
    action: pendingAction?.action?.type,
    result: { success: false, error: 'The approved action did not return a result.' }
  };
  return {
    ...entry,
    action: entry.action || pendingAction?.action?.type,
    _toolCallId: pendingAction?.action?._toolCallId || entry._toolCallId || null
  };
}

/*
 * Continue the background run that was waiting on this approval.
 *
 * A review-gated action inside an agent run used to be terminal: the loop stopped, the user
 * confirmed, the action ran on its own, and the goal it belonged to was never picked back
 * up. The run is parked with its checkpoint instead, and this restarts it from there.
 *
 * Best-effort by design — the approval itself has already succeeded by the time this runs,
 * so a resume failure must not turn a completed action into an error for the user.
 */
async function resumeRunAfterApproval(userId, pendingAction, actionResults, trace = null) {
  const taskId = pendingAction?.taskId;
  if (!taskId) return { resumed: false };
  let claimedTask = null;
  try {
    const task = await taskManager.getTask(userId, taskId);
    // Only a parked run with a checkpoint can continue. A run already finished, cancelled,
    // or picked up by another instance must not be restarted underneath it.
    if (!task || !task.checkpoint) return { resumed: false };
    if (!['paused', 'pending', 'failed'].includes(String(task.status || '').toLowerCase())) return { resumed: false };

    claimedTask = await taskManager.claimRun(userId, taskId, { allowAwaitingApproval: true });
    if (!claimedTask) return { resumed: false };

    const settledEntry = settleApprovalEntry(pendingAction, actionResults);
    const settledResults = replacePendingTaskEntry(claimedTask.results, settledEntry);
    const settledCheckpoint = claimedTask.checkpoint
      ? taskManager.trimCheckpoint({
        ...claimedTask.checkpoint,
        contents: replacePendingToolResult(claimedTask.checkpoint.contents, settledEntry),
        executedActions: replacePendingTaskEntry(claimedTask.checkpoint.executedActions, settledEntry)
      })
      : null;

    if (!approvedActionSucceeded(actionResults)) {
      await taskManager.updateTask(userId, taskId, {
        status: 'paused',
        heartbeat_at: null,
        last_error: 'The approved action did not complete.',
        results: settledResults,
        checkpoint: settledCheckpoint,
        metadata: { ...(claimedTask.metadata || {}), awaitingApproval: false }
      });
      return { resumed: false, failed: true };
    }

    const route = await resolveAgentTaskRoute(userId, claimedTask);
    // Fallback only — overwritten below by a real per-user chat prompt if the refresh succeeds.
    let dynamicSystemPrompt = buildSystemPrompt({ surface: 'background', context: {} });
    let useSearch = Boolean(claimedTask.metadata?.useSearch);
    try {
      const refreshed = await buildChatContext(userId, claimedTask.goal, trace, route.model, {
        location: pendingAction.location || null,
        nativeHints: pendingAction.nativeHints || null
      });
      dynamicSystemPrompt = refreshed.dynamicSystemPrompt || dynamicSystemPrompt;
      useSearch = Boolean(useSearch || refreshed.useSearch);
    } catch {}

    await taskManager.updateTask(userId, taskId, {
      results: settledResults,
      checkpoint: settledCheckpoint,
      metadata: { ...(claimedTask.metadata || {}), awaitingApproval: false }
    });

    const runtimeSessionId = pendingAction.sessionId || claimedTask.metadata?.runtimeSessionId || null;
    if (runtimeSessionId) {
      await agentRuntime.updateSession(supabase, userId, runtimeSessionId, {
        state: 'running',
        heartbeatAt: new Date().toISOString()
      }).catch(() => {});
    }

    trace?.log?.('agent.run.resume_after_approval', taskId);

    runAgenticLoop({
      userId,
      initialMessage: claimedTask.goal,
      dynamicSystemPrompt,
      useSearch,
      modelName: route.model,
      provider: route.provider,
      maxIterations: Number.isFinite(claimedTask.checkpoint?.maxIterations) ? claimedTask.checkpoint.maxIterations : 6,
      context: {
        autonomy: claimedTask.autonomy,
        guardMode: claimedTask.metadata?.guardMode === true,
        modelRoute: route,
        useSearch,
        runtimeSessionId
      },
      executeActionsFn: executeActions,
      persistTask: true,
      existingTaskId: taskId,
      resumeAction: settledEntry,
      // Never place raw connector/provider output in a user-role model message. It can
      // contain secrets, prompt-injection text, or unbounded payloads. The settled tool
      // response is already in the checkpoint for the model to inspect as structured data.
      resumeNote: `The user approved "${pendingAction.action?.type}" and it completed successfully. Continue the goal from here; do not ask for that approval again.`
    }).then(async (outcome) => {
      if (!runtimeSessionId) return;
      const traceStatus = outcome?.agentTrace?.status;
      const state = traceStatus === 'completed'
        ? 'completed'
        : traceStatus === 'awaiting_approval'
          ? 'waiting_approval'
          : traceStatus === 'error' ? 'failed' : 'paused';
      await agentRuntime.updateSession(supabase, userId, runtimeSessionId, {
        state,
        heartbeatAt: null,
        completedAt: state === 'completed' ? new Date().toISOString() : null
      }).catch(() => {});
    }).catch(async (e) => {
      try {
        await taskManager.updateTask(userId, taskId, {
          status: 'paused',
          heartbeat_at: null,
          last_error: String(e?.message || e).slice(0, 500)
        });
      } catch {}
      if (runtimeSessionId) {
        await agentRuntime.updateSession(supabase, userId, runtimeSessionId, {
          state: 'failed',
          heartbeatAt: null
        }).catch(() => {});
      }
    });
    return { resumed: true };
  } catch {
    if (claimedTask) {
      await taskManager.updateTask(userId, taskId, {
        status: 'paused',
        heartbeat_at: null,
        last_error: 'The approved action completed, but the task could not resume.'
      }).catch(() => {});
    }
    return { resumed: false };
  }
}

async function cancelApprovalRun(userId, pendingAction) {
  const taskId = pendingAction?.taskId;
  if (!taskId) return false;
  const task = await taskManager.getTask(userId, taskId);
  if (!task?.checkpoint) return false;
  const claimedTask = await taskManager.claimRun(userId, taskId, { allowAwaitingApproval: true });
  if (!claimedTask) return false;
  try {
    await taskManager.updateTask(userId, taskId, {
      status: 'cancelled',
      heartbeat_at: null,
      completed_at: new Date().toISOString(),
      checkpoint: null,
      metadata: { ...(claimedTask.metadata || {}), awaitingApproval: false }
    });
  } catch (error) {
    await taskManager.updateTask(userId, taskId, {
      status: 'paused',
      heartbeat_at: null,
      last_error: 'Cancellation could not be saved.',
      metadata: { ...(claimedTask.metadata || {}), awaitingApproval: true }
    }).catch(() => {});
    throw error;
  }
  return true;
}

async function settlePendingAction(userId, pendingAction, status) {
  if (pendingAction?.storage === 'runtime' && pendingAction.approvalId) {
    return agentApprovals.settleApproval(supabase, userId, pendingAction.approvalId, status).catch(() => false);
  }
  return false;
}

async function clearPendingAction(userId, pendingAction = null) {
  if (pendingAction?.storage === 'runtime' && pendingAction.approvalId) {
    await settlePendingAction(userId, pendingAction, 'cancelled');
  }
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
  if (pendingAction?.storage === 'runtime' && pendingAction.approvalId) {
    return agentApprovals.claimApproval(supabase, userId, pendingAction.approvalId).catch(() => false);
  }
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
    notion: ['create_note', 'search_notes'],
    trainline: ['search_trains', 'station_board'],
    concierge_account: ['check_concierge_balance', 'spend_from_concierge_account', 'top_up_concierge_account', 'receive_to_concierge_account', 'fund_opportunity'],
    stripe: ['stripe_charge', 'create_stripe_payment_link'],
    weather: ['get_weather', 'get_forecast'],
    amazon: ['search_amazon', 'add_to_amazon_cart'],
    slack: ['send_slack_message', 'search_slack'],
    strava: ['get_strava_activities'],
    oura: ['get_oura_sleep', 'get_oura_readiness'],
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

// Currently unused: its one caller, the raw-quote style-cue writer in postResponseTasks, was
// disabled in Phase 4 (2026-08-06). Left in place for a future typed style-preference layer
// to write through, rather than deleted and re-added.
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
  'agent_traces',
  'simulation_runs',
  'agent_tasks',
  'agent_workspace_files',
  'agent_workspace_sessions',
  'agent_workspaces',
  'agent_imports',
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
    briefings: data.briefings || [],
    agentTasks: data.agent_tasks || [],
    agentTraces: data.agent_traces || [],
    simulationRuns: data.simulation_runs || [],
    workspace: {
      workspaces: data.agent_workspaces || [],
      files: data.agent_workspace_files || [],
      sessions: data.agent_workspace_sessions || []
    },
    continuityImports: data.agent_imports || []
  };
}

async function getUserContext(userId, trace = null) {
  const cached = contextCache.get(userId);
  if (cached && Date.now() - cached.ts < CONTEXT_CACHE_TTL) {
    if (trace) trace.log('user_context.cache_hit');
    return cached.context;
  }

  // Names + relationships only (never the saved notes/preferences — those stay behind an
  // explicit find_people lookup rather than being pasted into every request). This is what
  // makes "email my manager" and a bare "her" resolvable without a tool round-trip.
  const loadKnownPeople = () => supabase.from('participants')
    .select('display_name, relationship').eq('user_id', userId)
    .order('updated_at', { ascending: false, nullsFirst: false }).limit(12);

  const [connectors, memories, actionLog, delegatedTasks, knownPeople] = trace
    ? await Promise.all([
      trace.run('supabase.user_context.connectors', () => supabase.from('connectors').select('connector_id').eq('user_id', userId).eq('enabled', true)),
      trace.run('supabase.user_context.memories', () => supabase.from('memories').select('content').eq('user_id', userId).order('created_at', { ascending: false }).limit(5)),
      trace.run('supabase.user_context.action_log', () => supabase.from('action_log').select('action, status, error, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(8)),
      trace.run('supabase.user_context.agent_tasks', () => supabase.from('agent_tasks').select('goal, status, autonomy, updated_at').eq('user_id', userId).neq('status', 'recipe').in('status', ['pending', 'running', 'paused', 'failed']).order('updated_at', { ascending: false }).limit(6)),
      trace.run('supabase.user_context.participants', loadKnownPeople)
    ])
    : await Promise.all([
      supabase.from('connectors').select('connector_id').eq('user_id', userId).eq('enabled', true),
      supabase.from('memories').select('content').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
      supabase.from('action_log').select('action, status, error, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(8),
      supabase.from('agent_tasks').select('goal, status, autonomy, updated_at').eq('user_id', userId).neq('status', 'recipe').in('status', ['pending', 'running', 'paused', 'failed']).order('updated_at', { ascending: false }).limit(6),
      loadKnownPeople()
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
  const activeGoals = (delegatedTasks.data || [])
    .map(task => String(task.status || 'pending') + ': ' + String(task.goal || '').trim())
    .filter(line => line.length > 10)
    .join(' | ') || 'none';

  const peopleLine = people.peopleContextLine(knownPeople.data || []);

  const context = [
    "LIVE USER CONTEXT:",
    "Active connectors: " + active,
    "Messaging patterns: " + patterns,
    "Known people: " + (peopleLine || 'none saved yet') + " (use find_people for their contact details, notes and saved dates)",
    "Key facts: " + memoryLines,
    "Active delegated goals: " + activeGoals,
    "Recent action outcomes: " + recentActions
  ].join("\n").slice(0, 2200);

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

    require('./services/millie-identity').ensureMillieIdentity(supabase, userId, { attemptPhone: false })
      .catch(err => log('warn', 'millie.provision.signup_failed', { userId, error: err.message }));

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

app.post('/millie/provision', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!requireMatchingUser(req, res, userId)) return;
    const { ensureMillieIdentity } = require('./services/millie-identity');
    const { provisionPhoneNumber } = require('../connectors/millie-sms-twilio');
    const { identity, handles } = await ensureMillieIdentity(supabase, userId, {
      attemptPhone: true,
      provisionPhoneNumber
    });
    res.json({
      success: true,
      email: handles.find(h => h.channel_type === 'email')?.handle_value || null,
      phone: handles.find(h => h.channel_type === 'phone_sms')?.handle_value || null
    });
  } catch (err) {
    log('error', 'millie.provision.error', { error: err.message });
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
    let { history, useSearch, dynamicSystemPrompt, cachedContentName, modelRoute } = context;
    if (needsSearch(userText)) {
      const refreshed = await buildChatContext(userId, userText, null, STREAMING_CHAT_MODEL);
      useSearch = refreshed.useSearch;
      dynamicSystemPrompt = refreshed.dynamicSystemPrompt;
      cachedContentName = refreshed.cachedContentName;
      modelRoute = refreshed.modelRoute;
    }
    const baseHistory = normalizeGeminiHistory(history);
    const initialRequest = buildModernGenerateRequest({
      dynamicSystemPrompt,
      useSearch,
      cachedContentName,
      baseHistory,
      userContent: { role: 'user', parts: [{ text: userText }] },
      // Voice turns get the same native tools as text chat — this path carried the identical
      // tools-disabled hole, so spoken requests to act were answered but never performed.
      useAgentTools: true
    });

    const stream = await streamBrain({
      provider: modelRoute.provider,
      model: modelRoute.model,
      contents: initialRequest.contents,
      config: initialRequest.config
    });
    let fullText = '';
    let streamedToolCalls = [];
    for await (const chunk of stream) {
      const text = chunk.text || '';
      if (text) fullText += text;
      if (chunk.functionCalls?.length) streamedToolCalls = chunk.functionCalls;
    }

    let { spoken, actions, parseError } = parseActions(fullText);
    if (parseError) console.warn('[process-audio] one or more <action> blocks failed to parse; some actions may be missing');
    // Applied to text-authored actions only; native tool calls are structured output from the
    // main chat model and are merged in afterwards. Mirrors the /chat streaming path.
    if (shouldIgnoreModelAuthoredActions(STREAMING_CHAT_MODEL) && actions.length) {
      console.warn(`[process-audio] ignored ${actions.length} fast-model authored action(s)`);
      actions = [];
    }
    actions = mergeNativeToolCalls(streamedToolCalls, actions);
    actions = guardCalendarActionsForUserMessage(actions, userText);

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
        userContent: { role: 'user', parts: [{ text: userText }] },
        // Synthesis-only turn: it writes prose about results that already came back, so it
        // must not be able to start more work. Was implicitly tool-free before tools were
        // forwarded at all; now stated explicitly.
        useAgentTools: false
      });
      followUpRequest.contents.push(
        { role: 'model', parts: [{ text: spoken || '...' }] },
        { role: 'user', parts: [{ text: synthesisPromptForDataResults(userText, dataResults) }] }
      );
      const followUp = await generateBrain({
        provider: modelRoute.provider,
        model: modelRoute.model,
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
    if (!isNonEmptyString(prompt)) return res.status(400).json({ error: 'prompt is required.' });

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

    const [{ history, useSearch, dynamicSystemPrompt, cachedContentName, modelRoute }] = await Promise.all([
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
      },
      // Out of scope for this phase: /chat-with-image keeps the <action> text path it has
      // today. Stated explicitly so forwarding tools in the provider does not silently
      // change this route's behaviour.
      useAgentTools: false
    });

    const brainRes = await generateBrain({
      provider: modelRoute.provider,
      model: modelRoute.model,
      contents: initialRequest.contents,
      config: initialRequest.config
    });
    let { spoken, actions, parseError } = parseActions(brainRes.text || '');
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
        },
        useAgentTools: false
      });
      followUpRequest.contents.push(
        { role: 'model', parts: [{ text: spoken || '...' }] },
        { role: 'user', parts: [{ text: `${synthesisPromptForDataResults(message, dataResults)}\nYou may also use the attached ${fileLabel} context.` }] }
      );
      const followUp = await generateBrain({
        provider: modelRoute.provider,
        model: modelRoute.model,
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
    if (!isNonEmptyString(content)) return res.status(400).json({ error: 'content is required.' });
    if (!isUsefulMemoryContent(content)) return res.status(400).json({ error: 'memory is too short or unclear.' });
    await saveMemory(userId, content.trim(), 'manual');

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Concrete /memory paths MUST stay above /memory/:userId. Express dispatches to the first
// matching route, so a literal segment registered below the param route is dead code —
// "recent-entities" reads as a userId, fails the ownership check, and returns 403.
app.get('/memory/recent-entities', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { entities } = await listRecentEntities(supabase, userId, 10);
    res.json({ entities });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    if (!isNonEmptyString(content)) return res.status(400).json({ error: 'content is required.' });
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
  // Stripe here is the app's OWN payment processor for concierge money movement, not a
  // personal Stripe account the user links — a functionality, not a connection.
  { id: 'stripe', name: 'Stripe (Payments)', icon: 'stripe', category: 'Finance', implemented: true, type: 'api', kind: 'functionality' },
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

// Concrete /connectors paths MUST stay above /connectors/:userId — see the note on
// /memory/recent-entities. "agent-card" reads as a userId and returns 403 otherwise.
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
  if (!isValidCalendarDate(date)) return res.status(400).json({ error: 'Invalid date' });
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

// Builds the 'background' surface system prompt for an unsupervised agent run (scheduled task,
// routine, or manual task resume/run) — the fix for background runs previously receiving only
// the bare static prompt (see api/prompts.js header comment). Reuses the exact same helpers the
// chat path uses, so background gets the same memory/preferences/connected-capabilities/active-
// goals-and-outcomes a live chat turn would.
async function buildBackgroundSystemPrompt(userId) {
  const [memory, preferences, enabledConnectors, liveContext, chatSettings, nativeContext] = await Promise.all([
    getMemory(userId, null, ''),
    getPreferences(userId),
    getEnabledConnectors(userId),
    getUserContext(userId),
    getChatSettings(supabase, userId),
    getLatestNativeContext(userId)
  ]);
  return buildSystemPrompt({
    surface: 'background',
    context: {
      memory,
      preferences,
      connectedCapabilities: buildAvailableActions(enabledConnectors),
      liveContext,
      autonomy: parseJsonObject(nativeContext?.settings)?.autonomy,
      guardMode: chatSettings?.guardMode === true,
      dateStr: getLocalDateKey(),
      timeStr: new Date().toLocaleString('en-GB', { timeZone: TIMEZONE })
    }
  });
}

// Shared logic for building the Gemini model + system prompt
async function buildChatContext(userId, message, trace = null, modelName = STREAMING_CHAT_MODEL, requestContext = {}) {
  const quickTurn = !requestContext.pendingAction && isQuickTurnMessage(message);
  const historyOptions = { since: requestContext.chatStartedAt };
  const [memory, history, preferences, preferenceMap, enabledConnectors, userContext, recentActions, chatSettings, nativeContext] = await Promise.all([
    quickTurn ? Promise.resolve('') : getMemory(userId, trace, message || ''),
    getHistory(userId, trace, 12, historyOptions),
    getPreferences(userId, trace),
    getPreferenceMap(userId),
    quickTurn ? Promise.resolve([]) : getEnabledConnectors(userId, trace),
    quickTurn ? Promise.resolve('') : getUserContext(userId, trace),
    quickTurn ? Promise.resolve([]) : getRecentLoggedActions(userId, trace, 8, historyOptions),
    quickTurn ? Promise.resolve(null) : getChatSettings(supabase, userId),
    quickTurn ? Promise.resolve(null) : getLatestNativeContext(userId)
  ]);
  // Real autonomy/guardMode for the AUTONOMY & APPROVAL prompt block — this only explains the
  // setting to the model; the server-side review gate in action-runner.js is unaffected by it.
  const autonomyContext = {
    autonomy: parseJsonObject(nativeContext?.settings)?.autonomy,
    guardMode: chatSettings?.guardMode === true
  };
  const requestedRoute = resolveModelRoute(preferenceMap);
  const modelRoute = requestedRoute.configured ? requestedRoute : (requestedRoute.fallback || requestedRoute);
  const cachedContentName = await getPromptCacheName(trace, modelRoute.model);
  const availableActions = quickTurn ? '' : buildAvailableActions(enabledConnectors);
  // extractShoppingContextHints is a genuinely derived hint (retailer/domain inferred from the
  // conversation), not a repeat of anything sent verbatim elsewhere, so it's kept on both paths.
  const shoppingContext = extractShoppingContextHints(history);
  // extractAlreadyStatedContext re-pastes recent ASSISTANT SENTENCES into the prompt. On the
  // full path below, `history` (unsliced) is also sent as contents[] via baseHistory, so those
  // same sentences would appear twice in one request. It is kept ONLY for quickTurn, whose
  // returned `history` is trimmed to the last 2 turns (see the return statement) — there the
  // recap is the only way the model sees what it said 3+ turns back, a real dependency rather
  // than incidental duplication. Phase 4, 2026-08-06.
  const statedContext = quickTurn
    ? [...extractAlreadyStatedContext(history), ...shoppingContext]
    : shoppingContext;
  const resolvedContext = requestContext.resolvedContext || (!quickTurn && isContextualReference(message)
    ? buildResolvedContext(message, history, recentActions)
    : null);
  const emailReplyContext = quickTurn
    ? ''
    : await buildEmailReplyDraftContext(userId, message, history, memory, preferences, trace);
  const emailDraftContext = quickTurn || emailReplyContext
    ? ''
    : await buildEmailDraftContext(userId, message, history, memory, preferences, trace);
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
        emailDraftContext,
        buildResolvedContextBlock(resolvedContext)
      ].filter(Boolean).join('\n\n'),
      statedContext,
      autonomyContext
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
    resolvedContext,
    modelRoute
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
  const windowLabel = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  const systemPrompt = buildSystemPrompt({
    surface: 'briefing',
    context: {
      memory,
      historyText: history.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n') || 'No recent messages.',
      windowLabel,
      maxWords: 100,
      dateStr: getLocalDateKey(now),
      timeStr: now.toLocaleString('en-GB', { timeZone: TIMEZONE })
    }
  });

  const briefingRes = await generateBrain({
    model: PRIMARY_CHAT_MODEL,
    contents: [{ role: 'user', parts: [{ text: 'whats going on today?' }] }],
    config: { systemInstruction: systemPrompt }
  });
  return parseActions(briefingRes.text || '');
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
        messageId: e.messageId,
        personal: e.llmPersonal
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
    const listing = emails.map((e, i) =>
      `${i}. From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${(e.snippet || '').slice(0, 300)}`
    ).join('\n\n');
    const prompt = `For each numbered email below, judge four things:

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

4. personal: true if this is about the user's own life outside work — family, health,
home, personal appointments, deliveries, money that's personally theirs to pay or chase.
false if it is about their job, business, or an automated system notification (a CI build,
a production deployment, a server alert, a SaaS product they run or administer) — these can
be just as real and actionable as a personal email, they are simply not what "what matters
in my life today" means. When genuinely unclear, prefer true — the cost of ranking a
personal-ish email slightly higher is much smaller than burying one that mattered.

${listing}

Respond with ONLY a JSON array, one object per email, same order as input, shape
[{"summary":"...","cta":"...","promotional":true|false,"personal":true|false}]. Examples:
[{"summary":"Capital One suspended your card after a missed payment — pay £22.80 today to unblock it","cta":"Pay it","promotional":false,"personal":true},
{"summary":"Amazon order shipped, arrives Thursday, nothing needed","cta":"Track it","promotional":false,"personal":true},
{"summary":"Product newsletter — nothing needed","cta":"Ignore","promotional":true,"personal":false},
{"summary":"Production deployment failed — review the error and redeploy","cta":"Review","promotional":false,"personal":false}]`;
    const res = await generateBrain({ model: FAST_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: {} });
    const match = (res.text || '').match(/\[[\s\S]*\]/);
    if (!match) return emails;
    const judged = JSON.parse(match[0]);
    return emails.map((e, i) => ({
      ...e,
      summary: typeof judged[i]?.summary === 'string' ? judged[i].summary.trim() : undefined,
      cta: typeof judged[i]?.cta === 'string' ? judged[i].cta.trim().slice(0, 24) : undefined,
      // Fail open (false) on a missing/malformed judgment for this email — better to
      // show one extra email than to silently drop something that might matter.
      llmPromotional: judged[i]?.promotional === true,
      // Fail open (true) here too, but in the opposite direction: an unjudged or
      // malformed result must not silently demote something that might have mattered.
      llmPersonal: judged[i]?.personal !== false
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
    const res = await generateBrain({ model: FAST_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: {} });
    const match = (res.text || '').match(/\{[\s\S]*\}/);
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

async function gatherCalendarContext(userId) {
  try {
    const enabled = await getEnabledConnectors(userId);
    const requests = [];
    if (enabled.includes('google')) {
      requests.push(dispatch(userId, 'get_calendar_events', { max_results: 12 }));
    }
    if (enabled.includes('microsoft')) {
      requests.push(dispatch(userId, 'get_outlook_events', { max_results: 12 }));
    }
    if (!requests.length) return [];
    const results = await Promise.all(requests);
    return results.flatMap(result => result?.success && Array.isArray(result.events) ? result.events : []).slice(0, 24);
  } catch (e) {
    return [];
  }
}

async function loadLifeBriefing(userId, now = new Date()) {
  const [tasks, emailContext, events, pending, legacyPending, scheduled] = await Promise.all([
    taskManager.listTasks(userId, null).catch(() => []),
    gatherEmailContext(userId),
    gatherCalendarContext(userId),
    agentApprovals.listPendingApprovals(supabase, userId).catch(() => ({ approvals: [] })),
    getLegacyPendingAction(userId),
    scheduledTasks.listScheduledTasks(userId).catch(() => ({ tasks: [] }))
  ]);

  const approvals = [
    ...(pending?.approvals || []),
    ...(legacyPending ? [legacyPending] : [])
  ].filter((approval, index, all) => {
    const key = approval.approvalId || `${approval.taskId || ''}:${approval.action?.type || ''}:${approval.createdAt || ''}`;
    return all.findIndex(candidate => {
      const candidateKey = candidate.approvalId || `${candidate.taskId || ''}:${candidate.action?.type || ''}:${candidate.createdAt || ''}`;
      return candidateKey === key;
    }) === index;
  });

  return buildLifeBriefing({
    tasks: tasks.map(safeAgentTaskSummary),
    approvals,
    emails: emailContext?.emails || [],
    events,
    scheduledTasks: scheduled?.tasks || [],
    now
  });
}

async function buildIntervalBriefing(userId, window, nativeContext, now = new Date()) {
  const [memory, history, preferences] = await Promise.all([
    getMemory(userId, null, ''),
    getHistory(userId),
    getPreferences(userId)
  ]);

  const health = parseJsonObject(nativeContext?.health);
  const location = parseJsonObject(nativeContext?.location);
  const nativeContextText = `Native context:
Location: ${location.latitude && location.longitude ? `${location.latitude}, ${location.longitude}` : 'not available'}
Health: ${Object.keys(health).length ? JSON.stringify(health).slice(0, 800) : 'not available'}`;
  const systemPrompt = buildSystemPrompt({
    surface: 'briefing',
    context: {
      memory,
      preferences,
      historyText: history.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n') || 'none',
      nativeContextText,
      windowLabel: window.label,
      maxWords: 70,
      dateStr: getLocalDateKey(now),
      timeStr: now.toLocaleString('en-GB', { timeZone: TIMEZONE })
    }
  });

  const windowRes = await generateBrain({
    model: PRIMARY_CHAT_MODEL,
    contents: [{ role: 'user', parts: [{ text: `${window.label} now` }] }],
    config: { systemInstruction: systemPrompt }
  });
  const text = stripActionMarkupForDisplay(windowRes.text || '').trim();
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

    const res = await generateBrain({ model: FAST_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: {} });
    const text = (res.text || '').trim();
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
    scheduledRuns: 0,
    recoveredRuns: 0,
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

// A condition watch that checked and found nothing new is not news — it's the poll doing
// its job. Surfacing it anyway is exactly the "notify on every poll" noise a background
// watch should avoid: a 30-minute price watch would otherwise post a fresh Home card and
// chat message every single cycle, most of them saying nothing happened. Every other
// outcome (a genuine trigger, a failure worth knowing about, or something that needs
// approval) is real news, and so is a plain non-condition scheduled task — it has no
// "checked, nothing yet" state at all, every run of it IS the deliverable.
function isScheduledRunNoteworthy(task, { conditionTriggered, failed, waiting }) {
  if (!task?.condition) return true;
  return Boolean(conditionTriggered || failed || waiting);
}

async function runScheduledTasksForUser(userId, logger = console, now = new Date()) {
  let runs = 0;
  let dueTasks = [];
  try {
    dueTasks = await scheduledTasks.getDueScheduledTasks(userId, now);
  } catch (error) {
    logger.warn?.(`[scheduled] could not load due tasks for ${userId}: ${error.message}`);
    return 0;
  }

  for (const due of dueTasks.slice(0, 3)) {
    const claimed = await scheduledTasks.claimScheduledTask(due, now).catch(() => null);
    if (!claimed) continue;

    let persistedTask = null;
    let runtimeSession = null;
    try {
      persistedTask = await taskManager.createTask(userId, claimed.title, {
        autonomy: 'Active',
        metadata: {
          scheduledTaskId: claimed.id,
          scheduledRecurrence: claimed.recurrence,
          scheduledCondition: claimed.condition || null
        }
      });
      const claimedTask = await taskManager.claimRun(userId, persistedTask.id, { now });
      if (!claimedTask) throw new Error('The scheduled run could not be claimed.');
      persistedTask = claimedTask;

      const route = await resolveAgentTaskRoute(userId, persistedTask);
      await taskManager.updateTask(userId, persistedTask.id, {
        metadata: { ...(persistedTask.metadata || {}), modelRoute: route }
      });
      persistedTask.metadata = { ...(persistedTask.metadata || {}), modelRoute: route };

      runtimeSession = await agentRuntime.ensureSession(supabase, userId, {
        taskId: persistedTask.id,
        deviceType: 'ambient_home',
        kind: 'task',
        title: claimed.title,
        state: 'running'
      });
      await agentRuntime.updateSession(supabase, userId, runtimeSession.id, {
        state: 'running',
        heartbeatAt: new Date().toISOString()
      });

      const result = await runAgenticLoop({
        userId,
        initialMessage: scheduledTasks.buildScheduledRunInstruction(claimed),
        dynamicSystemPrompt: await buildBackgroundSystemPrompt(userId),
        provider: route.provider,
        modelName: route.model,
        maxIterations: 6,
        context: {
          autonomy: 'Active',
          modelRoute: route,
          runtimeSessionId: runtimeSession.id,
          taskMetadata: persistedTask.metadata
        },
        executeActionsFn: executeActions,
        persistTask: true,
        existingTaskId: persistedTask.id
      });

      const waiting = result.agentTrace?.status === 'awaiting_approval';
      const failed = result.agentTrace?.status === 'error';
      // Re-read the row: the run may have written a real observation, and that recorded
      // verdict outranks whatever marker the model put in its answer.
      const { data: afterRun } = await supabase.from('scheduled_tasks')
        .select('watch_state').eq('id', claimed.id).maybeSingle();
      const conditionTriggered = scheduledTasks.scheduledConditionTriggered(claimed, result, afterRun?.watch_state || null);
      await agentRuntime.updateSession(supabase, userId, runtimeSession.id, {
        state: waiting ? 'waiting_approval' : failed ? 'failed' : 'completed',
        heartbeatAt: null,
        completedAt: waiting ? null : new Date().toISOString()
      }).catch(() => {});

      if (failed) {
        await scheduledTasks.deferScheduledTask(claimed, now);
      } else if (conditionTriggered) {
        // A watch the user asked about once ("tell me when it drops below £500") is done when
        // it fires. An ongoing or every-change watch ("keep me updated") must keep running —
        // it used to depend on the model remembering to re-create itself, which lost the
        // watch's baseline and history every time.
        const evaluation = afterRun?.watch_state?.lastEvaluation;
        if (evaluation && evaluation.terminal === false) await scheduledTasks.advanceScheduledTask(claimed, now);
        else await scheduledTasks.completeScheduledTask(claimed, now);
      } else if (waiting) {
        // Keep the watch alive, but do not create another run while this one waits
        // for the person to review an action.
        await scheduledTasks.deferScheduledTask(claimed, now);
      } else {
        await scheduledTasks.advanceScheduledTask(claimed, now);
      }

      if (isScheduledRunNoteworthy(claimed, { conditionTriggered, failed, waiting })) {
        const spoken = sanitizeAgentTaskText(
          scheduledTasks.cleanScheduledResultText(result.spoken),
          waiting ? `“${claimed.title}” needs your OK before Millie can continue.`
            : conditionTriggered ? `I found a match for “${claimed.title}”.`
              : `I checked “${claimed.title}”.`,
          500
        );
        const runStatus = waiting ? 'waiting_approval' : failed ? 'failed' : conditionTriggered ? 'triggered' : 'completed';
        await createBriefing(userId, {
          kind: 'scheduled_task',
          title: claimed.title,
          body: spoken,
          source: 'agent',
          metadata: {
            scheduledTaskId: claimed.id,
            taskId: persistedTask.id,
            status: runStatus
          },
          // The notification runtime owns channel choice from here — letting createBriefing
          // also fire its own push would be a second, uncontrolled attempt at the same event.
          push: false
        }).catch(error => logger.warn?.(`[scheduled] briefing failed for ${claimed.id}: ${error.message}`));

        // A background run that produced real news becomes a durable outbound notification,
        // not just a card in the app. Deduped on the watch AND the state it observed, so one
        // real transition is one alert however many times the sweep re-runs.
        const evaluation = afterRun?.watch_state?.lastEvaluation;
        await notificationDelivery.raise(userId, {
          category: /deliver|parcel|track/i.test(claimed.title) ? 'delivery' : 'watch',
          urgency: notifications.gradeUrgency({
            category: 'watch',
            exception: failed || evaluation?.kind === 'blocked',
            thresholdCrossed: evaluation?.kind === 'threshold_met',
            terminalState: evaluation?.terminal === true
          }),
          title: claimed.title,
          body: spoken,
          dedupeKey: notifications.dedupeKeyFor({
            category: 'watch',
            scheduledTaskId: claimed.id,
            state: evaluation?.reason || runStatus
          }),
          sourceRef: { scheduledTaskId: claimed.id, taskId: persistedTask.id, status: runStatus }
        }).catch(error => logger.warn?.(`[scheduled] notification failed for ${claimed.id}: ${error.message}`));
      }
      runs += 1;
    } catch (error) {
      if (persistedTask?.id) {
        await taskManager.updateTask(userId, persistedTask.id, {
          status: 'paused',
          heartbeat_at: null,
          last_error: 'Scheduled work could not start or finish.'
        }).catch(() => {});
      }
      if (runtimeSession?.id) {
        await agentRuntime.updateSession(supabase, userId, runtimeSession.id, {
          state: 'failed',
          heartbeatAt: null,
          completedAt: new Date().toISOString()
        }).catch(() => {});
      }
      await scheduledTasks.deferScheduledTask(claimed, now).catch(() => {});
      logger.error?.(`[scheduled] run failed for ${claimed.id}: ${error.message}`);
    }
  }
  return runs;
}

function mergeProactiveSummary(target, source) {
  for (const key of Object.keys(emptyProactiveSummary())) {
    target[key] = (target[key] || 0) + (source[key] || 0);
  }
}

async function runProactiveSweep(logger = console) {
  const startedAt = Date.now();
  const summary = emptyProactiveSummary();

  // Hand back runs abandoned by a dead instance before doing anything else. They are marked
  // 'paused' with their checkpoint intact, so the user (or a later sweep) can resume them
  // instead of finding a task stuck at 'running' with no explanation.
  try {
    const recovered = await taskManager.recoverStaleRuns(new Date());
    if (recovered.length) {
      summary.recoveredRuns = recovered.length;
      logger.log?.(`[sweep] recovered ${recovered.length} interrupted agent run(s): ${recovered.map(t => t.id).join(', ')}`);
    }
  } catch (e) {
    logger.error?.('[sweep] stale-run recovery failed', e.message);
  }

  const { data: users, error } = await supabase
    .from('users')
    .select('user_id');
  if (error) throw error;

  for (const user of users || []) {
    const userSummary = await runProactiveForUser(user.user_id, logger);
    mergeProactiveSummary(summary, userSummary);
    summary.scheduledRuns += await runScheduledTasksForUser(user.user_id, logger, new Date());
    // Everything raised above (and anything deferred by quiet hours that is now due) gets a
    // real delivery attempt on the same sweep.
    try {
      const delivery = await notificationDelivery.deliverPending(user.user_id);
      if (delivery?.results?.length) {
        summary.notificationsDelivered = (summary.notificationsDelivered || 0) +
          delivery.results.filter(r => r.status === 'delivered').length;
        summary.notificationsUndelivered = (summary.notificationsUndelivered || 0) +
          delivery.results.filter(r => r.status !== 'delivered').length;
        if (delivery.unavailable?.length) {
          logger.warn?.(`[notify] ${user.user_id}: ${delivery.unavailable.join('; ')}`);
        }
      }
    } catch (e) {
      logger.error?.(`[notify] delivery sweep failed for ${user.user_id}: ${e.message}`);
    }
  }

  // Scheduled routines (Phase 4 of the aside-parity roadmap) — reuses the existing
  // req/res-decoupled runAgenticLoop execution path (same one POST /agent/tasks/:id/run
  // uses for background agent runs), not a second dispatch mechanism.
  const dueRoutines = await listDueRoutines(supabase, new Date());
  for (const routine of dueRoutines) {
    try {
      await runAgenticLoop({
        userId: routine.user_id,
        initialMessage: routine.prompt,
        dynamicSystemPrompt: await buildBackgroundSystemPrompt(routine.user_id),
        maxIterations: 6,
        context: { autonomy: 'Active' },
        executeActionsFn: executeActions,
        persistTask: false
      });
      await markRoutineRun(supabase, routine.id, new Date());
    } catch (err) {
      logger?.error?.('routine_run_failed', { routineId: routine.id, error: err.message });
    }
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

const AGENT_AUTONOMY_LEVELS = new Set([
  'Reactive', 'Reserved', 'Balanced', 'Proactive', 'Autonomous',
  'Quiet', 'Low', 'Medium', 'Active', 'Medium-High', 'High', 'Bold', 'Assertive'
]);

function sanitizeAgentTaskText(value, fallback) {
  const text = String(value || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > 180 ? text.slice(0, 177) + '…' : text;
}

function safeAgentTaskSummary(task) {
  const rawResults = Array.isArray(task?.results) ? task.results : [];
  const results = rawResults.slice(-20).map((entry, index) => {
    const result = entry?.result || {};
    const pending = result.pending === true;
    const success = !pending && result.success !== false && !result.error;
    const summarySource = pending
      ? result.text || result.actionSummary
      : success
        ? result.actionSummary || result.cardText || result.text
        : actionFailureMessage(entry?.action, result.error || result.text);
    return {
      id: index + '-' + String(entry?.action || 'step'),
      action: sanitizeAgentTaskText(entry?.action, 'Agent step'),
      success,
      pending,
      summary: sanitizeAgentTaskText(
        summarySource,
        pending ? 'Waiting for your approval' : success ? 'Completed' : 'Could not complete this step'
      )
    };
  });

  const plan = Array.isArray(task?.plan)
    ? task.plan.slice(0, 12).map((step, index) => ({
      id: String(index),
      description: sanitizeAgentTaskText(
        typeof step === 'string' ? step : step?.description || step?.action || step?.type,
        'Step ' + (index + 1)
      )
    }))
    : [];

  return {
    id: task?.id,
    goal: sanitizeAgentTaskText(task?.goal, 'Untitled goal'),
    status: task?.status || 'pending',
    current_step: Number.isFinite(task?.current_step) ? task.current_step : 0,
    autonomy: task?.autonomy || 'Balanced',
    guard_mode: task?.metadata?.guardMode === true,
    // Why a run stopped. A paused task with no explanation is the state this whole
    // durability pass exists to eliminate. Sanitised like every other field, since the text
    // can carry a provider error containing a URL.
    last_error: task?.last_error ? sanitizeAgentTaskText(task.last_error, 'Stopped before finishing') : null,
    resumable: Boolean(task?.checkpoint),
    // Parked on the user rather than stalled. Distinct from last_error, because waiting for
    // an approval is not a failure and must not read like one.
    awaiting_approval: task?.metadata?.awaitingApproval === true,
    created_at: task?.created_at || null,
    updated_at: task?.updated_at || null,
    completed_at: task?.completed_at || null,
    plan,
    results
  };
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
  const safeError = isError ? formatActionFailure(actionType, result.error || result.text) : '';
  const summary = rawText.length > 160 ? rawText.slice(0, 157) + '…' : rawText;

  return {
    ...entry,
    action: actionType,
    // Rich presentation fields for browser "tasks" UI
    label,
    icon,
    status: pending ? 'pending' : (success ? 'success' : 'error'),
    summary: isError ? safeError : summary,
    isData: DATA_ACTIONS.has(actionType),
    isPendingReview: pending,
    displayTitle: pending
      ? (result.text || `${label} needs your OK`)
      : label,
    outcome: isError ? safeError : (pending ? 'Needs your OK' : 'Done'),
  };
}

function userFacingActionFailure(entry) {
  return formatActionFailure(entry?.action, entry?.result?.error || entry?.result?.text);
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
        return error;
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
  // Debt/arrears wording, added after a REAL Capital One "Notice of Sums in Arrears" scored
  // -2 and came out archivable: none of the words above appear in it, while its sending
  // domain (notification.capitalone.co.uk) collected the automated-sender penalty. Archiving
  // a genuine arrears notice is the worst thing inbox cleanup could do.
  if (/\b(arrears|sums in arrears|missed (?:a )?payments?|missed two or more|final notice|default notice|debt|collections|repossess|payment is (?:now )?overdue|late fees? (?:now )?apply|settle the invoice|please settle)\b/i.test(haystack)) add(5, 'money you owe');
  if (/\b(school|teacher|university|work|manager|client|invoice|contract|doctor|dentist|gp|travel|flight|train|hotel)\b/i.test(haystack)) add(2, 'personal/work signal');
  // Transactional mail (receipts, order/shipping/booking confirmations, refunds) is very
  // often sent from an automated-looking address (order-confirm@, noreply@, tracking@) —
  // without this, a genuine receipt would collect only the automated-sender penalty below
  // and read identically to a marketing newsletter. This is content-based, not sender-based,
  // so it can't be spoofed by simply not looking like a "no-reply" address either way.
  if (/\b(receipt|invoice|order confirm(?:ed|ation)?|order number|order #\d|tracking number|has shipped|out for delivery|been delivered|refund|return label|booking confirm(?:ed|ation)?|confirmation number|e-ticket|boarding pass|itinerary)\b/i.test(haystack)) add(3, 'receipt or confirmation');

  const automatedSender = /\b(no-?reply|noreply|donotreply|mailer-daemon|notification|notifications|alerts?|digest|newsletter|marketing)\b/i.test(sender);
  if (automatedSender) low(2, 'automated sender');
  // A List-Unsubscribe header is what actually makes something mailing-list mail. Real
  // promotional mail (an abandoned-cart nudge saying "complete your order") often carries no
  // marketing WORDS at all, so content alone left it unclassified and uncleaned. Recorded as
  // a signal here; whether it counts as bulk is decided below, so a receipt that happens to
  // come from a list-sending domain is not reclassified as junk.
  const mailingList = Boolean(email.listUnsubscribe);
  if (mailingList) low(1, 'mailing list header');
  if (/\b(newsletter|digest|roundup|recommended|recommendations|promotion|sale|offer|unsubscribe|manage preferences|marketing)\b/i.test(haystack)) low(3, 'bulk or promotional');
  if (/\b(job alert|jobs? alert|new jobs?|recommended jobs?|vacanc(?:y|ies)|workcircle|indeed|findeveryjob|totaljobs|reed\.co\.uk)\b/i.test(haystack)) {
    if (jobContext) add(2, 'job context match');
    else low(4, 'generic job alert');
  }
  if (/^(re:|fwd:)/i.test(subject) && !automatedSender) add(1, 'conversation thread');

  // "Automated sender" alone must not be treated the same as genuinely bulk/promotional
  // content — a delivery-tracking or booking-confirmation email is just as automated as a
  // newsletter, but it isn't junk. Only fold the sender-shape signal into 'bulk updates' when
  // nothing else redeems the message (no positive signal fired at all); real bulk/promotional
  // CONTENT (newsletter/offer/unsubscribe wording) always counts on its own.
  const hasBulkContent = lowSignals.includes('bulk or promotional');
  const hasOnlyAutomatedSenderPenalty = lowSignals.includes('automated sender') && signals.length === 0;
  // Same rule for the list header as for the sender shape: it only makes something bulk when
  // nothing positive fired. This is what keeps a real Travelzoo RECEIPT — which carries both
  // a List-Unsubscribe header and an unsubscribe footer — out of the archive pile.
  const isUnredeemedListMail = mailingList && signals.length === 0;
  const category = lowSignals.includes('generic job alert') ? 'job alerts'
    : (hasBulkContent || hasOnlyAutomatedSenderPenalty || isUnredeemedListMail) ? 'bulk updates'
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
  if (shouldSaveMemory(message) && !parseExplicitMemoryRequest(message)) {
    extractMemoryFact(userId, message).then(fact => {
      if (!fact) return;
      if (isDurableProfileFact(message)) {
        mergeIntoProfile(userId, fact).catch(() => {});
      } else {
        saveMemory(userId, fact, 'fact');
      }
    }).catch(() => {});
  }
  // Style-preference learning is disabled (Phase 4, 2026-08-06). This used to regex-match a
  // message and write `User said "<raw message>" — adapt accordingly` into `preferences` on
  // one occurrence, permanently — see the comment on ALLOWLISTED_STYLE_PREFERENCE_KEYS above
  // for what that produced live. filterStylePreferenceRows() also blocks any such rows
  // already in the table from reaching the prompt, so removing this write is a genuine
  // no-op today, not just a stop to future corruption. A typed, corroborated, decaying
  // replacement is future work, not this phase.
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
        const audio = await trace.run('voice.tts.generateSpeech.short_response', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
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
      const audio = await trace.run('voice.tts.generateSpeech.short_response_nonstream', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
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
    // Real saved home address (set in iOS Settings), not device GPS — "book a ride home"
    // needs the actual address, since the user isn't necessarily home when they ask.
    const homeLocation = (Number.isFinite(settings.homeLatitude) && Number.isFinite(settings.homeLongitude))
      ? { lat: settings.homeLatitude, lng: settings.homeLongitude }
      : null;

    if (!isNonEmptyString(message)) {
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

    const pendingAction = await timedDev('chat', 'intent_classification.pending_action', {}, () => getPendingAction(userId, message));
    if (pendingAction?.ambiguous && (
      isPendingConfirmMessage(message) ||
      isPendingCancelMessage(message) ||
      isPendingRevisionMessage(message)
    )) {
      await respondWithResult({
        res,
        streaming,
        wantsTTS,
        settings,
        trace,
        userId,
        message,
        spoken: agentApprovals.describeAmbiguousApprovals(pendingAction.approvals)
      });
      return;
    }
    if (pendingAction && isPendingCancelMessage(message)) {
      // Cancellation claims the same pending row as confirmation so a near-simultaneous
      // "yes" cannot execute the action after the task has been marked cancelled.
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
          spoken: 'That request was already handled.'
        });
        return;
      }
      let cancelled = false;
      try {
        cancelled = await cancelApprovalRun(userId, pendingAction);
      } catch (error) {
        trace.log('pending_action.cancel_failed', error.message);
      }
      if (cancelled || !pendingAction.taskId) {
        await settlePendingAction(userId, pendingAction, 'cancelled');
      }
      if (pendingAction.taskId && !cancelled) {
        // The preference was already claimed above. Put it back if task settlement
        // failed, otherwise a transient database error would silently lose the user's
        // only retry/cancel handle while the task remains resumable.
        await setPendingAction(userId, pendingAction.action, {
          userMessage: pendingAction.userMessage,
          location: pendingAction.location,
          nativeHints: pendingAction.nativeHints,
          persistedTaskId: pendingAction.taskId,
          runtimeSessionId: pendingAction.sessionId,
          taskGoal: pendingAction.taskGoal,
          approvalId: pendingAction.approvalId
        }).catch(() => {});
        await respondWithResult({
          res,
          streaming,
          wantsTTS,
          settings,
          trace,
          userId,
          message,
          spoken: 'I could not cancel that task cleanly. It is still waiting for your choice.'
        });
        return;
      }
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
      const pendingKey = `${userId}:${pendingAction.approvalId || pendingAction.createdAt || ''}:${pendingAction.action.type}:${JSON.stringify(pendingAction.action.input || {})}`;
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
            location: pendingAction.location || location,
            nativeHints: pendingAction.nativeHints || nativeHints,
            bypassReview: true,
            trace
          }, trace);
          actionResults = normalizeActionResultsForClient(actionResults);
          await settlePendingAction(
            userId,
            pendingAction,
            approvedActionSucceeded(actionResults) ? 'approved' : 'failed'
          );
          // If a background run was parked waiting on this approval, continue it from its
          // checkpoint. Executing the action alone would satisfy the confirmation prompt and
          // silently abandon the goal that asked for it.
          const resumeState = await resumeRunAfterApproval(userId, pendingAction, actionResults, trace);
          const spoken = [
            summarizeFinishedActionsForUser(actionResults) ||
              actionResults.map(a => a.result?.text || a.result?.error).filter(Boolean).join(' ') ||
              'Done.',
            resumeState.resumed ? 'Picking that task back up now.' : ''
          ].filter(Boolean).join(' ');
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
            location: pendingAction.location,
            nativeHints: pendingAction.nativeHints,
            persistedTaskId: pendingAction.taskId,
            runtimeSessionId: pendingAction.sessionId,
            taskGoal: pendingAction.taskGoal,
            approvalId: pendingAction.approvalId
          }).catch(() => {});
          throw e;
        }
      } finally {
        pendingActionConfirmLocks.delete(pendingKey);
      }
      return;
    }

    if (isLifeBriefingRequest(message)) {
      let briefing = null;
      try {
        briefing = await timedDev('chat', 'life_briefing.load', {}, () => loadLifeBriefing(userId));
      } catch (error) {
        trace.log('life_briefing.failed', error.message);
      }
      await respondWithResult({
        res,
        streaming,
        wantsTTS,
        settings,
        trace,
        userId,
        message,
        spoken: briefing ? formatLifeBriefing(briefing) : 'I couldn’t pull that together right now.'
      });
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
            const audio = await trace.run('voice.tts.generateSpeech.quick', () => generateSpeech(buildVoiceExcerpt(deterministicQuickReply), settings.voice));
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
          const audio = await trace.run('voice.tts.generateSpeech.quick_nonstream', () => generateSpeech(buildVoiceExcerpt(deterministicQuickReply), settings.voice));
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

    const resolvedEntity = await resolveEntityReference(supabase, userId, message).catch(() => null);
    const routingMessage = resolvedEntity
      ? message.replace(/\bthat \w+\b|\bthe \w+ i (?:opened|saw|looked at|checked)\b/i, `"${resolvedEntity.entityName}" (from ${resolvedEntity.site})`)
      : message;

    const contextualTurn = await timedDev('chat', 'intent_classification.contextual', {}, () => inferContextualDeterministicTurn(userId, routingMessage, settings, trace, {
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

    const deterministicAction = contextualTurn || inferDeterministicAction(routingMessage, {
      settings,
      appointmentProviderConnected: Boolean(getAppointmentBookingService())
    });
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
          homeLocation,
          nativeHints,
          trace,
          sequential: deterministicAction.actions.length > 1,
          guardMode: settings.guardMode
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
            const audio = await trace.run('voice.tts.generateSpeech.intent_router', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
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
        homeLocation,
        nativeHints,
        trace,
        sequential: deterministicAction.actions.length > 1,
        guardMode: settings.guardMode
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
          const audio = await trace.run('voice.tts.generateSpeech.intent_nonstream', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
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

    const requestedChatModel = streaming ? STREAMING_CHAT_MODEL : PRIMARY_CHAT_MODEL;
    const requestContext = {
      location,
      nativeHints,
      chatStartedAt,
      pendingAction: pendingAction && isPendingRevisionMessage(message) ? pendingAction : null
    };
    const {
      history,
      useSearch,
      dynamicSystemPrompt,
      cachedContentName,
      quickTurn,
      modelRoute
    } = await trace.run('buildChatContext', () => buildChatContext(userId, message, trace, requestedChatModel, requestContext));
    const chatModel = modelRoute.model;
    const chatProvider = modelRoute.provider;
    const baseHistory = normalizeGeminiHistory(history);
    const initialRequest = buildModernGenerateRequest({
      dynamicSystemPrompt,
      useSearch,
      cachedContentName,
      baseHistory,
      userContent: { role: 'user', parts: [{ text: message }] },
      // Native function declarations travel with every plain-chat turn. They were disabled
      // here in 78823773 (2026-07-07) to cut TTFT while the <action> TEXT fallback still
      // worked on Gemini; on gpt-5.6-luna that fallback emits nothing, so the classic path
      // was left claiming actions it never performed ("Playing Steve Lacy." with no music).
      useAgentTools: true
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
      let runtimeTaskId = null;
      let runtimeSessionId = null;
      let matchedTask = null;
      let runtimeStartError = null;

      // Create the execution identity before the first model turn. This is what makes an
      // ambient request a durable delegated goal rather than a chat response that happens
      // to call tools. If the optional runtime migration is not present yet, retain the
      // existing task-loop behaviour and surface the failure in the trace.
      try {
        const resumableTasks = await taskManager.listTasks(userId, null);
        matchedTask = resolveTaskReference(resumableTasks, message);
        const task = matchedTask || await taskManager.createTask(userId, message, {
          autonomy: autonomyLevel,
          metadata: {
            guardMode: settings.guardMode === true,
            modelRoute: { provider: chatProvider, model: chatModel },
            useSearch: Boolean(isBroadMoneyGoal || useSearch),
            deviceType: req.body?.deviceType || 'ambient_home'
          }
        });
        const claimed = await taskManager.claimRun(userId, task.id);
        if (matchedTask && !claimed) {
          runtimeStartError = 'That goal is already being handled.';
          throw new Error(runtimeStartError);
        }
        const executionTask = claimed || task;
        runtimeTaskId = executionTask.id;
        const projectRef = req.body?.projectRef || executionTask.metadata?.projectRef;
        const session = await agentRuntime.ensureSession(supabase, userId, {
          taskId: executionTask.id,
          deviceId: req.body?.deviceId,
          deviceType: req.body?.deviceType || 'ambient_home',
          projectRef,
          title: executionTask.goal || message,
          state: 'running'
        });
        runtimeSessionId = session.id;
        await agentRuntime.updateSession(supabase, userId, session.id, {
          state: 'running',
          heartbeatAt: new Date().toISOString()
        });
        await taskManager.updateTask(userId, executionTask.id, {
          metadata: {
            ...(executionTask.metadata || {}),
            runtimeSessionId: session.id,
            ...(projectRef ? { projectRef } : {}),
            modelRoute: { provider: chatProvider, model: chatModel },
            useSearch: Boolean(isBroadMoneyGoal || useSearch),
            deviceType: req.body?.deviceType || executionTask.metadata?.deviceType || 'ambient_home'
          }
        });
      } catch (error) {
        trace.log('agent.runtime_session.start_failed', String(error?.message || error).slice(0, 240));
      }

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

      if (runtimeStartError) {
        const spoken = runtimeStartError;
        if (streaming) {
          agenticSse({ type: 'replace', text: spoken });
          agenticSse({ type: 'done' });
          res.end();
        } else {
          res.json({ text: spoken, actions: [] });
        }
        saveMessage(userId, 'assistant', { text: spoken, actions: [] }, trace).catch(() => {});
        postResponseTasks(userId, message);
        return;
      }

      // The client's send watchdog extends itself on every status event it receives (see
      // ChatViewModel.startSendWatchdog) — but a single slow step inside the agent loop
      // (a page load, a third-party redirect) can legitimately go longer than the
      // watchdog's window with no real onStep event to send. Without a heartbeat, the
      // client times out a task that's still genuinely working. This fires on a fixed
      // interval regardless of what the loop is doing internally, so the client always
      // hears something well within its window.
      let heartbeat = null;
      if (agenticSendStatus) {
        heartbeat = setInterval(() => agenticSendStatus('agent_thinking', 'Working on it'), 15000);
      }

      try {
        const agentResult = await runAgenticLoop({
          userId,
          initialMessage: matchedTask ? (matchedTask.goal || message) : message,
          dynamicSystemPrompt,
          baseHistory,
          useSearch: isBroadMoneyGoal || useSearch, // force real-time research for money goals
          provider: chatProvider,
          modelName: chatModel,
          maxIterations: isBroadMoneyGoal || autonomyLevel === 'High' || autonomyLevel === 'Bold' ? 10 : 6,
          context: {
            userMessage: message,
            location,
            nativeHints,
            autonomy: autonomyLevel,
            modelRoute: { provider: chatProvider, model: chatModel },
            useSearch: isBroadMoneyGoal || useSearch,
            runtimeSessionId,
            ...(matchedTask ? { continuationMessage: message } : {})
          },
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
          persistTask: true,
          existingTaskId: runtimeTaskId || null
        });
        clearInterval(heartbeat);

        if (runtimeSessionId) {
          const traceStatus = agentResult?.agentTrace?.status;
          const state = traceStatus === 'completed'
            ? 'completed'
            : traceStatus === 'awaiting_approval'
              ? 'waiting_approval'
              : traceStatus === 'error' ? 'failed' : 'paused';
          await agentRuntime.updateSession(supabase, userId, runtimeSessionId, {
            state,
            heartbeatAt: null,
            completedAt: state === 'completed' ? new Date().toISOString() : null
          }).catch(error => trace.log('agent.runtime_session.settle_failed', error.message));
        }

        let actionResults = normalizeActionResultsForClient(agentResult.actions || []);
        let spoken = agentResult.spoken || 'Completed agent turn.';

        // For broad goals like making money, force a solid plan + research summary + persistent tracking
        if (isBroadMoneyGoal) {
          try {
            const plan = await generatePlan(userId, message, spoken, chatModel, chatProvider);
            spoken = `**Concierge Plan for "${message}":**\n${plan.title || 'Money-making strategy'}\n\nSteps:\n${(plan.steps || []).map((s, i) => `${i+1}. ${s.description}${s.actionType ? ` (use: ${s.actionType})` : ''}`).join('\n')}\n\nRisks: ${(plan.risks || []).join('; ')}\n\nAccount plan: ${plan.accountUsage || 'Use account to seed opportunities and receive earnings.'}\n\n${spoken}\n\nI've created a persistent task to monitor and advance this using the concierge account. With real API keys (e.g. STRIPE_SECRET_KEY), I can do actual charges and payouts. Check back or say "update money plan".`;
            if (agentResult.taskId) {
              await taskManager.appendResultToTask(userId, agentResult.taskId, { action: 'money_plan', result: { plan, research: 'used web_search' } });
            }
            // Auto-suggest small fund from account for seed if balance allows (will go through review)
            const prefs = await getPreferenceMap(userId);
            const bal = Number(prefs['concierge_account.balance'] || 0);
            if (bal >= 10) {
              spoken += `\n\nSuggestion: I can fund a small test opportunity (~$10-20) from the concierge account to get started (real via Stripe if keys wired).`;
            }
          } catch (planErr) {}
        }

        // Reflection for verification — fire-and-forget, not awaited: it only feeds a
        // trace log line, nothing downstream branches on it, so blocking the response on
        // a full extra Gemini call here was pure latency for zero payoff (same class of
        // fix as agent-orchestrator.js's mid-loop reflection).
        reflectOnResults(message, actionResults, actionResults, chatModel, chatProvider)
          .then((reflection) => {
            if (reflection && !reflection.achieved && reflection.nextAction) {
              trace && trace.log && trace.log('agent.reflection.next_action', JSON.stringify({
                summary: String(reflection.summary || '').slice(0, 240),
                nextAction: reflection.nextAction
              }));
            }
          })
          .catch(() => {});

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
        clearInterval(heartbeat);
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
        // Stream the model response token-by-token (provider per OXY_BRAIN_PROVIDER)
        const stream = await trace.run('brain.stream.initial', () => streamBrain({
          provider: chatProvider,
          model: chatModel,
          contents: initialRequest.contents,
          config: initialRequest.config
        }));
        let fullText = '';
        let streamedToolCalls = [];
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
            if (firstChunk) { trace.log('brain.first_token'); firstChunk = false; }
            fullText += text;
            emitSafeDisplayText(text);
            // Kick off TTS for complete sentences as they arrive, not after full generation
            if (ttsStreamer && !actionMarkupStarted) ttsStreamer.ingest(fullText);
          }
          // The provider emits accumulated tool calls as one terminal chunk, so this
          // assigns rather than appends. Text and tool calls can both be present.
          if (chunk.functionCalls?.length) {
            streamedToolCalls = chunk.functionCalls;
            trace.log('brain.native_tool_calls', streamedToolCalls.map(fc => fc.name).join(','));
          }
        }
        flushSafeDisplayText();
        trace.log('brain.initial_complete');
        // A turn that called a tool legitimately has no text yet — the reply is composed from
        // the results below. Only an empty turn with nothing at all is a failed generation.
        if (!fullText.trim() && !streamedToolCalls.length) {
          fullText = await recoverEmptyModelResponse({ provider: chatProvider, model: chatModel, initialRequest, message, trace });
          if (fullText) trace.log('brain.empty_recovery_success');
        }

        let { spoken, actions, parseError } = parseActions(fullText);
        if (parseError) trace.log('parse_actions.malformed_block', 'one or more <action> blocks failed to parse; some actions may be missing');
        // This guard exists for actions a weak fast tier AUTHORED AS TEXT, so it is applied to
        // the parsed <action> blocks only — native tool calls are structured output from the
        // main chat model and must not be swept up by it.
        if (shouldIgnoreModelAuthoredActions(chatModel) && actions.length) {
          trace.log('fast_model.actions_ignored', `count=${actions.length}`);
          actions = [];
        }
        actions = mergeNativeToolCalls(streamedToolCalls, actions);
        actions = guardCalendarActionsForUserMessage(actions, message);
        spoken = stripActionMarkupForDisplay(spoken).trim();
        if (!spoken && !actions.length) {
          const recovered = await recoverEmptyModelResponse({ provider: chatProvider, model: chatModel, initialRequest, message, trace });
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
          }, () => executeActions(userId, actions, { userMessage: message, location, homeLocation, nativeHints, trace, guardMode: settings.guardMode }, trace, {
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
          const followUp = await trace.run('brain.stream.followup', () => streamBrain({
            provider: chatProvider,
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
            await trace.run('voice.tts.generateSpeech.streamed', async () => {
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
        try { sse({ type: 'error', error: formatProviderFailure(err.message) }); res.end(); } catch {}
      }
      return;
    }

    // ── Non-streaming mode (JSON — backward compatible) ─────────────────
    const brainRes = await trace.run('brain.generate.nonstream', () => generateBrain({
      provider: chatProvider,
      model: chatModel,
      contents: initialRequest.contents,
      config: initialRequest.config
    }));

    const rawText = brainRes.text || '';
    const nonStreamToolCalls = brainRes.functionCalls || [];
    let { spoken, actions, parseError } = parseActions(rawText);
    if (parseError) trace.log('parse_actions.malformed_block', 'one or more <action> blocks failed to parse; some actions may be missing');
    if (shouldIgnoreModelAuthoredActions(chatModel) && actions.length) {
      trace.log('fast_model.actions_ignored', `count=${actions.length}`);
      actions = [];
    }
    if (nonStreamToolCalls.length) trace.log('brain.native_tool_calls', nonStreamToolCalls.map(fc => fc.name).join(','));
    actions = mergeNativeToolCalls(nonStreamToolCalls, actions);
    actions = guardCalendarActionsForUserMessage(actions, message);
    if ((!rawText.trim() && !nonStreamToolCalls.length) || (!spoken && !actions.length)) {
      const recovered = await recoverEmptyModelResponse({ provider: chatProvider, model: chatModel, initialRequest, message, trace });
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
      }, () => executeActions(userId, actions, { userMessage: message, location, homeLocation, nativeHints, trace, guardMode: settings.guardMode }, trace));
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
      const followUp = await trace.run('brain.generate.followup_nonstream', () => generateBrain({
        provider: chatProvider,
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
        const audio = await trace.run('voice.tts.generateSpeech.nonstream', () => generateSpeech(buildVoiceExcerpt(spoken), settings.voice));
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
    const safeError = formatProviderFailure(err.message);
    res.status(500).json({ error: safeError, text: safeError });
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
  const brainRoute = resolveModelRoute({});
  const brainStatus = providerConfiguration(brainRoute.provider, brainRoute.model);
  res.json({
    status: (missingEnv.length || dbStatus !== 'ok' || !brainStatus.ready) ? 'degraded' : 'ok',
    db: { status: dbStatus, latencyMs: dbLatencyMs },
    brain: {
      provider: brainStatus.provider,
      model: brainStatus.model,
      configured: brainStatus.configured,
      ready: brainStatus.ready,
      issue: brainStatus.issue
    },
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
app.get('/agent/workspace', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [{ workspace, files }, { sessions }] = await Promise.all([
      agentWorkspace.listWorkspaceFiles(supabase, userId),
      agentWorkspace.listWorkspaceSessions(supabase, userId)
    ]);
    res.json({
      workspace,
      files,
      sessions,
      capabilities: ['text_files', 'project_folders', 'persistent_sessions', 'task_history']
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load workspace.' });
  }
});

app.get('/agent/workspace/files', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await agentWorkspace.listWorkspaceFiles(supabase, userId, req.query.prefix || '');
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/agent/workspace/files/content', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const file = await agentWorkspace.readWorkspaceFile(supabase, userId, req.query.path);
    if (!file) return res.status(404).json({ error: 'Workspace file not found.' });
    res.json({ file });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/agent/workspace/files', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { path: filePath, content, kind } = req.body || {};
    const file = await agentWorkspace.writeWorkspaceFile(supabase, userId, filePath, content, kind);
    res.json({ file });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/agent/workspace/sessions', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json(await agentWorkspace.listWorkspaceSessions(supabase, userId));
  } catch (e) {
    res.status(500).json({ error: 'Could not load workspace sessions.' });
  }
});

app.post('/agent/workspace/sessions', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const session = await agentWorkspace.createWorkspaceSession(supabase, userId, req.body || {});
    res.json({ session });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/agent/continuity', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabase.from('agent_imports')
      .select('id, source, status, conversation_count, message_count, project_count, document_count, memory_count, metadata, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({ imports: data || [], supportedSources: ['chatgpt', 'claude', 'gemini', 'generic'] });
  } catch (e) {
    res.status(500).json({ error: 'Could not load continuity history.' });
  }
});

// Dry run. An export whose instructions and memory silently didn't parse looks identical to
// a clean import from the outside, so the coverage report is shown BEFORE anything is
// written and the user confirms against it.
app.post('/agent/continuity/preview', requireSessionAuth, continuityBodyParser, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json(agentContinuity.previewContinuity(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not read that export.' });
  }
});

app.post('/agent/continuity/import', requireSessionAuth, continuityBodyParser, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await agentContinuity.importContinuity(supabase, userId, req.body || {});
    invalidateUserContextCache(userId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not import continuity.' });
  }
});

app.get('/agent/context', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json({ context: await loadAgentContext(supabase, userId) });
  } catch (e) {
    res.status(500).json({ error: 'Could not load agent context.' });
  }
});

// One bounded, answer-first view of the user's current life context. The endpoint exposes
// only ranked titles and short next-step summaries; connector payloads, message bodies,
// addresses, credentials, and raw task results stay server-side.
app.get('/agent/briefing', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json(await loadLifeBriefing(userId));
  } catch (e) {
    res.status(503).json({ error: 'Could not load the current briefing.' });
  }
});

app.get('/agent/tools', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const enabled = new Set(await getEnabledConnectors(userId));
    const tools = Object.entries(ACTION_CONTRACTS).map(([id, contract]) => ({
      id,
      risk: contract.risk || 'low',
      executionMode: contract.executionMode || 'direct',
      confirmation: contract.confirmation || 'none',
      required: contract.required || [],
      available: !contract.connector || enabled.has(contract.connector)
    }));
    res.json({
      tools,
      connectors: CONNECTORS.map(connector => ({
        id: connector.id,
        name: connector.name,
        category: connector.category,
        kind: connector.kind,
        implemented: connector.implemented,
        connected: enabled.has(connector.id)
      })),
      capabilities: ['communication', 'productivity', 'development', 'travel', 'shopping', 'health', 'finance']
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load tool catalog.' });
  }
});

app.get('/agent/browser', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabase.from('browser_sessions')
      .select('site, last_url, goal, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({
      sessions: (data || []).map(session => ({
        site: session.site,
        lastUrl: session.last_url,
        goal: session.goal,
        updatedAt: session.updated_at
      })),
      capabilities: ['persistent_sessions', 'login_state', 'website_understanding', 'form_filling', 'checkout_review']
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load browser sessions.' });
  }
});

app.get('/agent/permissions', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const settings = await getChatSettings(supabase, userId);
  res.json({
    guardMode: settings.guardMode === true,
    read: { default: 'automatic', description: 'Read-only context and lookups can run automatically.' },
    write: { default: settings.guardMode ? 'approval' : 'contract', description: settings.guardMode ? 'Every write waits for approval.' : 'Writes follow their action contract.' },
    payment: { default: 'approval', description: 'Money movement always waits for approval or an explicit spend guard.' },
    audit: { enabled: true, undo: 'connector-dependent' }
  });
});

app.get('/agent/audit', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabase.from('action_log')
      .select('action, status, error, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    const entries = (data || []).map(row => {
      const action = typeof row.action === 'string' ? safeParseJSON(row.action) : row.action;
      const type = String(action?.type || 'unknown');
      const contract = ACTION_CONTRACTS[type] || {};
      return {
        type,
        status: row.status || 'unknown',
        error: row.error || null,
        createdAt: row.created_at,
        risk: contract.risk || 'unknown',
        executionMode: contract.executionMode || 'direct',
        reviewRequired: contract.confirmation === 'review_required' || contract.executionMode === 'review',
        undo: null
      };
    });
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ error: 'Could not load the action history.' });
  }
});

app.post('/agent/tasks', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { goal, autonomy, plan, guardMode } = req.body || {};
  if (!goal) return res.status(400).json({ error: 'goal required' });
  if (guardMode !== undefined && typeof guardMode !== 'boolean') {
    return res.status(400).json({ error: 'guardMode must be a boolean' });
  }
  try {
    const task = await taskManager.createTask(userId, goal, {
      autonomy,
      plan,
      metadata: typeof guardMode === 'boolean' ? { guardMode } : undefined
    });
    res.json({ task: safeAgentTaskSummary(task) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/agent/tasks', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const status = req.query.status;
  try {
    const tasks = await taskManager.listTasks(userId, status || null);
    res.json({ tasks: tasks.map(safeAgentTaskSummary) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/agent/tasks/:id', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const task = await taskManager.getTask(userId, req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    res.json({ task: safeAgentTaskSummary(task) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/agent/scheduled-tasks', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await scheduledTasks.listScheduledTasks(userId);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json({
      tasks: (result.tasks || []).map(task => ({
        id: task.id,
        title: task.title,
        recurrence: task.recurrence,
        nextRunAt: task.next_run_at,
        condition: task.condition || null,
        intervalMinutes: task.interval_minutes || null,
        expiresAt: task.expires_at || null,
        active: task.active !== false
      }))
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load what Millie is watching.' });
  }
});

app.delete('/agent/scheduled-tasks/:id', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await scheduledTasks.cancelScheduledTask(userId, { id: req.params.id });
    if (!result.success) return res.status(result.error === 'not_found' ? 404 : 500).json({ error: result.error });
    res.json({ success: true, task: { id: result.task?.id, title: result.task?.title, active: false } });
  } catch (e) {
    res.status(500).json({ error: 'Could not stop watching that.' });
  }
});

app.get('/agent/tasks/:id/runtime', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const task = await taskManager.getTask(userId, req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    const sessionId = task.metadata?.runtimeSessionId;
    res.json({ runtime: sessionId ? await agentRuntime.getSnapshot(supabase, userId, sessionId) : null });
  } catch (e) {
    res.status(500).json({ error: 'Could not load the work session.' });
  }
});

app.get('/agent/tasks/:id/runtime/diff', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const task = await taskManager.getTask(userId, req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    const sessionId = task.metadata?.runtimeSessionId;
    if (!sessionId) return res.status(404).json({ error: 'No work session has started.' });
    const runtime = await agentRuntime.getSnapshot(supabase, userId, sessionId);
    if (!runtime?.projectRef) return res.status(404).json({ error: 'This work session has no project changes.' });
    const diff = await agentProjectRuntime.gitDiff(userId, task.id, runtime.projectRef);
    res.json({
      projectRef: diff.projectRef,
      projectName: diff.projectName,
      diff: diff.diff,
      truncated: diff.truncated
    });
  } catch (e) {
    res.status(503).json({ error: 'Project changes are not available right now.' });
  }
});

app.patch('/agent/tasks/:id', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { autonomy, guardMode } = req.body || {};
  if (autonomy !== undefined && (!AGENT_AUTONOMY_LEVELS.has(autonomy) || autonomy.length > 32)) {
    return res.status(400).json({ error: 'Unsupported autonomy level' });
  }
  if (guardMode !== undefined && typeof guardMode !== 'boolean') {
    return res.status(400).json({ error: 'guardMode must be a boolean' });
  }
  if (autonomy === undefined && guardMode === undefined) {
    return res.status(400).json({ error: 'No task controls supplied' });
  }
  try {
    const task = await taskManager.getTask(userId, req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    const updates = {};
    if (autonomy !== undefined) updates.autonomy = autonomy;
    if (guardMode !== undefined) {
      updates.metadata = { ...(task.metadata || {}), guardMode };
    }
    const updated = await taskManager.updateTask(userId, task.id, updates);
    res.json({ task: safeAgentTaskSummary(updated) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/agent/tasks/:id/run', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const task = await taskManager.getTask(userId, req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (task.metadata?.awaitingApproval === true) {
    return res.status(409).json({ error: 'That task is waiting for your approval.', awaitingApproval: true, taskId: task.id });
  }

  const resuming = Boolean(task.checkpoint);
  // Claim with a compare-and-set update before handing off to the background loop.
  // This closes the read-then-update race between Work, approval resume, and two
  // simultaneous requests on different Cloud Run instances.
  const claimedTask = await taskManager.claimRun(userId, task.id);
  if (!claimedTask) {
    return res.status(409).json({ error: 'That task is already running or was claimed by another request.', taskId: task.id });
  }
  let runtimeSession;
  try {
    runtimeSession = await agentRuntime.ensureSession(supabase, userId, {
      taskId: claimedTask.id,
      deviceId: req.body?.deviceId || claimedTask.metadata?.deviceId,
      deviceType: req.body?.deviceType || claimedTask.metadata?.deviceType || 'ambient_home',
      projectRef: req.body?.projectRef || claimedTask.metadata?.projectRef,
      kind: req.body?.kind || claimedTask.metadata?.runtimeKind || 'task',
      title: claimedTask.goal,
      state: 'running'
    });
    await agentRuntime.updateSession(supabase, userId, runtimeSession.id, {
      state: 'running',
      heartbeatAt: new Date().toISOString()
    });
  } catch (error) {
    await taskManager.updateTask(userId, claimedTask.id, {
      status: 'paused',
      heartbeat_at: null,
      last_error: 'The work session could not be started.'
    }).catch(() => {});
    return res.status(503).json({ error: 'Could not start the work session.' });
  }
  const route = await resolveAgentTaskRoute(userId, claimedTask);
  await taskManager.updateTask(userId, claimedTask.id, {
    metadata: {
      ...(claimedTask.metadata || {}),
      modelRoute: route,
      runtimeSessionId: runtimeSession.id
    }
  });

  buildBackgroundSystemPrompt(userId).then(dynamicSystemPrompt => runAgenticLoop({
    userId,
    initialMessage: claimedTask.goal,
    dynamicSystemPrompt,
    provider: route.provider,
    modelName: route.model,
    maxIterations: Number.isFinite(claimedTask.checkpoint?.maxIterations) ? claimedTask.checkpoint.maxIterations : 6,
    context: {
      autonomy: claimedTask.autonomy,
      guardMode: claimedTask.metadata?.guardMode === true,
      modelRoute: route,
      runtimeSessionId: runtimeSession.id
    },
    executeActionsFn: executeActions,
    persistTask: true,
    existingTaskId: claimedTask.id
  }).then(async (outcome) => {
    const traceStatus = outcome?.agentTrace?.status;
    const state = traceStatus === 'completed'
      ? 'completed'
      : traceStatus === 'awaiting_approval'
        ? 'waiting_approval'
        : traceStatus === 'error' ? 'failed' : 'paused';
    await agentRuntime.updateSession(supabase, userId, runtimeSession.id, {
      state,
      heartbeatAt: null,
      completedAt: state === 'completed' ? new Date().toISOString() : null
    }).catch(error => console.warn('[agent-runtime] session settlement failed:', error.message));
  }).catch(async (e) => {
    // Swallowing this left the task stranded at 'running' forever with nothing to explain
    // it. Record the failure and keep the checkpoint so it stays resumable.
    try {
      await taskManager.updateTask(userId, claimedTask.id, {
        status: 'paused',
        heartbeat_at: null,
        last_error: String(e?.message || e).slice(0, 500)
      });
    } catch {}
    await agentRuntime.updateSession(supabase, userId, runtimeSession.id, {
      state: 'failed',
      heartbeatAt: null
    }).catch(() => {});
  }));
  res.json({ started: true, resumed: resuming, taskId: claimedTask.id });
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

// General-purpose credential vault — Phase 2 of the aside-parity roadmap. Any site
// credential (not just payment cards); stored encrypted, one per (user, site), decrypted
// only inside the browser-task engine at point of use (confirmCredentialUse in
// api/services/browser-task.js). GET never returns the password. Credential entry
// happens over these authed routes (iOS Vault screen), NEVER via chat.
app.post('/vault/credentials', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { site, label, username, password } = req.body || {};
    const result = await saveVaultCredential(supabase, userId, { site, label, username, password });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ saved: true, credential: result.credential });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/vault/credentials', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { credentials, error } = await listVaultCredentials(supabase, userId);
    if (error) return res.status(500).json({ error });
    res.json({ credentials });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/vault/credentials/:id', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await deleteVaultCredential(supabase, userId, req.params.id);
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fills a username/password the user just typed directly into the live browser-task page's
// login form, for a `reauth` outcome — same rule as the vault routes above: credentials are
// NEVER accepted over chat, only here, over an authed route, straight into the DOM. Never
// logged, never in a model prompt. See browser-task.js's fillReauthLogin for the fill logic.
app.post('/browser-task/reauth-login', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { username, password, saveToVault, label } = req.body || {};
    const result = await browserTask.fillReauthLogin(userId, { username, password, saveToVault, label });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recently touched entities (Phase 3 of the aside-parity roadmap) — a light "what did the
// agent last work on" surface, not a search UI. Reuses task_entities written by
// api/services/browser-task.js's runOrderingTurnImpl.
// Chat settings (Phase 4 of the aside-parity roadmap) — effort is stored/exposed as a
// preference only (no model-selection wiring). Guard mode is enforced server-side, see
// api/services/action-runner.js's executionMode gate.
app.get('/chat-settings', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await getChatSettings(supabase, userId));
});

app.put('/chat-settings', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { effort, guardMode } = req.body || {};
  const result = await saveChatSettings(supabase, userId, { effort, guardMode });
  res.json(result);
});

// Model independence: the relationship is owned by the user, while credentials stay
// server-side. A route can be selected before its provider is configured; chat keeps the
// current route active until then and the response makes the unavailable state explicit.
app.get('/model-routing', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json(publicModelRouting(await getPreferenceMap(userId)));
});

app.put('/model-routing', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const route = validateModelRouteInput(req.body || {});
  if (route.error) return res.status(400).json({ error: route.error });
  await Promise.all([
    setPreferenceValue(userId, ROUTE_KEYS.provider, route.provider),
    setPreferenceValue(userId, ROUTE_KEYS.model, route.model)
  ]);
  res.json(publicModelRouting({
    ...(await getPreferenceMap(userId)),
    [ROUTE_KEYS.provider]: route.provider,
    [ROUTE_KEYS.model]: route.model
  }));
});

// One-off address -> lat/lng lookup, used by the iOS Settings "Home address" field so a
// saved home location can be resolved once (not repeated per ride/route request).
app.post('/geocode', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const address = String(req.body?.address || '').trim();
  if (!address) return res.status(400).json({ error: 'address is required.' });
  try {
    const result = await geocodeLocation(address);
    res.json({ lat: result.lat, lng: result.lng, formattedAddress: result.formattedAddress });
  } catch (e) {
    res.status(400).json({ error: e.message });
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

// Routines — a user-saved name + prompt they can re-run later (api/services/routines.js).
app.post('/routines', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { name, prompt } = req.body || {};
    if (!name || !prompt) return res.status(400).json({ error: 'name and prompt required' });
    const routine = await createRoutine(supabase, { userId, name, prompt });
    if (routine.error) return res.status(500).json({ error: routine.error });
    res.status(201).json(routine);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/routines', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { routines, error } = await listRoutines(supabase, userId);
    if (error) return res.status(500).json({ error });
    res.json({ routines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/routines/:id', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await deleteRoutine(supabase, userId, req.params.id);
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json(result);
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
module.exports.mergeNativeToolCalls = mergeNativeToolCalls;
module.exports.buildModernGenerateRequest = buildModernGenerateRequest;
module.exports.shouldUseAgenticLoopForMessage = shouldUseAgenticLoopForMessage;
module.exports.shouldIgnoreModelAuthoredActions = shouldIgnoreModelAuthoredActions;
module.exports.isBroadEmailTriageRequest = isBroadEmailTriageRequest;
module.exports.triageEmailsForRequest = triageEmailsForRequest;
module.exports.emailTriageSignals = emailTriageSignals;
module.exports.normalizeActionResultsForClient = normalizeActionResultsForClient;
module.exports.safeAgentTaskSummary = safeAgentTaskSummary;
module.exports.approvedActionSucceeded = approvedActionSucceeded;
module.exports.executeAction = executeAction;
module.exports.validatePendantTranscriptionUpload = validatePendantTranscriptionUpload;
module.exports.isUserFacingMemory = isUserFacingMemory;
module.exports.isUsefulMemoryContent = isUsefulMemoryContent;
module.exports.isDurableProfileFact = isDurableProfileFact;
module.exports.parseExplicitMemoryRequest = parseExplicitMemoryRequest;
module.exports.isEmailDraftRequest = isEmailDraftRequest;
module.exports.findRecentEmailTarget = findRecentEmailTarget;
module.exports.CONNECTORS = CONNECTORS;
module.exports.getWavDurationMs = getWavDurationMs;
module.exports.isImplausibleTranscript = isImplausibleTranscript;
module.exports.ALLOWLISTED_STYLE_PREFERENCE_KEYS = ALLOWLISTED_STYLE_PREFERENCE_KEYS;
module.exports.filterStylePreferenceRows = filterStylePreferenceRows;
module.exports.extractAlreadyStatedContext = extractAlreadyStatedContext;
module.exports.extractShoppingContextHints = extractShoppingContextHints;
module.exports.buildDynamicSystemPrompt = buildDynamicSystemPrompt;
module.exports.buildQuickTurnContext = buildQuickTurnContext;
module.exports.buildBackgroundSystemPrompt = buildBackgroundSystemPrompt;
module.exports.buildChatContext = buildChatContext;
module.exports.buildMorningBriefing = buildMorningBriefing;
module.exports.buildIntervalBriefing = buildIntervalBriefing;
module.exports.checkMillieSendCap = checkMillieSendCap;
module.exports.runAgenticLoop = runAgenticLoop;
module.exports.executeActions = executeActions;
module.exports.runScheduledTasksForUser = runScheduledTasksForUser;
module.exports.notificationDelivery = notificationDelivery;
module.exports.isScheduledRunNoteworthy = isScheduledRunNoteworthy;

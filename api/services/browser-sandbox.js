'use strict';
// One persistent E2B sandbox per user, each running a real headed Chromium with an on-disk
// profile. The agent drives it over CDP, so everything above browser-session.js is unchanged.
// An idle sandbox is paused (memory included), so tabs, logins and the profile survive.

const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const CDP_PORT = 9223; // socat in the template forwards this to Chromium's loopback-only 9222
const VIEW_PORT = 6080; // noVNC
const APP_TAG = 'adam-browser';

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const config = () => ({
  template: process.env.OXY_E2B_TEMPLATE || 'oxy-browser',
  timeoutMs: envInt('OXY_E2B_TIMEOUT_MS', 15 * 60 * 1000),
  pauseDelayMs: envInt('OXY_E2B_PAUSE_DELAY_MS', 5 * 60 * 1000),
  bootTimeoutMs: envInt('OXY_E2B_BOOT_TIMEOUT_MS', 30 * 1000),
  connectTimeoutMs: envInt('OXY_E2B_CONNECT_TIMEOUT_MS', 20 * 1000),
});

function backendName() {
  const name = String(process.env.OXY_BROWSER_BACKEND || 'local').toLowerCase();
  return name === 'e2b' ? 'e2b' : 'local';
}

// OXY_BROWSER_SANDBOX_USERS (comma-separated user ids) limits the sandbox to those users, so it
// can be tried on one account before everyone. Unset means every user.
function isEnabled(userId) {
  if (backendName() !== 'e2b' || !process.env.E2B_API_KEY) return false;
  const list = String(process.env.OXY_BROWSER_SANDBOX_USERS || '').split(',').map((v) => v.trim()).filter(Boolean);
  return !list.length || userId === undefined || list.includes(userId);
}

// E2B is a third party: it gets an opaque tag, never the user id.
function userTag(userId) {
  return createHash('sha256').update(`adam-sandbox:${userId}`).digest('hex').slice(0, 32);
}

const TIMING = process.env.OXY_BROWSER_TIMING === '1';
async function timed(label, fn) {
  if (!TIMING) return fn();
  const t = Date.now();
  try { return await fn(); } finally { console.warn(`[timing] sandbox.${label}: ${Date.now() - t}ms`); }
}

let sdk = null;
let endpointFor = (sandbox, port) => `https://${sandbox.getHost(port)}`;
const entries = new Map(); // userId -> { sandbox, sandboxId, locks, pauseTimer, busy }
const pending = new Map(); // userId -> Promise, so concurrent opens share one boot
const warming = new Map();

function getSdk() {
  if (!sdk) sdk = require('e2b').Sandbox;
  return sdk;
}

function trafficHeaders(sandbox) {
  return sandbox.trafficAccessToken ? { 'e2b-traffic-access-token': sandbox.trafficAccessToken } : {};
}

async function fetchJson(url, headers, timeoutMs) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function probeBrowser(sandbox, timeoutMs = 3000) {
  const base = endpointFor(sandbox, CDP_PORT);
  return fetchJson(`${base}/json/version`, trafficHeaders(sandbox), timeoutMs);
}

// A new or resumed sandbox answers 502 for a moment while its browser is already starting, so
// poll briefly first. Only when it stays down (a cold boot, or a crashed Chromium) is the
// template's start script run again, and then we wait for the debugging endpoint.
async function pollBrowser(sandbox, untilMs) {
  const deadline = Date.now() + untilMs;
  let lastError;
  do {
    try { return await probeBrowser(sandbox, 1500); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw lastError || new Error('timed out');
}

async function ensureBrowserRunning(sandbox, bootTimeoutMs) {
  try { return await pollBrowser(sandbox, 4000); } catch { /* still down */ }
  await sandbox.commands.run('bash /opt/oxy/start.sh', { background: true });
  try { return await pollBrowser(sandbox, bootTimeoutMs); }
  catch (error) { throw new Error(`Sandbox browser did not start: ${error.message}`); }
}

async function findExisting(userId) {
  const paginator = getSdk().list({
    query: { metadata: { app: APP_TAG, user: userTag(userId) }, state: ['running', 'paused'] },
    limit: 5,
  });
  const items = await paginator.nextItems();
  return items.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0] || null;
}

async function createSandbox(userId, cfg) {
  return getSdk().create(cfg.template, {
    metadata: { app: APP_TAG, user: userTag(userId) },
    timeoutMs: cfg.timeoutMs,
    lifecycle: { onTimeout: 'pause' },
    // Sandbox URLs need the traffic token, which only this server holds.
    network: { allowPublicTraffic: false, maskRequestHost: 'localhost' },
  });
}

async function ensureSandbox(userId) {
  const cfg = config();
  const known = entries.get(userId);
  if (known?.pauseTimer) { clearTimeout(known.pauseTimer); known.pauseTimer = null; }

  let sandbox = null;
  if (known) {
    try {
      // connect() resumes a paused sandbox and extends the timeout of a running one.
      sandbox = await timed('resume', () => getSdk().connect(known.sandboxId, { timeoutMs: cfg.timeoutMs }));
    } catch { entries.delete(userId); }
  }
  if (!sandbox) {
    const found = await timed('find', () => findExisting(userId));
    if (found) {
      try { sandbox = await timed('resume', () => getSdk().connect(found.sandboxId, { timeoutMs: cfg.timeoutMs })); }
      catch (error) { console.warn('[browser-sandbox] could not resume sandbox, creating a new one:', error.message); }
    }
  }
  if (!sandbox) sandbox = await timed('create', () => createSandbox(userId, cfg));

  entries.set(userId, { sandbox, sandboxId: sandbox.sandboxId, pauseTimer: null, inUse: Boolean(known?.inUse) });
  return sandbox;
}

/**
 * Wake a sandbox the user already has, ahead of the browser being asked for, so a task that
 * does need it starts on a running machine. Never creates one, never connects Playwright, and
 * never throws: a chat message that never touches the browser must not pay for or fail on this.
 */
function prewarm(userId) {
  if (!isEnabled(userId) || pending.has(userId) || warming.has(userId)) return;
  const run = (async () => {
    const known = entries.get(userId);
    if (!known && !(await findExisting(userId))) return;
    const sandbox = await ensureSandbox(userId);
    await ensureBrowserRunning(sandbox, config().bootTimeoutMs);
    // Nothing asked for it yet, so the usual idle timer applies, unless a session took it meanwhile.
    if (!entries.get(userId)?.inUse) release(userId);
  })().catch((error) => console.warn('[browser-sandbox] prewarm failed:', error.message))
    .finally(() => warming.delete(userId));
  warming.set(userId, run);
  return run;
}

/**
 * Get this user's sandbox browser, connected over CDP. Resolves to the same shape browser
 * sessions already use, plus the profile's default context and a release() to call when the
 * session ends. Throws if the sandbox cannot be reached; the caller decides on a fallback.
 */
async function acquire(userId) {
  if (pending.has(userId)) return pending.get(userId);
  const run = (async () => {
    const cfg = config();
    const sandbox = await ensureSandbox(userId);
    const version = await timed('browser-up', () => ensureBrowserRunning(sandbox, cfg.bootTimeoutMs));
    // The reported debugger URL carries the masked host, so build ours from the known endpoint.
    const wsPath = new URL(version.webSocketDebuggerUrl).pathname;
    const base = new URL(endpointFor(sandbox, CDP_PORT));
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = wsPath;
    const browser = await timed('cdp-connect', () => chromium.connectOverCDP(base.toString(), {
      headers: trafficHeaders(sandbox),
      timeout: cfg.connectTimeoutMs,
    }));
    const persistentContext = browser.contexts()[0] || await browser.newContext();
    const entry = entries.get(userId);
    if (entry) entry.inUse = true;
    return {
      browser,
      persistentContext,
      backend: 'e2b',
      sandboxId: sandbox.sandboxId,
      release: () => release(userId),
    };
  })();
  pending.set(userId, run);
  try { return await run; } finally { pending.delete(userId); }
}

// Pause shortly after the last session ends. A new session inside the delay cancels it, so a
// run of quick tasks does not pay a resume each time.
function release(userId) {
  const entry = entries.get(userId);
  if (!entry) return;
  entry.inUse = false;
  if (entry.pauseTimer) return;
  entry.pauseTimer = setTimeout(() => {
    entry.pauseTimer = null;
    pauseNow(userId).catch((error) => console.warn('[browser-sandbox] pause failed:', error.message));
  }, config().pauseDelayMs);
  entry.pauseTimer.unref?.();
}

async function pauseNow(userId) {
  const entry = entries.get(userId);
  if (!entry) return false;
  if (entry.pauseTimer) { clearTimeout(entry.pauseTimer); entry.pauseTimer = null; }
  return getSdk().pause(entry.sandboxId);
}

/** Delete the user's sandbox and everything on it: profile, logins, files. */
async function destroyForUser(userId) {
  const entry = entries.get(userId);
  if (entry?.pauseTimer) clearTimeout(entry.pauseTimer);
  entries.delete(userId);
  if (!process.env.E2B_API_KEY && !sdk) return { destroyed: 0 };
  let destroyed = 0;
  const ids = new Set(entry ? [entry.sandboxId] : []);
  const paginator = getSdk().list({
    query: { metadata: { app: APP_TAG, user: userTag(userId) }, state: ['running', 'paused'] },
    limit: 50,
  });
  while (true) {
    for (const item of await paginator.nextItems()) ids.add(item.sandboxId);
    if (!paginator.hasNext) break;
  }
  for (const id of ids) if (await getSdk().kill(id)) destroyed += 1;
  return { destroyed };
}

/** Where to reach the live view for this user's sandbox, for the server-side proxy. */
function viewTarget(userId) {
  const entry = entries.get(userId);
  if (!entry) return null;
  return { base: endpointFor(entry.sandbox, VIEW_PORT), headers: trafficHeaders(entry.sandbox) };
}

module.exports = {
  isEnabled, backendName, acquire, prewarm, release, pauseNow, destroyForUser, viewTarget, userTag,
  CDP_PORT, VIEW_PORT,
  _setSdk(fake) { sdk = fake; },
  _setEndpoint(fn) { endpointFor = fn; },
  _entries: entries,
};

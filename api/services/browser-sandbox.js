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
  pauseDelayMs: envInt('OXY_E2B_PAUSE_DELAY_MS', 90 * 1000),
  bootTimeoutMs: envInt('OXY_E2B_BOOT_TIMEOUT_MS', 30 * 1000),
  connectTimeoutMs: envInt('OXY_E2B_CONNECT_TIMEOUT_MS', 20 * 1000),
});

function backendName() {
  const name = String(process.env.OXY_BROWSER_BACKEND || 'local').toLowerCase();
  return name === 'e2b' ? 'e2b' : 'local';
}

function isEnabled() {
  return backendName() === 'e2b' && Boolean(process.env.E2B_API_KEY);
}

// E2B is a third party: it gets an opaque tag, never the user id.
function userTag(userId) {
  return createHash('sha256').update(`adam-sandbox:${userId}`).digest('hex').slice(0, 32);
}

let sdk = null;
let endpointFor = (sandbox, port) => `https://${sandbox.getHost(port)}`;
const entries = new Map(); // userId -> { sandbox, sandboxId, locks, pauseTimer, busy }
const pending = new Map(); // userId -> Promise, so concurrent opens share one boot

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

// A paused sandbox restores with its processes. A cold boot (or a crashed Chromium) does not,
// so start the template's script again and wait for the debugging endpoint.
async function ensureBrowserRunning(sandbox, bootTimeoutMs) {
  try { return await probeBrowser(sandbox); } catch { /* not up yet */ }
  await sandbox.commands.run('bash /opt/oxy/start.sh', { background: true });
  const deadline = Date.now() + bootTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await probeBrowser(sandbox); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Sandbox browser did not start: ${lastError?.message || 'timed out'}`);
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
      sandbox = await getSdk().connect(known.sandboxId, { timeoutMs: cfg.timeoutMs });
    } catch { entries.delete(userId); }
  }
  if (!sandbox) {
    const found = await findExisting(userId);
    if (found) {
      try { sandbox = await getSdk().connect(found.sandboxId, { timeoutMs: cfg.timeoutMs }); }
      catch (error) { console.warn('[browser-sandbox] could not resume sandbox, creating a new one:', error.message); }
    }
  }
  if (!sandbox) sandbox = await createSandbox(userId, cfg);

  entries.set(userId, { sandbox, sandboxId: sandbox.sandboxId, pauseTimer: null });
  return sandbox;
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
    const version = await ensureBrowserRunning(sandbox, cfg.bootTimeoutMs);
    // The reported debugger URL carries the masked host, so build ours from the known endpoint.
    const wsPath = new URL(version.webSocketDebuggerUrl).pathname;
    const base = new URL(endpointFor(sandbox, CDP_PORT));
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = wsPath;
    const browser = await chromium.connectOverCDP(base.toString(), {
      headers: trafficHeaders(sandbox),
      timeout: cfg.connectTimeoutMs,
    });
    const persistentContext = browser.contexts()[0] || await browser.newContext();
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
  if (!entry || entry.pauseTimer) return;
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
  isEnabled, backendName, acquire, release, pauseNow, destroyForUser, viewTarget, userTag,
  CDP_PORT, VIEW_PORT,
  _setSdk(fake) { sdk = fake; },
  _setEndpoint(fn) { endpointFor = fn; },
  _entries: entries,
};

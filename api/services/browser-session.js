'use strict';
// Browser process and session ownership: launches Chromium, hands out sessions keyed by user,
// closes them again. No task knowledge of any kind — the browser is an environment the agent
// acts in, not a resource owned by one loop. browser-environment.js sits on top of this.

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { randomUUID } = require('node:crypto');

chromium.use(stealth);

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const VIEWPORT = {
  width: envInt('OXY_BROWSER_VIEWPORT_W', 1280),
  height: envInt('OXY_BROWSER_VIEWPORT_H', 800)
};

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); })
  ]);
}

// ── Chromium process ────────────────────────────────────────────────────────────────────

function directChildPids(parentPid) {
  try {
    const out = require('child_process').execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean).map(Number));
  } catch {
    try {
      const fs = require('fs');
      const pids = new Set();
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
          const ppid = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[1];
          if (Number(ppid) === parentPid) pids.add(Number(entry));
        } catch { /* process gone between readdir and read, skip */ }
      }
      return pids;
    } catch {
      return new Set(); // no /proc (non-Linux, no pgrep) — backstop below becomes a no-op
    }
  }
}

// --no-sandbox: the setuid sandbox can't initialise as root in the Fly container.
// --disable-dev-shm-usage: the container gives /dev/shm ~64MB and Chromium stalls when it fills.
const CHROMIUM_LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
const BROWSER_LAUNCH_TIMEOUT_MS = envInt('OXY_BROWSER_LAUNCH_TIMEOUT_MS', 45000);
const BROWSER_CLOSE_TIMEOUT_MS = 5000;

async function launchLocalBrowser() {
  const before = directChildPids(process.pid);
  const browser = await chromium.launch({
    headless: process.env.BROWSER_HEADLESS !== 'false',
    args: CHROMIUM_LAUNCH_ARGS,
    timeout: BROWSER_LAUNCH_TIMEOUT_MS,
  });
  // This Playwright build doesn't expose browser.process() on a locally launched browser, so
  // stash the OS PID from the before/after child diff for the force-kill in closeSession.
  const after = directChildPids(process.pid);
  const newPid = [...after].find((pid) => !before.has(pid));
  if (newPid) browser._oxyChildPid = newPid;
  return browser;
}

// Warm pool: a cold Chromium launch is ~4s, paid on the first step of a turn inside the
// client's watchdog. Keep one spare launched so a turn grabs it instantly.
const WARM_POOL_ENABLED = process.env.OXY_BROWSER_WARM_POOL !== 'false';
let warmSpare = null;
let warmingPromise = null;

function primeWarmBrowser() {
  if (!WARM_POOL_ENABLED || warmSpare || warmingPromise) return;
  warmingPromise = launchLocalBrowser()
    .then((b) => { warmSpare = b; })
    .catch((err) => { console.warn('[browser-session] warm launch failed:', err.message); })
    .finally(() => { warmingPromise = null; });
}

async function getWarmBrowser() {
  if (WARM_POOL_ENABLED && warmSpare) {
    const spare = warmSpare;
    warmSpare = null;
    if (spare.isConnected()) {
      primeWarmBrowser();
      return spare;
    }
    spare.close().catch(() => {});
  }
  const browser = await launchLocalBrowser();
  primeWarmBrowser();
  return browser;
}

async function acquireBrowser() {
  return { browser: await getWarmBrowser() };
}

// A one-shot script has no "next turn" to claim the spare, so its process would hang open
// holding a live browser. Standalone runners must call this after their last closeSession().
async function closeWarmPool() {
  if (!warmSpare) return;
  const spare = warmSpare;
  warmSpare = null;
  await spare.close().catch(() => {});
}

// ── Live sessions ───────────────────────────────────────────────────────────────────────

const SESSION_IDLE_MS = 20 * 60 * 1000;
const liveSessions = new Map();

function createSession(userId, session) {
  // credentialTaskId is the identity a task-scoped credential grant binds to. It is created
  // once per browsing RUN because the only other id in play is a fresh uuid every turn, and a
  // grant bound to one turn's id could never match the next turn's.
  const record = {
    userId,
    credentialTaskId: randomUUID(),
    ...session,
    lastActivityAt: Date.now()
  };
  liveSessions.set(userId, record);
  return record;
}

function getSession(userId) {
  const session = liveSessions.get(userId);
  if (!session) return null;
  if (Date.now() - session.lastActivityAt > SESSION_IDLE_MS) {
    liveSessions.delete(userId);
    session.browser.close().catch(() => {});
    return null;
  }
  return session;
}

function touchSession(userId) {
  const session = liveSessions.get(userId);
  if (session) session.lastActivityAt = Date.now();
}

async function closeSession(userId) {
  const session = liveSessions.get(userId);
  if (!session) return;
  liveSessions.delete(userId);
  const pid = session.browser._oxyChildPid;
  try {
    await withTimeout(session.browser.close(), BROWSER_CLOSE_TIMEOUT_MS, 'browser.close()');
  } catch (error) {
    console.warn('[browser-session] browser.close() failed:', error.message);
  }
  if (pid) {
    try {
      process.kill(pid, 0); // existence check only — throws ESRCH if already gone
      console.warn(`[browser-session] chromium pid ${pid} still alive after close(), force-killing`);
      process.kill(pid, 'SIGKILL');
    } catch { /* already exited */ }
  }
}

// Persist progress onto the WORKFLOW, not this session. The live session stays disposable:
// if it dies, reopening currentUrl and reading this back is enough to carry on.
// Best-effort — failing to checkpoint must never abort work that is otherwise fine.
async function checkpointBrowserState(session, { nextIntendedAction = null, lastObservation = null } = {}) {
  if (!session?.workflowId) return;
  try {
    const { saveBrowserState } = require('./workflows');
    await saveBrowserState(getSupabase(), session.userId, session.workflowId, {
      objective: session.goal,
      currentUrl: typeof session.page?.url === 'function' ? session.page.url() : null,
      lastObservation,
      completedActions: session.history || [],
      nextIntendedAction
    });
  } catch (err) {
    console.warn('[browser-session] could not checkpoint workflow state:', err.message);
  }
}


// ── Session persistence ─────────────────────────────────────────────────────────────────
// Cookies/localStorage plus a resume marker (last url, objective, history) so an evicted or
// crashed session can be reopened where it left off. Encrypted with the same envelope as
// connector tokens.

const runtime = require('../../runtime');
const { encryptTokens, decryptTokens } = require('./token-crypto');
const { recordUse } = require('./credential-grants');

const BROWSER_CONTEXT_LOOKUP_TIMEOUT_MS = envInt('OXY_BROWSER_CONTEXT_LOOKUP_TIMEOUT_MS', 2500);
const TIMING = process.env.OXY_BROWSER_TIMING === '1';

let supabaseClient = null;
function getSupabase() {
  if (!supabaseClient) supabaseClient = runtime.createSupabaseServiceClient();
  return supabaseClient;
}

async function timed(label, fn) {
  if (!TIMING) return fn();
  const t = Date.now();
  try { return await fn(); }
  finally { console.warn(`[timing] ${label}: ${Date.now() - t}ms`); }
}

// ponytail: site key keeps cookies/login isolated per domain per user. One row
// per (user, site) — fine at personal-assistant scale, revisit if sites multiply.
async function loadStorageState(userId, site) {
  try {
    const { data } = await withTimeout(getSupabase()
      .from('browser_sessions')
      .select('storage_state')
      .eq('user_id', userId)
      .eq('site', site)
      .maybeSingle(), BROWSER_CONTEXT_LOOKUP_TIMEOUT_MS, 'browser session load');
    if (!data?.storage_state) return undefined;
    // Cookies/localStorage are bearer credentials — often stronger than a password, since a
    // live session cookie skips login and 2FA entirely. decryptTokens transparently passes
    // through any pre-existing plaintext row (isEncryptedTokenEnvelope check), so this reads
    // both old and newly-encrypted rows with no migration needed.
    const decrypted = decryptTokens(data.storage_state);

    // A session the user handed over from their own browser expires on its own. Past that
    // point it is ignored rather than deleted, so the row stays visible in their session
    // list as something that lapsed instead of vanishing without explanation.
    const imported = decrypted?.[IMPORT_STATE_KEY];
    if (imported?.expires_at && Date.parse(imported.expires_at) <= Date.now()) {
      await recordUse(getSupabase(), userId, {
        site, taskId: null, outcome: 'denied', reason: 'imported_session_expired'
      }).catch(() => {});
      return undefined;
    }

    return unpackBrowserStorageState(decrypted);
  } catch {
    return undefined;
  }
}

function siteKeyFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return 'unknown'; }
}

// A retailer can leave the document usable while never completing DOMContentLoaded (John
// Lewis does this intermittently on a persisted PDP). Playwright reports that as a timeout,
// but throwing it away loses the exact cart/page we just checkpointed. Continue only when a
// real document arrived; a genuine blank navigation still fails normally.
async function gotoBrowserPage(page, openUrl) {
  try {
    await timed('open.goto', () => page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }));
  } catch (error) {
    if (!/timeout/i.test(String(error?.message || ''))) throw error;
    const currentUrl = page.url();
    const bodyLength = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);
    if (!currentUrl || currentUrl === 'about:blank' || bodyLength === 0) throw error;
    console.warn(`[browser-task] page navigation timed out with a usable document; continuing (${bodyLength} chars)`);
  }
}

// The first browser_sessions migration only has storage_state. Keep the resume marker inside
// that JSONB value so a deploy cannot silently depend on a separate migration having already
// been applied. It is encrypted together with cookies/localStorage in production.
const RESUME_STATE_KEY = '__oxy_resume';

// An imported session came from the user's own browser rather than from a sign-in Oxy
// performed. It carries its own expiry so the one credential Oxy never earned cannot also
// be the one that never ages out. Stored in the same JSONB value for the same reason as
// the resume marker: no separate migration to depend on.
const IMPORT_STATE_KEY = '__oxy_import';

function packBrowserStorageState(browserState, session) {
  return {
    ...browserState,
    [RESUME_STATE_KEY]: {
      last_url: session.page.url(),
      goal: session.goal,
      history: Array.isArray(session.history) ? session.history : [],
      site: session.site,
    }
  };
}

function unpackBrowserStorageState(storedState) {
  if (!storedState || typeof storedState !== 'object') return storedState;
  const { [RESUME_STATE_KEY]: _resume, [IMPORT_STATE_KEY]: _import, ...browserState } = storedState;
  return browserState;
}

function resumeFromBrowserStorage(storedState, fallbackSite) {
  if (!storedState || typeof storedState !== 'object') return null;
  const resume = storedState[RESUME_STATE_KEY];
  if (!resume?.last_url || !resume?.goal) return null;
  return { ...resume, site: resume.site || fallbackSite };
}

// Best-effort: save cookies/localStorage AND the resumable context (last url, goal,
// history) so an idle-evicted or accidentally-closed session can be re-opened where it
// left off instead of dead-ending. Failing to persist must never abort an in-progress order.
const BROWSER_PERSIST_TIMEOUT_MS = envInt('OXY_BROWSER_PERSIST_TIMEOUT_MS', 2500);

async function persistStorage(userId, session) {
  try {
    return await withTimeout((async () => {
      const browserState = await session.context.storageState();
      const { error } = await getSupabase().from('browser_sessions').upsert({
        user_id: userId,
        site: session.site,
        // Same AES-256-GCM envelope already used for connector tokens and vault_credentials
        // (token-crypto.js) — these are just as sensitive and were the one place still storing
        // plaintext. Fails closed in production if OXY_TOKEN_ENCRYPTION_KEY is unset, same as
        // the rest of the app's credential storage.
        storage_state: encryptTokens(packBrowserStorageState(browserState, session)),
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,site' });
      if (error) throw error;
      return true;
    })(), BROWSER_PERSIST_TIMEOUT_MS, 'browser session checkpoint');
  } catch (error) {
    // swallow — persistence is non-critical to the current turn, but leave a bounded
    // diagnostic so a missing live migration/schema cannot masquerade as a routing bug.
    console.warn(`[browser-task] browser session checkpoint failed for ${session.site}: ${error.message}`);
    return false;
  }
}

// Most-recent persisted session for the user, so a resume with no live session and no
// url can re-open the browser at the last page (cookies + cart survive via storageState).
async function loadResumeContext(userId) {
  try {
    const { data } = await withTimeout(getSupabase()
      .from('browser_sessions')
      .select('storage_state, site')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(), BROWSER_CONTEXT_LOOKUP_TIMEOUT_MS, 'browser resume load');
    if (!data?.storage_state) return null;
    return resumeFromBrowserStorage(decryptTokens(data.storage_state), data.site);
  } catch {
    return null;
  }
}

async function hasResumableSession(userId) {
  const resume = await loadResumeContext(userId).catch(() => null);
  return Boolean(resume?.last_url && resume?.goal);
}

module.exports = {
  VIEWPORT,
  envInt,
  withTimeout,
  acquireBrowser,
  getWarmBrowser,
  primeWarmBrowser,
  closeWarmPool,
  launchLocalBrowser,
  createSession,
  getSession,
  touchSession,
  closeSession,
  checkpointBrowserState,
  loadStorageState,
  persistStorage,
  loadResumeContext,
  hasResumableSession,
  siteKeyFromUrl,
  gotoBrowserPage,
  packBrowserStorageState,
  unpackBrowserStorageState,
  resumeFromBrowserStorage,
  RESUME_STATE_KEY,
  IMPORT_STATE_KEY,
  getSupabase,
  timed,
  _liveSessions: liveSessions,
};

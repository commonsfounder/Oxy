const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { createSupabaseServiceClient, createGeminiServiceClient } = require('../../runtime');
const { learnTemplateFromUrl, createFastpathStore } = require('./browser-fastpaths');
const { nextRecipeMove, selectRecipeForHost, recipeHealth, isJohnLewisExpressOnlyPdp, johnLewisSizeQueryValue, parseSizeFromGoal, RECIPES } = require('./browser-recipes');
const { resolveRetailerFromGoal, resolveSearchSite, buildSearchSites, isDeliveryHost } = require('./retailer-sites');
const { extractPrice, extractProductName, extractFirstProductUrl, extractVisibleDeals } = require('./browser-price-parser');
const { parseGoalContext } = require('./browser-goal-context');
const {
  classifyCheckoutAsk,
  findEmailInputElement,
  matchProfileFieldForInput,
  parseEmailFromUserText,
  parseCheckoutReplyFromUserText,
  wantsSaveDetailsConsent,
  buildEmailAskWithConsent,
  buildDetailsAskWithConsent,
  loadCheckoutProfile,
  saveCheckoutProfile,
  saveCheckoutEmail,
} = require('./checkout-profile');
const axios = require('axios');
// Whole-layer kill-switch: OXY_BROWSER_RECIPES=false → the loop is exactly today's all-vision path.
const RECIPES_ENABLED = process.env.OXY_BROWSER_RECIPES !== 'false';

chromium.use(stealth);

// Driving a real browser from a screenshot is a vision+reasoning task, not a cheap
// helper call — the flash-lite tier hallucinated out-of-range element ids on cluttered
// commercial pages (john lewis etc.) and the loop had no way to recover. Default this
// loop to the primary reasoning model; OXY_BROWSER_MODEL overrides if you want to A/B.
const BROWSER_MODEL = process.env.OXY_BROWSER_MODEL || process.env.OXY_REASONING_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

// For cheap/fast providers (Groq, Together, Fireworks, OpenRouter etc.) you can set:
// OXY_BROWSER_PROVIDER=openai-compatible
// OXY_BROWSER_BASE_URL=https://api.groq.com/openai/v1
// OXY_BROWSER_API_KEY=...
// Then set OXY_BROWSER_MODEL to a vision model they host (e.g. llama-4-scout or meta-llama/llama-4-maverick-17b-128e-instruct)
// Each turn must finish well within the mobile client's ~45s request watchdog, or the
// app reports "stuck waiting on the network" while the server is still working. Keep
// turns short; if the order isn't done, return awaiting_more and the next message
// (routed back in by the deterministic-resume path) continues it.
//
// This budget covers the WHOLE turn, including opening a brand-new browser session
// (launch + page load + hydration) on the first call — not just the step loop — or a
// slow first open alone could already exceed the 45s watchdog before a single step runs.
const MAX_STEPS = 20;
// Whole-turn budget, must stay under the mobile client's ~45s request watchdog. Raised
// from 18s now that steps are cheap (see settle() below) — the old 18s + a 2.5s-per-step
// networkidle wait left room for only ~1 real action per turn.
const MAX_DURATION_MS = 30 * 1000;

// --- Latency knobs (see docs/superpowers/specs/2026-07-01-browser-task-latency-design.md) ---
// ~70% of each step is the Gemini vision call, so the screenshot we send dominates cost.
// A smaller viewport + JPEG (not PNG) shrinks the upload and the pixels the model must read,
// cutting per-step latency. All env-tunable so a regression is a config flip, not a redeploy.
const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
};
const VIEWPORT = { width: envInt('OXY_BROWSER_VIEWPORT_W', 1280), height: envInt('OXY_BROWSER_VIEWPORT_H', 800) };
const SCREENSHOT_QUALITY = envInt('OXY_BROWSER_SCREENSHOT_QUALITY', 30);

// Per-phase timing for latency work: set OXY_BROWSER_TIMING=1 to log how long each phase
// (goto, settle, extract, screenshot, model decide, action) takes to stderr. No-op otherwise.
const TIMING = process.env.OXY_BROWSER_TIMING === '1';
async function timed(label, fn) {
  if (!TIMING) return fn();
  const t = Date.now();
  try { return await fn(); }
  finally { console.warn(`[timing] ${label}: ${Date.now() - t}ms`); }
}
// Fewer numbered badges = a cleaner image and a shorter element list (fewer input tokens).
const MAX_ELEMENTS = envInt('OXY_BROWSER_MAX_ELEMENTS', 60);
// The loop model is a *thinking* model; thinking is what recovers from hallucinated element
// ids, but it's also the bulk of model latency. Cap it low (not off) and tune via E2E.
// OXY_BROWSER_THINKING_BUDGET=-1 drops the field entirely if a model version rejects it.
const BROWSER_THINKING_BUDGET = envInt('OXY_BROWSER_THINKING_BUDGET', 64);
// Fixed hydration beats. goto already waits for domcontentloaded (~2s), so by the time these
// run the DOM is parsed — the beat is just insurance against a not-yet-painted SPA shell.
// Trimmed from 1500/400/600 (which were a third of a fast turn spent waiting); the model's
// "wait" action is the safety net if a page genuinely isn't ready. Tunable per-env if a slow
// site needs more.
const OPEN_HYDRATE_MS = envInt('OXY_BROWSER_OPEN_HYDRATE_MS', 150);
const OPEN_POST_CONSENT_MS = envInt('OXY_BROWSER_OPEN_POST_CONSENT_MS', 100);
const STEP_SETTLE_MS = envInt('OXY_BROWSER_STEP_SETTLE_MS', 80);
// Recipe-driven steps chain quickly — a shorter beat between them saves ~0.5–1s per step vs the
// full vision-path settle without risking the old networkidle trap.
const RECIPE_SETTLE_MS = envInt('OXY_BROWSER_RECIPE_SETTLE_MS', 50);
function browserThinkingConfig() {
  return BROWSER_THINKING_BUDGET >= 0 ? { thinkingConfig: { thinkingBudget: BROWSER_THINKING_BUDGET } } : {};
}

let geminiClient = null;
function getGemini() {
  if (!geminiClient) geminiClient = createGeminiServiceClient();
  return geminiClient;
}

let supabaseClient = null;
function getSupabase() {
  if (!supabaseClient) supabaseClient = createSupabaseServiceClient();
  return supabaseClient;
}

// Self-learning fast-path store. loadRows/saveRow are Supabase-backed but best-effort — a DB
// hiccup never blocks a turn. Only LEARNED hosts live here; curated SEARCH_SITES stay in code.
const fastpathStore = createFastpathStore({
  loadRows: async () => {
    const { data } = await getSupabase().from('browser_fastpaths').select('host,url_template,param,fail_count');
    return data || [];
  },
  saveRow: async (row) => {
    await getSupabase().from('browser_fastpaths').upsert(
      { ...row, last_ok_at: row.fail_count === 0 ? new Date().toISOString() : undefined, updated_at: new Date().toISOString() },
      { onConflict: 'host' }
    );
  }
});

// Load the learned fast-paths into memory (call on server boot, alongside primeWarmBrowser).
async function primeFastpaths() { await fastpathStore.load(); }

// ponytail: site key keeps cookies/login isolated per domain per user. One row
// per (user, site) — fine at personal-assistant scale, revisit if sites multiply.
async function loadStorageState(userId, site) {
  const { data } = await getSupabase()
    .from('browser_sessions')
    .select('storage_state')
    .eq('user_id', userId)
    .eq('site', site)
    .maybeSingle();
  return data?.storage_state || undefined;
}

function siteKeyFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return 'unknown'; }
}

// --- Local vs managed (remote) browser --------------------------------------------------
// Local stealth Chromium is FREE but runs on this box's IP — a datacenter IP on Cloud Run,
// which anti-bot walls (Cloudflare/PerimeterX/"Access Denied") block on ~a third of sites
// (Next, H&M, Argos, Nike, Just Eat in the reliability benchmark). A managed scraping browser
// (Bright Data, Browserbase, …) routes through residential IPs + real fingerprints and clears
// those walls — but it's METERED ($/GB or $/browser-hour), so we do NOT want every task on it.
//
// Cost control: route ONLY the hosts that actually need residential through the managed
// browser; keep the ~two-thirds that work on datacenter IP on the free local pool. Which
// hosts are "remote" is a pure, testable decision (shouldUseRemoteForHost) driven by env.
function usingRemoteBrowser() {
  return Boolean(process.env.BROWSERBASE_API_KEY || process.env.BROWSER_REMOTE_ENDPOINT);
}

// Empirically bot-walled on a datacenter IP (from test/dev/reliability-benchmark.js — these
// are the sites that returned Access-Denied/Cloudflare, NOT my a-priori guesses: Tesco and
// Zara actually pass on datacenter IP, so they're deliberately absent). Bare hosts, no www.
// Override wholesale with BROWSER_REMOTE_HOSTS; force everything remote with BROWSER_REMOTE_ALWAYS=true.
const DEFAULT_REMOTE_HOSTS = ['next.co.uk', 'hm.com', 'asos.com', 'nike.com', 'argos.co.uk', 'just-eat.co.uk', 'deliveroo.co.uk', 'sainsburys.co.uk', 'boots.com'];

// Pure so it's unit-testable. Decide whether a given host should use the managed browser:
//  - no endpoint configured                 → never (free local, today's behaviour)
//  - BROWSER_REMOTE_ALWAYS=true              → always
//  - BROWSER_REMOTE_HOSTS set                → only those hosts (comma list)
//  - else                                    → the empirical bot-wall default set
// Matches the host itself or any subdomain of it (h === entry || h endsWith '.'+entry).
function shouldUseRemoteForHost(host, env = process.env) {
  if (!env.BROWSERBASE_API_KEY && !env.BROWSER_REMOTE_ENDPOINT) return false;
  if (String(env.BROWSER_REMOTE_ALWAYS).toLowerCase() === 'true') return true;
  const list = env.BROWSER_REMOTE_HOSTS
    ? env.BROWSER_REMOTE_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_REMOTE_HOSTS;
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  return list.some((entry) => h === entry || h.endsWith('.' + entry));
}

// Always launches a LOCAL stealth Chromium (the warm pool + the non-remote path). Never
// touches the managed endpoint — remote is a separate, per-host connect (connectRemoteBrowser).
async function launchLocalBrowser() {
  // ponytail: headless:true in prod; BROWSER_HEADLESS=false lets a local debug run pop
  // a real window so you can watch the loop click around, instead of trusting logs.
  return chromium.launch({ headless: process.env.BROWSER_HEADLESS !== 'false' });
}

// Connect to the managed scraping browser over CDP. Bounded — a wrong/down endpoint must
// fail fast so acquireBrowser can fall back to local instead of hanging the whole turn.
// BrowserBase (preferred): POST /sessions → get a per-session connectUrl → connectOverCDP.
// BROWSER_REMOTE_ENDPOINT (fallback): static WSS endpoint, e.g. a self-hosted Bright Data proxy.
const REMOTE_CONNECT_TIMEOUT_MS = envInt('OXY_BROWSER_REMOTE_CONNECT_TIMEOUT_MS', 15000);
async function connectRemoteBrowser() {
  if (process.env.BROWSERBASE_API_KEY) {
    const res = await fetch('https://api.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'x-bb-api-key': process.env.BROWSERBASE_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`BrowserBase session create failed: ${res.status} ${await res.text()}`);
    const { connectUrl } = await res.json();
    return withTimeout(chromium.connectOverCDP(connectUrl), REMOTE_CONNECT_TIMEOUT_MS, 'browserbase connect');
  }
  return withTimeout(
    chromium.connectOverCDP(process.env.BROWSER_REMOTE_ENDPOINT),
    REMOTE_CONNECT_TIMEOUT_MS,
    'remote browser connect',
  );
}

// Get a browser for a specific host: the managed one when the host needs residential (and an
// endpoint is configured), otherwise the free local warm pool. A remote connect failure
// degrades to local — a bot-walled host will then fail as it does today, which is strictly
// better than hanging on a dead endpoint. Returns { browser, remote } so the caller knows
// whether to expect a metered session (and skips the warm-pool return path for it).
async function acquireBrowser(host) {
  if (shouldUseRemoteForHost(host)) {
    try {
      return { browser: await connectRemoteBrowser(), remote: true };
    } catch (err) {
      console.warn(`[browser-task] managed browser connect failed for ${host}, falling back to local:`, err.message);
    }
  }
  return { browser: await getWarmBrowser(), remote: false };
}

// Warm browser pool: launching Chromium cold is ~4s — paid on the FIRST step of a turn,
// inside the mobile client's 45s watchdog. Keep one spare browser already launched so a
// turn grabs it instantly, then relaunch a replacement in the background for next time.
// One spare is enough at personal-assistant concurrency (one user, mostly one task at a
// time); if a second turn lands while the spare is in use it just launches cold as before.
// Keep the local warm pool alive even when a managed endpoint is configured — selective
// routing still sends the ~two-thirds of (non-walled) hosts through local, so they still
// benefit from the warm spare. Only BROWSER_REMOTE_ALWAYS (everything remote) disables it.
const WARM_POOL_ENABLED = process.env.OXY_BROWSER_WARM_POOL !== 'false' &&
  String(process.env.BROWSER_REMOTE_ALWAYS).toLowerCase() !== 'true';
let warmSpare = null;      // a launched, idle Browser waiting to be claimed
let warmingPromise = null; // in-flight launch, so we never start two at once

function primeWarmBrowser() {
  if (!WARM_POOL_ENABLED || warmSpare || warmingPromise) return;
  warmingPromise = launchLocalBrowser()
    .then((b) => { warmSpare = b; })
    .catch((err) => { console.warn('[browser-task] warm launch failed:', err.message); })
    .finally(() => { warmingPromise = null; });
}

// Hand out a ready browser. Prefer the spare (instant) after a liveness check, and kick
// off priming the next one so the following turn is fast too. Falls back to a synchronous
// cold launch when no healthy spare is ready (warming, disabled, or remote endpoint).
async function getWarmBrowser() {
  if (WARM_POOL_ENABLED && warmSpare) {
    const spare = warmSpare;
    warmSpare = null;
    if (spare.isConnected()) {
      primeWarmBrowser(); // replace the one we just took
      return spare;
    }
    // Spare died while idle (crash, OS reaped it) — drop it and fall through to a fresh launch.
    spare.close().catch(() => {});
  }
  const browser = await launchLocalBrowser();
  primeWarmBrowser(); // nothing was warm; warm one for next time
  return browser;
}

// Live session store with idle eviction
const SESSION_IDLE_MS = 20 * 60 * 1000;
const liveSessions = new Map();

function createSession(userId, session) {
  const record = { ...session, lastActivityAt: Date.now() };
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
  await session.browser.close().catch(() => {});
}

// Deterministic backstop: any element whose text matches this is treated as a
// payment/finalize control and is NEVER auto-clicked — the loop pauses for explicit
// user confirmation instead. Tuned to over-match: a false positive merely over-pauses,
// a false negative is an unconfirmed charge. \bpay\b / \bbuy\b cover "pay now",
// "pay £9.50 now", "slide to pay", "confirm and pay", "buy now", etc.
const PAYMENT_KEYWORD_PATTERN = /\bpay\b|\bbuy\b|place\s+(your\s+)?order|order\s+now|complete\s+(your\s+)?(order|purchase|payment)|confirm\s+(your\s+)?(purchase|order|payment)|submit\s+(order|payment)|checkout\s*(and|&)?\s*pay|proceed\s+to\s+payment|continue\s+to\s+payment|go\s+to\s+payment|payment\s+method|pay\s+with\s+card|pay\s+securely|slide\s+to\s+pay/i;

function matchesPaymentKeyword(text) {
  return PAYMENT_KEYWORD_PATTERN.test(String(text || ''));
}

function isCheckoutPaymentUrl(url) {
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.hash}`;
    return /\/(?:payment|pay|billing|order\/pay)\b/i.test(p)
      || /checkout\/(?:payment|pay|billing|order-payment)/i.test(p)
      || /\/hybrid\/payment/i.test(p)
      || /\/checkout\/[^/]*payment/i.test(p)
      || /#\/(?:payment|pay|billing)/i.test(p)
      || /\/(?:delivery|shipping|review)(?:\/|$)/i.test(p) && /checkout/i.test(u.hostname);
  } catch {
    return false;
  }
}

const AUTO_NAV_BASKET_SITES = new Set(['asos.com', 'currys.co.uk', 'marksandspencer.com', 'nike.com', 'screwfix.com']);
const ADD_PROBE_SITES = new Set(['johnlewis.com', 'nike.com', 'marksandspencer.com', 'asos.com', 'screwfix.com', 'currys.co.uk']);

function isRecipeAddConfirmed(session) {
  if (!session) return false;
  const site = session.site;
  if (site === 'johnlewis.com') return !!session.jlAddConfirmed;
  if (site === 'nike.com') return !!session.nikeAddConfirmed;
  if (site === 'marksandspencer.com') return !!session.msAddConfirmed;
  if (site === 'asos.com') return !!session.asosAddConfirmed;
  if (site === 'screwfix.com') return !!session.screwfixAddConfirmed;
  if (site === 'currys.co.uk') return !!session.currysAddConfirmed;
  if (site === 'waitrose.com') return !!session.waitroseAddConfirmed;
  if (!RECIPES[site] && !isDeliveryHost(site)) return !!session.convAddConfirmed;
  return false;
}

// A question we must NEVER surface to the user: a real assistant doesn't ask for a
// URL, an element id, a CSS selector, or "which platform" — those are the loop's job
// to figure out. If the model tries, we suppress it and retry instead.
const TECHNICAL_ASK_PATTERN = /\b(url|link|element\s*id|element's\s*id|selector|css|xpath|dom|html|\bid\s+of\b|which\s+(site|platform)|delivery\s+platform|search\s+bar)\b/i;

function isTechnicalAsk(question) {
  return TECHNICAL_ASK_PATTERN.test(String(question || ''));
}

// Re-auth detection. A stored login (storageState) eventually expires — the merchant
// invalidates the cookie (days/weeks, or on a new IP / 2FA challenge). When that happens
// the agent lands on a sign-in wall and, blind to it, burns its whole step budget trying
// to "order" behind the login before returning a vague "I got stuck". Detecting the wall
// lets us stop immediately and ask the user to reconnect — a clean handoff, not a flail.
const LOGIN_URL_PATTERN = /\/(login|log-?in|signin|sign-?in|auth|authenticate|account\/(login|signin))(\b|\/|\?|$)/i;
// Copy that, TOGETHER with a password field, marks a page as a login wall (not a header
// "Sign in" link on an otherwise-normal shopping page). Kept tight to avoid false pauses.
const LOGIN_COPY_PATTERN = /\b(sign in to|log in to|enter your password|incorrect password|forgot your password|keep me signed in|sign in to your account)\b/i;
// Stronger basket/checkout soft-gate (e.g. M&S "Sign in or create an account for faster checkout").
// These often appear without a visible password field until clicked — catch them for order goals.
const LOGIN_BASKET_PATTERN = /\b(sign in|log in|sign-in|log-in|create an account|register).*(?:basket|cart|checkout|to (?:continue|view|see|access)|for faster checkout)\b/i;
const PASSWORD_FIELD_SELECTOR = 'input[type="password"]';

// Pure so it's unit-testable without a live page. A wall is either (a) the URL is a login
// route, or (b) there's a real password field AND login copy on the page. A password field
// alone (inline "create account" upsell) or login copy alone (a "Sign in" nav link) is not
// enough — both together, or a login URL, are.
// Also (c) a strong "sign in to see basket/checkout" soft gate (no pw field yet) — helps M&S etc.
function looksLikeLoginWall({ url, bodyText, hasPasswordField, goal } = {}) {
  const u = String(url || '');
  if (LOGIN_URL_PATTERN.test(u)) return true;
  const bt = String(bodyText || '');
  if (hasPasswordField && LOGIN_COPY_PATTERN.test(bt)) return true;
  if (LOGIN_BASKET_PATTERN.test(bt)) return true;
  return false;
}

// Anti-automation interstitials: a datacenter IP (Cloud Run) trips these on many sites.
// The page LOADS with real bytes — so the empty-shell size guard misses it — but every real
// control is replaced by an "Access Denied" / Cloudflare / "verify you're human" challenge.
// Left undetected, the loop clicks around the dead page for its whole step budget, returns
// awaiting_more, and the client AUTO-CONTINUES — a bot-walled Just Eat ran 6 turns / ~13min
// before this landed. Detecting the copy lets us bail on the first step that shows it.
const BLOCK_WALL_PATTERN = /access denied|you (?:don'?t|do not) have permission to access|unusual traffic|verify (?:you(?:'?re| are)|that you are) (?:a )?human|are you a human|checking your browser before|pardon our interruption|press (?:&|and) hold to|enable javascript and cookies to continue|request (?:has been )?blocked|bot(?:s)? (?:detected|protection)|automated access|disable any browser extensions|hcaptcha|recaptcha challenge|cf-challenge/i;

// Pure so it's unit-testable. A wall page is SMALL (a challenge, not a shop) AND contains the
// copy — gating on length keeps a normal 5k-char product page that merely mentions "captcha"
// in a footer link from tripping it. bodyLen is the FULL innerText length; text is a prefix.
function looksLikeBlockWall({ text, bodyLen } = {}) {
  if (!text) return false;
  if (Number.isFinite(bodyLen) && bodyLen > 1500) return false; // a real page, not a wall
  return BLOCK_WALL_PATTERN.test(String(text));
}

// Live probe: one short innerText read. Best-effort — a failed read degrades to "not a wall".
async function detectBlockWall(page) {
  try {
    const { text, bodyLen, dialogText } = await page.evaluate(() => {
      const it = document.body?.innerText || '';
      // A wall can also be a DIALOG over an otherwise-fine page (Nike's "disable any browser
      // extensions" add-to-cart rejection) — the page behind keeps bodyLen over the length
      // gate, so the biggest visible dialog gets probed with its own length.
      let dialogText = '';
      for (const d of document.querySelectorAll('[role="dialog"],[aria-modal="true"]')) {
        const s = getComputedStyle(d);
        const r = d.getBoundingClientRect();
        if (s.visibility === 'hidden' || s.display === 'none' || !r.width || !r.height) continue;
        const t = (d.innerText || '').trim();
        if (t.length > dialogText.length) dialogText = t.slice(0, 1500);
      }
      return { text: it.slice(0, 1500), bodyLen: it.length, dialogText };
    });
    return looksLikeBlockWall({ text, bodyLen })
      || (dialogText ? looksLikeBlockWall({ text: dialogText, bodyLen: dialogText.length }) : false);
  } catch {
    return false;
  }
}

// A genuine login wall sometimes still offers a guest path right there — M&S's CIAM login
// page ("Sign in" + a separate "Guest Checkout" link) and Wickes' checkout "login-or-guest"
// page both do. Clicking past it avoids asking the human to sign in for an order that never
// needed an account — most one-off shopping tasks don't care about having a Toolstation
// login. Pure so it's unit-testable; the live wrapper reuses the loop's already-extracted
// clickable elements (same locatorIndex space the loop's own clicks use).
const GUEST_CHECKOUT_PATTERN = /\b(guest checkout|continue as (?:a )?guest|checkout as (?:a )?guest|continue without (?:an )?account|shop as (?:a )?guest|guest order|order as (?:a )?guest|pay as (?:a )?guest|checkout without (?:signing in|an account)|continue without signing in|continue without logging in|shop without an account|skip sign[- ]?in|checkout without registering|order without (?:an )?account)\b/i;
const GUEST_FORK_URL_PATTERN = /login-or-guest|guest[-_]checkout|checkout\/guest|\/ciam\/|checkout\/login|checkout\/signin/i;
const CHECKOUTISH_URL_PATTERN = /\/(?:checkout|basket|cart|bag|trolley|order)(?:\/|$|\?)/i;

function isGuestCheckoutUrl(url) {
  const u = String(url || '');
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return GUEST_FORK_URL_PATTERN.test(parsed.pathname) || GUEST_FORK_URL_PATTERN.test(parsed.hostname);
  } catch {
    return GUEST_FORK_URL_PATTERN.test(u);
  }
}

function findGuestCheckoutElement(elements) {
  return (elements || []).find((el) => GUEST_CHECKOUT_PATTERN.test(String(el.text || ''))) || null;
}

function isCheckoutishUrl(url) {
  try {
    const u = new URL(url);
    return CHECKOUTISH_URL_PATTERN.test(u.pathname) || GUEST_FORK_URL_PATTERN.test(u.pathname)
      || /^checkout\./i.test(u.hostname);
  } catch {
    return CHECKOUTISH_URL_PATTERN.test(String(url || '')) || GUEST_FORK_URL_PATTERN.test(String(url || ''));
  }
}

// Vision clicks that waste steps on nav promos, widgets, or post-cart re-search.
function shouldSuppressVisionClick(session, text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\b(careers at|about us|investor relations|press office|cookie settings|help centre)\b/i.test(t)) return true;
  if (/\boffer\b/i.test(t) && t.length <= 24 && !session?.cartEverNonzero) return true;
  if (/\b(find your fit assistant|fit assistant)\b/i.test(t)) return true;
  if (!session?.cartEverNonzero && /\b(power tools|drills|screws|nails|lighting|bathrooms|kitchens|painting|tiling)\b/i.test(t) && t.length < 40) return true;
  if (/\bno items in basket\b/i.test(t)) return true;
  if (/\bclose widget\b/i.test(t)) {
    session._widgetCloseHits = (session._widgetCloseHits || 0) + 1;
    if (session._widgetCloseHits > 2) return true;
  }
  if (session?.cartEverNonzero && /\bsearch products?\b/i.test(t)) return true;
  return false;
}

// DOM-based guest click — does not rely on extractClickableElements (Wickes login-or-guest
// often yields only 2–3 extracted nodes while the guest CTA is still in the DOM).
async function tryGuestCheckoutClick(page, session, steps, onProgress) {
  if (session.guestCheckoutDone) return false;
  if (await isGuestEmailSubmitStep(page)) return false;
  const hit = await page.evaluate((sel, patSource, patFlags) => {
    const pat = new RegExp(patSource, patFlags);
    const all = [...document.querySelectorAll(sel)];
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const el of all) {
      const t = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim();
      if (!pat.test(t)) continue;
      if (!visible(el)) continue;
      const node = el.closest(sel) || el;
      const idx = all.indexOf(node);
      if (idx >= 0) return { idx, text: t.replace(/\s+/g, ' ').slice(0, 80) };
    }
    return null;
  }, CLICKABLE_SELECTOR, GUEST_CHECKOUT_PATTERN.source, GUEST_CHECKOUT_PATTERN.flags).catch(() => null);
  if (!hit) return false;
  const locator = await page.evaluateHandle(
    ({ selector, idx }) => document.querySelectorAll(selector)[idx] || null,
    { selector: CLICKABLE_SELECTOR, idx: hit.idx }
  ).then((h) => h.asElement()).catch(() => null);
  if (!locator) return false;
  onProgress(`Clicking "${hit.text}"…`);
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await locator.click({ timeout: 10000, force: true }).catch(() => false);
  session.guestCheckoutDone = true;
  session.checkoutEmailFilled = false;
  session.checkoutEmailSubmitted = false;
  session.history.push(`Step ${steps}: clicked "${hit.text}" (skipped sign-in — guest checkout available)`);
  session.lastWasRecipe = true;
  return true;
}

// Live-page wrapper: gather the signals looksLikeLoginWall needs. Best-effort — any probe
// failure degrades to "not a wall" so a flaky read never blocks a legitimate order.
async function pageHasGuestCheckoutCta(page) {
  return page.evaluate((sel, patSource, patFlags) => {
    const pat = new RegExp(patSource, patFlags);
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return [...document.querySelectorAll(sel)].some((el) => {
      const t = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim();
      return visible(el) && pat.test(t);
    });
  }, CLICKABLE_SELECTOR, GUEST_CHECKOUT_PATTERN.source, GUEST_CHECKOUT_PATTERN.flags).catch(() => false);
}

async function detectLoginWall(page, goal) {
  try {
    const url = page.url();
    if (await pageHasGuestCheckoutCta(page)) return false;
    // Fast path: a login URL needs no DOM read at all.
    if (LOGIN_URL_PATTERN.test(url) || isGuestCheckoutUrl(url)) return true;
    const hasPasswordField = await page.locator(PASSWORD_FIELD_SELECTOR).first().isVisible().catch(() => false);
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '').catch(() => '');
    // Check basket soft-gate even if no pw field visible yet (M&S etc show "sign in to continue to basket/checkout")
    if (!hasPasswordField && !LOGIN_BASKET_PATTERN.test(bodyText)) {
      return false;
    }
    if (GUEST_CHECKOUT_PATTERN.test(bodyText)) return false;
    return looksLikeLoginWall({ url, bodyText, hasPasswordField, goal });
  } catch {
    return false;
  }
}

// Goals that mean "place an order" — for these, "done" is ALWAYS premature inside the
// loop: a real order only completes through ready_for_payment → confirmPayment, so an
// early "done" (e.g. right after setting the address) must not close the browser.
const ORDER_GOAL_PATTERN = /\b(order|deliver(?:y|ed)?|buy|cart|basket|checkout|food|eats|pizza|meal|grocer|takeaway|takeout)\b/i;

function isOrderGoal(goal) {
  return ORDER_GOAL_PATTERN.test(String(goal || ''));
}

// A model "ask" whose text is really "I've hit a bot/security wall" — Cloudflare and similar
// challenges often render in an IFRAME, so detectBlockWall's top-document innerText probe
// can't see them, but the model DOES (it's in the screenshot) and tries to ask the user how
// to proceed. Convert that to a clean bail instead of surfacing a confusing technical ask.
const SECURITY_WALL_ASK_PATTERN = /security (?:verification|check)|cloudflare|\bcaptcha\b|verify (?:you(?:'?re| are)|that you are) (?:a )?human|are you a human|access denied|blocking automated|robot check|press (?:&|and) hold/i;

function describesBlockWall(question) {
  return SECURITY_WALL_ASK_PATTERN.test(String(question || ''));
}

// Unified no-progress detector inputs. Returns { sig, stateKey, itemCount }:
//  - sig: exact fingerprint (URL + cart count + dialogs + DOM sample) — equality across steps
//    means the page is literally frozen (wait-loops, dead clicks).
//  - stateKey: coarse page identity (host+path + cart + open-dialog count + titles, NO query/
//    sample churn) — fed into a per-session seen-set so we can tell "a page we've already
//    visited" (cycling/wandering) from "a new page" (forward progress). Normal shopping flows
//    produce a NEW stateKey nearly every step; spins revisit old ones.
// Both persisted on session so they survive auto-continue turns (like lastActionSig).
// Dialog count/title are included so an item modal (Deliveroo/Uber Eats) counts as a state
// change even when the URL and main <h1> don't move.
async function computeProgressSignature(page) {
  const fallback = (u) => ({ sig: u, stateKey: u, itemCount: 0 });
  try {
    const url = page.url() || '';
    const info = await page.evaluate(() => {
      // Cart/basket item count — try common badges/counts first (cheap, no full DOM walk).
      // Broadened to catch JL [data-testid="basket-amount"], M&S etc.
      let itemCount = 0;
      const countCands = document.querySelectorAll(
        '[class*="cart-count" i],[class*="basket-count" i],[data-testid*="cart" i],[data-testid*="basket" i],[aria-label*="cart" i],[aria-label*="basket" i],.bag-count,#bag-count,[class*="items-count" i],a[href*="/basket"],a[href*="/cart"],[class*="bag" i]'
      );
      for (const el of countCands) {
        const txt = (el.textContent || el.getAttribute('aria-label') || '').replace(/[^0-9]/g, '');
        if (txt) itemCount = Math.max(itemCount, parseInt(txt, 10) || 0);
      }
      if (!itemCount && /\/(cart|basket|bag|checkout)/i.test(location.pathname)) {
        // rough fallback on cart page: count obvious item containers
        const rough = document.querySelectorAll('[class*="item" i],[data-testid*="product"],li.product,[role="listitem"]').length;
        if (rough > 0) itemCount = Math.min(99, rough);
      }
      // Page key focused on host + cartCount + main title (coarse so internal nav/category hops and rec churn
      // don't reset "no progress" counter when itemCount stays 0). Real add-to-basket will bump count and flip sig.
      const host = location.hostname.replace(/^www\./, '');
      const mainTitle = (document.querySelector('main h1, main h2, h1, [data-testid*="title"], [data-testid*="product-name"], .product-title') || {}).innerText || '';
      // Sample stable controls near content (add, sizes, titles)
      const stableNodes = document.querySelectorAll('main h1, main h2, h1, h2, main [data-testid*="add"], [data-testid*="basket"], button[aria-label*="size" i], [role="button"]');
      const sample = Array.from(stableNodes)
        .slice(0, 6)
        .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 22))
        .filter(Boolean)
        .join('|')
        .slice(0, 100);
      // Open dialogs flip the state: an item-options modal is real progress even when the
      // URL/main title stay put, and closing it back to a seen page is a revisit.
      const dialogEls = document.querySelectorAll('[role="dialog"],[aria-modal="true"]');
      const dialogs = dialogEls.length;
      const dialogTitle = dialogs
        ? (((document.querySelector('[role="dialog"] h1, [role="dialog"] h2, [aria-modal="true"] h1, [aria-modal="true"] h2') || {}).innerText || '').trim().slice(0, 40))
        : '';
      // Product presence: loading results or PDP changes the "contentful" state even if title/path similar.
      // Helps break category/search repeat loops when actual items appear.
      const hasProducts = document.querySelectorAll('[class*="product" i], [data-testid*="product"], .item, li[class*="item"], [class*="tile" i]').length > 2 ? 1 : 0;
      return { itemCount, path: location.pathname, dialogs, dialogTitle, pageKey: host + '|c' + itemCount + '|' + mainTitle.slice(0,40) + '|p' + hasProducts, sample, hasProducts };
    }).catch(() => null);
    if (!info) return fallback(url);
    return {
      sig: `${url}|c${info.itemCount}|d${info.dialogs}|k${info.pageKey}|${info.dialogTitle}|${info.sample}`,
      stateKey: `${info.path}|d${info.dialogs}|${info.pageKey}|${info.dialogTitle}|p${info.hasProducts || 0}`,
      itemCount: info.itemCount,
    };
  } catch {
    return fallback(page && typeof page.url === 'function' ? page.url() : 'err');
  }
}

// Pure verdict over the persisted no-progress counters — exported for unit tests
// (test/smoke/browser-progress-detector.test.js pins these thresholds).
//  - stepsSinceProgress: consecutive steps with an IDENTICAL exact sig → frozen page /
//    wait-loop. Nudge at 4, stuck at 7.
//  - stepsSinceNewState: steps since we last saw a stateKey NOT already visited this
//    session → catches cycles ([click→wait×5→click back], modal open/close churn, category
//    ping-pong) WITHOUT punishing long-but-forward flows where each step is a new page.
//    Nudge at 5, stuck at 9.
//  - stepsSinceCartProgress: order-only slow backstop for "browsing forever, never adding".
//    A normal flow legitimately needs 7-12 empty-cart steps (search→results→PDP→size→add) —
//    this was the premature-STUCK bug: bailing at 7 killed M&S/Currys/Wickes/Nike/Deliveroo
//    mid-normal-browse. Now it only nudges ("commit to an item") at 8 and only hard-bails at
//    16, and is disabled once the basket has EVER been non-empty (cart badges often vanish
//    on checkout pages, which would otherwise re-arm it against a healthy flow).
function assessProgress(counters, { isOrder = false, cartEverNonzero = false } = {}) {
  // No recipe exemption: recipe steps that genuinely advance reset the counters at the
  // execution site, so a recipe site only accumulates stall when its recipe is spinning
  // (same step re-firing) or its vision steps are — both real spins that must bail.
  const { stepsSinceProgress = 0, stepsSinceNewState = 0, stepsSinceCartProgress = 0 } = counters || {};
  if (stepsSinceProgress >= 7 || stepsSinceNewState >= 9) return { verdict: 'stuck', correction: '' };
  const cartStallActive = isOrder && !cartEverNonzero;
  if (cartStallActive && stepsSinceCartProgress >= 16) return { verdict: 'stuck', correction: '' };
  if (stepsSinceProgress >= 4 || stepsSinceNewState >= 5) {
    const n = Math.max(stepsSinceProgress, stepsSinceNewState);
    // Only point at the basket/checkout once something is IN the basket — nudging an
    // empty-cart flow toward "Basket" just sends the model to an empty-basket dead end
    // (Wickes did exactly that).
    const move = cartEverNonzero
      ? 'go to the basket and proceed to checkout'
      : 'open the best matching product, select the required size/option, and press the Add to basket/bag button';
    return {
      verdict: 'nudge',
      correction: `No real progress for ${n} steps — the page is not changing, or you keep returning to pages you have already visited. Do something DIFFERENT now: ${move}.`,
    };
  }
  if (cartStallActive && stepsSinceCartProgress >= 8) {
    return {
      verdict: 'nudge',
      correction: `You have taken ${stepsSinceCartProgress} steps and the basket is still EMPTY. Stop browsing and comparing. Pick the best matching product visible right now, open it, select any required size/option, and press its Add to basket/bag button.`,
    };
  }
  return { verdict: 'ok', correction: '' };
}

function buildDecisionPrompt(goal, history, elements, correction = '', goalContext = null) {
  const historyText = history.length
    ? history.map((entry, i) => `${i + 1}. ${entry}`).join('\n')
    : '(nothing yet)';
  const elementsText = elements.map(el => `#${el.id} "${el.text}"`).join('\n');
  const lastId = elements.length ? elements.length - 1 : 0;
  const correctionBlock = correction ? `\n⚠️ CORRECTION: ${correction}\n` : '';

  let contextBlock = '';
  if (goalContext) {
    const parts = [];
    if (goalContext.size) parts.push(`size: ${goalContext.size}`);
    if (goalContext.color) parts.push(`color: ${goalContext.color}`);
    if (goalContext.budget) parts.push(`max budget: £${goalContext.budget}`);
    if (goalContext.dealHints && goalContext.dealHints.length) parts.push(`deal prefs: ${goalContext.dealHints.join(', ')}`);
    if (parts.length) contextBlock = `\nEXTRACTED CONTEXT FROM USER GOAL: ${parts.join(' | ')}\nPrioritize matching size/color and look for any coupons, codes, BOGO, sales, or deals that match the prefs. Surface them in "done" or "ask".\n`;
  }

  return `You are controlling a real web browser to help with this goal: "${goal}"
${contextBlock}${correctionBlock}
You can SEE the current page in the attached screenshot. Every clickable element has a
small numbered badge drawn on it; the number is its element id and matches the list
below. LOOK at the screenshot first — find the thing you need (search box, address
field, an item, an "Add" button) by sight, then act on it by its number. The page
text alone is unreliable; trust your eyes. If the page looks like it's still loading
(spinners, blank areas, a skeleton), choose "wait".

For shopping/ordering goals (anything with "order", "basket", "cart", "buy", "checkout", "add to"):
COMMIT IMMEDIATELY to the first reasonable match. Click the first plausible product tile, select size if shown, click the primary "Add to basket" / "Add to bag" / "Add to cart" button.
NEVER repeat search, "Men", categories, "view more", or similar links.
NEVER click the same or very similar control twice in a row unless the page visibly changed toward the cart.
If the last two steps were similar navigation without adding an item, your next action MUST be to pick and add a specific product.
After add, go straight to basket then checkout. "ready_for_payment" is the win condition.
A decent item in the basket now is infinitely better than perfect research that never adds.

If an item dialog/modal is open (size, options, quantity), FINISH it: choose the required
options, then press its Add/confirm button — usually at the bottom of the dialog; scroll
inside the dialog if you can't see it. NEVER press Close/X on a dialog for an item you
intend to order.

If you pressed Add and nothing changed, a REQUIRED option (size, colour, delivery method)
is probably unselected — select it first, then press Add again. Elements marked
"(unavailable)" are out of stock or disabled — clicking them does nothing. If the requested
size or option is unavailable, do NOT ask the user — use {"action":"back"} (with a note
saying why) to return to the results and pick a different product that matches the goal.
NEVER re-open a product you already went back from — the history notes tell you which.

CRITICAL: elementId MUST be one of the ids listed below (0 to ${lastId}). Do NOT invent a
number, and never use a price, quantity, postcode, or any number you read off the page as
an elementId — only the badge numbers in the list are valid.

EXTRACTED CONTEXT FROM USER GOAL: ${goalContext ? JSON.stringify(goalContext) : 'none'} — prioritize matching the size/color and actively look for + surface any coupons, BOGO, sales, or promo codes.

What's happened so far:
${historyText}

Numbered clickable elements on the current page:
${elementsText}

Reply with ONLY one JSON object, one of these shapes:
{"action":"click","elementId":<number>}
{"action":"fill","elementId":<number>,"value":"<text>"}
{"action":"back","note":"<why, e.g. UK 10 unavailable on this product>"}
{"action":"wait"}
{"action":"ask","question":"<short question for the user>"}
{"action":"done","summary":"<short summary answering the goal>"}
{"action":"ready_for_payment","summary":"<what's in the cart>","total":"<price as shown on the page>"}

NEVER ask the user for a URL, a link, an element id, a selector, or which website/platform
to use — that is YOUR job. STAY ON THE GOAL. DEFAULT TO ACTING. Use "ready_for_payment" when cart is ready. "done" only for pure info or after payment confirmation. Prefer fill/click. (Full original rules preserved in spirit.)`;
}

function parseModelDecision(rawText) {
  let text = String(rawText || '').trim();
  // Reasoning models don't always honour the JSON mime type — they wrap the object in
  // ```json fences or prepend prose ("Here is the JSON requested:\n{...}"). Strip fences,
  // then fall back to extracting the first balanced {...} block, before giving up.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return { action: 'invalid', error: 'Could not parse model response as JSON.' };
    }
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { action: 'invalid', error: 'Could not parse model response as JSON.' };
    }
  }
  const validActions = new Set(['click', 'fill', 'back', 'wait', 'ask', 'done', 'ready_for_payment']);
  if (!parsed || typeof parsed !== 'object' || !validActions.has(parsed.action)) {
    return { action: 'invalid', error: 'Model returned an unrecognized action.' };
  }
  return parsed;
}

function findElementByText(elements, text) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return null;
  return elements.find(el => el.text.trim().toLowerCase() === needle)
    || elements.find(el => el.text.trim().toLowerCase().includes(needle))
    || null;
}

// Include ARIA-role interactives, not just native controls: address-autocomplete
// suggestions, menu items, size/option radios etc. are often role-based divs/li that
// the loop must be able to see and click (e.g. committing a delivery address).
// `label` is here for styled radio/checkbox chips (M&S/Nike sizes: a <label> fronting a
// visually-hidden input) — extraction only keeps labels whose control is hidden, so plain
// form labels don't double every field.
const CLICKABLE_SELECTOR = 'button, a, input, textarea, label, [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="combobox"]';

async function extractClickableElements(page) {
  // One round-trip, not ~6 per element. The old per-element loop (isVisible + innerText +
  // 3 getAttribute + boundingBox, each a separate CDP call) cost ~0.8s on a 40-element page;
  // doing it all inside a single page.evaluate brings that to tens of ms. `locatorIndex` is
  // the index into querySelectorAll(CLICKABLE_SELECTOR), which matches Playwright's
  // locator(...).nth(i) order, so the downstream click/fill via .nth(locatorIndex) is unchanged.
  return page.evaluate(({ selector, max }) => {
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0; // zero-size also catches display:none ancestors
    };
    // Full-document order is what Playwright's locator(selector).nth(i) indexes, so the
    // click/fill site can re-find an element by `locatorIndex`. Keep this list as the source
    // of truth for indices even when we scope perception to a modal below.
    const allNodes = Array.from(document.querySelectorAll(selector));
    // If a modal/dialog covers the page, only its controls matter — badges drawn on the
    // elements behind it land mis-aligned and the model re-clicks the tile behind the dialog
    // (the Uber Eats "add item" modal failure). Scope to the largest visible dialog, if any.
    const vw = window.innerWidth * window.innerHeight;
    let dialog = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'))
      .filter(visible)
      .map((el) => { const r = el.getBoundingClientRect(); return { el, area: r.width * r.height }; })
      .filter((d) => d.area > vw * 0.15) // ignore small popovers/tooltips that are also role=dialog
      .sort((a, b) => b.area - a.area)[0];
    if (!dialog) {
      // Obstruction fallback: some interstitials (Nike's Klarna "click continue to proceed"
      // overlay) are plain fixed divs with no dialog role, so badges land on the inert page
      // behind them and the model can never find the Continue/close control. Ask the DOM
      // what's physically on top at the viewport centre; if its fixed ancestor blankets the
      // viewport and holds only a handful of controls (an overlay card, not an app shell),
      // scope perception to it.
      let n = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      while (n && n !== document.body && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        if (cs.position === 'fixed') {
          const r = n.getBoundingClientRect();
          if (r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.6) {
            const controls = n.querySelectorAll(selector).length;
            if (controls >= 1 && controls <= 12) dialog = { el: n, area: r.width * r.height };
          }
          break; // nearest fixed ancestor decides either way
        }
        n = n.parentElement;
      }
    }
    let scope = dialog ? Array.from(dialog.el.querySelectorAll(selector)) : allNodes;
    if (dialog && scope.length === 0) scope = allNodes; // never let scoping blind the model entirely
    // Commercial pages front-load 20-40 header/nav controls in DOM order, which used to
    // consume the whole element budget before the first product tile — the model could only
    // ever see site chrome (2026-07-02 Currys screenshots: every badge in the header, zero
    // on products or the consent dialog, so it clicked "Search" forever). Re-order the
    // candidates: in-viewport CONTENT first, then chrome controls that matter to the goal
    // (search, basket, consent), then the rest of the chrome, then off-viewport elements.
    if (!dialog) {
      const inViewport = (el) => {
        const r = el.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
      };
      const inChrome = (el) => !!el.closest('header,nav,footer,aside,[role="banner"],[role="navigation"],[role="contentinfo"]');
      const KEY_CHROME = /search|basket|\bbag\b|cart|checkout|allow|accept/i;
      const labelOf = (el) => ((el.innerText || '') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 80);
      // Off-screen CONTENT outranks on-screen plain chrome: on a PDP the buy box (size
      // chips, Add to bag) is routinely below the fold while ~20 header nav links are on
      // screen — the nav links used to consume the budget and the model couldn't buy
      // (M&S 2026-07-02). Key chrome (search/basket/consent) keeps its priority.
      const content = [], keyChrome = [], chrome = [], offContent = [], offChrome = [];
      for (const el of scope) {
        const chromeEl = inChrome(el);
        if (!inViewport(el)) { (chromeEl ? offChrome : offContent).push(el); continue; }
        if (!chromeEl) { content.push(el); continue; }
        (KEY_CHROME.test(labelOf(el)) ? keyChrome : chrome).push(el);
      }
      scope = [...content, ...keyChrome, ...offContent, ...chrome, ...offChrome];
    }
    const out = [];
    for (const el of scope) {
      if (out.length >= max) break;
      if (!visible(el)) continue;
      // "Soft hidden": the visually-hidden idiom (1×1 box + clip rect, or opacity:0) keeps
      // visibility:visible so the plain visible() check passes — M&S/Nike size radios.
      const softHidden = (n) => {
        const r = n.getBoundingClientRect();
        return !visible(n) || r.width <= 2 || r.height <= 2 || getComputedStyle(n).opacity === '0';
      };
      let proxyCtl = null;
      if (el.tagName === 'LABEL') {
        // Keep a label only when it's the visible face of a hidden control (styled
        // radio/checkbox chips). A label for a visible control would just duplicate it.
        const ctl = el.control || (el.htmlFor && document.getElementById(el.htmlFor)) || el.querySelector('input,select,textarea');
        if (!ctl || !softHidden(ctl)) continue;
        proxyCtl = ctl;
      } else if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
        // Mirror of the label rule: when the label is the visible face, drop the hidden
        // input so each chip appears ONCE (Nike listed every size twice, and the duplicate
        // burned the element budget before "UK 10" was reached — 2026-07-02).
        const lab = (el.labels && el.labels[0]) || el.closest('label');
        if (lab && visible(lab) && softHidden(el)) continue;
      }
      const raw = (el.innerText || '') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('value') || '';
      let text = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!text) continue;
      // Surface disabled state (out-of-stock size chips, inactive CTAs) so the model can
      // reason about it instead of clicking a dead control forever (Nike: sold-out sizes
      // are aria-disabled radios behind styled labels — 2026-07-02, 273s of "UK 10" clicks).
      const isOff = el.disabled || el.getAttribute('aria-disabled') === 'true'
        || (proxyCtl && (proxyCtl.disabled || proxyCtl.getAttribute('aria-disabled') === 'true'));
      if (isOff && !/unavailable|out of stock/i.test(text)) text = `${text} (unavailable)`;
      const locatorIndex = allNodes.indexOf(el); // index in full-document order = Playwright nth()
      if (locatorIndex === -1) continue;
      const r = el.getBoundingClientRect();
      // box is viewport-relative so it lines up with the screenshot; off-viewport elements
      // keep their (off-screen) coords and simply get no visible badge, as before.
      out.push({ id: out.length, text, locatorIndex, box: { x: r.x, y: r.y, width: r.width, height: r.height } });
    }
    return out;
  }, { selector: CLICKABLE_SELECTOR, max: MAX_ELEMENTS }).catch(() => []);
}

// Set-of-marks perception: draw a numbered badge on each element, screenshot the
// viewport, remove the overlay. The model SEES the page with ids it can point at —
// which is what lets it find a search box even when the DOM text/aria is empty.
async function captureMarkedScreenshot(page, elements) {
  const marks = elements.filter(el => el.box).map(el => ({ id: el.id, ...el.box }));
  await page.evaluate((marks) => {
    const layer = document.createElement('div');
    layer.id = '__oxy_marks__';
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    for (const m of marks) {
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${m.x}px;top:${m.y}px;width:${m.width}px;height:${m.height}px;border:2px solid #ff0066;box-sizing:border-box;`;
      const label = document.createElement('div');
      label.textContent = String(m.id);
      label.style.cssText = `position:fixed;left:${m.x}px;top:${Math.max(0, m.y - 15)}px;background:#ff0066;color:#fff;font:bold 11px/15px monospace;padding:0 3px;`;
      layer.appendChild(box);
      layer.appendChild(label);
    }
    document.body.appendChild(layer);
  }, marks).catch(() => {});
  try {
    // JPEG (not PNG) at a moderate quality is a fraction of the bytes for a screenshot the
    // model reads once and discards — the badges and layout stay legible at q55, and the
    // smaller upload + fewer pixels cut the dominant per-step vision-call latency.
    const shot = await page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY });
    return shot.toString('base64');
  } finally {
    await page.evaluate(() => document.getElementById('__oxy_marks__')?.remove()).catch(() => {});
  }
}

// Let the page catch up before we perceive it — without the old 'networkidle' trap.
// Analytics/websocket-heavy SPAs (john lewis, uber eats, …) NEVER reach networkidle, so
// waitForLoadState('networkidle') always ran its FULL timeout achieving nothing — 2.5s
// of dead waiting on every step, ~69% of each step's wall time. Instead: ensure the DOM
// is parsed (fast, usually already done) then take one short fixed hydration beat. Pages
// that are still visibly loading are handled by the model's "wait" action, not by us
// blocking the whole loop. Never throws — best-effort.
async function settle(page, pauseMs = 600) {
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(Math.max(0, pauseMs)).catch(() => {});
}

// Cookie/consent walls are the first thing a commercial site shows, and they cover the
// real page — so the model's first screenshot is all banner junk and it picks garbage.
// Best-effort dismiss: click the first visible accept/agree control we recognise. Tries
// the common consent frameworks (OneTrust, Cookiebot) by id, then a text match. Never
// throws and never waits long — if there's no banner, it's a couple of cheap no-ops.
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '[data-testid="modal"] button:has-text("Allow all")',
  'dialog button:has-text("Allow all")',
  'button[aria-label*="accept" i]',
  'button[id*="accept" i]'
];
// Exact accept-button labels, most-specific first. Exact (anchored) matches so we never
// click "Manage cookies" or "Reject all" by accident.
const CONSENT_NAMES = [
  /^allow all cookies$/i, /^accept all cookies$/i, /^allow all$/i, /^accept all$/i,
  /^accept cookies$/i, /^i accept$/i, /^accept$/i, /^agree$/i, /^got it$/i, /^continue$/i
];
async function dismissConsent(page) {
  // Fast path: the common consent frameworks expose a stable id.
  for (const sel of CONSENT_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 120 }).catch(() => false)) {
      await el.click({ timeout: 1500, force: true }).catch(() => {});
      return true;
    }
  }
  // Role+name search the WHOLE accessibility tree, not a position-capped slice — the old
  // "first 40 buttons" scan missed john lewis's "Allow all" because the header has dozens
  // of links/buttons ahead of it in DOM order. Check the main frame and any iframes
  // (some managers render the banner inside one).
  for (const root of page.frames()) { // page.frames() includes the main frame
    for (const name of CONSENT_NAMES) {
      const btn = root.getByRole('button', { name }).first();
      if (await btn.isVisible({ timeout: 120 }).catch(() => false)) {
        await btn.click({ timeout: 1500, force: true }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

// Hard cap on a single model call. A transient Gemini "fetch failed" was hanging the SDK's
// internal retry/backoff for 60–130s, blowing the whole-turn watchdog on one blip. Bound it
// and let decideNextAction's own retry handle recovery.
const MODEL_CALL_TIMEOUT_MS = envInt('OXY_BROWSER_MODEL_TIMEOUT_MS', 20000);
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function decideNextAction(goal, history, elements, screenshotB64, correction = '', goalContext = null) {
  const provider = (process.env.OXY_BROWSER_PROVIDER || 'gemini').toLowerCase();
  const promptText = buildDecisionPrompt(goal, history, elements, correction, goalContext);

  // Very rough token estimator for cost tracking (image tokens dominate)
  const imageTokens = screenshotB64 ? Math.round((screenshotB64.length * 0.65) / 4) : 0;
  const textTokens = Math.round(promptText.length / 4);
  const estInputTokens = imageTokens + textTokens + (elements.length * 15);

  if (process.env.OXY_BROWSER_COST_TRACKING === '1') {
    const pricePerM = Number(process.env.OXY_BROWSER_INPUT_PRICE_PER_M || 0.20);
    const stepCost = (estInputTokens / 1_000_000) * pricePerM;
    console.warn(`[cost] ~${estInputTokens} tokens → $${stepCost.toFixed(5)} (using $${pricePerM}/M input)`);
  }

  // Generic OpenAI-compatible path (Groq, Together, Fireworks, OpenRouter, etc.)
  // Set:
  //   OXY_BROWSER_PROVIDER=openai
  //   OXY_BROWSER_BASE_URL=https://api.groq.com/openai/v1
  //   OXY_BROWSER_API_KEY=...
  //   OXY_BROWSER_MODEL=meta-llama/llama-4-scout-...   (any vision model they host)
  if (provider === 'openai' || provider === 'groq' || provider === 'together' || provider === 'fireworks') {
    const apiKey = process.env.OXY_BROWSER_API_KEY || process.env.XAI_API_KEY || process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('OXY_BROWSER_API_KEY required for openai-compatible browser provider');

    const baseURL = process.env.OXY_BROWSER_BASE_URL || 'https://api.groq.com/openai/v1';
    const model = BROWSER_MODEL;

    const content = [{ type: 'text', text: promptText }];
    if (screenshotB64) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotB64}` } });

    const timeoutMs = envInt('OXY_BROWSER_MODEL_TIMEOUT_MS', 20000);
    const resP = fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        max_tokens: 600,
        temperature: 0.1
      })
    });
    const res = await Promise.race([resP, new Promise((_, r) => setTimeout(() => r(new Error('provider timeout')), timeoutMs))]);
    if (!res.ok) throw new Error(`Provider ${res.status}: ${(await res.text()).slice(0,300)}`);
    const j = await res.json();
    return parseModelDecision(j.choices?.[0]?.message?.content || '');
  }

  if (provider === 'grok' || (BROWSER_MODEL || '').startsWith('grok')) {
    // Grok via xAI (OpenAI compat)
    const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
    if (!apiKey) throw new Error('XAI_API_KEY (or GROK_API_KEY) required for browser Grok');
    const model = BROWSER_MODEL || 'grok-4.3';
    const content = [{ type: 'text', text: promptText }];
    if (screenshotB64) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotB64}` } });

    const timeoutMs = envInt('OXY_BROWSER_MODEL_TIMEOUT_MS', 20000);
    const resP = fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        max_tokens: 600,
        temperature: 0.1
      })
    });
    const res = await Promise.race([resP, new Promise((_, r) => setTimeout(() => r(new Error('grok timeout')), timeoutMs))]);
    if (!res.ok) throw new Error(`Grok ${res.status}: ${(await res.text()).slice(0,200)}`);
    const j = await res.json();
    return parseModelDecision(j.choices?.[0]?.message?.content || '');
  }

  // Gemini default path
  const model = getGemini().getGenerativeModel({ model: BROWSER_MODEL });
  const parts = [{ text: promptText }];
  if (screenshotB64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: screenshotB64 } });
  const request = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: 'application/json', ...browserThinkingConfig() }
  };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await withTimeout(model.generateContent(request), MODEL_CALL_TIMEOUT_MS, 'model call');
      return parseModelDecision(response.response.text());
    } catch (err) {
      lastErr = err;
    }
  }
  return { action: 'invalid', error: `model call failed: ${String(lastErr && lastErr.message || lastErr).split('\n')[0].slice(0, 120)}` };
}

// --- Direct-search fast-paths -------------------------------------------------------------
// Typing a query into a site's search box costs ~2-3 model steps (find the box, fill it,
// submit). For sites with a stable search-results URL we can jump straight there, deleting
// those steps — pure win on the dominant steps×model term. Best-effort: if we can't derive a
// confident query we open the original url, i.e. exactly today's behaviour.
// Retailer registry (name → home + search URL). Extended via api/services/retailer-sites.js.
const SEARCH_SITES = buildSearchSites();

// Leading intent verbs and trailing fluff that aren't part of the thing being searched for.
const LEAD_NOISE = /^(?:can you\s+|could you\s+|please\s+|i\s+(?:want|need|would like)\s+(?:to\s+)?(?:find|buy|get|order)?\s*|find\s+(?:me\b\s*)?|search\s+(?:for\s+)?|look\s+(?:for|up)\s+|buy\s+(?:me\b\s*)?|order\s+(?:me\b\s*)?|add\s+(?:me\b\s*)?|get\s+(?:me\b\s*)?|show\s+(?:me\b\s*)?|a\s+pair\s+of\s+|some\s+|a\s+|an\s+|the\s+)+/i;
// Strip a trailing request-about-the-result clause. Anchored to a connective ("…and tell me
// the exact price shown", "…how much", "…and the price") so it eats the whole tail regardless
// of adjectives, but does NOT touch a product name that merely contains "price"/"cost".
// Also strip "i think its", "probably", "about" qualifiers.
const TRAIL_NOISE = /\s*(?:and\s+)?(?:tell\s+me|let\s+me\s+know|show\s+me|give\s+me|how\s+much)\b.*$|\s*and\s+(?:the\s+|its\s+)?(?:price|cost)\b.*$|\s+(?:near|for)\s+me\s*$|\s*please\s*$|\s*i\s+think\s+(?:its?|it'?s)\s*(?!\d)/i;
// Ordering-instruction tails: the "…add to basket and go to checkout" half of an order goal
// describes what to DO with the product, not what to search for. Passing it through produced
// garbage queries ("add a wireless mouse to basket and go to checkout") that opened every
// seeded site on a no-results page (2026-07-02 benchmark). Applied iteratively with
// TRAIL_NOISE. Order matters within the alternation: whole-clause forms first.
const ORDER_TAIL_NOISE = new RegExp([
  String.raw`\s*,?\s*(?:and\s+)?add\s+(?:it|them|one|this)?\s*to\s+(?:my\s+)?(?:basket|bag|cart|trolley)\b.*$`,
  String.raw`\s+to\s+(?:my\s+)?(?:basket|bag|cart|trolley)\b.*$`, // after a lead "add …" was stripped
  String.raw`\s*,?\s*(?:and\s+)?(?:go|proceed|head|continue)\s+to\s+(?:the\s+)?checkout\b.*$`,
  String.raw`\s*,?\s*and\s+checkout\b.*$`,
  String.raw`\s+for\s+(?:collection|delivery|pickup|click\s+and\s+collect)\b.*$`,
  String.raw`\s+near\s+(?![a-z]*\bme\b)[\w'’]+(?:\s+[\w'’]+)*\s*$`, // "near EC1A 1BB London" ("near me" is TRAIL_NOISE's)
  String.raw`\s+in\s+size\s+[\w. ]+$`, // size is chosen on the product page, not searched for
].join('|'), 'i');

// Pull the "thing to search for" out of a natural-language goal. Conservative: returns null
// whenever the result looks implausible as a query, so the caller falls back to a normal open.
function deriveSearchTerm(goal, site) {
  let t = String(goal || '').trim();
  if (!t) return null;
  // Drop a mention of the site itself ("… on John Lewis", "from johnlewis") — that's WHERE
  // to look, not WHAT to look for.
  for (const name of (site?.names || [])) {
    t = t.replace(new RegExp(`\\s*(?:on|at|from|in|using)\\s+${name}\\b`, 'ig'), '');
    t = t.replace(new RegExp(`\\b${name}\\b`, 'ig'), '');
  }
  t = t.replace(LEAD_NOISE, '');
  // Trailing fluff can stack ("joggers to basket and go to checkout please") — strip until stable.
  let prev;
  do { prev = t; t = t.replace(TRAIL_NOISE, '').replace(ORDER_TAIL_NOISE, ''); } while (t !== prev);
  t = t.trim().replace(/\s+/g, ' ');
  if (t.length < 2 || t.length > 80) return null; // too short to be a query / probably not one
  return t;
}

// If url is a known search-site root AND we can derive a query, return the results-page url
// to open instead; otherwise null (open url unchanged).
function directSearchUrl(url, goal, retailOptions = {}) {
  if (!url || !goal) return null;
  if (process.env.OXY_BROWSER_FASTPATH === 'false') return null; // kill-switch / A-B isolation
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  // Only short-circuit a homepage/root — including locale roots like /gb, /uk, /en_gb
  // (nike.com/gb never got its seed before this). If the url is a real deep link (a search,
  // product, or category page) the caller meant to land there — don't override it.
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path !== '' && !/^\/[a-z]{2}(?:[_-][a-z]{2})?$/i.test(path)) return null;
  const host = parsed.hostname.replace(/^www\./, '');
  const site = resolveSearchSite(host, goal, retailOptions) || SEARCH_SITES[host];
  // For a curated site, use its names to strip; otherwise strip using the host's brand word.
  const term = deriveSearchTerm(goal, site || { names: [host.split('.')[0]] });
  if (!term) return null;
  if (site) return site.searchUrl(term);          // curated seed wins
  return fastpathStore.getLearnedSearchUrl(host, term); // else a learned template, or null
}

// --- Tier-0: no-browser price/availability lookups for info goals ----------------------
// Pure HTTP GETs + the price parser. Reuses derive/direct logic. Falls through silently
// on any failure (bot wall on fetch, no price found, network error) so the browser path
// is unchanged. Only used for !isOrderGoal.

// Returns true when the extracted product name is plausibly about the same thing the user
// asked for. Prevents returning a homepage promotional price (e.g. "£5 off") as the answer
// to "find the Dyson Supersonic price". Requires at least one significant word from the
// goal's search term to appear in the product name — if none match, fall through to browser.
const TIER0_STOP_WORDS = new Set([
  'the','and','for','with','from','that','this','buy','get','find','look','price',
  'tell','me','your','our','all','new','uk','gb','search','latest','shop','sale',
  'free','home','page','site','online','delivery','discover','explore','store',
  'pro','max','plus','mini','ultra','lite','se','oled','size','model','specs',
]);
function tier0NameMatchesGoal(name, searchTerm) {
  if (!name || !searchTerm) return false;
  const words = (s) => s.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !TIER0_STOP_WORDS.has(w));
  const nameWords = words(name);
  const termWords = words(searchTerm);
  if (!termWords.length) return false;
  // At least one term word must appear (or be contained in) a name word, or vice-versa.
  return termWords.some(tw => nameWords.some(nw => nw.includes(tw) || tw.includes(nw)));
}

const TIER0_GENERIC_NAME = /homepage|home\s*page|official\s+site|online\s+(?:food\s+)?shopping|shop\s+now|welcome\s+to|beauty\s+discovery|life\s*wear|bedding,\s*curtains|delivered\s+by|favourite\s+groceries|deals?\s+spotted|promobadge/i;

function tier0ProductLooksValid(name, searchTerm) {
  if (!name || !searchTerm) return false;
  if (TIER0_GENERIC_NAME.test(name)) return false;
  return tier0NameMatchesGoal(name, searchTerm);
}

function tier0FormatDone(name, price, html) {
  const deals = extractVisibleDeals(html || '');
  let text = `The ${name} is priced at ${price}.`;
  if (deals.length) text += ` Deals spotted: ${deals.slice(0, 3).join(', ')}.`;
  return { type: 'done', text };
}

async function tryTier0HttpLookup(url, goal, searchTerm) {
  const tryHtml = (html, pageUrl) => {
    const price = extractPrice(html);
    if (!price) return null;
    const name = extractProductName(html);
    if (!tier0ProductLooksValid(name, searchTerm)) return null;
    return tier0FormatDone(name, price, html);
  };

  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    const looksLikeProduct = /\/(p\d|product|item|detail|pd\/|p\/[a-z0-9-]{5,})/i.test(path);
    if (looksLikeProduct) {
      const directHtml = await fetchHtml(url);
      if (directHtml) {
        const hit = tryHtml(directHtml, url);
        if (hit) return hit;
      }
    }
  } catch { /* fall through */ }

  const searchUrl = directSearchUrl(url, goal);
  if (!searchUrl) return null;

  const searchHtml = await fetchHtml(searchUrl);
  if (!searchHtml) return null;

  const inline = tryHtml(searchHtml, searchUrl);
  if (inline) return inline;

  const productUrl = extractFirstProductUrl(searchHtml, searchUrl);
  if (!productUrl) return null;

  const pdpHtml = await fetchHtml(productUrl);
  if (!pdpHtml) return null;
  return tryHtml(pdpHtml, productUrl);
}

// fetchHtml is still used by resolveOrderOpenUrl below.
const TIER0_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIER0_TIMEOUT_MS = 7000;

async function fetchHtml(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': TIER0_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      timeout: TIER0_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true
    });
    if (res.status >= 200 && res.status < 300 && typeof res.data === 'string' && res.data.length > 200) {
      return res.data;
    }
    return null;
  } catch {
    return null;
  }
}

// Model for Tier-0 search grounding: flash-lite is cheap + fast. The task is trivial
// (extract a price from grounded search results) so it doesn't need the reasoning model.
const TIER0_SEARCH_MODEL = process.env.OXY_TIER0_SEARCH_MODEL || process.env.OXY_HELPER_MODEL || 'gemini-2.5-flash-lite';
const TIER0_SEARCH_TIMEOUT_MS = envInt('OXY_TIER0_SEARCH_TIMEOUT_MS', 8000);

// Newer @google/genai SDK — used only for Tier-0 (supports .models.generateContent +
// googleSearch grounding). The browser loop uses the older SDK via getGemini().
const { GoogleGenAI: _GoogleGenAI } = require('@google/genai');
let _tier0GenAI = null;
function getTier0GenAI() {
  if (!_tier0GenAI) _tier0GenAI = new _GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
  return _tier0GenAI;
}

/**
 * Tier-0 price lookup via Google Search grounding.
 * One Gemini call with { googleSearch: {} } — typically 1-3s, accurate, no bot walls,
 * works even for sites that block datacenter IPs. Falls through (returns null) on timeout
 * or if Gemini can't find a confident price, so the browser path handles it.
 */
async function tryTier0SearchGrounding(url, goal, searchTerm) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}

  const prompt = host
    ? `What is the current price of "${searchTerm}" on ${host}? Give the exact product name and price in GBP only. If you cannot find it on that specific site, say so — do not guess.`
    : `What is the current price of "${searchTerm}" in the UK? Give the exact product name, retailer, and price in GBP. Do not guess.`;

  try {
    const result = await withTimeout(
      getTier0GenAI().models.generateContent({
        model: TIER0_SEARCH_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.1,
          maxOutputTokens: 256,
        },
      }),
      TIER0_SEARCH_TIMEOUT_MS,
      'tier0 search grounding'
    );

    const text = (result?.text || '').trim();
    if (!text) return null;

    const hasPrice = /£\s*[\d]|[\d]+\s*(?:pounds?|gbp)/i.test(text);
    const admitsUnknown = /(?:couldn'?t|can'?t|don'?t|unable|not (?:able|find|found|available|listed|show)|no (?:price|result|listing)|sorry)/i.test(text);
    if (!hasPrice || admitsUnknown) return null;
    if (TIER0_GENERIC_NAME.test(text)) return null;
    if (!tier0NameMatchesGoal(text, searchTerm)) return null;

    return { type: 'done', text };
  } catch {
    return null;
  }
}

async function tryTier0PriceLookup(url, goal) {
  if (!url || !goal || isOrderGoal(goal)) return null;

  const searchTerm = deriveSearchTerm(goal, null) || goal;

  const httpHit = await tryTier0HttpLookup(url, goal, searchTerm);
  if (httpHit) return httpHit;

  return tryTier0SearchGrounding(url, goal, searchTerm);
}

// Order open URL: search → first product PDP in one HTTP hop when possible, skipping the
// search-results vision step (~3–5s). Falls back to search URL, then the raw url.
async function resolveOrderOpenUrl(url, goal, retailOptions = {}) {
  const searchUrl = directSearchUrl(url, goal, retailOptions);
  if (!searchUrl) return url;
  const html = await fetchHtml(searchUrl);
  if (!html) return searchUrl;
  const { extractProductUrlCandidates, looksOrderablePdp } = require('./browser-price-parser');
  const candidates = extractProductUrlCandidates(html, searchUrl).slice(0, 5);
  if (!candidates.length) return searchUrl;
  const checked = await Promise.all(candidates.map(async (productUrl) => {
    const pdpHtml = await fetchHtml(productUrl);
    return { productUrl, orderable: Boolean(pdpHtml && looksOrderablePdp(pdpHtml)) };
  }));
  const hit = checked.find((c) => c.orderable);
  return hit?.productUrl || candidates[0] || searchUrl;
}

async function loadUserLocation(userId) {
  try {
    const { data } = await getSupabase()
      .from('native_context')
      .select('location')
      .eq('user_id', userId)
      .maybeSingle();
    const loc = data?.location;
    const lat = Number(loc?.latitude ?? loc?.lat);
    const lng = Number(loc?.longitude ?? loc?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { latitude: lat, longitude: lng };
  } catch { /* non-critical */ }
  return null;
}

async function openNewSession(userId, url, goal, retailOptions = {}) {
  const site = siteKeyFromUrl(url);
  const storageState = await loadStorageState(userId, site);
  // Route bot-walled hosts through the managed (residential) browser, everything else
  // through the free local warm pool. `remote` is carried on the session so close paths and
  // logs know it was a metered session.
  const { browser, remote } = await acquireBrowser(site);
  // A smaller viewport means a smaller screenshot — fewer bytes and fewer pixels for the
  // model to read each step (the dominant per-step cost). 1024×768 still shows enough of a
  // commercial page to find a search box / first result.
  const context = await browser.newContext({ viewport: VIEWPORT, ...(storageState ? { storageState } : {}) });
  const page = await context.newPage();
  // Orders: open the first product PDP directly when a plain fetch can resolve it; else the
  // search-results URL; else the caller's url. Info goals keep the search-page fastpath only.
  let openUrl = isOrderGoal(goal)
    ? await resolveOrderOpenUrl(url, goal, retailOptions)
    : (directSearchUrl(url, goal, retailOptions) || url);
  if (site === 'johnlewis.com' && isOrderGoal(goal)) {
    try {
      const u = new URL(openUrl);
      if (/\/p\d+(?:\b|\/|$)/i.test(u.pathname) && !/[?&]size=/i.test(u.search)) {
        const sizeQ = johnLewisSizeQueryValue(goal, parseGoalContext(goal));
        if (sizeQ) { u.searchParams.set('size', sizeQ); openUrl = u.href; }
      }
    } catch { /* keep openUrl */ }
  }
  await timed('open.goto', () => page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }));
  // Let the SPA hydrate before the first perception, or we screenshot a bare skeleton
  // and the model thinks there's no search bar. A longer beat here (first paint is the
  // slowest) but still bounded — not the old open-ended networkidle wait.
  await timed('open.settle1', () => settle(page, OPEN_HYDRATE_MS));
  // Clear the consent wall up front so the model's very first screenshot is the real
  // page, not a cookie banner it'll waste steps on.
  await timed('open.consent', () => dismissConsent(page).catch(() => {}));
  await timed('open.settle2', () => settle(page, OPEN_POST_CONSENT_MS));
  const goalContext = parseGoalContext(goal);
  const usedFastpath = (openUrl !== url) ? siteKeyFromUrl(url) : null;
  return createSession(userId, { browser, context, page, site, goal, goalContext, history: [], pendingPaymentLabel: null, isOrder: isOrderGoal(goal), usedFastpath, remote });
}

// Best-effort: save cookies/localStorage AND the resumable context (last url, goal,
// history) so an idle-evicted or accidentally-closed session can be re-opened where it
// left off instead of dead-ending. Failing to persist must never abort an in-progress order.
async function persistStorage(userId, session) {
  try {
    await getSupabase().from('browser_sessions').upsert({
      user_id: userId,
      site: session.site,
      storage_state: await session.context.storageState(),
      last_url: session.page.url(),
      goal: session.goal,
      history: session.history,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,site' });
  } catch {
    // swallow — persistence is non-critical to the current turn
  }
}

// Most-recent persisted session for the user, so a resume with no live session and no
// url can re-open the browser at the last page (cookies + cart survive via storageState).
async function loadResumeContext(userId) {
  const { data } = await getSupabase()
    .from('browser_sessions')
    .select('last_url, goal, history, site')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.last_url ? data : null;
}

// One place for the "site is blocking us" bail: mark a used fast-path as failed (so a stale
// learned template self-heals) and return the calm, order-aware copy the classifier reads as
// a bot-wall ceiling rather than a loop bug.
function blockedPageResult(session) {
  if (session.usedFastpath) fastpathStore.recordOutcome(session.usedFastpath, false);
  return { type: 'error', error: session.isOrder
    ? 'I couldn\'t load the page properly just now — the site may be blocking automated access. Want me to try a different site or platform instead?'
    : 'I couldn\'t load the page properly just now — the site may be blocking automated access. Want me to try a different site instead?' };
}

// Checkout identity: load once per session turn, reuse the preferences KV store.
async function getCheckoutProfileCached(session, userId) {
  if (session.checkoutProfile) return session.checkoutProfile;
  session.checkoutProfile = await loadCheckoutProfile(getSupabase(), userId);
  return session.checkoutProfile;
}

// Fill a visible email <input> directly — avoids mis-targeting guest-checkout CTAs from
// extracted clickable labels ("Continue with email", etc.).
async function fillEmailInputDirect(session, email, steps, onProgress) {
  const selectors = [
    'input[type="email"]:visible',
    'input[autocomplete="email"]:visible',
    'input[name*="email" i]:visible',
    'input[id*="email" i]:visible',
    'input[placeholder*="email" i]:visible',
  ];
  for (const sel of selectors) {
    const loc = session.page.locator(sel).first();
    const ok = await loc.isVisible({ timeout: 600 }).catch(() => false);
    if (!ok) continue;
    onProgress('Typing into email field…');
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try {
      const current = (await loc.inputValue().catch(() => '')).trim().toLowerCase();
      const want = String(email || '').trim().toLowerCase();
      if (current && want && current === want) {
        session.history.push(`Step ${steps}: [checkout-profile] email already filled (${sel})`);
        session.checkoutEmailFilled = true;
        return true;
      }
      await loc.fill(String(email || ''), { timeout: 8000 });
      await loc.press('Enter').catch(() => {});
      session.checkoutEmailFilled = true;
      session.history.push(`Step ${steps}: [checkout-profile] filled email input (${sel})`);
      return true;
    } catch { /* try next selector */ }
  }
  return false;
}

// Fill a single checkout field by locator index + optional DOM fallback probe.
// fieldPredicate: RegExp tested against label/hint text, or (el, hint) → boolean.
async function autoFillCheckoutField(session, elements, value, steps, onProgress, labelText, fieldPredicate) {
  const matchesPredicate = (hint) => {
    if (!hint) return false;
    if (GUEST_CHECKOUT_PATTERN.test(hint)) return false;
    if (typeof fieldPredicate === 'function') return fieldPredicate(null, hint);
    if (fieldPredicate instanceof RegExp) return fieldPredicate.test(hint);
    return false;
  };
  let target = (elements || []).find((el) => {
    const t = String(el.text || '');
    if (/\b(sign in|log in|continue|submit)\b/i.test(t) && /\b(e-?mail)\b/i.test(t)) return false;
    return matchesPredicate(t);
  });
  let actionIndex = target?.locatorIndex;
  if (actionIndex == null) {
    const predSrc = fieldPredicate instanceof RegExp ? fieldPredicate.source : '';
    const predFlags = fieldPredicate instanceof RegExp ? fieldPredicate.flags : 'i';
    const idx = await session.page.evaluate((selector, predSrc, predFlags) => {
      const pat = new RegExp(predSrc, predFlags);
      const nodes = document.querySelectorAll(selector);
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'hidden' || type === 'password') continue;
        const hint = [type, el.getAttribute('name'), el.getAttribute('id'),
          el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ');
        if (type === 'email' || pat.test(hint)) return i;
      }
      return -1;
    }, CLICKABLE_SELECTOR, predSrc, predFlags).catch(() => -1);
    if (idx >= 0) {
      actionIndex = idx;
      target = { text: labelText, locatorIndex: idx };
    }
  }
  if (actionIndex == null) return false;
  const locator = await session.page.evaluateHandle(
    ({ selector, idx }) => document.querySelectorAll(selector)[idx] || null,
    { selector: CLICKABLE_SELECTOR, idx: actionIndex }
  ).then((h) => h.asElement()).catch(() => null);
  if (!locator) return false;
  onProgress(`Typing into "${target?.text || labelText}"…`);
  const val = String(value || '');
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  const tag = await locator.evaluate((el) => el.tagName).catch(() => '');
  if (tag && tag !== 'INPUT' && tag !== 'TEXTAREA') {
    const nested = await locator.$('input, textarea').catch(() => null);
    if (!nested) return false;
    await nested.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await nested.fill(val, { timeout: 8000 });
    session.history.push(`Step ${steps}: [checkout-profile] filled nested input for "${target?.text || labelText}"`);
    return true;
  }
  try {
    await locator.fill(val, { timeout: 8000 });
  } catch {
    const nested = await locator.$('input, textarea').catch(() => null);
    if (!nested) return false;
    await nested.fill(val, { timeout: 8000 });
  }
  session.history.push(`Step ${steps}: [checkout-profile] filled "${target?.text || labelText}" with "${val}"`);
  return true;
}

// Convenience wrapper for email (preserves existing call sites).
async function autoFillCheckoutEmail(session, elements, email, steps, onProgress) {
  if (await fillEmailInputDirect(session, email, steps, onProgress)) return true;
  const labelled = findEmailInputElement(elements);
  if (labelled?.locatorIndex != null) {
    const ok = await autoFillCheckoutField(
      session, [labelled], email, steps, onProgress, 'email', /\be-?mail\b/i
    );
    if (ok) return true;
  }
  return autoFillCheckoutField(
    session, elements, email, steps, onProgress, 'email',
    /\be-?mail\b/i
  );
}

const FORM_FIELD_SELECTOR = 'input, select, textarea';

function buildCheckoutFieldValues(profile) {
  const values = { title: 'Mr' };
  if (profile.email) values.email = profile.email;
  if (profile.name) {
    const parts = String(profile.name).trim().split(/\s+/);
    values.full_name = profile.name;
    values.first_name = parts[0] || profile.name;
    values.last_name = parts.slice(1).join(' ') || parts[0];
  }
  if (profile.phone) values.phone = profile.phone;
  if (profile.address) {
    if (profile.address.line1) values.line1 = profile.address.line1;
    if (profile.address.line2) values.line2 = profile.address.line2;
    if (profile.address.city) values.city = profile.address.city;
    if (profile.address.postcode) values.postcode = profile.address.postcode;
  }
  return values;
}

// Multi-field pass for delivery-details pages. Enumerates visible inputs/selects,
// matches each to a profile value via matchProfileFieldForInput, fills confident matches.
async function autoFillCheckoutDetails(session, profile, steps, onProgress) {
  const values = buildCheckoutFieldValues(profile);
  let filled = 0;

  const candidates = await session.page.evaluate((paymentPatSrc, paymentPatFlags) => {
    const payPat = new RegExp(paymentPatSrc, paymentPatFlags);
    const nodes = document.querySelectorAll('input, select, textarea');
    const results = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') continue;
      const type = (el.getAttribute('type') || tag.toLowerCase()).toLowerCase();
      if (type === 'hidden' || type === 'password' || type === 'checkbox' || type === 'radio') continue;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const id = el.getAttribute('id') || '';
      const labelEl = (el.labels && el.labels[0])
        || (id && document.querySelector(`label[for="${CSS.escape(id)}"]`))
        || el.closest('label');
      const label = labelEl ? (labelEl.innerText || '').trim() : '';
      const hint = [tag.toLowerCase(), type, el.getAttribute('name'), id,
        el.getAttribute('placeholder'), el.getAttribute('aria-label'),
        el.getAttribute('autocomplete'), label].join(' ');
      if (payPat.test(hint)) continue;
      results.push({ idx: i, hint: hint.toLowerCase(), tag: tag.toLowerCase() });
    }
    return results;
  },
    /\b(card\s*(?:number|details)?|payment\s*details|cvv|cvc|security\s*code|sort\s*code|account\s*number)\b/.source,
    'i'
  ).catch(() => []);

  filled = 0;
  for (const { idx, hint, tag } of candidates) {
    const profileField = matchProfileFieldForInput(hint);
    if (!profileField || !(profileField in values)) continue;
    const value = values[profileField];

    const locator = await session.page.evaluateHandle(
      (i) => document.querySelectorAll('input, select, textarea')[i] || null,
      idx
    ).then((h) => h.asElement()).catch(() => null);
    if (!locator) continue;

    const already = tag === 'select'
      ? await locator.evaluate((sel) => !!sel.value && sel.selectedIndex > 0).catch(() => false)
      : !!(await locator.inputValue().catch(() => '')).trim();
    if (already) continue;

    onProgress(`Typing "${profileField}"…`);
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try {
      if (tag === 'select') {
        const picked = await locator.evaluate((sel, want) => {
          const opts = [...sel.options].filter((o) => o.value && !/^(-{1,2}|select|choose)/i.test(o.text));
          const hit = opts.find((o) => new RegExp(`^${want}$`, 'i').test(o.text) || /^mr$/i.test(o.text))
            || opts.find((o) => /^(mr|mrs|ms|miss|mx)$/i.test(o.text))
            || opts[0];
          if (!hit) return false;
          sel.value = hit.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, String(value)).catch(() => false);
        if (!picked) continue;
      } else {
        await locator.fill(String(value), { timeout: 6000 });
      }
      session.history.push(`Step ${steps}: [checkout-profile] filled "${hint.trim().slice(0, 40)}" with "${profileField}"`);
      filled++;
    } catch {
      // Skip fields that don't respond — continue to next
    }
  }

  if (filled === 0) {
    const direct = [
      ['select#title, select[name*="title" i], select[id*="title" i]', 'title', 'select'],
      ['input#firstName, input[autocomplete="given-name"]', 'first_name', 'fill'],
      ['input#lastName, input[autocomplete="family-name"]', 'last_name', 'fill'],
      ['input[name*="firstName" i], input[id*="firstName" i]', 'first_name', 'fill'],
      ['input[name*="lastName" i], input[name*="surname" i]', 'last_name', 'fill'],
      ['input#phone, input#mobile, input[autocomplete="tel"], input[name*="mobile" i], input[name*="phone" i]', 'phone', 'fill'],
      ['input#line1, input#addressLine1', 'line1', 'fill'],
      ['input#postcode, input#postalCode', 'postcode', 'fill'],
      ['input#townCity, input#city', 'city', 'fill'],
      ['input[autocomplete="street-address"], input[name*="line1" i], input[name*="address1" i], input[name*="line_1" i]', 'line1', 'fill'],
      ['input[autocomplete="address-level2"], input[name*="town" i], input[name*="city" i], input[name*="townCity" i]', 'city', 'fill'],
      ['input[autocomplete="postal-code"], input[name*="postcode" i], input[name*="postal" i], input[name*="postalCode" i]', 'postcode', 'fill'],
    ];
    for (const [sel, field, mode] of direct) {
      if (!(field in values)) continue;
      const loc = session.page.locator(sel).first();
      if (!(await loc.isVisible({ timeout: 400 }).catch(() => false))) continue;
      const already = mode === 'select'
        ? await loc.evaluate((el) => !!el.value && el.selectedIndex > 0).catch(() => false)
        : !!(await loc.inputValue().catch(() => '')).trim();
      if (already) continue;
      onProgress(`Typing "${field}"…`);
      try {
        if (mode === 'select') {
          await loc.selectOption({ label: 'Mr' }).catch(() => loc.selectOption({ index: 1 }));
        } else {
          await loc.fill(String(values[field]), { timeout: 6000 });
        }
        session.history.push(`Step ${steps}: [checkout-profile] filled ${field} via ${sel}`);
        filled++;
      } catch { /* next */ }
    }
  }

  if (filled < 3) {
    const labelFills = [
      { pat: /title|salutation/i, field: 'title', mode: 'select' },
      { pat: /first name|given name/i, field: 'first_name', mode: 'fill' },
      { pat: /surname|last name|family name/i, field: 'last_name', mode: 'fill' },
      { pat: /mobile|phone number|contact number/i, field: 'phone', mode: 'fill' },
      { pat: /address line 1|line 1|street|house/i, field: 'line1', mode: 'fill' },
      { pat: /town|city/i, field: 'city', mode: 'fill' },
      { pat: /post\s?code|postal/i, field: 'postcode', mode: 'fill' },
    ];
    for (const { pat, field, mode } of labelFills) {
      if (!(field in values)) continue;
      const loc = session.page.getByLabel(pat).first();
      if (!(await loc.isVisible({ timeout: 400 }).catch(() => false))) continue;
      const already = mode === 'select'
        ? await loc.evaluate((el) => !!el.value && el.selectedIndex > 0).catch(() => false)
        : !!(await loc.inputValue().catch(() => '')).trim();
      if (already) continue;
      onProgress(`Typing "${field}" (label)…`);
      try {
        if (mode === 'select') {
          await loc.selectOption({ label: 'Mr' }).catch(() => loc.selectOption({ index: 1 }));
        } else {
          await loc.fill(String(values[field]), { timeout: 6000 });
        }
        session.history.push(`Step ${steps}: [checkout-profile] filled ${field} via label ${pat}`);
        filled++;
      } catch { /* next */ }
    }
  }
  return filled;
}

// After a recipe click, wait for the DOM/URL state the NEXT recipe gate reads — stops the
// Wickes basket/checkout double-fire (flyout not open yet → checkout invisible → spin).
async function waitAfterRecipeStep(page, site, stepName, session) {
  if (stepName === 'add' && !RECIPES[site] && !isDeliveryHost(site)) {
    const ok = await page.waitForFunction(() => {
      const sels = ['[data-testid*="basket" i]', '[data-testid*="cart" i]', '[data-testid*="bag" i]', 'a[aria-label*="bag" i]', 'a[aria-label*="basket" i]'];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        const text = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`;
        if (/\d+/.test(text)) return true;
      }
      for (const el of document.querySelectorAll('a, button')) {
        const t = (el.innerText || '').trim();
        if (!/^view (?:basket|bag)$/i.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      return false;
    }, { timeout: 3500, polling: 200 }).catch(() => false);
    if (session && ok) session.convAddConfirmed = true;
    return;
  }
  if (stepName === 'search-pick') {
    await page.waitForURL((u) => !isSearchResultsUrl(u), { timeout: 3000 }).catch(() => {});
    return;
  }
  // Delivery cart-commit: after "Add to order" the modal must close or the cart badge must tick up.
  if (isDeliveryHost(site) && stepName === 'modal-add') {
    const ok = await page.waitForFunction(() => {
      const vw = window.innerWidth * window.innerHeight;
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      let itemCount = 0;
      for (const el of document.querySelectorAll('[class*="cart-count" i],[class*="basket-count" i],[data-testid*="cart" i],[aria-label*="cart" i],[aria-label*="basket" i]')) {
        const txt = (el.textContent || el.getAttribute('aria-label') || '').replace(/[^0-9]/g, '');
        if (txt) itemCount = Math.max(itemCount, parseInt(txt, 10) || 0);
      }
      const dialogOpen = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'))
        .filter(visible)
        .some((el) => { const r = el.getBoundingClientRect(); return r.width * r.height > vw * 0.12; });
      return itemCount > 0 || !dialogOpen;
    }, { timeout: 4500, polling: 200 }).catch(() => false);
    if (session && ok) session.deliveryAddConfirmed = true;
    return;
  }
  if (site === 'johnlewis.com' && stepName === 'size') {
    await page.waitForFunction(() => (
      /[?&]size=/i.test(location.search)
      || !!document.querySelector('[data-testid="size:option:button"][aria-current="true"]')
    ), { timeout: 3500, polling: 150 }).catch(() => {});
    return;
  }
  if (site === 'johnlewis.com' && stepName === 'add') {
    const ok = await page.waitForFunction(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const badge = document.querySelector('[data-testid="basket-amount"]');
      if (badge) {
        const m = (badge.innerText || badge.getAttribute('aria-label') || '').match(/\d+/);
        if (m && parseInt(m[0], 10) > 0) return true;
      }
      for (const el of document.querySelectorAll('a, button')) {
        const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
        if (/^view basket$/i.test(t) && visible(el)) return true;
      }
      return /\/basket(?:\/|$)/i.test(location.pathname);
    }, { timeout: 5000, polling: 150 }).catch(() => false);
    if (session && ok) session.jlAddConfirmed = true;
    return;
  }
  if (site === 'nike.com' && stepName === 'add') {
    const ok = await page.waitForFunction(() => {
      const badge = document.querySelector('[data-qa="cart-count"], [class*="cart-count" i]');
      if (badge) {
        const m = (badge.textContent || badge.getAttribute('aria-label') || '').match(/\d+/);
        if (m && parseInt(m[0], 10) > 0) return true;
      }
      return /\/cart/i.test(location.pathname);
    }, { timeout: 5000, polling: 200 }).catch(() => false);
    if (session && ok) session.nikeAddConfirmed = true;
    return;
  }
  if (site === 'asos.com' && stepName === 'add') {
    const ok = await page.waitForFunction(() => {
      for (const el of document.querySelectorAll('[data-testid="bag-item-count"], a[href*="/bag"]')) {
        const m = (el.textContent || el.getAttribute('aria-label') || '').match(/\d+/);
        if (m && parseInt(m[0], 10) > 0) return true;
      }
      return /\/bag/i.test(location.pathname);
    }, { timeout: 5000, polling: 200 }).catch(() => false);
    if (session && ok) session.asosAddConfirmed = true;
    return;
  }
  if (site === 'marksandspencer.com' && stepName === 'add') {
    const ok = await page.waitForFunction(() => {
      for (const el of document.querySelectorAll('a[aria-label*="Shopping bag" i]')) {
        const m = (el.getAttribute('aria-label') || '').match(/\d+/);
        if (m && parseInt(m[0], 10) > 0) return true;
      }
      return /\/basket/i.test(location.pathname);
    }, { timeout: 4000, polling: 200 }).catch(() => false);
    if (session && ok) session.msAddConfirmed = true;
    return;
  }
  if (site === 'screwfix.com' && stepName === 'add') {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
        if (/^continue shopping$/i.test(t)) { el.click(); return; }
      }
    }).catch(() => {});
    const ok = await page.waitForFunction(() => {
      const body = document.body?.innerText || '';
      if (/added to (?:your )?basket|item(?:s)? added/i.test(body)) return true;
      for (const el of document.querySelectorAll(
        '[class*="basket-count" i], [id*="basket" i], [id*="BasketQty" i], #headerBasketCount, a[href*="/basket"], [data-qaid*="basket" i]'
      )) {
        const m = (el.textContent || el.getAttribute('aria-label') || '').match(/\d+/);
        if (m && parseInt(m[0], 10) > 0) return true;
      }
      return /\/basket/i.test(location.pathname);
    }, { timeout: 6000, polling: 200 }).catch(() => false);
    if (session && ok) { session.screwfixAddConfirmed = true; return; }
    const basketOk = await page.evaluate(async () => {
      try {
        const r = await fetch('/basket', { credentials: 'same-origin' });
        const html = await r.text();
        if (/your basket is empty|basket\s*:\s*0|no items in your basket/i.test(html)) return false;
        return /(?:basket-item|product-row|line-item|data-qaid="product|class="product)/i.test(html);
      } catch { return false; }
    }).catch(() => false);
    if (session && basketOk) session.screwfixAddConfirmed = true;
    return;
  }
  if (site === 'currys.co.uk' && stepName === 'add') {
    const ok = await page.waitForFunction(() => {
      for (const el of document.querySelectorAll('[data-test*="basket" i], a[href*="/basket"]')) {
        const m = (el.textContent || el.getAttribute('aria-label') || '').match(/\d+/);
        if (m && parseInt(m[0], 10) > 0) return true;
      }
      return /\/basket/i.test(location.pathname);
    }, { timeout: 5000, polling: 200 }).catch(() => false);
    if (session && ok) session.currysAddConfirmed = true;
    return;
  }
  if (site === 'waitrose.com' && stepName === 'add') {
    const ok = await page.waitForFunction(() => {
      const body = document.body?.innerText || '';
      if (/added to (?:your )?trolley|item(?:s)? added/i.test(body)) return true;
      for (const el of document.querySelectorAll('a[href*="/trolley"], [aria-label*="trolley" i], [class*="trolley" i]')) {
        const m = (el.textContent || el.getAttribute('aria-label') || '').match(/\d+/);
        if (m && parseInt(m[0], 10) > 0) return true;
      }
      return /\/trolley/i.test(location.pathname);
    }, { timeout: 5000, polling: 200 }).catch(() => false);
    if (session && ok) session.waitroseAddConfirmed = true;
    return;
  }
  if (['checkout', 'go-to-basket', 'add', 'modal-add', 'navigate'].includes(stepName)) {
    await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
  }
}

function isSearchResultsUrl(url) {
  try {
    const u = new URL(url);
    if (/\/search\b/i.test(u.pathname)) return true;
    if (/^\/s\/?$/i.test(u.pathname) && /[\?&]k=/i.test(u.search)) return true; // Amazon
    return /[\?&](?:q|text|query|searchterm)=/i.test(u.search);
  } catch { return false; }
}

// Order fast-path: on a search-results page, click the first visible product link — skips a
// vision call (~3–5s) that otherwise picks a result from the screenshot.
async function tryAdvanceDeliveryAddress(page, steps, onProgress) {
  const hit = await page.evaluate((sel) => {
    const pat = /^(continue|next|confirm|deliver here|deliver|search|find|go|submit)(\s|$)/i;
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const all = [...document.querySelectorAll(sel)];
    for (const el of all) {
      const t = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim();
      if (!pat.test(t)) continue;
      if (!visible(el)) continue;
      const idx = all.indexOf(el.closest(sel) || el);
      if (idx >= 0) return { idx, text: t.slice(0, 60) };
    }
    return null;
  }, CLICKABLE_SELECTOR).catch(() => null);
  if (!hit) {
    await page.keyboard.press('Enter').catch(() => {});
    return false;
  }
  onProgress(`Clicking "${hit.text}"…`);
  const locator = await page.evaluateHandle(
    ({ selector, idx }) => document.querySelectorAll(selector)[idx] || null,
    { selector: CLICKABLE_SELECTOR, idx: hit.idx }
  ).then((h) => h.asElement()).catch(() => null);
  if (!locator) return false;
  await locator.click({ timeout: 6000, force: true }).catch(() => false);
  await settle(page, 1200);
  return true;
}

async function tryPickDeliveryAddressSuggestion(session, steps, onProgress) {
  if (!isDeliveryHost(session.site) || session.deliveryAddressPicked) return false;
  const picked = await session.page.evaluate(() => {
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const el of document.querySelectorAll('[role="option"], [role="listbox"] li, li[class*="suggestion" i], [class*="autocomplete" i] li')) {
      if (!visible(el)) continue;
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (t.length < 8 || t.length > 200) continue;
      el.click();
      return t.slice(0, 100);
    }
    return null;
  }).catch(() => null);
  if (!picked) {
    const advanced = await tryAdvanceDeliveryAddress(session.page, steps, onProgress);
    if (advanced) {
      session.deliveryAddressPicked = true;
      session.history.push(`Step ${steps}: [delivery] advanced past address entry`);
      return true;
    }
    return false;
  }
  session.deliveryAddressPicked = true;
  onProgress(`Selected address "${picked.slice(0, 60)}"…`);
  session.history.push(`Step ${steps}: [checkout-profile] picked delivery address "${picked.slice(0, 80)}"`);
  await settle(session.page, 900);
  await tryAdvanceDeliveryAddress(session.page, steps, onProgress);
  return true;
}

async function tryDeliveryFoodSearch(page, session, steps, onProgress) {
  if (!session.isOrder || !isDeliveryHost(session.site) || session.deliveryFoodSearchDone) return false;
  if (!session.deliveryAddressPicked) return false;
  const goal = String(session.goal || '');
  const m = goal.match(/\b(pizza|burger|curry|sushi|chinese|indian|kebab|chicken|pasta|salad|coffee|breakfast)\b/i);
  const term = m ? m[1] : goal.match(/\border\s+(?:a\s+)?([a-z][a-z\s]{2,24}?)(?:\s+from|\s+near|\s*$)/i)?.[1]?.trim();
  if (!term) return false;
  const filled = await page.evaluate((query) => {
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const inputs = [...document.querySelectorAll('input[type="search"], input[placeholder*="search" i], input[aria-label*="search" i]')];
    for (const inp of inputs) {
      if (!visible(inp)) continue;
      inp.focus();
      inp.value = query;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }, term).catch(() => false);
  if (!filled) return false;
  await page.keyboard.press('Enter').catch(() => {});
  session.deliveryFoodSearchDone = true;
  onProgress(`Searching for "${term}"…`);
  session.history.push(`Step ${steps}: [delivery] searched for "${term}"`);
  await settle(page, 1200);
  return true;
}

async function tryProactiveOrderSearch(page, session, steps, onProgress) {
  if (!session.isOrder || session.proactiveSearchDone || session.cartEverNonzero || session.addClicked) return false;
  if (isDeliveryHost(session.site)) return false;
  let path = '';
  try { path = new URL(page.url()).pathname.replace(/\/+$/, ''); } catch { return false; }
  if (/\/p\/|\/prd\/|\/product\//i.test(path)) return false;
  if (path && !/^\/[a-z]{2}(?:[_-][a-z]{2})?$/i.test(path) && !isSearchResultsUrl(page.url())) return false;
  const term = deriveSearchTerm(session.goal, { names: [session.site?.split('.')[0] || ''] });
  if (!term) return false;
  const filled = await page.evaluate((query) => {
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const inputs = [...document.querySelectorAll('input[type="search"], input[name*="search" i], input[id*="search" i], input[placeholder*="search" i], input[aria-label*="search" i]')];
    for (const inp of inputs) {
      if (!visible(inp)) continue;
      inp.focus();
      inp.value = query;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }, term).catch(() => false);
  if (!filled) return false;
  await page.keyboard.press('Enter').catch(() => {});
  session.proactiveSearchDone = true;
  session.lastFilledValue = term;
  onProgress(`Searching for "${term}"…`);
  session.history.push(`Step ${steps}: [fastpath] searched for "${term}"`);
  await settle(page, 1200);
  return true;
}

async function tryOrderSearchPick(page, session) {
  if (!session.isOrder || session.searchPickDone || !isSearchResultsUrl(page.url())) return null;
  const hit = await page.evaluate((sel) => {
    const patterns = [/\/p\/[^/?#]+/i, /\/p\/\d+/i, /\/p\d+(?:\/|$)/i, /\/prd\//i, /\/product\//i, /\/dp\/[A-Z0-9]/i, /\/gp\/product\//i];
    const all = [...document.querySelectorAll(sel)];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (!patterns.some((p) => p.test(href))) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      const el = a.closest(sel) || a;
      const idx = all.indexOf(el);
      if (idx === -1) continue;
      const text = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (text.length < 3) continue;
      return { locatorIndex: idx, text };
    }
    return null;
  }, CLICKABLE_SELECTOR).catch(() => null);
  if (!hit) return null;
  session.searchPickDone = true;
  return { action: 'click', locatorIndex: hit.locatorIndex, text: hit.text, stepName: 'search-pick' };
}

// Click a visible checkout advance CTA (Continue/Next/Submit) — shared by email submit
// and post-email steps like "Continue to Delivery Options".
async function tryAdvanceCheckoutStep(session, page, steps, onProgress, { allowSubmit = true, skipGuest = false } = {}) {
  const emailFilled = session?.checkoutEmailFilled
    || !!(await page.locator('input[type="email"]:visible').first().inputValue().catch(() => ''));
  if (skipGuest || session?.checkoutEmailSubmitted) skipGuest = true;
  // Only treat a VISIBLE guest fork as blocking before email is on the page — Wickes keeps
  // the guest CTA in the DOM beside the email form.
  if (!emailFilled) {
    const guestFork = await page.evaluate((sel, patSource, patFlags) => {
      const pat = new RegExp(patSource, patFlags);
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return [...document.querySelectorAll(sel)].some((el) => visible(el) && pat.test((el.innerText || '').trim()));
    }, CLICKABLE_SELECTOR, GUEST_CHECKOUT_PATTERN.source, GUEST_CHECKOUT_PATTERN.flags).catch(() => false);
    if (guestFork) return false;
  }

  const hit = await page.evaluate((sel, allowSubmit, guestPatSource, guestPatFlags, emailFilled, skipGuest) => {
    const guestPat = new RegExp(guestPatSource, guestPatFlags);
    const wants = /^(continue|next|proceed|submit|save|confirm|deliver)(\s|$| to\b| &)/i;
    const all = [...document.querySelectorAll(sel)];
    const hasEmailValue = () => {
      for (const inp of document.querySelectorAll('input[type="email"], input[name*="email" i]')) {
        if ((inp.value || '').trim().length > 3) return true;
      }
      return false;
    };
    for (const el of all) {
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      if (guestPat.test(t)) {
        if (skipGuest) continue;
        const inForm = !!el.closest('form');
        const isSubmit = el.getAttribute('type') === 'submit';
        if (!(emailFilled && hasEmailValue() && (isSubmit || inForm))) continue;
      }
      const isSubmit = el.getAttribute('type') === 'submit';
      if (!wants.test(t) && !isSubmit) continue;
      if (!allowSubmit && isSubmit) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const node = el.closest(sel) || el;
      const idx = all.indexOf(node);
      if (idx >= 0) return { idx, text: t.slice(0, 80) || 'Continue' };
    }
    if (allowSubmit) {
      const sub = document.querySelector('button[type="submit"], input[type="submit"]');
      if (sub) {
        const idx = all.indexOf(sub);
        if (idx >= 0) return { idx, text: 'Submit' };
      }
    }
    return null;
  }, CLICKABLE_SELECTOR, allowSubmit, GUEST_CHECKOUT_PATTERN.source, GUEST_CHECKOUT_PATTERN.flags, emailFilled, skipGuest).catch(() => null);
  if (hit) {
    session.checkoutAdvanceClicked = session.checkoutAdvanceClicked || new Set();
    const advanceKey = `${page.url()}::${hit.text}`;
    if (session.checkoutAdvanceClicked.has(advanceKey)) return false;
    const locator = await page.evaluateHandle(
      ({ selector, idx }) => document.querySelectorAll(selector)[idx] || null,
      { selector: CLICKABLE_SELECTOR, idx: hit.idx }
    ).then((h) => h.asElement()).catch(() => null);
    if (locator) {
      onProgress(`Clicking "${hit.text}"…`);
      const beforeUrl = page.url();
      const beforeSnap = await checkoutPageSnapshot(page);
      await tryAcceptCheckoutCheckboxes(page);
      await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await locator.click({ timeout: 8000, force: true }).catch(() => false);
      await page.waitForURL((u) => u !== beforeUrl, { timeout: 4000 }).catch(() => {});
      await settle(page, 900);
      const advanced = await pageCheckoutStepAdvanced(page, beforeUrl, beforeSnap);
      if (!advanced) return false;
      session.checkoutAdvanceClicked.add(advanceKey);
      if (emailFilled && GUEST_CHECKOUT_PATTERN.test(hit.text)) session.checkoutEmailSubmitted = true;
      session.history.push(`Step ${steps}: [checkout-profile] clicked "${hit.text}" to advance checkout`);
      return true;
    }
  }

  const playwrightCandidates = [
    page.getByRole('button', { name: /continue to (?:delivery|payment|billing|checkout)|save (?:and )?continue|go to payment/i }),
    page.getByRole('button', { name: /^(continue|next|proceed)(\s|$| to\b)/i }),
    ...(emailFilled ? [page.getByRole('button', { name: /continue as guest|guest checkout/i })] : []),
    ...(allowSubmit ? [page.locator('button[type="submit"]:visible'), page.locator('input[type="submit"]:visible')] : []),
  ];
  for (const loc of playwrightCandidates) {
    const el = loc.first();
    const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
    if (!visible) continue;
    const text = (await el.innerText().catch(() => '') || await el.getAttribute('value').catch(() => '') || 'Continue').trim();
    if (GUEST_CHECKOUT_PATTERN.test(text) && (skipGuest || !emailFilled)) continue;
    session.checkoutAdvanceClicked = session.checkoutAdvanceClicked || new Set();
    const advanceKey = `${page.url()}::${text}`;
    if (session.checkoutAdvanceClicked.has(advanceKey)) continue;
    onProgress(`Clicking "${text.slice(0, 60)}"…`);
    const beforeUrl = page.url();
    const beforeSnap = await checkoutPageSnapshot(page);
    await tryAcceptCheckoutCheckboxes(page);
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await el.click({ timeout: 8000, force: true }).catch(() => false);
    await page.waitForURL((u) => u !== beforeUrl, { timeout: 4000 }).catch(() => {});
    await settle(page, 900);
    const advanced = await pageCheckoutStepAdvanced(page, beforeUrl, beforeSnap);
    if (!advanced) continue;
    session.checkoutAdvanceClicked.add(advanceKey);
    if (emailFilled && GUEST_CHECKOUT_PATTERN.test(text)) session.checkoutEmailSubmitted = true;
    session.history.push(`Step ${steps}: [checkout-profile] clicked "${text.slice(0, 60)}" to advance checkout`);
    return true;
  }
  return false;
}

// True when the guest-labelled control is the email-step submit (Currys/M&S), not a login fork.
function guestEmailSubmitLocator(page) {
  return page.locator('button, a, [role="button"], input[type="submit"]').filter({ hasText: /continue as guest|guest checkout/i }).first();
}

async function isGuestEmailSubmitStep(page) {
  const emailLoc = page.locator('input[type="email"]:visible, input[name*="email" i]:visible').first();
  if (!(await emailLoc.isVisible({ timeout: 400 }).catch(() => false))) return false;
  const emailVal = await emailLoc.inputValue().catch(() => '');
  if (!emailVal.trim()) return false;
  return guestEmailSubmitLocator(page).isVisible({ timeout: 400 }).catch(() => false);
}

// Lightweight DOM fingerprint for SPA checkouts (Currys/M&S/Selfridges) where URL stays put.
async function checkoutPageSnapshot(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    let emailVisible = false;
    let identityFields = 0;
    let postcodeVisible = false;
    let paymentHeading = false;
    let cardField = false;
    const body = (document.body?.innerText || '').slice(0, 4000);
    if (/\b(payment details?|pay(?:ment)? method|card details?|billing)\b/i.test(body)) paymentHeading = true;
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (!visible(el)) continue;
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (type === 'hidden' || type === 'password') continue;
      const hint = [
        el.getAttribute('name'), el.id, el.getAttribute('placeholder'),
        el.getAttribute('aria-label'), el.getAttribute('autocomplete'),
      ].join(' ').toLowerCase();
      if (/e-?mail/.test(hint) || type === 'email') { emailVisible = true; continue; }
      if (/post.?code|postal|zip/.test(hint)) postcodeVisible = true;
      if (/card|cc-number|cvv|cvc/.test(hint)) cardField = true;
      if (/given-name|family-name|first.?name|last.?name|surname|title|mobile|phone|tel\b|street|address|line.?1/.test(hint)) {
        identityFields++;
      }
    }
    const stepEl = document.querySelector('[aria-current="step"], [data-step][aria-selected="true"], .active[class*="step" i]');
    const stepLabel = stepEl ? (stepEl.innerText || stepEl.getAttribute('aria-label') || '').trim().slice(0, 80) : '';
    return { emailVisible, identityFields, postcodeVisible, paymentHeading, cardField, stepLabel };
  }).catch(() => ({
    emailVisible: false, identityFields: 0, postcodeVisible: false, paymentHeading: false, cardField: false, stepLabel: '',
  }));
}

async function pageCheckoutStepAdvanced(page, beforeUrl, beforeSnap) {
  const afterUrl = page.url();
  if (afterUrl !== beforeUrl) return true;
  try {
    const before = new URL(beforeUrl);
    const after = new URL(afterUrl);
    if (before.hash !== after.hash || before.search !== after.search) return true;
  } catch { /* keep going */ }
  if (await isCheckoutPaymentUrl(afterUrl)) return true;
  const afterSnap = await checkoutPageSnapshot(page);
  if (afterSnap.cardField || afterSnap.paymentHeading) return true;
  if (beforeSnap) {
    if (afterSnap.stepLabel && beforeSnap.stepLabel && afterSnap.stepLabel !== beforeSnap.stepLabel) return true;
    if (afterSnap.postcodeVisible && !beforeSnap.postcodeVisible) return true;
    if (afterSnap.identityFields > beforeSnap.identityFields && afterSnap.identityFields >= 2) return true;
    if (beforeSnap.emailVisible && !afterSnap.emailVisible) return true;
  }
  const identity = page.locator(
    'input[autocomplete="given-name"]:visible, input[name*="firstName" i]:visible, input[name*="first_name" i]:visible, select[name*="title" i]:visible'
  ).first();
  if (await identity.isVisible({ timeout: 800 }).catch(() => false)) return true;
  const emailGone = !(await page.locator('input[type="email"]:visible, input[name*="email" i]:visible').first()
    .isVisible({ timeout: 400 }).catch(() => false));
  return emailGone;
}

// Tick terms/marketing checkboxes that gate checkout CTAs (Currys/M&S often require this).
async function tryAcceptCheckoutCheckboxes(page) {
  const n = await page.evaluate(() => {
    let ticked = 0;
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
      if (!visible(cb) || cb.checked) continue;
      const label = cb.labels?.[0] || (cb.id && document.querySelector(`label[for="${CSS.escape(cb.id)}"]`));
      const hint = `${label?.innerText || ''} ${cb.name || ''} ${cb.id || ''}`.toLowerCase();
      if (/card|payment|cvv|cvc|save card/.test(hint)) continue;
      if (/terms|privacy|marketing|newsletter|agree|consent|contact|promotion|offer/.test(hint)) {
        cb.click();
        ticked++;
      }
    }
    return ticked;
  }).catch(() => 0);
  if (n > 0) await settle(page, 400);
  return n > 0;
}

// Currys/M&S: after email is in the form, "Continue as guest" is the submit — not a re-fork.
async function tryClickGuestEmailSubmit(page, session, steps, onProgress) {
  if (session.checkoutEmailSubmitted) return false;
  if (!(await isGuestEmailSubmitStep(page))) return false;
  session.checkoutAdvanceClicked = session.checkoutAdvanceClicked || new Set();
  const advanceKey = `${page.url()}::guest-email-submit`;
  if (session.checkoutAdvanceClicked.has(advanceKey)) return false;
  await tryAcceptCheckoutCheckboxes(page);
  const loc = guestEmailSubmitLocator(page);
  const text = (await loc.innerText().catch(() => '') || 'Continue as guest').trim();
  onProgress(`Clicking "${text}"…`);
  const beforeUrl = page.url();
  const beforeSnap = await checkoutPageSnapshot(page);
  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await loc.click({ timeout: 8000, force: true }).catch(() => false);
  await page.waitForURL((u) => u !== beforeUrl, { timeout: 4000 }).catch(() => {});
  await settle(page, 900);
  let advanced = await pageCheckoutStepAdvanced(page, beforeUrl, beforeSnap);
  if (!advanced) {
    const emailLoc = page.locator('input[type="email"]:visible, input[name*="email" i]:visible').first();
    await emailLoc.press('Enter').catch(() => {});
    await settle(page, 1200);
    advanced = await pageCheckoutStepAdvanced(page, beforeUrl, beforeSnap);
  }
  if (!advanced) {
    await settle(page, 2000);
    advanced = await pageCheckoutStepAdvanced(page, beforeUrl, beforeSnap)
      || !(await isGuestEmailSubmitStep(page));
  }
  if (!advanced) return false;
  session.checkoutAdvanceClicked.add(advanceKey);
  session.checkoutEmailSubmitted = true;
  session.history.push(`Step ${steps}: [checkout-profile] submitted guest email via "${text}"`);
  return true;
}

// After guest email fill, click Continue/Submit if visible — avoids a vision step.
async function trySubmitCheckoutEmail(session, page, steps, onProgress) {
  if (session?.checkoutEmailSubmitted) return false;
  if (await isGuestEmailSubmitStep(page)) {
    const guestSubmit = await tryClickGuestEmailSubmit(page, session, steps, onProgress);
    if (guestSubmit) return true;
  }
  if (!session.guestCheckoutDone) {
    const pwVisible = await page.locator(PASSWORD_FIELD_SELECTOR).first().isVisible().catch(() => false);
    if (pwVisible && (await pageHasGuestCheckoutCta(page) || isGuestCheckoutUrl(page.url()))) {
      const guest = await tryGuestCheckoutClick(page, session, steps, onProgress);
      if (guest) return true;
      return false;
    }
  }
  const ok = await tryAdvanceCheckoutStep(session, page, steps, onProgress, { allowSubmit: true });
  if (ok) session.checkoutEmailSubmitted = true;
  return ok;
}

function checkoutEmailFilledResult(session) {
  const n = session.history.length;
  return { type: 'awaiting_more', summary: `Working on your order — ${n} step${n === 1 ? '' : 's'} in…` };
}

async function completeCheckoutEmailFill(session, userId, page, steps, onProgress) {
  session.checkoutEmailFilled = true;
  await settle(page, 500);
  const submitted = await trySubmitCheckoutEmail(session, page, steps, onProgress);
  if (submitted) {
    session.guestCheckoutDone = true;
    touchSession(userId);
    await persistStorage(userId, session);
    return checkoutEmailFilledResult(session);
  }
  if (!session.guestCheckoutDone && (await pageHasGuestCheckoutCta(page) || isGuestCheckoutUrl(page.url()))) {
    const guestClicked = await tryGuestCheckoutClick(page, session, steps, onProgress);
    if (guestClicked) {
      touchSession(userId);
      await persistStorage(userId, session);
      return checkoutEmailFilledResult(session);
    }
  }
  touchSession(userId);
  await persistStorage(userId, session);
  return null;
}

// Generic checkout tail for non-Wickes sites: guest → email → details → advance → payment.
async function tryPaymentReady(session, page) {
  const elements = await extractClickableElements(page).catch(() => []);
  const payEl = elements.find((el) => matchesPaymentKeyword(el.text));
  if (payEl) {
    session.pendingPaymentLabel = payEl.text;
    return { type: 'ready_for_payment', summary: 'Checkout — payment step', total: '' };
  }
  if (isCheckoutPaymentUrl(page.url())) {
    session.pendingPaymentLabel = 'Pay';
    return { type: 'ready_for_payment', summary: 'Checkout — payment step', total: '' };
  }
  return null;
}

async function tryGenericCheckoutProgress(session, userId, page, steps, onProgress, elements) {
  const url = page.url();
  if (!session.isOrder || (!isCheckoutishUrl(url) && !isGuestCheckoutUrl(url))) return null;

  if (!session.guestCheckoutDone && !(await isGuestEmailSubmitStep(page))) {
    const guest = await tryGuestCheckoutClick(page, session, steps, onProgress);
    if (guest) return { advanced: true };
  }

  const profile = await getCheckoutProfileCached(session, userId);
  for (let pass = 0; pass < 4; pass++) {
    const ready = await tryPaymentReady(session, page);
    if (ready) return { ready, result: ready };

    if (session.guestCheckoutDone && profile.consent && !session.checkoutEmailSubmitted) {
      await page.waitForSelector('input[type="email"], input[name*="email" i], input[id*="email" i]', { state: 'visible', timeout: 1500 }).catch(() => {});
    }
    if (!session.checkoutEmailFilled && profile.email && profile.consent) {
      const filled = await autoFillCheckoutEmail(session, elements, profile.email, steps, onProgress);
      if (filled) {
        session.checkoutEmailFilled = true;
        await settle(page, 500);
        if (await trySubmitCheckoutEmail(session, page, steps, onProgress)) {
          session.guestCheckoutDone = true;
          return { advanced: true };
        }
        if (!session.guestCheckoutDone && await pageHasGuestCheckoutCta(page)) {
          await tryGuestCheckoutClick(page, session, steps, onProgress);
          return { advanced: true };
        }
      }
    } else if (session.checkoutEmailFilled && !session.checkoutEmailSubmitted) {
      if (await trySubmitCheckoutEmail(session, page, steps, onProgress)) return { advanced: true };
    } else if (profile.consent && (session.checkoutEmailSubmitted || session.guestCheckoutDone)) {
      if (profile.name || profile.address?.postcode || profile.phone) {
        await autoFillCheckoutDetails(session, profile, steps, onProgress);
      }
      await tryAcceptCheckoutCheckboxes(page);
      const advanced = await tryAdvanceCheckoutStep(session, page, steps, onProgress, {
        allowSubmit: true,
        skipGuest: !!session.checkoutEmailSubmitted,
      });
      if (advanced) return { advanced: true };
    }

    const readyMid = await tryPaymentReady(session, page);
    if (readyMid) return { ready: true, result: readyMid };
    if (pass < 3) await settle(page, 400);
  }

  const readyAfter = await tryPaymentReady(session, page);
  if (readyAfter) return { ready: true, result: readyAfter };
  return null;
}

async function navigateToSiteBasket(session, page, steps, onProgress) {
  const recipe = RECIPES[session.site];
  if (!recipe?.basketUrl) return false;
  if (session.basketNavDone) return false;
  let origin;
  try { origin = new URL(page.url()).origin; } catch { return false; }
  const dest = `${origin}${recipe.basketUrl}`;
  try {
    const cur = new URL(page.url());
    if (cur.pathname.replace(/\/+$/, '') === new URL(dest).pathname.replace(/\/+$/, '')) {
      session.basketNavDone = true;
      return false;
    }
  } catch { /* keep going */ }
  onProgress('Opening basket…');
  await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  session.basketNavDone = true;
  session.history.push(`Step ${steps}: [recipe] navigated to basket after add`);
  await settle(page, RECIPE_SETTLE_MS);
  return true;
}

async function runOrderingTurn(userId, { url, goal, location = null, onProgress = () => {} }) {
  // Started here, not after the session is open — a slow first-time browser launch +
  // page load must count against the same budget that bounds the step loop, or the
  // open alone can eat the mobile client's 45s watchdog before a single step runs.
  const startedAt = Date.now();
  if (!location) location = await loadUserLocation(userId);
  const retailOptions = { location };
  let session = getSession(userId);
  // A live session left open by a finished lookup (see the 'done' keep-alive below) is a
  // continuation ("order it") ONLY if it's the same site. If a new url points at a different
  // site, it's a fresh task — close the stale session so we open the right site, not continue
  // on the old product page.
  if (session && url && siteKeyFromUrl(url) !== session.site) {
    await closeSession(userId);
    session = null;
  }
  if (!session) {
    // No live session. Prefer the url we were handed; otherwise re-open where we left
    // off from persisted context so an idle-evicted order resumes instead of dead-ending.
    let openUrl = url;
    let priorHistory = null;
    if (!openUrl && goal) {
      const retailer = resolveRetailerFromGoal(goal, retailOptions);
      if (retailer) {
        openUrl = retailer.homeUrl;
        onProgress(`Opening ${retailer.displayName}…`);
      }
    }
    if (!openUrl) {
      const resume = await loadResumeContext(userId);
      if (!resume) {
        return { type: 'error', error: 'I don\'t have an order in progress to pick back up. Tell me what you\'d like and where to get it from, and I\'ll start fresh.' };
      }
      openUrl = resume.last_url;
      priorHistory = Array.isArray(resume.history) ? resume.history : [];
      // An empty incoming goal is a silent continuation — recover the real goal from
      // what was persisted rather than re-opening with nothing to work toward.
      goal = goal || resume.goal || '';
      onProgress('Picking up where we left off…');
    } else {
      onProgress('Opening browser…');
    }

    // Tier-0: for non-order (info/price/availability) goals, attempt a zero-browser
    // HTTP lookup first. Reuses existing derive/direct + parser. On confident price we
    // return immediately with a done; no session is created. On any miss (wall, no price
    // parseable, network), we fall through to the normal browser path unchanged.
    // Orders are strictly gated out (isOrderGoal) — they always use the real browser.
    if (!priorHistory && !isOrderGoal(goal || '')) {
      const tier0 = await tryTier0PriceLookup(openUrl, goal || '');
      if (tier0) {
        return tier0;
      }
    }

    try {
      session = await openNewSession(userId, openUrl, goal, retailOptions);
      if (priorHistory) {
        session.history = priorHistory;
        // A resumed session that already has steps is an order in progress — latch the
        // flag so a premature "done" (on a bare reply like "mcdonald's") can't close it.
        if (priorHistory.length) session.isOrder = true;
      }
      // Re-parse or keep context
      if (!session.goalContext) session.goalContext = parseGoalContext(goal || session.goal);
    } catch (error) {
      return { type: 'error', error: error.message };
    }
  } else {
    touchSession(userId);
    // Empty goal = silent continuation (auto-continue loop) — keep grinding on the
    // existing instruction instead of clobbering it. Non-empty = a real new reply/goal.
    if (goal) {
      session.goal = goal;
      session.isOrder = session.isOrder || isOrderGoal(goal); // latch once an order, always an order
      session.autoContinueCount = 0; // a real instruction resets the runaway guard
      // User replied with checkout identity (email, name, address, phone).
      if (session.isOrder) {
        const parsed = parseCheckoutReplyFromUserText(goal);
        if (Object.keys(parsed).length > 0) {
          const consent = wantsSaveDetailsConsent(goal);
          if (consent) {
            await saveCheckoutProfile(getSupabase(), userId, parsed, true);
            session.checkoutProfile = null; // force reload with updated values next step
          }
          session.pendingCheckoutFill = { fields: parsed };
        }
      }
    } else {
      session.autoContinueCount = (session.autoContinueCount || 0) + 1;
    }
  }

  // Backstop against auto-continuing forever. Set high enough to carry a long-but-healthy
  // order all the way to the pay button (it stops there for confirmation anyway) — this
  // only trips on a genuinely runaway loop, where a human check-in is the right call.
  // Only an order is about food/delivery; a "find me a pair", "check the listing" etc.
  // is a plain browse — its copy must not talk about orders, restaurants or Deliveroo.
  const taskNoun = session.isOrder ? 'order' : 'task';
  if ((session.autoContinueCount || 0) > 40) {
    return { type: 'ask', question: `This ${taskNoun} is taking an unusually long time — want me to keep trying, or stop here?` };
  }

  let steps = 0;
  let consecutiveBadDecisions = session.consecutiveBadDecisions || 0;
  let consecutiveWaits = session.consecutiveWaits || 0;
  // A click on a VALID element "succeeds" even when it achieves nothing, so the bad-decision
  // guard never trips on a model that re-clicks the same tile forever (seen on the Uber Eats
  // item modal). Track the last action's signature and nudge, then trip, on repeats.
  // Persisted on the session so the guard survives across turns — without this, the model
  // resets to zero each auto-continue and can spin on the same element indefinitely.
  let lastActionSig = session.lastActionSig || '';
  let repeatActionCount = session.repeatActionCount || 0;
  // Progress sigs persisted on session (cross-turn) — the core guard against click-wait cycles
  // that reset per-action counters. See computeProgressSignature.
  let lastProgressSig = session.lastProgressSig || '';
  let stepsSinceProgress = session.stepsSinceProgress || 0;
  // Steps since the page reached a state we had NOT already visited this session — the
  // wandering/cycling detector. Backed by session.seenStateKeys (see assessProgress).
  let stepsSinceNewState = session.stepsSinceNewState || 0;
  // Order-only slow backstop: steps with the basket still empty. Only meaningful alongside
  // the new-state counter — normal browsing keeps this climbing for 7-12 steps legitimately.
  let stepsSinceCartProgress = session.stepsSinceCartProgress || 0;
  // When the model picks an element that isn't on the page (a hallucinated id, e.g. a
  // price read off the screen), we feed a pointed correction into the NEXT decision so it
  // can fix itself — instead of silently re-asking the identical prompt against the same
  // screenshot, which just reproduces the same bad id until the stuck-guard trips.
  let pendingCorrection = '';
  // One calm line when we genuinely can't make progress — never a loop of asks, never a
  // request for a URL/selector. Keeps the session open so "keep going" can retry.
  const STUCK = { type: 'error', error: session.isOrder
    ? 'I got stuck on this page and couldn\'t make progress. Want me to try a different site or platform?'
    : 'I got stuck on this page and couldn\'t make progress. Want me to try a different site, or take another approach?' };

  if (session.isOrder && !session.checkoutProfile) {
    session.checkoutProfile = await loadCheckoutProfile(getSupabase(), userId);
  }

  try {
    while (steps < MAX_STEPS && Date.now() - startedAt < MAX_DURATION_MS) {
      steps += 1;
      session.consecutiveWaits = consecutiveWaits;
      session.consecutiveBadDecisions = consecutiveBadDecisions;
      session.lastProgressSig = lastProgressSig;
      session.stepsSinceProgress = stepsSinceProgress;
      session.stepsSinceNewState = stepsSinceNewState;
      session.stepsSinceCartProgress = stepsSinceCartProgress;
      onProgress('Looking at the page…');
      const stepSettleMs = session.lastWasRecipe ? RECIPE_SETTLE_MS : STEP_SETTLE_MS;
      session.lastWasRecipe = false;
      await timed('step.settle', () => settle(session.page, stepSettleMs)); // let any in-flight render finish before we look
      // Learn a fast-path: if the last thing we typed now shows up as a query param in the
      // URL, we've discovered this site's search-results template. Don't override a code seed.
      if (session.lastFilledValue) {
        const learned = learnTemplateFromUrl(session.page.url(), session.lastFilledValue);
        if (learned && !SEARCH_SITES[learned.host]) {
          fastpathStore.learn(learned.host, learned.param, learned.template);
          session.lastFilledValue = null; // captured — stop probing for it
        }
        // else keep it: a search box is often filled one step and submitted the next, so the
        // results URL may not exist yet. A later fill overwrites it; it never overrides a seed.
      }
      // Consent walls are often injected LATE — after the initial open-time dismiss has
      // already run — and they overlay the real page, so the model wastes every step
      // choosing banner junk. Keep trying until one is caught, then stop (cheap no-op
      // once gone). This is what was silently breaking john lewis: search worked, but
      // the results stayed hidden behind a modal that appeared a beat after page load.
      if (!session.consentHandled) {
        if (await dismissConsent(session.page).catch(() => false)) {
          session.consentHandled = true;
          await settle(session.page, OPEN_POST_CONSENT_MS);
        } else if (steps >= 4) {
          const bannerOpen = await session.page.locator('[data-testid="modal"], dialog[open]').first()
            .isVisible({ timeout: 200 }).catch(() => false);
          if (!bannerOpen) session.consentHandled = true;
        }
      }

      // --- Unified progress detector (PRIORITY 1) ---------------------------------------
      // Three signals, combined in assessProgress (thresholds pinned by unit tests):
      //  1. exact sig unchanged        → frozen page (wait-loops, dead clicks)
      //  2. no NEW stateKey seen       → cycling/revisiting (the real spin patterns), while
      //     forward flows reset it every step because each page is new
      //  3. basket empty for very long → order-only backstop so a never-committing browse
      //     still bails fast (~turn 2) instead of burning the full turn budget
      // The old detector bailed on signal 3 alone at 7 steps, which is INSIDE the range a
      // normal search→PDP→size→add flow needs — it killed M&S/Currys/Wickes/Nike/Deliveroo
      // mid-browse in one turn. Persisted via session so all of it survives auto-continue.
      const prog = await timed('step.progress-sig', () => computeProgressSignature(session.page)).catch(() => null);
      const currentSig = prog ? prog.sig : (session.page.url() || '');
      if (currentSig && currentSig === lastProgressSig) {
        stepsSinceProgress += 1;
      } else if (currentSig) {
        lastProgressSig = currentSig;
        stepsSinceProgress = 0;
      }
      session.lastProgressSig = lastProgressSig;
      session.stepsSinceProgress = stepsSinceProgress;

      // Seen-set of coarse page states: a state we've already visited (or never leaving the
      // current one) counts toward "no new state"; a genuinely new page resets the counter.
      const stateKey = prog ? prog.stateKey : currentSig;
      session.seenStateKeys = session.seenStateKeys || [];
      if (stateKey && !session.seenStateKeys.includes(stateKey)) {
        session.seenStateKeys.push(stateKey);
        if (session.seenStateKeys.length > 80) session.seenStateKeys.shift();
        stepsSinceNewState = 0;
      } else {
        stepsSinceNewState += 1;
      }
      session.stepsSinceNewState = stepsSinceNewState;

      const currCount = prog ? prog.itemCount : 0;
      if (currCount > 0) {
        stepsSinceCartProgress = 0;
        session.cartEverNonzero = true; // basket badge seen non-empty → backstop off for good
      } else {
        stepsSinceCartProgress += 1;
      }
      session.stepsSinceCartProgress = stepsSinceCartProgress;

      const assessed = assessProgress(
        { stepsSinceProgress, stepsSinceNewState, stepsSinceCartProgress },
        { isOrder: session.isOrder, cartEverNonzero: session.cartEverNonzero }
      );
      if (assessed.verdict === 'stuck') {
        // Reset counters before bailing so a user "keep going" gets fresh room to retry
        // instead of instantly re-tripping on the persisted values.
        session.stepsSinceProgress = 0;
        session.stepsSinceNewState = 0;
        session.stepsSinceCartProgress = 0;
        return STUCK;
      }
      if (assessed.verdict === 'nudge') {
        pendingCorrection = assessed.correction;
      }

      const elements = await timed('step.extract', () => extractClickableElements(session.page));

      // ponytail: debug-only — dump what the model can act on each step (pairs with the
      // step-N.jpg screenshots below) so element-extraction bugs are diagnosable offline.
      if (process.env.OXY_DEBUG_SCREENSHOT_DIR) {
        require('fs').writeFile(`${process.env.OXY_DEBUG_SCREENSHOT_DIR}/step-${steps}.elements.json`,
          JSON.stringify({ url: session.page.url(), elements: elements.map(e => ({ id: e.id, text: e.text, box: e.box && { x: Math.round(e.box.x), y: Math.round(e.box.y) } })) }, null, 1), () => {});
      }

      // Discover deals/coupons/promos on every step (visible text + element labels). This
      // feeds richer context so the final answer can be conversational and useful ("found it
      // for £45 + 20% code SUMMER visible").
      try {
        const pageText = await session.page.evaluate(() => (document.body && document.body.innerText || '')).catch(() => '');
        const dealText = [pageText, ...elements.map(e => e.text || '')].join(' ');
        const found = extractVisibleDeals(dealText);
        if (found.length) {
          session.discoveredDeals = session.discoveredDeals || [];
          for (const d of found) if (!session.discoveredDeals.includes(d)) session.discoveredDeals.push(d);
        }
      } catch {}

      // Login wall: fire whenever the URL changes — catches both expired sessions and
      // first-time sign-in gates that appear mid-flow (e.g. after clicking checkout).
      // Cheap: URL pattern check is a string test; DOM read only when URL matches or has
      // a password field. Session stays open so "keep going" resumes the same order.
      const currentUrl = session.page.url();
      // Guest fork: click before vision/email — extraction often misses the CTA on sparse pages.
      if (session.isOrder && !session.guestCheckoutDone
        && !(session.checkoutEmailFilled && !session.checkoutEmailSubmitted)
        && !(await isGuestEmailSubmitStep(session.page))
        && (isGuestCheckoutUrl(currentUrl) || isCheckoutishUrl(currentUrl) || findGuestCheckoutElement(elements))) {
        const guestClicked = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
        if (guestClicked) {
          await settle(session.page, RECIPE_SETTLE_MS);
          consecutiveBadDecisions = 0;
          consecutiveWaits = 0;
          touchSession(userId);
          await persistStorage(userId, session);
          continue;
        }
      }
      if (session.isOrder && session.guestCheckoutDone && isCheckoutishUrl(currentUrl)) {
        const pwVisible = await session.page.locator(PASSWORD_FIELD_SELECTOR).first().isVisible().catch(() => false);
        if (pwVisible && (await pageHasGuestCheckoutCta(session.page) || findGuestCheckoutElement(elements))) {
          session.guestCheckoutDone = false;
          session.checkoutEmailFilled = false;
          session.checkoutEmailSubmitted = false;
          const guestRetry = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
          if (guestRetry) {
            await settle(session.page, RECIPE_SETTLE_MS);
            consecutiveBadDecisions = 0;
            continue;
          }
        }
      }
      if (currentUrl !== session.lastLoginCheckUrl) {
        session.lastLoginCheckUrl = currentUrl;
        if (await detectLoginWall(session.page, session.goal)) {
          if (!session.guestCheckoutDone) {
            const guestClicked = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
            if (guestClicked) {
              await settle(session.page, RECIPE_SETTLE_MS);
              consecutiveBadDecisions = 0;
              consecutiveWaits = 0;
              touchSession(userId);
              await persistStorage(userId, session);
              continue;
            }
            if (isGuestCheckoutUrl(session.page.url())) {
              await settle(session.page, 300);
              const retryGuest = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
              if (retryGuest) {
                await settle(session.page, RECIPE_SETTLE_MS);
                consecutiveBadDecisions = 0;
                consecutiveWaits = 0;
                touchSession(userId);
                await persistStorage(userId, session);
                continue;
              }
            }
          }
          if (isGuestCheckoutUrl(session.page.url()) || /^checkout\./i.test((() => { try { return new URL(session.page.url()).hostname; } catch { return ''; } })())) {
            if (!session.guestCheckoutDone) {
              await settle(session.page, 400);
              continue;
            }
          }
          session.loginWallAttempts = (session.loginWallAttempts || 0) + 1;
          if (session.loginWallAttempts < 4) {
            const guestRetry = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
            if (guestRetry) {
              await settle(session.page, RECIPE_SETTLE_MS);
              consecutiveBadDecisions = 0;
              continue;
            }
            await settle(session.page, 400);
            continue;
          }
          const siteName = session.site ? session.site.replace(/\.(com|co\.uk|co|net|org)$/i, '') : 'the site';
          return { type: 'reauth', site: session.site, question: `I need to sign in to ${siteName} to continue your order — once you've signed in, say "keep going" and I'll carry on from where I left off.` };
        }
      }

      // Generic checkout pipeline (guest → identity → payment) for all non-Wickes hosts.
      if (session.isOrder && (isCheckoutishUrl(currentUrl) || isGuestCheckoutUrl(currentUrl))) {
        const generic = await tryGenericCheckoutProgress(session, userId, session.page, steps, onProgress, elements);
        if (generic?.result) {
          touchSession(userId);
          await persistStorage(userId, session);
          return generic.result;
        }
        if (generic?.advanced) {
          consecutiveBadDecisions = 0;
          consecutiveWaits = 0;
          touchSession(userId);
          await persistStorage(userId, session);
          await settle(session.page, RECIPE_SETTLE_MS);
          continue;
        }
      }

      // Guest-checkout identity fills — AFTER login-wall/guest fork so we never fill on the
      // sign-in page before clicking "Checkout as a guest".
      if (session.isOrder && session.pendingCheckoutFill?.fields) {
        const fields = session.pendingCheckoutFill.fields;
        session.pendingCheckoutFill._attempts = (session.pendingCheckoutFill._attempts || 0) + 1;
        // Email: keep the v1 submit-after-fill path.
        if (fields.email) {
          const filled = await autoFillCheckoutEmail(session, elements, fields.email, steps, onProgress);
          if (filled) {
            delete fields.email;
            if (!Object.keys(fields).length) session.pendingCheckoutFill = null;
            const out = await completeCheckoutEmailFill(session, userId, session.page, steps, onProgress);
            if (out) return out;
            continue;
          }
        }
        // Other fields (name/phone/address): multi-field fill, no auto-submit.
        const nonEmailFields = Object.keys(fields).filter((k) => k !== 'email');
        if (nonEmailFields.length > 0) {
          const cached = await getCheckoutProfileCached(session, userId);
          const mergedProfile = {
            name: fields.name || cached.name,
            phone: fields.phone || cached.phone,
            address: fields.address || cached.address,
            email: fields.email || cached.email,
          };
          const count = await autoFillCheckoutDetails(session, mergedProfile, steps, onProgress);
          if (count > 0) {
            nonEmailFields.forEach((k) => delete fields[k]);
            if (!Object.keys(fields).length) session.pendingCheckoutFill = null;
            touchSession(userId);
            await persistStorage(userId, session);
            const advanced = await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: false });
            if (advanced) {
              await settle(session.page, RECIPE_SETTLE_MS);
              continue;
            }
            return checkoutEmailFilledResult(session);
          }
          if (session.pendingCheckoutFill._attempts < 6) {
            touchSession(userId);
            await persistStorage(userId, session);
            await settle(session.page, 600);
            continue;
          }
        }
        // Give up on pending fill after repeated attempts to avoid a stuck loop
        if (session.pendingCheckoutFill && session.pendingCheckoutFill._attempts >= 6) {
          session.pendingCheckoutFill = null;
        }
      } else if (session.isOrder && session.guestCheckoutDone && !session.checkoutEmailFilled) {
        const profile = await getCheckoutProfileCached(session, userId);
        if (profile.email && profile.consent) {
          await session.page.waitForSelector('input[type="email"]', { state: 'visible', timeout: 4000 }).catch(() => {});
          const filled = await autoFillCheckoutEmail(session, elements, profile.email, steps, onProgress);
          if (filled) {
            const out = await completeCheckoutEmailFill(session, userId, session.page, steps, onProgress);
            if (out) return out;
            continue;
          }
        }
      } else if (session.isOrder && session.checkoutEmailFilled && !session.checkoutEmailSubmitted) {
        const submitted = await trySubmitCheckoutEmail(session, session.page, steps, onProgress);
        if (submitted) {
          await settle(session.page, RECIPE_SETTLE_MS);
          consecutiveBadDecisions = 0;
          consecutiveWaits = 0;
          touchSession(userId);
          await persistStorage(userId, session);
          continue;
        }
      } else if (session.isOrder && session.checkoutEmailFilled && session.checkoutEmailSubmitted) {
        const profile = await getCheckoutProfileCached(session, userId);
        if (profile.consent && profile.name && (profile.address?.line1 || profile.address?.postcode)) {
          const count = await autoFillCheckoutDetails(session, profile, steps, onProgress);
          if (count > 0) {
            touchSession(userId);
            await persistStorage(userId, session);
          }
        }
        const advanced = await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: false });
        if (advanced) {
          await settle(session.page, RECIPE_SETTLE_MS);
          consecutiveBadDecisions = 0;
          consecutiveWaits = 0;
          touchSession(userId);
          await persistStorage(userId, session);
          continue;
        }
      }

      // Bail on a blocked page — two shapes, both meaning "the site won't serve us a real
      // page". (a) An empty/stripped shell on the FIRST step (near-zero text). (b) An
      // anti-automation interstitial on ANY step: many sites serve a full page, then swap in
      // an "Access Denied"/Cloudflare challenge AFTER a search (Next & Argos did exactly
      // this), which the size guard misses because the wall page isn't empty. Detecting the
      // copy stops the loop auto-continuing for turns against a dead page.
      const emptyShell = steps === 1 && elements.length < 3 &&
        (await session.page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0)) < 200;
      if (emptyShell || await detectBlockWall(session.page)) {
        return blockedPageResult(session);
      }

      // Tier-2 deterministic recipe: on stable steps (size → add → basket → checkout) a
      // hand-written selector move replaces the vision call. Cheap; falls through to the
      // model whenever it can't confidently resolve (returns null). See browser-recipes.js.
      let decision, recipeStepName = null;
      if (session.isOrder && !session.cartEverNonzero && !session.proactiveSearchDone) {
        const searched = await tryProactiveOrderSearch(session.page, session, steps, onProgress);
        if (searched) {
          consecutiveBadDecisions = 0;
          consecutiveWaits = 0;
          touchSession(userId);
          await persistStorage(userId, session);
          continue;
        }
      }
      if (isDeliveryHost(session.site) && session.isOrder && session.deliveryAddressPicked && !session.deliveryFoodSearchDone) {
        const foodSearched = await tryDeliveryFoodSearch(session.page, session, steps, onProgress);
        if (foodSearched) {
          consecutiveBadDecisions = 0;
          consecutiveWaits = 0;
          touchSession(userId);
          await persistStorage(userId, session);
          continue;
        }
      }
      if (isDeliveryHost(session.site) && session.isOrder && !session.deliveryAddressPicked) {
        const profile = await getCheckoutProfileCached(session, userId);
        const postcode = (session.goal || '').match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})\b/i)?.[1]
          || profile.address?.postcode;
        if (postcode) {
          const addrFilled = await session.page.evaluate((pc) => {
            const visible = (el) => {
              const s = window.getComputedStyle(el);
              if (s.visibility === 'hidden' || s.display === 'none') return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            };
            for (const inp of document.querySelectorAll('input')) {
              if (!visible(inp)) continue;
              const hint = `${inp.placeholder || ''} ${inp.getAttribute('aria-label') || ''} ${inp.name || ''}`.toLowerCase();
              if (!/address|postcode|post code|delivery|location/.test(hint)) continue;
              inp.focus();
              inp.value = pc;
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            return false;
          }, postcode).catch(() => false);
          if (addrFilled) {
            onProgress('Confirming delivery address…');
            await session.page.keyboard.press('Enter').catch(() => {});
            await settle(session.page, 600);
            await tryPickDeliveryAddressSuggestion(session, steps, onProgress);
            await tryAdvanceDeliveryAddress(session.page, steps, onProgress);
            await settle(session.page, 900);
            touchSession(userId);
            await persistStorage(userId, session);
            continue;
          }
        }
      }
      const searchPick = session.isOrder ? await tryOrderSearchPick(session.page, session) : null;
      const recipe = RECIPES_ENABLED ? selectRecipeForHost(session.site) : null;
      let recipeMove = !searchPick && recipe ? await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null) : null;

      // Convention recipe: poll basket badge before re-firing add (Selfridges etc).
      if (!RECIPES[session.site] && !isDeliveryHost(session.site) && session.convAddSent && !session.convAddConfirmed) {
        await waitAfterRecipeStep(session.page, session.site, 'add', session);
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (recipeMove?.stepName === 'add' && session.convAddSent && !RECIPES[session.site]) {
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      // John Lewis: add click may lag — poll basket badge before re-firing add.
      if (session.site === 'johnlewis.com' && session.jlAddSent && !session.jlAddConfirmed) {
        await waitAfterRecipeStep(session.page, session.site, 'add', session);
        if (!session.jlAddConfirmed) {
          recipeHealth.recordMiss(session.site, 'add');
          session.jlAddGiveUp = true;
        }
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (session.jlAddGiveUp && recipeMove?.stepName === 'add') recipeMove = null;
      if (session.site === 'nike.com' && session.nikeAddSent && !session.nikeAddConfirmed) {
        await waitAfterRecipeStep(session.page, session.site, 'add', session);
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (recipeMove?.stepName === 'add' && session.nikeAddSent && session.site === 'nike.com') {
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (session.site === 'marksandspencer.com' && session.msAddSent && !session.msAddConfirmed) {
        await waitAfterRecipeStep(session.page, session.site, 'add', session);
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (recipeMove?.stepName === 'add' && session.msAddSent && session.site === 'marksandspencer.com') {
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (session.site === 'asos.com' && session.asosAddSent && !session.asosAddConfirmed) {
        await waitAfterRecipeStep(session.page, session.site, 'add', session);
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (recipeMove?.stepName === 'add' && session.asosAddSent && session.site === 'asos.com') {
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (session.site === 'screwfix.com' && session.screwfixAddSent && !session.screwfixAddConfirmed) {
        await waitAfterRecipeStep(session.page, session.site, 'add', session);
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (recipeMove?.stepName === 'add' && session.screwfixAddSent && session.site === 'screwfix.com') {
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (session.site === 'currys.co.uk' && session.currysAddSent && !session.currysAddConfirmed) {
        await waitAfterRecipeStep(session.page, session.site, 'add', session);
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (recipeMove?.stepName === 'add' && session.currysAddSent && session.site === 'currys.co.uk') {
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (session.site === 'waitrose.com' && session.waitroseAddSent && !session.waitroseAddConfirmed) {
        await waitAfterRecipeStep(session.page, session.site, 'add', session);
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (recipeMove?.stepName === 'add' && session.waitroseAddSent && session.site === 'waitrose.com') {
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      // Delivery: modal-add must register in the cart before re-clicking Add.
      if (isDeliveryHost(session.site) && session.deliveryAddSent && !session.deliveryAddConfirmed) {
        await waitAfterRecipeStep(session.page, session.site, 'modal-add', session);
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (recipeMove?.stepName === 'modal-add' && session.deliveryAddSent && session.deliveryAddConfirmed) {
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (recipeMove?.stepName === 'add' && session.jlAddSent && session.site === 'johnlewis.com') {
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      // Guest fork: recipe guest step beats a ~2s vision call on login-or-guest pages.
      if (!recipeMove && session.isOrder && !session.guestCheckoutDone
        && (isGuestCheckoutUrl(session.page.url()) || isCheckoutishUrl(session.page.url())) && recipe) {
        recipeMove = await nextRecipeMove(session.page, session, recipe, recipeHealth).catch(() => null);
      }
      if (recipeMove?.stepName === 'guest' && (session.guestCheckoutDone || await isGuestEmailSubmitStep(session.page))) {
        if (await isGuestEmailSubmitStep(session.page)) {
          const submitted = await tryClickGuestEmailSubmit(session.page, session, steps, onProgress)
            || await trySubmitCheckoutEmail(session, session.page, steps, onProgress);
          if (submitted) {
            session.guestCheckoutDone = true;
            await settle(session.page, RECIPE_SETTLE_MS);
            consecutiveBadDecisions = 0;
            touchSession(userId);
            await persistStorage(userId, session);
            continue;
          }
        }
        recipeMove = null;
      }
      // Recipe advance must verify page movement — blind clicks on "Continue to delivery"
      // spin forever on SPAs (Selfridges, M&S) when identity fields still need filling.
      if (recipeMove?.stepName === 'advance') {
        const stallProfile = await getCheckoutProfileCached(session, userId);
        if (stallProfile.consent) await autoFillCheckoutDetails(session, stallProfile, steps, onProgress);
        const advanced = await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: true, skipGuest: true });
        if (advanced) {
          const sameStep = session.lastRecipeStep === 'advance';
          session.lastRecipeStep = 'advance';
          session.recipeStepRepeats = sameStep ? (session.recipeStepRepeats || 0) + 1 : 0;
          stepsSinceProgress = 0;
          stepsSinceNewState = 0;
          await settle(session.page, RECIPE_SETTLE_MS);
          const ready = await tryPaymentReady(session, session.page);
          if (ready) {
            touchSession(userId);
            await persistStorage(userId, session);
            return ready;
          }
          consecutiveBadDecisions = 0;
          touchSession(userId);
          await persistStorage(userId, session);
          continue;
        }
        const sameStep = session.lastRecipeStep === 'advance';
        session.lastRecipeStep = 'advance';
        session.recipeStepRepeats = sameStep ? (session.recipeStepRepeats || 0) + 1 : 1;
        if (session.recipeStepRepeats >= 2) recipeHealth.recordMiss(session.site, 'advance');
        const generic = await tryGenericCheckoutProgress(session, userId, session.page, steps, onProgress, await extractClickableElements(session.page).catch(() => []));
        if (generic?.result) {
          touchSession(userId);
          await persistStorage(userId, session);
          return generic.result;
        }
        if (generic?.advanced) {
          await settle(session.page, RECIPE_SETTLE_MS);
          consecutiveBadDecisions = 0;
          touchSession(userId);
          await persistStorage(userId, session);
          continue;
        }
        recipeMove = null;
      }
      // John Lewis ship-from-store: bail before vision spins on express checkout.
      if (!recipeMove && !searchPick && session.isOrder && session.site === 'johnlewis.com' && !session.jlExpressOnlyNoted) {
        try {
          const u = new URL(session.page.url());
          if (/\/p\d+(?:\b|\/|$)/i.test(u.pathname) && await isJohnLewisExpressOnlyPdp(session.page)) {
            session.jlExpressOnlyNoted = true;
            return {
              type: 'error',
              error: 'This John Lewis item is ship-from-store only (Express checkout) — I can\'t add it to a standard basket here. Want me to find it at another retailer, or pick a similar item with normal delivery?',
            };
          }
        } catch { /* keep going */ }
      }
      if (searchPick) {
        decision = searchPick;
        recipeStepName = searchPick.stepName;
      } else if (recipeMove) {
        decision = recipeMove;
        recipeStepName = recipeMove.stepName;
      } else {
        const screenshot = await timed('step.screenshot', () => captureMarkedScreenshot(session.page, elements).catch(() => null));
        // ponytail: debug-only — set OXY_DEBUG_SCREENSHOT_DIR to dump what the model sees
        // at each step, to eyeball that badges land on real controls. No-op when unset.
        if (screenshot && process.env.OXY_DEBUG_SCREENSHOT_DIR) {
          require('fs').writeFile(`${process.env.OXY_DEBUG_SCREENSHOT_DIR}/step-${steps}.jpg`, Buffer.from(screenshot, 'base64'), () => {});
        }
        decision = await timed('step.decide', () => decideNextAction(session.goal, session.history, elements, screenshot, pendingCorrection, session.goalContext));
        pendingCorrection = ''; // consumed — only applies to the one retry it was raised for
      }

      if (decision.action === 'invalid') {
        consecutiveBadDecisions += 1;
        session.history.push(`Step ${steps}: could not decide an action (${decision.error})`);
        if (consecutiveBadDecisions >= 3) return STUCK;
        continue;
      }

      if (decision.action === 'wait') {
        session.history.push(`Step ${steps}: waited for the page to settle`);
        await session.page.waitForTimeout(1500);
        consecutiveBadDecisions = 0;
        consecutiveWaits += 1;
        // "wait" is benign once, but a model that waits forever (e.g. it reads a lazy-load
        // skeleton as "still loading") never makes progress and never trips the stuck
        // guard. After a few, nudge it to act; if it STILL only waits, treat it as stuck.
        if (consecutiveWaits >= 3) {
          pendingCorrection = 'You have chosen "wait" several times in a row. The page has finished loading. Do NOT wait again — look at the screenshot and take a concrete action (click or fill) that moves toward the goal now.';
        }
        if (consecutiveWaits >= 6) {
          consecutiveBadDecisions += 1;
          if (consecutiveBadDecisions >= 3) return STUCK;
        }
        continue;
      }

      if (decision.action === 'back') {
        // History navigation is a real primitive: "this product can't fulfil the goal (size
        // out of stock) → return to the results" must work even when the site's own back
        // affordances are hidden (Nike's auto-hiding header). Counts as a real action.
        await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await settle(session.page);
        const why = decision.note ? ` (${String(decision.note).replace(/\s+/g, ' ').slice(0, 80)})` : '';
        session.history.push(`Step ${steps}: went back to the previous page${why}`);
        consecutiveBadDecisions = 0;
        consecutiveWaits = 0;
        continue;
      }

      if (decision.action === 'done') {
        // For an order, "done" inside the loop is always premature — a real order only
        // completes via ready_for_payment → confirmPayment. Don't throw away the cart.
        if (session.isOrder) {
          consecutiveBadDecisions += 1;
          session.history.push(`Step ${steps}: ignored a premature "done" (order isn't placed yet)`);
          if (consecutiveBadDecisions >= 3) {
            return { type: 'awaiting_more', summary: 'Paused — tell me the next step (which item, size, or deal) and I\'ll carry on.' };
          }
          continue;
        }
        // Goal answered via a fast-path → the learned/seed template worked; reward it.
        if (session.usedFastpath) fastpathStore.recordOutcome(session.usedFastpath, true);
        // Keep the browser open on a finished lookup: "what's the price of X" is often followed
        // by "order it" / "add it to my basket". Leaving the session on its current product page
        // lets that follow-up continue right here instead of reopening from scratch. Idle
        // eviction (SESSION_IDLE_MS) reclaims it if no follow-up comes; a different-site task
        // closes it via the same-site guard at the top of runOrderingTurn.
        touchSession(userId);
        await persistStorage(userId, session);
        const ctx = session.goalContext || {};
        let nice = decision.summary || 'Done.';
        const deals = (session.discoveredDeals || []).slice(0, 3);
        // Make final answer conversational + include discovered value (size/color from goal + deals)
        if (ctx.size || ctx.color || ctx.budget || deals.length) {
          const bits = [];
          if (ctx.color) bits.push(ctx.color);
          if (ctx.size) bits.push(`size ${ctx.size}`);
          const desc = bits.length ? bits.join(' ') + ' ' : '';
          nice = `Found the ${desc}for you${ctx.budget ? ` (under £${ctx.budget})` : ''}. ${decision.summary || ''}`.trim();
          if (deals.length) {
            nice += ` Deals I spotted: ${deals.join(' • ')}.`;
          }
        }
        return { type: 'done', text: nice };
      }

      if (decision.action === 'ask') {
        // The model hit a bot/security wall (often a Cloudflare iframe detectBlockWall can't
        // read) and is asking the user what to do. Don't surface a confusing technical ask —
        // bail cleanly, same as a detected wall, so the user gets "try another site", not
        // "there's a Cloudflare screen".
        if (describesBlockWall(decision.question)) {
          return blockedPageResult(session);
        }
        // Never surface a technical question. Treat it as a stuck step and retry instead.
        if (isTechnicalAsk(decision.question)) {
          consecutiveBadDecisions += 1;
          session.history.push(`Step ${steps}: suppressed a technical question ("${String(decision.question).slice(0, 60)}")`);
          if (consecutiveBadDecisions >= 3) return STUCK;
          await session.page.waitForTimeout(1200);
          continue;
        }
        // Order-only: auto-fill checkout identity when stored with consent; else ask once.
        if (session.isOrder) {
          if (/\b(password|sign[- ]?in|log[- ]?in|requires? a sign|create an account|register)\b/i.test(decision.question || '')) {
            session.guestCheckoutDone = false;
            session.checkoutEmailFilled = false;
            session.checkoutEmailSubmitted = false;
            const guestClicked = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
            if (guestClicked) {
              await settle(session.page, RECIPE_SETTLE_MS);
              consecutiveBadDecisions = 0;
              consecutiveWaits = 0;
              touchSession(userId);
              await persistStorage(userId, session);
              continue;
            }
            if (await pageHasGuestCheckoutCta(session.page)) {
              await settle(session.page, 400);
              continue;
            }
            const pwProfile = await getCheckoutProfileCached(session, userId);
            if (pwProfile.consent) {
              consecutiveBadDecisions = 0;
              continue;
            }
          }
          const checkoutField = classifyCheckoutAsk(decision.question);
          if (checkoutField === 'email' || checkoutField === 'title') {
            // Try guest-checkout fork first (Wickes-style login-or-guest page)
            if (!session.guestCheckoutDone && (isGuestCheckoutUrl(session.page.url()) || findGuestCheckoutElement(elements))) {
              const guestClicked = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
              if (guestClicked) {
                await settle(session.page, RECIPE_SETTLE_MS);
                consecutiveBadDecisions = 0;
                consecutiveWaits = 0;
                touchSession(userId);
                await persistStorage(userId, session);
                continue;
              }
            }
            const profile = await getCheckoutProfileCached(session, userId);
            if (profile.consent) {
              let progressed = false;
              if (/\btitle\b/i.test(decision.question || '') || checkoutField === 'title') {
                const count = await autoFillCheckoutDetails(session, profile, steps, onProgress);
                if (count > 0) progressed = true;
              }
              if (profile.email) {
                const filled = await autoFillCheckoutEmail(session, elements, profile.email, steps, onProgress);
                if (filled) {
                  session.checkoutEmailFilled = true;
                  progressed = true;
                }
              }
              if (progressed) {
                const out = await completeCheckoutEmailFill(session, userId, session.page, steps, onProgress);
                if (out) return out;
                const advanced = await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: !session.checkoutEmailSubmitted });
                if (advanced) {
                  await settle(session.page, RECIPE_SETTLE_MS);
                  consecutiveBadDecisions = 0;
                  continue;
                }
                continue;
              }
            }
            if (profile.email && profile.consent) {
              session.pendingCheckoutFill = { fields: { email: profile.email } };
              consecutiveBadDecisions = 0;
              continue;
            }
            return { type: 'ask', question: buildEmailAskWithConsent(decision.question) };
          }
          if (checkoutField === 'name' || checkoutField === 'phone' || checkoutField === 'address') {
            const profile = await getCheckoutProfileCached(session, userId);
            const hasField = checkoutField === 'name' ? !!profile.name
              : checkoutField === 'phone' ? !!profile.phone
              : !!(profile.address?.line1 || profile.address?.postcode);
            if (profile.consent && hasField) {
              const count = await autoFillCheckoutDetails(session, profile, steps, onProgress);
              if (count > 0) {
                consecutiveBadDecisions = 0;
                consecutiveWaits = 0;
                touchSession(userId);
                await persistStorage(userId, session);
                continue; // let the vision loop click continue
              }
            }
            // Ask for all missing fields in one go
            const missing = [];
            if (!profile.name) missing.push('full name');
            if (!profile.address?.line1) missing.push('delivery address and postcode');
            if (!profile.phone) missing.push('phone number');
            return { type: 'ask', question: buildDetailsAskWithConsent(decision.question, missing) };
          }
        }
        return { type: 'ask', question: decision.question };
      }

      if (decision.action === 'ready_for_payment') {
        // Info/lookup goals must never enter the payment handoff — treat a price summary as done.
        if (!session.isOrder) {
          const summary = String(decision.summary || decision.total || '').trim();
          if (summary && /£\s*[\d]/.test(summary)) {
            touchSession(userId);
            await persistStorage(userId, session);
            return { type: 'done', text: summary };
          }
          consecutiveBadDecisions += 1;
          session.history.push(`Step ${steps}: ignored ready_for_payment on info lookup`);
          if (consecutiveBadDecisions >= 3) return STUCK;
          continue;
        }
        // Find the real pay button (the cart-summary text never matches a clickable
        // element) so confirmPayment can re-find and click it. If no pay control is
        // visible yet, don't hand off a dead-end — ask the user how to proceed.
        const payEl = elements.find(el => matchesPaymentKeyword(el.text));
        if (!payEl) {
          if (!session.guestCheckoutDone && !(session.checkoutEmailFilled && !session.checkoutEmailSubmitted)
            && !(await isGuestEmailSubmitStep(session.page))) {
            const guestClicked = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
            if (guestClicked) {
              await settle(session.page, RECIPE_SETTLE_MS);
              consecutiveBadDecisions = 0;
              continue;
            }
          }
          const profile = await getCheckoutProfileCached(session, userId);
          if (profile.email && profile.consent && !session.checkoutEmailFilled) {
            const filled = await autoFillCheckoutEmail(session, elements, profile.email, steps, onProgress);
            if (filled) {
              const out = await completeCheckoutEmailFill(session, userId, session.page, steps, onProgress);
              if (out) return out;
              continue;
            }
          }
          const advanced = await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: false });
          if (advanced) {
            await settle(session.page, RECIPE_SETTLE_MS);
            consecutiveBadDecisions = 0;
            continue;
          }
          const payRetry = (await extractClickableElements(session.page)).find((el) => matchesPaymentKeyword(el.text));
          if (payRetry) {
            session.pendingPaymentLabel = payRetry.text;
            return { type: 'ready_for_payment', summary: decision.summary, total: decision.total || '' };
          }
          if (isCheckoutPaymentUrl(session.page.url())) {
            session.pendingPaymentLabel = 'Pay';
            return { type: 'ready_for_payment', summary: decision.summary || 'Checkout — payment step', total: decision.total || '' };
          }
          return { type: 'ask', question: 'The order looks ready, but I can\'t see a payment button on screen yet — want me to keep going, or check the cart yourself?' };
        }
        session.pendingPaymentLabel = payEl.text;
        return { type: 'ready_for_payment', summary: decision.summary, total: decision.total || '' };
      }

      // click or fill — the id MUST be one we actually showed the model. A miss here is
      // almost always a hallucinated id (the model used a price/quantity it read off the
      // page). Don't just retry the identical prompt — raise a correction so the next
      // decision is told the id was invalid and which ids are real, then it can recover.
      // A recipe move already carries a full-DOM locatorIndex + the element's text, so it
      // bypasses the elementId→element lookup the vision path uses. A vision move still maps
      // its badge elementId (0..lastId) to the extracted element; a miss there is a hallucination.
      let target;
      if (decision.action === 'navigate') {
        session.history.push(`Step ${steps}: ${recipeStepName ? `[recipe:${recipeStepName}] ` : ''}navigated to "${decision.url || decision.text || 'basket'}"`);
        if (recipeStepName) {
          session.lastRecipeStep = recipeStepName;
          session.recipeStepRepeats = 0;
          stepsSinceProgress = 0;
          stepsSinceNewState = 0;
          await waitAfterRecipeStep(session.page, session.site, recipeStepName, session);
        }
        consecutiveBadDecisions = 0;
        consecutiveWaits = 0;
        touchSession(userId);
        await persistStorage(userId, session);
        continue;
      }

      if (recipeStepName) {
        target = { id: -1, text: decision.text || '', locatorIndex: decision.locatorIndex };
      } else {
        const lastId = elements.length ? elements.length - 1 : 0;
        const idIsValid = Number.isInteger(decision.elementId) && decision.elementId >= 0 && decision.elementId <= lastId;
        target = idIsValid ? elements.find(el => el.id === decision.elementId) : null;
        if (!target) {
          consecutiveBadDecisions += 1;
          pendingCorrection = `Your last reply used elementId ${decision.elementId}, which is NOT on this page. Valid element ids are 0 to ${lastId}. Look at the numbered badges in the screenshot and choose one of those — do not use any other number.`;
          session.history.push(`Step ${steps}: model chose elementId ${decision.elementId}, which is not on the page (valid 0-${lastId}); asked it to pick a real one`);
          if (consecutiveBadDecisions >= 3) return STUCK;
          continue;
        }
      }

      if (matchesPaymentKeyword(target.text)) {
        session.pendingPaymentLabel = target.text;
        return { type: 'ready_for_payment', summary: `Ready to ${target.text}`, total: '' };
      }

      if (!recipeStepName && decision.action === 'click' && shouldSuppressVisionClick(session, target.text)) {
        session.history.push(`Step ${steps}: suppressed junk click "${String(target.text || '').slice(0, 60)}"`);
        consecutiveBadDecisions = 0;
        continue;
      }

      if (decision.action === 'click' && GUEST_CHECKOUT_PATTERN.test(String(target.text || ''))) {
        const onEmailSubmit = await isGuestEmailSubmitStep(session.page);
        if (onEmailSubmit || (session.checkoutEmailFilled && !session.checkoutEmailSubmitted)) {
          const emailSent = await tryClickGuestEmailSubmit(session.page, session, steps, onProgress)
            || await trySubmitCheckoutEmail(session, session.page, steps, onProgress);
          if (emailSent) {
            session.guestCheckoutDone = true;
            const stallProfile = await getCheckoutProfileCached(session, userId);
            if (stallProfile.consent) {
              await autoFillCheckoutDetails(session, stallProfile, steps, onProgress);
              await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: true, skipGuest: true });
            }
            await settle(session.page, RECIPE_SETTLE_MS);
            consecutiveBadDecisions = 0;
            consecutiveWaits = 0;
            touchSession(userId);
            await persistStorage(userId, session);
            continue;
          }
        }
        if (!session.guestCheckoutDone && !(session.checkoutEmailFilled && !session.checkoutEmailSubmitted)) {
          const guestFirst = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
          if (guestFirst) {
            session.guestCheckoutDone = true;
            await settle(session.page, RECIPE_SETTLE_MS);
            consecutiveBadDecisions = 0;
            continue;
          }
          session.guestCheckoutDone = true;
        } else if (!session.guestCheckoutDone && session.checkoutEmailFilled && !session.checkoutEmailSubmitted) {
          session.guestCheckoutDone = true;
        }
        if (!onEmailSubmit && findGuestCheckoutElement(elements)
          && !(session.checkoutEmailFilled && !session.checkoutEmailSubmitted)) {
          session.guestCheckoutDone = false;
          session.checkoutEmailFilled = false;
          session.checkoutEmailSubmitted = false;
          const guestRetry = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
          if (guestRetry) {
            await settle(session.page, RECIPE_SETTLE_MS);
            consecutiveBadDecisions = 0;
            continue;
          }
          session.guestCheckoutDone = true;
        }
        const generic = await tryGenericCheckoutProgress(session, userId, session.page, steps, onProgress, elements);
        if (generic?.result) {
          touchSession(userId);
          await persistStorage(userId, session);
          return generic.result;
        }
        if (generic?.advanced) {
          consecutiveBadDecisions = 0;
          consecutiveWaits = 0;
          touchSession(userId);
          await persistStorage(userId, session);
          await settle(session.page, RECIPE_SETTLE_MS);
          continue;
        }
        const stallProfile = await getCheckoutProfileCached(session, userId);
        if (stallProfile.email && stallProfile.consent) {
          if (!session.checkoutEmailFilled) {
            const filled = await autoFillCheckoutEmail(session, elements, stallProfile.email, steps, onProgress);
            if (filled) session.checkoutEmailFilled = true;
          }
          if (session.checkoutEmailSubmitted) {
            await autoFillCheckoutDetails(session, stallProfile, steps, onProgress);
            const advanced = await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: true });
            if (advanced) {
              await settle(session.page, RECIPE_SETTLE_MS);
              consecutiveBadDecisions = 0;
              consecutiveWaits = 0;
              continue;
            }
          } else {
            const submitted = await tryClickGuestEmailSubmit(session.page, session, steps, onProgress)
              || await trySubmitCheckoutEmail(session, session.page, steps, onProgress);
            if (submitted) {
              await autoFillCheckoutDetails(session, stallProfile, steps, onProgress);
              await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: true, skipGuest: true });
              await settle(session.page, RECIPE_SETTLE_MS);
              consecutiveBadDecisions = 0;
              consecutiveWaits = 0;
              continue;
            }
            await autoFillCheckoutDetails(session, stallProfile, steps, onProgress);
            const advanced = await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: true, skipGuest: true });
            if (advanced) {
              await settle(session.page, RECIPE_SETTLE_MS);
              consecutiveBadDecisions = 0;
              consecutiveWaits = 0;
              continue;
            }
          }
        }
        const ready = await tryPaymentReady(session, session.page);
        if (ready) {
          touchSession(userId);
          await persistStorage(userId, session);
          return ready;
        }
        session.history.push(`Step ${steps}: suppressed repeat guest checkout click on "${target.text}"`);
        consecutiveBadDecisions = 0;
        continue;
      }

      // Never type an email address into a non-email control (model often picks "Checkout as
      // a guest" after the real email field was already filled by checkout-profile).
      if (decision.action === 'fill' && /@/.test(String(decision.value || '')) && !/\b(e-?mail)\b/i.test(String(target.text || ''))) {
        const guestish = GUEST_CHECKOUT_PATTERN.test(String(target.text || ''))
          || /\b(continue as guest|guest checkout)\b/i.test(String(target.text || ''));
        if (guestish) {
          if (session.guestCheckoutDone) {
            const generic = await tryGenericCheckoutProgress(session, userId, session.page, steps, onProgress, elements);
            if (generic?.result) {
              touchSession(userId);
              await persistStorage(userId, session);
              return generic.result;
            }
            if (generic?.advanced) {
              await settle(session.page, RECIPE_SETTLE_MS);
              consecutiveBadDecisions = 0;
              continue;
            }
            const stallProfile = await getCheckoutProfileCached(session, userId);
            if (stallProfile.consent) {
              await autoFillCheckoutDetails(session, stallProfile, steps, onProgress);
              const advanced = await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: true });
              if (advanced) {
                await settle(session.page, RECIPE_SETTLE_MS);
                consecutiveBadDecisions = 0;
                stepsSinceProgress = 0;
                continue;
              }
            }
            session.history.push(`Step ${steps}: suppressed repeat guest fill on "${target.text}"`);
            consecutiveBadDecisions = 0;
            continue;
          }
          const guestClicked = await tryGuestCheckoutClick(session.page, session, steps, onProgress);
          if (guestClicked) {
            await settle(session.page, RECIPE_SETTLE_MS);
            consecutiveBadDecisions = 0;
            continue;
          }
          session.guestCheckoutDone = true;
          session.history.push(`Step ${steps}: marked guest checkout after "${target.text}"`);
          consecutiveBadDecisions = 0;
          continue;
        }
        consecutiveBadDecisions += 1;
        session.history.push(`Step ${steps}: suppressed fill of email into non-email field "${target.text}"`);
        if (consecutiveBadDecisions >= 3) return STUCK;
        continue;
      }
      const CHECKOUT_CTA = /^(continue|next|proceed|submit|checkout)(\s|$| to\b)/i;
      if (decision.action === 'fill' && CHECKOUT_CTA.test(String(target.text || ''))) {
        const profile = await getCheckoutProfileCached(session, userId);
        if (profile.consent && (profile.name || profile.address?.line1)) {
          const count = await autoFillCheckoutDetails(session, profile, steps, onProgress);
          if (count > 0) {
            const advanced = await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: false });
            if (advanced) await settle(session.page, RECIPE_SETTLE_MS);
            consecutiveBadDecisions = 0;
            continue;
          }
        }
        const advanced = await tryAdvanceCheckoutStep(session, session.page, steps, onProgress, { allowSubmit: false });
        if (advanced) {
          await settle(session.page, RECIPE_SETTLE_MS);
          consecutiveBadDecisions = 0;
          continue;
        }
        session.history.push(`Step ${steps}: suppressed fill into checkout CTA "${target.text}"`);
        consecutiveBadDecisions += 1;
        if (consecutiveBadDecisions >= 3) return STUCK;
        continue;
      }

      // The DOM often re-renders between perception and action (hydration, results refresh,
      // a dismissed banner shifting indices), leaving locatorIndex pointing at a DIFFERENT —
      // frequently hidden — node: Wickes' "Add for Delivery" failed "Element is not visible"
      // three times in a row this way while a visible twin sat elsewhere in the DOM. If the
      // indexed node's label no longer matches what the model chose, re-find the element by
      // its visible text (fresh extraction only lists visible nodes, so a hidden mobile/
      // desktop duplicate resolves to the visible one).
      let actionIndex = target.locatorIndex;
      if (target.text) {
        const drifted = await session.page.evaluate(({ selector, idx, want }) => {
          const el = document.querySelectorAll(selector)[idx];
          if (!el) return true;
          // Text alone can't detect drift between DUPLICATES: Wickes renders one hidden
          // "Add for Delivery" twin per product tile, so the shifted index still text-matches
          // while pointing at a zero-size node ("Element is not visible" ×3, 2026-07-02).
          // A control the model just SAW must have a real box — treat a sizeless/hidden one
          // as drift so we re-resolve to the visible twin.
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') return true;
          const label = ((el.innerText || '') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('value') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          return label !== want;
        }, { selector: CLICKABLE_SELECTOR, idx: target.locatorIndex, want: target.text }).catch(() => false);
        if (drifted) {
          const fresh = await extractClickableElements(session.page);
          const match = findElementByText(fresh, target.text);
          if (match) actionIndex = match.locatorIndex;
        }
      }
      // Resolve the node in the SAME index space extraction used (document.querySelectorAll
      // order). Playwright's locator(sel).nth(i) is a DIFFERENT space — its CSS engine
      // pierces open shadow roots, so on shadow-DOM sites every index past the first shadow
      // host lands N elements off and the loop clicks the wrong control (Nike: "Add to Bag"
      // resolved to the Klarna "Check purchase power" trigger, 2026-07-02). An ElementHandle
      // keeps Playwright's actionability checks + trusted input on the exact node we saw.
      const locator = await session.page.evaluateHandle(
        ({ selector, idx }) => document.querySelectorAll(selector)[idx] || null,
        { selector: CLICKABLE_SELECTOR, idx: actionIndex }
      ).then((h) => h.asElement()).catch(() => null);
      try {
        if (!locator) throw new Error('element is no longer on the page');
        if (decision.action === 'click') {
          onProgress(`Clicking "${target.text}"…`);
          // Two real-site hazards: (1) elements in horizontal carousels/off-screen rows
          // aren't in the viewport, and force-click alone errors "outside of the viewport"
          // because force skips the patient scroll-and-retry; (2) decorative/consent <div>s
          // overlay the target and "intercept pointer events". So: scroll it into view
          // first, then force the click past any overlay. Safe — the payment guardrail
          // above means the loop never force-clicks a pay button.
          await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await session.page.evaluate(el => el && el.scrollIntoView({ block: 'center', behavior: 'instant' }), locator).catch(() => {});
          try {
            await locator.click({ timeout: 10000, force: true });
          } catch (clickErr) {
            // Hidden-twin recovery: sites render the same control several times (desktop/
            // mobile/sticky variants — Wickes has one "Add for Delivery" per layout) and the
            // indexed node can be the clipped twin that has a size but no clickable point,
            // failing "Element is not visible" even with force. Let Playwright's own
            // visibility semantics arbitrate: scan same-text candidates and click the one it
            // deems visible. Only for this error shape — anything else propagates as before.
            if (!/not visible|outside of the viewport/i.test(String(clickErr.message)) || !target.text) throw clickErr;
            const exact = new RegExp(`^\\s*${target.text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
            const cands = session.page.locator(CLICKABLE_SELECTOR).filter({ hasText: exact });
            const n = Math.min(await cands.count().catch(() => 0), 12);
            let clicked = false;
            for (let i = 0; i < n; i++) {
              const cand = cands.nth(i);
              if (await cand.isVisible().catch(() => false)) {
                await cand.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                await cand.click({ timeout: 5000, force: true });
                clicked = true;
                break;
              }
            }
            if (!clicked) throw clickErr;
          }
          session.history.push(`Step ${steps}: ${recipeStepName ? `[recipe:${recipeStepName}] ` : ''}clicked "${target.text}"`);
        } else if (decision.action === 'fill' && /search/i.test(String(target.text || '')) && session.addClicked && RECIPES[session.site]?.basketUrl) {
          const nav = await navigateToSiteBasket(session, session.page, steps, onProgress);
          if (nav) {
            consecutiveBadDecisions = 0;
            continue;
          }
        } else if (decision.action === 'fill') {
          onProgress(`Typing into "${target.text}"…`);
          const value = String(decision.value || '');
          await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          try {
            await locator.fill(value, { timeout: 8000 });
          } catch (fillErr) {
            // The model often points at a search WRAPPER (a div[role="combobox"] or a
            // button that reveals the real field) instead of the <input> itself, so fill
            // throws "not an <input>". Recover: fill a nested input if there is one, else
            // focus the element and type via the keyboard.
            const nested = await locator.$('input, textarea, [contenteditable]').catch(() => null);
            if (nested) {
              await nested.fill(value, { timeout: 8000 });
            } else {
              await locator.click({ timeout: 5000, force: true }).catch(() => {});
              await session.page.keyboard.type(value, { delay: 10 });
            }
          }
          session.history.push(`Step ${steps}: ${recipeStepName ? `[recipe:${recipeStepName}] ` : ''}filled "${target.text}" with "${value}"`);
          // Remember what we typed into a SEARCH box so the next iterations can detect a
          // search-results navigation and learn this site's fast-path template. Gated to
          // search fields so we never mis-learn a filter/quantity/address as a search URL.
          if (/search/i.test(target.text)) {
            session.lastFilledValue = value;
            // Most sites only run the search on Enter — the model regularly fills the box and
            // then clicks a "Search" icon that merely toggles the overlay, spinning forever
            // (M&S/Nike/Wickes in the 2026-07-02 benchmark). Submit for it: the field is still
            // focused from the fill, and Enter is universal on search inputs.
            await session.page.keyboard.press('Enter').catch(() => {});
            session.history[session.history.length - 1] += ' and pressed Enter to search';
          }
          if (isDeliveryHost(session.site) && /\b(address|postcode|post code|delivery)\b/i.test(String(target.text || ''))) {
            await tryPickDeliveryAddressSuggestion(session, steps, onProgress);
          }
        }
        consecutiveBadDecisions = 0;
        consecutiveWaits = 0; // a real action broke the wait streak
        // Detect a no-progress spin: the same action on the same element, repeatedly. Some
        // repeats are legitimate (a "+" quantity button), so we don't block — we nudge after
        // a few, then count toward "stuck" if it keeps going. value is included so re-typing
        // the same field counts but a different value doesn't.
        const sig = `${decision.action}:${target.locatorIndex}:${decision.action === 'fill' ? String(decision.value || '') : ''}`;
        if (sig === lastActionSig) {
          repeatActionCount += 1;
          if (repeatActionCount >= 2) {
            pendingCorrection = `You have just done the SAME action ("${decision.action}" on "${target.text}") ${repeatActionCount + 1} times and the page isn't advancing. It is not working — do something DIFFERENT: pick another element, scroll to reveal a control (like an "Add"/"Save"/"Continue" button often at the bottom of a dialog), or choose a required option first.`;
          }
          if (repeatActionCount >= 4) {
            consecutiveBadDecisions += 1;
            if (consecutiveBadDecisions >= 3) return STUCK;
          }
        } else {
          lastActionSig = sig;
          repeatActionCount = 0;
        }

        // Extra: if we are repeating the exact same action AND cart is still 0 on an order goal,
        // treat as strong no-progress signal (prevents the "click search 5 times" pattern).
        if (session.isOrder && !session.cartEverNonzero && repeatActionCount >= 2) {
          stepsSinceNewState = Math.max(stepsSinceNewState, repeatActionCount + 2);
          stepsSinceCartProgress = Math.max(stepsSinceCartProgress, repeatActionCount + 3);
        }
        session.lastActionSig = lastActionSig;
        session.repeatActionCount = repeatActionCount;
        if (recipeStepName) {
          if (recipeStepName === 'guest') {
            const stillGuest = findGuestCheckoutElement(await extractClickableElements(session.page).catch(() => []));
            if (!stillGuest) session.guestCheckoutDone = true;
          }
          if (recipeStepName === 'add' && session.site === 'johnlewis.com') session.jlAddSent = true;
          if (recipeStepName === 'add' && session.site === 'nike.com') session.nikeAddSent = true;
          if (recipeStepName === 'add' && session.site === 'marksandspencer.com') session.msAddSent = true;
          if (recipeStepName === 'add' && session.site === 'asos.com') session.asosAddSent = true;
          if (recipeStepName === 'add' && session.site === 'screwfix.com') session.screwfixAddSent = true;
          if (recipeStepName === 'add' && session.site === 'currys.co.uk') session.currysAddSent = true;
          if (recipeStepName === 'add' && session.site === 'waitrose.com') session.waitroseAddSent = true;
          if (recipeStepName === 'add' && !RECIPES[session.site] && !isDeliveryHost(session.site)) session.convAddSent = true;
          if (recipeStepName === 'modal-add' && isDeliveryHost(session.site)) session.deliveryAddSent = true;
          const sameStep = session.lastRecipeStep === recipeStepName;
          session.lastRecipeStep = recipeStepName;
          if (sameStep) {
            // The SAME recipe step firing again means the last firing didn't advance the
            // page — a silent loop the health tracker can't see (it only counts selector
            // misses; Wickes' GENERIC cart step clicked "Checkout" 20× this way). Count
            // ineffective repeats as misses so the step self-disables and vision takes
            // over, and leave the progress counters running so a stuck recipe ultimately
            // bails like any other spin.
            session.recipeStepRepeats = (session.recipeStepRepeats || 0) + 1;
            if (session.recipeStepRepeats >= 2) recipeHealth.recordMiss(session.site, recipeStepName);
          } else {
            session.recipeStepRepeats = 0;
            // Recipe advanced to a different step — trusted mechanical progress; reset the
            // detector so multi-click recipe sequences (e.g. JL size then add on the same
            // PDP) don't accumulate.
            stepsSinceProgress = 0;
            stepsSinceNewState = 0;
            stepsSinceCartProgress = 0;
            lastProgressSig = lastProgressSig + '|r';
            session.lastProgressSig = lastProgressSig;
            session.stepsSinceProgress = stepsSinceProgress;
            session.stepsSinceNewState = stepsSinceNewState;
            session.stepsSinceCartProgress = stepsSinceCartProgress;
          }
          session.lastWasRecipe = true;
          await waitAfterRecipeStep(session.page, session.site, recipeStepName, session);
          if (recipeStepName === 'add') {
            const probed = ADD_PROBE_SITES.has(session.site);
            const confirmed = !probed || isRecipeAddConfirmed(session);
            if (confirmed) {
              session.addClicked = true;
              session.cartEverNonzero = true;
              if (AUTO_NAV_BASKET_SITES.has(session.site)) {
                await navigateToSiteBasket(session, session.page, steps, onProgress);
              }
            }
          }
        }
        touchSession(userId);
        await persistStorage(userId, session);
      } catch (actionErr) {
        // One failed action must NOT kill the whole turn (the outer catch used to end it).
        // Record it, nudge the model toward a different element, and re-perceive. Only a
        // sustained run of failures trips the stuck guard.
        const reason = String(actionErr.message || 'action failed').split('\n')[0].slice(0, 120);
        consecutiveBadDecisions += 1;
        pendingCorrection = `Your previous ${decision.action} on "${target.text}" failed (${reason}). Pick a different element or try another way to reach the goal.`;
        session.history.push(`Step ${steps}: ${decision.action} on "${target.text}" failed (${reason})`);
        if (consecutiveBadDecisions >= 3) return STUCK;
        continue;
      }
    }
  } catch (error) {
    // Playwright errors carry a multi-line call log — log it server-side, but show the
    // user a short, calm line (the session stays open so they can continue).
    console.warn('[browser-task] step failed:', error.message);
    const reason = String(error.message || 'something went wrong').split('\n')[0].slice(0, 160);
    session.history.push(`Step ${steps}: action failed (${reason})`);
    return { type: 'error', error: `Hit a snag on the page (${reason}). Say "keep going" and I'll pick up where I left off.` };
  }

  // No "want me to keep going?" — the client auto-continues, so asking a question we
  // immediately answer ourselves just litters the transcript.
  const n = session.history.length;
  return { type: 'awaiting_more', summary: session.isOrder
    ? `Working on your order — ${n} step${n === 1 ? '' : 's'} in…`
    : `Working on it — ${n} step${n === 1 ? '' : 's'} in…` };
}

async function confirmPayment(userId) {
  const session = getSession(userId);
  if (!session || !session.pendingPaymentLabel) {
    return { type: 'error', error: 'No order is waiting for payment confirmation — it may have expired.' };
  }
  try {
    const elements = await extractClickableElements(session.page);
    // Exact match only — never substring-fallback at the payment step, where a
    // stored "Pay" could otherwise match "Apple Pay"/"PayPal" and click the wrong control.
    const wanted = session.pendingPaymentLabel.trim().toLowerCase();
    const target = elements.find(el => el.text.trim().toLowerCase() === wanted);
    if (!target) {
      return { type: 'error', error: `Couldn't find the "${session.pendingPaymentLabel}" button anymore — the page may have changed.` };
    }
    // Same-index-space resolve as the main loop: locator().nth() counts shadow-DOM nodes
    // that querySelectorAll (extraction) doesn't, and a mis-indexed click HERE is a wrong
    // click on a payment page — the one place that must never happen.
    const handle = await session.page.evaluateHandle(
      ({ selector, idx }) => document.querySelectorAll(selector)[idx] || null,
      { selector: CLICKABLE_SELECTOR, idx: target.locatorIndex }
    ).then((h) => h.asElement());
    if (!handle) {
      return { type: 'error', error: `Couldn't find the "${session.pendingPaymentLabel}" button anymore — the page may have changed.` };
    }
    await handle.click({ timeout: 10000 });
    const text = `Done — placed the order (${session.pendingPaymentLabel}).`;
    await persistStorage(userId, session);
    await closeSession(userId);
    return { type: 'done', text };
  } catch (error) {
    return { type: 'error', error: error.message };
  }
}

function cancelPayment(userId) {
  touchSession(userId);
}

module.exports = {
  primeWarmBrowser,
  primeFastpaths,
  _fastpathStore: fastpathStore,
  getWarmBrowser,
  shouldUseRemoteForHost,
  usingRemoteBrowser,
  deriveSearchTerm,
  directSearchUrl,
  parseGoalContext,
  tryTier0PriceLookup,
  tier0NameMatchesGoal,
  matchesPaymentKeyword,
  isTechnicalAsk,
  looksLikeLoginWall,
  findGuestCheckoutElement,
  classifyCheckoutAsk,
  findEmailInputElement,
  matchProfileFieldForInput,
  autoFillCheckoutField,
  autoFillCheckoutDetails,
  isSearchResultsUrl,
  isGuestCheckoutUrl,
  looksLikeBlockWall,
  detectBlockWall,
  describesBlockWall,
  isOrderGoal,
  assessProgress,
  buildDecisionPrompt,
  parseModelDecision,
  findElementByText,
  createSession,
  getSession,
  touchSession,
  closeSession,
  extractClickableElements,
  CLICKABLE_SELECTOR,
  runOrderingTurn,
  confirmPayment,
  cancelPayment
};

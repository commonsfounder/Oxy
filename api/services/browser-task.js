const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { createSupabaseServiceClient, createGeminiServiceClient } = require('../../runtime');
const { learnTemplateFromUrl, createFastpathStore } = require('./browser-fastpaths');

chromium.use(stealth);

// Driving a real browser from a screenshot is a vision+reasoning task, not a cheap
// helper call — the flash-lite tier hallucinated out-of-range element ids on cluttered
// commercial pages (john lewis etc.) and the loop had no way to recover. Default this
// loop to the primary reasoning model; OXY_BROWSER_MODEL overrides if you want to A/B.
const BROWSER_MODEL = process.env.OXY_BROWSER_MODEL || process.env.OXY_REASONING_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
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
const VIEWPORT = { width: envInt('OXY_BROWSER_VIEWPORT_W', 1024), height: envInt('OXY_BROWSER_VIEWPORT_H', 768) };
const SCREENSHOT_QUALITY = envInt('OXY_BROWSER_SCREENSHOT_QUALITY', 55);

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
const MAX_ELEMENTS = envInt('OXY_BROWSER_MAX_ELEMENTS', 40);
// The loop model is a *thinking* model; thinking is what recovers from hallucinated element
// ids, but it's also the bulk of model latency. Cap it low (not off) and tune via E2E.
// OXY_BROWSER_THINKING_BUDGET=-1 drops the field entirely if a model version rejects it.
const BROWSER_THINKING_BUDGET = envInt('OXY_BROWSER_THINKING_BUDGET', 256);
// Fixed hydration beats. goto already waits for domcontentloaded (~2s), so by the time these
// run the DOM is parsed — the beat is just insurance against a not-yet-painted SPA shell.
// Trimmed from 1500/400/600 (which were a third of a fast turn spent waiting); the model's
// "wait" action is the safety net if a page genuinely isn't ready. Tunable per-env if a slow
// site needs more.
const OPEN_HYDRATE_MS = envInt('OXY_BROWSER_OPEN_HYDRATE_MS', 800);
const OPEN_POST_CONSENT_MS = envInt('OXY_BROWSER_OPEN_POST_CONSENT_MS', 250);
const STEP_SETTLE_MS = envInt('OXY_BROWSER_STEP_SETTLE_MS', 350);
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

// Launches local stealth Chromium by default. Set BROWSER_REMOTE_ENDPOINT to a
// managed scraping-browser CDP endpoint (Bright Data, Browserbase, etc.) to
// swap in proxy/fingerprint-rotation reliability without touching call sites.
function usingRemoteBrowser() {
  return Boolean(process.env.BROWSER_REMOTE_ENDPOINT);
}

async function launchBrowser() {
  const remoteEndpoint = process.env.BROWSER_REMOTE_ENDPOINT;
  if (remoteEndpoint) return chromium.connectOverCDP(remoteEndpoint);
  // ponytail: headless:true in prod; BROWSER_HEADLESS=false lets a local debug run pop
  // a real window so you can watch the loop click around, instead of trusting logs.
  return chromium.launch({ headless: process.env.BROWSER_HEADLESS !== 'false' });
}

// Warm browser pool: launching Chromium cold is ~4s — paid on the FIRST step of a turn,
// inside the mobile client's 45s watchdog. Keep one spare browser already launched so a
// turn grabs it instantly, then relaunch a replacement in the background for next time.
// One spare is enough at personal-assistant concurrency (one user, mostly one task at a
// time); if a second turn lands while the spare is in use it just launches cold as before.
const WARM_POOL_ENABLED = process.env.OXY_BROWSER_WARM_POOL !== 'false' && !usingRemoteBrowser();
let warmSpare = null;      // a launched, idle Browser waiting to be claimed
let warmingPromise = null; // in-flight launch, so we never start two at once

function primeWarmBrowser() {
  if (!WARM_POOL_ENABLED || warmSpare || warmingPromise) return;
  warmingPromise = launchBrowser()
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
  const browser = await launchBrowser();
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
const PAYMENT_KEYWORD_PATTERN = /\bpay\b|\bbuy\b|place\s+(your\s+)?order|order\s+now|complete\s+(your\s+)?(order|purchase|payment)|confirm\s+(your\s+)?(purchase|order|payment)|submit\s+(order|payment)|checkout\s*(and|&)?\s*pay|proceed\s+to\s+payment|slide\s+to\s+pay/i;

function matchesPaymentKeyword(text) {
  return PAYMENT_KEYWORD_PATTERN.test(String(text || ''));
}

// A question we must NEVER surface to the user: a real assistant doesn't ask for a
// URL, an element id, a CSS selector, or "which platform" — those are the loop's job
// to figure out. If the model tries, we suppress it and retry instead.
const TECHNICAL_ASK_PATTERN = /\b(url|link|element\s*id|element's\s*id|selector|css|xpath|dom|html|\bid\s+of\b|which\s+(site|platform)|delivery\s+platform|search\s+bar)\b/i;

function isTechnicalAsk(question) {
  return TECHNICAL_ASK_PATTERN.test(String(question || ''));
}

// Goals that mean "place an order" — for these, "done" is ALWAYS premature inside the
// loop: a real order only completes through ready_for_payment → confirmPayment, so an
// early "done" (e.g. right after setting the address) must not close the browser.
const ORDER_GOAL_PATTERN = /\b(order|deliver(?:y|ed)?|buy|cart|basket|checkout|food|eats|pizza|meal|grocer|takeaway|takeout)\b/i;

function isOrderGoal(goal) {
  return ORDER_GOAL_PATTERN.test(String(goal || ''));
}

function buildDecisionPrompt(goal, history, elements, correction = '') {
  const historyText = history.length
    ? history.map((entry, i) => `${i + 1}. ${entry}`).join('\n')
    : '(nothing yet)';
  const elementsText = elements.map(el => `#${el.id} "${el.text}"`).join('\n');
  const lastId = elements.length ? elements.length - 1 : 0;
  const correctionBlock = correction ? `\n⚠️ CORRECTION: ${correction}\n` : '';
  return `You are controlling a real web browser to help with this goal: "${goal}"
${correctionBlock}
You can SEE the current page in the attached screenshot. Every clickable element has a
small numbered badge drawn on it; the number is its element id and matches the list
below. LOOK at the screenshot first — find the thing you need (search box, address
field, a restaurant, an "Add" button) by sight, then act on it by its number. The page
text alone is unreliable; trust your eyes. If the page looks like it's still loading
(spinners, blank areas, a skeleton), choose "wait".

CRITICAL: elementId MUST be one of the ids listed below (0 to ${lastId}). Do NOT invent a
number, and never use a price, quantity, postcode, or any number you read off the page as
an elementId — only the badge numbers in the list are valid.

What's happened so far:
${historyText}

Numbered clickable elements on the current page:
${elementsText}

Reply with ONLY one JSON object, one of these shapes:
{"action":"click","elementId":<number>}
{"action":"fill","elementId":<number>,"value":"<text>"}
{"action":"wait"}
{"action":"ask","question":"<short question for the user>"}
{"action":"done","summary":"<short summary answering the goal>"}
{"action":"ready_for_payment","summary":"<what's in the cart>","total":"<price as shown on the page>"}

NEVER ask the user for a URL, a link, an element id, a selector, or which website/platform
to use — that is YOUR job to work out from the page you can see. The only acceptable
questions are about the order itself (which restaurant, which item, which size, a missing
delivery address). If you can't find a control, "wait" for the page to settle and look
again; do not ask a technical question.

STAY ON THE GOAL. Re-read the goal every step and only take actions that move toward THAT specific thing. To find a named restaurant (e.g. "McDonald's"), use the SEARCH box and type its name — do NOT browse category tiles like "Healthy Food", "Offers", "Fast Food", or cuisine filters; those are distractions and almost never the goal. If you catch yourself on a category/promo page that isn't the named restaurant, go back to search. Pick the option whose text actually matches the goal, not one that merely looks clickable.

DEFAULT TO ACTING. Carry out the goal yourself — type the restaurant name into the search box, enter the delivery address, click Search, open the single most relevant restaurant, add the requested item — WITHOUT asking permission. On a delivery site (Uber Eats, Deliveroo, Just Eat), restaurants and the search bar usually do NOT appear until a delivery address is entered — if you don't see restaurants or a search box yet, find the address/postcode input, fill it with the address from the goal, and pick the first suggestion, BEFORE trying to search. The address box is an AUTOCOMPLETE: after you fill it, a dropdown of address suggestions appears as separate clickable items — you MUST click the matching suggestion to lock the address in; typing alone does NOT set it. Do not search or proceed until you have clicked a suggestion. If the restaurants shown are in the WRONG city or area (e.g. London when the address is Birmingham), the address did not commit — the page is defaulting to the server's location; clear the field, re-type the address, and click the suggestion. Never ask the user for a URL or to pick a different platform — work with the page you're on. The user already gave you the goal; doing the obvious next step is your job, not theirs. Prefer "fill"/"click" over "ask" every single time you can.

Use "ask" ONLY as a genuine last resort, when you truly cannot proceed: a real fork the goal does not resolve (e.g. two clearly different restaurants match equally well), or required input that is missing from the goal and history (e.g. a delivery address you were never given). NEVER ask whether to do something you could just do — searching for a named item, filling a field whose value you already know, or picking the obvious best match. "Should I search for X?" is never a valid question — just search.

Use "ready_for_payment" once the cart is built and the next step would be paying — never choose "click" on anything that finalizes a purchase yourself.

CRITICAL — "done" CLOSES the browser and ENDS the task. Use it ONLY when the goal is fully complete with nothing left to do: a pure information lookup you have answered, or an order that has ALREADY been placed. While building an order you must NEVER use "done". If you are waiting on the user to choose something (which pizza, which size, which deal) so you can continue, that is "ask" — it keeps the session alive so you can carry on when they reply. Showing a menu and waiting for their choice is "ask", NOT "done". If the cart is built, it is "ready_for_payment". Choosing "done" mid-order throws away the cart and forces the user to start over.`;
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
  const validActions = new Set(['click', 'fill', 'wait', 'ask', 'done', 'ready_for_payment']);
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
const CLICKABLE_SELECTOR = 'button, a, input, textarea, [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="combobox"]';

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
    const dialog = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'))
      .filter(visible)
      .map((el) => { const r = el.getBoundingClientRect(); return { el, area: r.width * r.height }; })
      .filter((d) => d.area > vw * 0.15) // ignore small popovers/tooltips that are also role=dialog
      .sort((a, b) => b.area - a.area)[0];
    const scope = dialog ? Array.from(dialog.el.querySelectorAll(selector)) : allNodes;
    const out = [];
    for (const el of scope) {
      if (out.length >= max) break;
      if (!visible(el)) continue;
      const raw = (el.innerText || '') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('value') || '';
      const text = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!text) continue;
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

async function decideNextAction(goal, history, elements, screenshotB64, correction = '') {
  const model = getGemini().getGenerativeModel({ model: BROWSER_MODEL });
  const parts = [{ text: buildDecisionPrompt(goal, history, elements, correction) }];
  if (screenshotB64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: screenshotB64 } });
  const request = {
    contents: [{ role: 'user', parts }],
    // Headroom: the reasoning model spends output tokens thinking before it emits the
    // JSON — 300 truncated it to an empty/partial object on most steps. 2048 leaves room
    // for the thinking pass plus the (tiny) action object. browserThinkingConfig() caps
    // how much of that the model spends reasoning, the largest single chunk of step latency.
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: 'application/json', ...browserThinkingConfig() }
  };
  // One bounded retry. A transient API error or timeout shouldn't end the turn — degrade to
  // a recoverable "invalid" (the loop nudges + re-perceives) only after both attempts fail.
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
const SEARCH_SITES = {
  'johnlewis.com': {
    names: ['john lewis', 'johnlewis'],
    searchUrl: (term) => `https://www.johnlewis.com/search?search-term=${encodeURIComponent(term)}`
  },
  'selfridges.com': {
    names: ['selfridges'],
    searchUrl: (term) => `https://www.selfridges.com/GB/en/cat/?freeText=${encodeURIComponent(term)}&srch=Y`
  }
};

// Leading intent verbs and trailing fluff that aren't part of the thing being searched for.
const LEAD_NOISE = /^(?:can you\s+|could you\s+|please\s+|i\s+(?:want|need|would like)\s+(?:to\s+)?(?:find|buy|get|order)?\s*|find\s+(?:me\b\s*)?|search\s+(?:for\s+)?|look\s+(?:for|up)\s+|buy\s+(?:me\b\s*)?|order\s+(?:me\b\s*)?|get\s+(?:me\b\s*)?|show\s+(?:me\b\s*)?|a\s+pair\s+of\s+|some\s+|a\s+|an\s+)+/i;
// Strip a trailing request-about-the-result clause. Anchored to a connective ("…and tell me
// the exact price shown", "…how much", "…and the price") so it eats the whole tail regardless
// of adjectives, but does NOT touch a product name that merely contains "price"/"cost".
const TRAIL_NOISE = /\s*(?:and\s+)?(?:tell\s+me|let\s+me\s+know|show\s+me|give\s+me|how\s+much)\b.*$|\s*and\s+(?:the\s+|its\s+)?(?:price|cost)\b.*$|\s+(?:near|for)\s+me\s*$|\s*please\s*$/i;

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
  // Trailing fluff can stack ("joggers and tell me the price please") — strip until stable.
  let prev;
  do { prev = t; t = t.replace(TRAIL_NOISE, ''); } while (t !== prev);
  t = t.trim().replace(/\s+/g, ' ');
  if (t.length < 2 || t.length > 80) return null; // too short to be a query / probably not one
  return t;
}

// If url is a known search-site root AND we can derive a query, return the results-page url
// to open instead; otherwise null (open url unchanged).
function directSearchUrl(url, goal) {
  if (!url || !goal) return null;
  if (process.env.OXY_BROWSER_FASTPATH === 'false') return null; // kill-switch / A-B isolation
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const site = SEARCH_SITES[parsed.hostname.replace(/^www\./, '')];
  if (!site) return null;
  // Only short-circuit a homepage/root. If the url is already a deep link (a search,
  // product, or category page) the caller meant to land there — don't override it.
  if (parsed.pathname.replace(/\/+$/, '') !== '') return null;
  const term = deriveSearchTerm(goal, site);
  return term ? site.searchUrl(term) : null;
}

async function openNewSession(userId, url, goal) {
  const site = siteKeyFromUrl(url);
  const storageState = await loadStorageState(userId, site);
  const browser = await getWarmBrowser();
  // A smaller viewport means a smaller screenshot — fewer bytes and fewer pixels for the
  // model to read each step (the dominant per-step cost). 1024×768 still shows enough of a
  // commercial page to find a search box / first result.
  const context = await browser.newContext({ viewport: VIEWPORT, ...(storageState ? { storageState } : {}) });
  const page = await context.newPage();
  // Jump straight to a search-results page on sites we know how to query (skips the
  // find-box → fill → submit steps); falls back to the given url when we can't.
  const openUrl = directSearchUrl(url, goal) || url;
  await timed('open.goto', () => page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }));
  // Let the SPA hydrate before the first perception, or we screenshot a bare skeleton
  // and the model thinks there's no search bar. A longer beat here (first paint is the
  // slowest) but still bounded — not the old open-ended networkidle wait.
  await timed('open.settle1', () => settle(page, OPEN_HYDRATE_MS));
  // Clear the consent wall up front so the model's very first screenshot is the real
  // page, not a cookie banner it'll waste steps on.
  await timed('open.consent', () => dismissConsent(page).catch(() => {}));
  await timed('open.settle2', () => settle(page, OPEN_POST_CONSENT_MS));
  return createSession(userId, { browser, context, page, site, goal, history: [], pendingPaymentLabel: null, isOrder: isOrderGoal(goal) });
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

async function runOrderingTurn(userId, { url, goal, onProgress = () => {} }) {
  // Started here, not after the session is open — a slow first-time browser launch +
  // page load must count against the same budget that bounds the step loop, or the
  // open alone can eat the mobile client's 45s watchdog before a single step runs.
  const startedAt = Date.now();
  let session = getSession(userId);
  if (!session) {
    // No live session. Prefer the url we were handed; otherwise re-open where we left
    // off from persisted context so an idle-evicted order resumes instead of dead-ending.
    let openUrl = url;
    let priorHistory = null;
    if (!openUrl) {
      const resume = await loadResumeContext(userId);
      if (!resume) {
        return { type: 'error', error: 'I don\'t have an order in progress to pick back up. Tell me what you\'d like and where to deliver it, and I\'ll start fresh.' };
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
    try {
      session = await openNewSession(userId, openUrl, goal);
      if (priorHistory) {
        session.history = priorHistory;
        // A resumed session that already has steps is an order in progress — latch the
        // flag so a premature "done" (on a bare reply like "mcdonald's") can't close it.
        if (priorHistory.length) session.isOrder = true;
      }
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
  let consecutiveBadDecisions = 0;
  let consecutiveWaits = 0;
  // A click on a VALID element "succeeds" even when it achieves nothing, so the bad-decision
  // guard never trips on a model that re-clicks the same tile forever (seen on the Uber Eats
  // item modal). Track the last action's signature and nudge, then trip, on repeats.
  let lastActionSig = '';
  let repeatActionCount = 0;
  // When the model picks an element that isn't on the page (a hallucinated id, e.g. a
  // price read off the screen), we feed a pointed correction into the NEXT decision so it
  // can fix itself — instead of silently re-asking the identical prompt against the same
  // screenshot, which just reproduces the same bad id until the stuck-guard trips.
  let pendingCorrection = '';
  // One calm line when we genuinely can't make progress — never a loop of asks, never a
  // request for a URL/selector. Keeps the session open so "keep going" can retry.
  const STUCK = { type: 'error', error: session.isOrder
    ? 'I got stuck on this page and couldn\'t make progress. Want me to try a different restaurant, or another platform like Deliveroo or Just Eat?'
    : 'I got stuck on this page and couldn\'t make progress. Want me to try a different site, or take another approach?' };

  try {
    while (steps < MAX_STEPS && Date.now() - startedAt < MAX_DURATION_MS) {
      steps += 1;
      onProgress('Looking at the page…');
      await timed('step.settle', () => settle(session.page, STEP_SETTLE_MS)); // let any in-flight render finish before we look
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
          session.consentHandled = true; // no banner showed up in the first few steps; stop checking
        }
      }
      const elements = await timed('step.extract', () => extractClickableElements(session.page));

      // Blocked/empty shell: a near-empty page with almost no text means the site served
      // a stripped page (common when a datacenter IP is blocked). Fail once, cleanly.
      if (steps === 1 && elements.length < 3) {
        const bodyLen = await session.page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
        if (bodyLen < 200) {
          return { type: 'error', error: session.isOrder
            ? 'I couldn\'t load the page properly just now — the site may be blocking automated access. Want me to try Deliveroo or Just Eat instead?'
            : 'I couldn\'t load the page properly just now — the site may be blocking automated access. Want me to try a different site instead?' };
        }
      }

      const screenshot = await timed('step.screenshot', () => captureMarkedScreenshot(session.page, elements).catch(() => null));
      // ponytail: debug-only — set OXY_DEBUG_SCREENSHOT_DIR to dump what the model sees
      // at each step, to eyeball that badges land on real controls. No-op when unset.
      if (screenshot && process.env.OXY_DEBUG_SCREENSHOT_DIR) {
        require('fs').writeFile(`${process.env.OXY_DEBUG_SCREENSHOT_DIR}/step-${steps}.jpg`, Buffer.from(screenshot, 'base64'), () => {});
      }
      const decision = await timed('step.decide', () => decideNextAction(session.goal, session.history, elements, screenshot, pendingCorrection));
      pendingCorrection = ''; // consumed — only applies to the one retry it was raised for

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
        await closeSession(userId);
        return { type: 'done', text: decision.summary || 'Done.' };
      }

      if (decision.action === 'ask') {
        // Never surface a technical question. Treat it as a stuck step and retry instead.
        if (isTechnicalAsk(decision.question)) {
          consecutiveBadDecisions += 1;
          session.history.push(`Step ${steps}: suppressed a technical question ("${String(decision.question).slice(0, 60)}")`);
          if (consecutiveBadDecisions >= 3) return STUCK;
          await session.page.waitForTimeout(1200);
          continue;
        }
        return { type: 'ask', question: decision.question };
      }

      if (decision.action === 'ready_for_payment') {
        // Find the real pay button (the cart-summary text never matches a clickable
        // element) so confirmPayment can re-find and click it. If no pay control is
        // visible yet, don't hand off a dead-end — ask the user how to proceed.
        const payEl = elements.find(el => matchesPaymentKeyword(el.text));
        if (!payEl) {
          return { type: 'ask', question: 'The order looks ready, but I can\'t see a payment button on screen yet — want me to keep going, or check the cart yourself?' };
        }
        session.pendingPaymentLabel = payEl.text;
        return { type: 'ready_for_payment', summary: decision.summary, total: decision.total || '' };
      }

      // click or fill — the id MUST be one we actually showed the model. A miss here is
      // almost always a hallucinated id (the model used a price/quantity it read off the
      // page). Don't just retry the identical prompt — raise a correction so the next
      // decision is told the id was invalid and which ids are real, then it can recover.
      const lastId = elements.length ? elements.length - 1 : 0;
      const idIsValid = Number.isInteger(decision.elementId) && decision.elementId >= 0 && decision.elementId <= lastId;
      const target = idIsValid ? elements.find(el => el.id === decision.elementId) : null;
      if (!target) {
        consecutiveBadDecisions += 1;
        pendingCorrection = `Your last reply used elementId ${decision.elementId}, which is NOT on this page. Valid element ids are 0 to ${lastId}. Look at the numbered badges in the screenshot and choose one of those — do not use any other number.`;
        session.history.push(`Step ${steps}: model chose elementId ${decision.elementId}, which is not on the page (valid 0-${lastId}); asked it to pick a real one`);
        if (consecutiveBadDecisions >= 3) return STUCK;
        continue;
      }

      if (matchesPaymentKeyword(target.text)) {
        session.pendingPaymentLabel = target.text;
        return { type: 'ready_for_payment', summary: `Ready to ${target.text}`, total: '' };
      }

      const locator = session.page.locator(CLICKABLE_SELECTOR).nth(target.locatorIndex);
      try {
        if (decision.action === 'click') {
          onProgress(`Clicking "${target.text}"…`);
          // Two real-site hazards: (1) elements in horizontal carousels/off-screen rows
          // aren't in the viewport, and force-click alone errors "outside of the viewport"
          // because force skips the patient scroll-and-retry; (2) decorative/consent <div>s
          // overlay the target and "intercept pointer events". So: scroll it into view
          // first, then force the click past any overlay. Safe — the payment guardrail
          // above means the loop never force-clicks a pay button.
          await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await locator.click({ timeout: 10000, force: true });
          session.history.push(`Step ${steps}: clicked "${target.text}"`);
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
            const nested = locator.locator('input, textarea, [contenteditable]').first();
            if (await nested.count().catch(() => 0)) {
              await nested.fill(value, { timeout: 8000 });
            } else {
              await locator.click({ timeout: 5000, force: true }).catch(() => {});
              await session.page.keyboard.type(value, { delay: 10 });
            }
          }
          session.history.push(`Step ${steps}: filled "${target.text}" with "${value}"`);
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
    await session.page.locator(CLICKABLE_SELECTOR).nth(target.locatorIndex).click({ timeout: 10000 });
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
  deriveSearchTerm,
  directSearchUrl,
  matchesPaymentKeyword,
  isTechnicalAsk,
  isOrderGoal,
  buildDecisionPrompt,
  parseModelDecision,
  findElementByText,
  createSession,
  getSession,
  touchSession,
  closeSession,
  extractClickableElements,
  runOrderingTurn,
  confirmPayment,
  cancelPayment
};

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { createSupabaseServiceClient, createGeminiServiceClient } = require('../../runtime');

chromium.use(stealth);

const FAST_MODEL = process.env.OXY_FAST_MODEL || process.env.GEMINI_FAST_MODEL || 'gemini-3.1-flash-lite';
const MAX_STEPS = 40;
const MAX_DURATION_MS = 4 * 60 * 1000;

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

async function saveStorageState(userId, site, storageState) {
  await getSupabase()
    .from('browser_sessions')
    .upsert({ user_id: userId, site, storage_state: storageState, updated_at: new Date().toISOString() }, { onConflict: 'user_id,site' });
}

function siteKeyFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return 'unknown'; }
}

// Launches local stealth Chromium by default. Set BROWSER_REMOTE_ENDPOINT to a
// managed scraping-browser CDP endpoint (Bright Data, Browserbase, etc.) to
// swap in proxy/fingerprint-rotation reliability without touching call sites.
async function launchBrowser() {
  const remoteEndpoint = process.env.BROWSER_REMOTE_ENDPOINT;
  if (remoteEndpoint) return chromium.connectOverCDP(remoteEndpoint);
  return chromium.launch({ headless: true });
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

function buildDecisionPrompt(goal, history, elements) {
  const historyText = history.length
    ? history.map((entry, i) => `${i + 1}. ${entry}`).join('\n')
    : '(nothing yet)';
  const elementsText = elements.map(el => `#${el.id} "${el.text}"`).join('\n');
  return `You are controlling a real web browser to help with this goal: "${goal}"

What's happened so far:
${historyText}

Visible clickable elements on the current page:
${elementsText}

Reply with ONLY one JSON object, one of these shapes:
{"action":"click","elementId":<number>}
{"action":"fill","elementId":<number>,"value":"<text>"}
{"action":"ask","question":"<short question for the user>"}
{"action":"done","summary":"<short summary answering the goal>"}
{"action":"ready_for_payment","summary":"<what's in the cart>","total":"<price as shown on the page>"}

DEFAULT TO ACTING. Carry out the goal yourself — type in the search box, enter the delivery address, click Search, open the single most relevant restaurant, add the requested item — WITHOUT asking permission. The user already gave you the goal; doing the obvious next step is your job, not theirs. Prefer "fill"/"click" over "ask" every single time you can.

Use "ask" ONLY as a genuine last resort, when you truly cannot proceed: a real fork the goal does not resolve (e.g. two clearly different restaurants match equally well), or required input that is missing from the goal and history (e.g. a delivery address you were never given). NEVER ask whether to do something you could just do — searching for a named item, filling a field whose value you already know, or picking the obvious best match. "Should I search for X?" is never a valid question — just search.

Use "ready_for_payment" once the cart is built and the next step would be paying — never choose "click" on anything that finalizes a purchase yourself.`;
}

function parseModelDecision(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawText || '').trim());
  } catch {
    return { action: 'invalid', error: 'Could not parse model response as JSON.' };
  }
  const validActions = new Set(['click', 'fill', 'ask', 'done', 'ready_for_payment']);
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

const CLICKABLE_SELECTOR = 'button, a, input, [role="button"]';
const MAX_ELEMENTS = 60;

async function extractClickableElements(page) {
  const locator = page.locator(CLICKABLE_SELECTOR);
  const count = await locator.count();
  const elements = [];
  for (let i = 0; i < count && elements.length < MAX_ELEMENTS; i++) {
    const el = locator.nth(i);
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const text = (await el.innerText().catch(() => ''))
      || (await el.getAttribute('aria-label').catch(() => ''))
      || (await el.getAttribute('placeholder').catch(() => ''))
      || (await el.getAttribute('value').catch(() => ''))
      || '';
    const trimmed = text.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!trimmed) continue;
    elements.push({ id: elements.length, text: trimmed, locatorIndex: i });
  }
  return elements;
}

async function decideNextAction(goal, history, elements) {
  const model = getGemini().getGenerativeModel({ model: FAST_MODEL });
  const response = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: buildDecisionPrompt(goal, history, elements) }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 300, responseMimeType: 'application/json' }
  });
  return parseModelDecision(response.response.text());
}

async function openNewSession(userId, url, goal) {
  const site = siteKeyFromUrl(url);
  const storageState = await loadStorageState(userId, site);
  const browser = await launchBrowser();
  const context = await browser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return createSession(userId, { browser, context, page, site, goal, history: [], pendingPaymentLabel: null });
}

// Best-effort: save cookies/localStorage so a logged-in session survives into the
// next run. Failing to persist must never abort an in-progress order.
async function persistStorage(userId, session) {
  try {
    await saveStorageState(userId, session.site, await session.context.storageState());
  } catch {
    // swallow — cookie persistence is non-critical to the current turn
  }
}

async function runOrderingTurn(userId, { url, goal, onProgress = () => {} }) {
  let session = getSession(userId);
  if (!session) {
    if (!url) return { type: 'error', error: 'That session expired (idle too long) and there\'s no url to restart it — ask the user which site/restaurant again.' };
    onProgress('Opening browser…');
    try {
      session = await openNewSession(userId, url, goal);
    } catch (error) {
      return { type: 'error', error: error.message };
    }
  } else {
    touchSession(userId);
    session.goal = goal; // latest message becomes the active instruction, history carries prior context
  }

  const startedAt = Date.now();
  let steps = 0;
  let consecutiveBadDecisions = 0;

  try {
    while (steps < MAX_STEPS && Date.now() - startedAt < MAX_DURATION_MS) {
      steps += 1;
      onProgress('Looking at the page…');
      const elements = await extractClickableElements(session.page);
      const decision = await decideNextAction(session.goal, session.history, elements);

      if (decision.action === 'invalid') {
        consecutiveBadDecisions += 1;
        session.history.push(`Step ${steps}: could not decide an action (${decision.error})`);
        if (consecutiveBadDecisions >= 3) {
          return { type: 'ask', question: 'I\'m stuck on this page — what should I do next?' };
        }
        continue;
      }

      if (decision.action === 'done') {
        await closeSession(userId);
        return { type: 'done', text: decision.summary || 'Done.' };
      }

      if (decision.action === 'ask') {
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

      // click or fill
      const target = elements.find(el => el.id === decision.elementId);
      if (!target) {
        consecutiveBadDecisions += 1;
        session.history.push(`Step ${steps}: tried to act on element #${decision.elementId}, which no longer exists`);
        if (consecutiveBadDecisions >= 3) {
          return { type: 'ask', question: 'I\'m stuck on this page — what should I do next?' };
        }
        continue;
      }

      if (matchesPaymentKeyword(target.text)) {
        session.pendingPaymentLabel = target.text;
        return { type: 'ready_for_payment', summary: `Ready to ${target.text}`, total: '' };
      }

      const locator = session.page.locator(CLICKABLE_SELECTOR).nth(target.locatorIndex);
      if (decision.action === 'click') {
        onProgress(`Clicking "${target.text}"…`);
        await locator.click({ timeout: 10000 });
        session.history.push(`Step ${steps}: clicked "${target.text}"`);
      } else if (decision.action === 'fill') {
        onProgress(`Typing into "${target.text}"…`);
        await locator.fill(String(decision.value || ''), { timeout: 10000 });
        session.history.push(`Step ${steps}: filled "${target.text}" with "${decision.value}"`);
      }
      consecutiveBadDecisions = 0;
      touchSession(userId);
      await persistStorage(userId, session);
    }
  } catch (error) {
    return { type: 'error', error: error.message };
  }

  return { type: 'awaiting_more', summary: `Still working on it — ${session.history.length} step(s) so far. Want me to keep going?` };
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
  matchesPaymentKeyword,
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

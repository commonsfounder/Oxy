const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { createSupabaseServiceClient, createGeminiServiceClient } = require('../../runtime');

chromium.use(stealth);

const FAST_MODEL = process.env.OXY_FAST_MODEL || process.env.GEMINI_FAST_MODEL || 'gemini-3.1-flash-lite';
// Each turn must finish well within the mobile client's ~45s request watchdog, or the
// app reports "stuck waiting on the network" while the server is still working. Keep
// turns short; if the order isn't done, return awaiting_more and the next message
// (routed back in by the deterministic-resume path) continues it.
const MAX_STEPS = 15;
const MAX_DURATION_MS = 30 * 1000;

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
  // ponytail: headless:true in prod; BROWSER_HEADLESS=false lets a local debug run pop
  // a real window so you can watch the loop click around, instead of trusting logs.
  return chromium.launch({ headless: process.env.BROWSER_HEADLESS !== 'false' });
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

function buildDecisionPrompt(goal, history, elements) {
  const historyText = history.length
    ? history.map((entry, i) => `${i + 1}. ${entry}`).join('\n')
    : '(nothing yet)';
  const elementsText = elements.map(el => `#${el.id} "${el.text}"`).join('\n');
  return `You are controlling a real web browser to help with this goal: "${goal}"

You can SEE the current page in the attached screenshot. Every clickable element has a
small numbered badge drawn on it; the number is its element id and matches the list
below. LOOK at the screenshot first — find the thing you need (search box, address
field, a restaurant, an "Add" button) by sight, then act on it by its number. The page
text alone is unreliable; trust your eyes. If the page looks like it's still loading
(spinners, blank areas, a skeleton), choose "wait".

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
  let parsed;
  try {
    parsed = JSON.parse(String(rawText || '').trim());
  } catch {
    return { action: 'invalid', error: 'Could not parse model response as JSON.' };
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
    // box is viewport-relative (getBoundingClientRect under the hood) so it lines up
    // with the screenshot; may be null for off-viewport elements — those just get no badge.
    const box = await el.boundingBox().catch(() => null);
    elements.push({ id: elements.length, text: trimmed, locatorIndex: i, box });
  }
  return elements;
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
    const shot = await page.screenshot({ type: 'png' });
    return shot.toString('base64');
  } finally {
    await page.evaluate(() => document.getElementById('__oxy_marks__')?.remove()).catch(() => {});
  }
}

// Wait for the SPA to go quiet, but never throw: sites with long-poll/websocket
// connections never reach true networkidle, so we swallow the timeout and move on.
async function settle(page, timeout = 2500) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

async function decideNextAction(goal, history, elements, screenshotB64) {
  const model = getGemini().getGenerativeModel({ model: FAST_MODEL });
  const parts = [{ text: buildDecisionPrompt(goal, history, elements) }];
  if (screenshotB64) parts.push({ inlineData: { mimeType: 'image/png', data: screenshotB64 } });
  const response = await model.generateContent({
    contents: [{ role: 'user', parts }],
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
  // Let the SPA hydrate before the first perception, or we screenshot a bare skeleton
  // and the model thinks there's no search bar.
  await settle(page, 8000);
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
    session.goal = goal; // latest message becomes the active instruction, history carries prior context
    session.isOrder = session.isOrder || isOrderGoal(goal); // latch once an order, always an order
  }

  const startedAt = Date.now();
  let steps = 0;
  let consecutiveBadDecisions = 0;
  // One calm line when we genuinely can't make progress — never a loop of asks, never a
  // request for a URL/selector. Keeps the session open so "keep going" can retry.
  const STUCK = { type: 'error', error: 'I got stuck on this page and couldn\'t make progress. Want me to try a different restaurant, or another platform like Deliveroo or Just Eat?' };

  try {
    while (steps < MAX_STEPS && Date.now() - startedAt < MAX_DURATION_MS) {
      steps += 1;
      onProgress('Looking at the page…');
      await settle(session.page); // let any in-flight render finish before we look
      const elements = await extractClickableElements(session.page);

      // Blocked/empty shell: a near-empty page with almost no text means the site served
      // a stripped page (common when a datacenter IP is blocked). Fail once, cleanly.
      if (steps === 1 && elements.length < 3) {
        const bodyLen = await session.page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
        if (bodyLen < 200) {
          return { type: 'error', error: 'I couldn\'t load the page properly just now — the site may be blocking automated access. Want me to try Deliveroo or Just Eat instead?' };
        }
      }

      const screenshot = await captureMarkedScreenshot(session.page, elements).catch(() => null);
      // ponytail: debug-only — set OXY_DEBUG_SCREENSHOT_DIR to dump what the model sees
      // at each step, to eyeball that badges land on real controls. No-op when unset.
      if (screenshot && process.env.OXY_DEBUG_SCREENSHOT_DIR) {
        require('fs').writeFile(`${process.env.OXY_DEBUG_SCREENSHOT_DIR}/step-${steps}.png`, Buffer.from(screenshot, 'base64'), () => {});
      }
      const decision = await decideNextAction(session.goal, session.history, elements, screenshot);

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

      // click or fill
      const target = elements.find(el => el.id === decision.elementId);
      if (!target) {
        consecutiveBadDecisions += 1;
        session.history.push(`Step ${steps}: tried to act on element #${decision.elementId}, which no longer exists`);
        if (consecutiveBadDecisions >= 3) return STUCK;
        continue;
      }

      if (matchesPaymentKeyword(target.text)) {
        session.pendingPaymentLabel = target.text;
        return { type: 'ready_for_payment', summary: `Ready to ${target.text}`, total: '' };
      }

      const locator = session.page.locator(CLICKABLE_SELECTOR).nth(target.locatorIndex);
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
        await locator.fill(String(decision.value || ''), { timeout: 10000 });
        session.history.push(`Step ${steps}: filled "${target.text}" with "${decision.value}"`);
      }
      consecutiveBadDecisions = 0;
      touchSession(userId);
      await persistStorage(userId, session);
    }
  } catch (error) {
    // Playwright errors carry a multi-line call log — log it server-side, but show the
    // user a short, calm line (the session stays open so they can continue).
    console.warn('[browser-task] step failed:', error.message);
    const reason = String(error.message || 'something went wrong').split('\n')[0].slice(0, 160);
    session.history.push(`Step ${steps}: action failed (${reason})`);
    return { type: 'error', error: `Hit a snag on the page (${reason}). Say "keep going" and I'll pick up where I left off.` };
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

'use strict';
// The browser as a general environment: perception and the primitive actions, knowing nothing
// about any task. The perception heuristics below name common control labels only to rank what
// the model sees first on a cluttered page; nothing here branches on what the goal is.

const {
  VIEWPORT, envInt, withTimeout, acquireBrowser, createSession, getSession, touchSession,
  closeSession, checkpointBrowserState, loadStorageState, persistStorage, siteKeyFromUrl,
  gotoBrowserPage,
} = require('./browser-session');

const SCREENSHOT_QUALITY = envInt('OXY_BROWSER_SCREENSHOT_QUALITY', 30);
const MAX_ELEMENTS = envInt('OXY_BROWSER_MAX_ELEMENTS', 60);
const SCROLL_DELTAS = Object.freeze({ small: 350, medium: 700, large: 1100 });

// Site knowledge is consulted lazily so this module stays loadable without a database.
let siteKnowledge = null;
function getSiteKnowledge() {
  if (!siteKnowledge) siteKnowledge = require('./site-knowledge-store');
  return siteKnowledge;
}
const FRAME_EVALUATE_TIMEOUT_MS = envInt('OXY_BROWSER_FRAME_EVALUATE_TIMEOUT_MS', 4000);

// A frame can navigate or detach mid-evaluate; bound it and fall back rather than throwing.
function safeFrameEvaluate(frame, pageFunction, arg, fallback) {
  return withTimeout(frame.evaluate(pageFunction, arg), FRAME_EVALUATE_TIMEOUT_MS, 'frame evaluate')
    .catch(() => fallback);
}

// Anti-automation interstitials, which a datacenter IP trips on many sites. The page loads with
// real bytes, so the empty-shell guard misses it, and the loop then spends its whole budget
// clicking a dead page. Matching the copy lets it bail on the first step instead.
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

// [dropdown] carries its options inline so the model picks a value it has actually seen —
// guessed text fails the exact-match-first selectOption call.
function renderElementLine(el) {
  const tag = el.isSelect
    ? ` [dropdown, options: ${(el.options || []).map((o) => `"${o}"`).join(', ')}]`
    : (el.isInput ? ' [input]' : '');
  return `#${el.id}${tag} "${el.text}"`;
}

// ARIA-role interactives too, not just native controls: autocomplete suggestions, menu items
// and size radios are often role-based divs. `label` covers styled radio/checkbox chips (only
// where the real control is hidden, so plain form labels don't double every field), and
// `select` covers native dropdowns, which need the "select" action rather than click/fill.
const CLICKABLE_SELECTOR = 'button, a, input, textarea, label, select, [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="combobox"]';

async function extractClickableElements(page) {
  // One page.evaluate rather than ~6 CDP calls per element, which costs ~0.8s on a 40-element
  // page. `locatorIndex` is the querySelectorAll index, matching Playwright's .nth(i) order.
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
      // Some interstitials are plain fixed divs with no dialog role, so badges land on the inert
      // page behind them. Ask what is physically on top at the viewport centre, and scope
      // perception to it when that turns out to be an overlay card rather than the app shell.
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
    // Commercial pages front-load 20-40 nav controls in DOM order, which eats the element budget
    // before the first product tile. Order: in-viewport content, then chrome that matters
    // (search, basket, consent), then the rest of the chrome, then anything off-viewport.
    if (!dialog) {
      const inViewport = (el) => {
        const r = el.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
      };
      const inChrome = (el) => !!el.closest('header,nav,footer,aside,[role="banner"],[role="navigation"],[role="contentinfo"]');
      const KEY_CHROME = /search|basket|\bbag\b|cart|checkout|allow|accept|sign\s?in|log\s?in|account|settings|my\s|continue|next|submit|apply|manage/i;
      const labelOf = (el) => ((el.innerText || '') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 80);
      // Off-screen content outranks on-screen plain chrome: a product page's buy box is often
      // below the fold with 20 nav links above it. Key chrome keeps its priority.
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
      // A native <select>'s innerText is every option concatenated, not the selected one, so it
      // needs its own text: the selected option, plus a capped list to pick an exact value from.
      const isSelect = el.tagName === 'SELECT';
      let options = null;
      if (isSelect) {
        options = Array.from(el.options)
          .map((o) => (o.text || '').trim().replace(/\s+/g, ' ').slice(0, 40))
          .filter(Boolean)
          .slice(0, 30);
      }
      const raw = isSelect
        ? ((el.options[el.selectedIndex] && el.options[el.selectedIndex].text) || el.getAttribute('aria-label') || '')
        : (el.innerText || '') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('value') || '';
      let text = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!text) continue;
      // Skip accessibility skip-links (Skip to main content, Skip to navigation, etc.) —
      // they are off-screen by design and clicking them throws "outside of viewport".
      if (/^skip\s+(to|the)\b/i.test(text)) continue;
      // Surface disabled state (out-of-stock size chips, inactive CTAs) so the model can
      // reason about it instead of clicking a dead control forever (Nike: sold-out sizes
      // are aria-disabled radios behind styled labels — 2026-07-02, 273s of "UK 10" clicks).
      const isOff = el.disabled || el.getAttribute('aria-disabled') === 'true'
        || (proxyCtl && (proxyCtl.disabled || proxyCtl.getAttribute('aria-disabled') === 'true'));
      if (isOff && !/unavailable|out of stock/i.test(text)) text = `${text} (unavailable)`;
      const locatorIndex = allNodes.indexOf(el); // index in full-document order = Playwright nth()
      if (locatorIndex === -1) continue;
      const r = el.getBoundingClientRect();
      // A promo banner and a search box can carry equally relevant-sounding text, and on labels
      // alone the model picks the banner. Only the DOM knows which one accepts typed input.
      const inputTarget = proxyCtl || el;
      const NON_TEXT_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color']);
      const isInput = (inputTarget.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((inputTarget.type || 'text').toLowerCase()))
        || inputTarget.tagName === 'TEXTAREA'
        || inputTarget.getAttribute('contenteditable') === 'true'
        || ['searchbox', 'textbox', 'combobox'].includes(inputTarget.getAttribute('role') || '');
      // box is viewport-relative so it lines up with the screenshot; off-viewport elements
      // keep their (off-screen) coords and simply get no visible badge, as before.
      const item = { id: out.length, text, locatorIndex, isInput, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
      if (isSelect) { item.isSelect = true; item.options = options; }
      out.push(item);
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

// Let the page catch up before perceiving it. Never 'networkidle': analytics-heavy SPAs never
// reach it, so that always burns its full timeout. Parse the DOM, take one short hydration
// beat, and leave a still-loading page to the model's "wait" action. Best-effort, never throws.
async function settle(page, pauseMs = 600) {
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(Math.max(0, pauseMs)).catch(() => {});
}

// A consent wall covers the real page, so the first screenshot is all banner. Clicks the first
// accept control it recognises — the common frameworks by id, then by text. Cheap and
// best-effort: with no banner present it is a couple of no-ops.
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
  /^accept cookies$/i, /^i accept$/i, /^accept$/i, /^agree$/i, /^got it$/i, /^continue$/i,
  // Sainsbury's cookie banner reads "Continue and accept" — start-anchored (not fully
  // anchored like the others above) since real sites glue accept-language onto "Continue".
  /^continue\s+and\s+accept\b/i
];

async function dismissConsentOnce(page) {
  // Fast path: the common consent frameworks expose a stable id.
  for (const sel of CONSENT_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 120 }).catch(() => false)) {
      await el.click({ timeout: 1500, force: true }).catch(() => {});
      return true;
    }
  }
  // The whole accessibility tree, not a capped slice — a header carries dozens of controls
  // ahead of the banner in DOM order. Main frame and iframes, since some managers use one.
  for (const root of page.frames()) { // page.frames() includes the main frame
    for (const name of CONSENT_NAMES) {
      const btn = root.getByRole('button', { name }).first();
      if (await btn.isVisible({ timeout: 120 }).catch(() => false)) {
        await btn.click({ timeout: 1500, force: true }).catch(() => {});
        return true;
      }
    }
  }
  // Shadow-DOM fallback: some consent widgets live in an open shadow root, which the computed
  // accessibility tree doesn't surface, so the scan above and getByRole both miss the banner
  // while it swallows every click. Walk shadow roots directly and match on innerText.
  const shadowClicked = await page.evaluate((patterns) => {
    const regexes = patterns.map((p) => new RegExp(p, 'i'));
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const hit = walk(el.shadowRoot);
          if (hit) return hit;
        }
      }
      for (const el of root.querySelectorAll('button, a, [role="button"]')) {
        const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
        if (regexes.some((re) => re.test(t))) return el;
      }
      return null;
    };
    const btn = walk(document);
    if (btn) { btn.click(); return true; }
    return false;
  }, CONSENT_NAMES.map((re) => re.source)).catch(() => false);
  return shadowClicked;
}

// Some consent managers inject the banner a beat after domcontentloaded, so a single pass right
// after load loses the race and every later click lands under the modal. One retry after a real
// wait catches that, and costs nothing when the banner is absent or already dismissed.
async function dismissConsent(page) {
  if (await dismissConsentOnce(page)) return true;
  await page.waitForTimeout(700).catch(() => {});
  return dismissConsentOnce(page);
}

async function readPageText(page) {
  const texts = [];
  for (const frame of page.frames()) {
    const body = await safeFrameEvaluate(frame, () => (document.body ? document.body.innerText : '') || '', undefined, '');
    if (body) texts.push(body.slice(0, 20000));
  }
  return texts.join('\n');
}
// ── Primitive actions ───────────────────────────────────────────────────────────────────
// Each returns a fresh observation, so the caller acts on what the page shows rather than what
// it expected, and "did the state change?" is answerable from any two observations.

const OBSERVATION_TEXT_LIMIT = 4000;

async function observePage(page, { includeScreenshot = false } = {}) {
  const [elements, text] = await Promise.all([
    extractClickableElements(page).catch(() => []),
    readPageText(page).catch(() => ''),
  ]);
  const observation = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    elements,
    elementLines: elements.map(renderElementLine),
    text: String(text || '').slice(0, OBSERVATION_TEXT_LIMIT),
  };
  if (includeScreenshot) {
    observation.screenshot = await captureMarkedScreenshot(page, elements).catch(() => null);
  }
  return observation;
}

function requireSession(userId) {
  const session = getSession(userId);
  if (!session) {
    const error = new Error('No browser session is open. Open a page first.');
    error.code = 'NO_SESSION';
    throw error;
  }
  touchSession(userId);
  return session;
}

// Open a URL. Plain navigation — no search-term derivation, no site fast-paths, no goal
// parsing. `objective` is carried only so a workflow checkpoint can say what the browsing
// was for; nothing branches on it.
async function open(userId, { url, site = '', searchFor = '', objective = '', workflowId = null } = {}) {
  // Resolve a destination from what is already known about the host, so the agent does not
  // have to guess a search URL or land on a homepage and hunt for the search box. Site
  // knowledge is DATA here: when it has nothing, the given url is used unchanged.
  let target = String(url || '').trim();
  let resolvedVia = 'url';
  if (site || searchFor) {
    const knowledge = getSiteKnowledge().forHost(site || target, { term: searchFor });
    const candidate = (searchFor && knowledge.entryPoints.search) || knowledge.entryPoints.home;
    if (candidate) {
      target = candidate;
      resolvedVia = searchFor && knowledge.entryPoints.search ? `search:${knowledge.entryPoints.searchSource}` : 'home';
    }
  }
  url = target;
  if (!url || !/^https?:\/\//i.test(String(url))) {
    throw new Error('browser_open needs an absolute http(s) url, or a site it already knows.');
  }
  const existing = getSession(userId);
  if (existing) await closeSession(userId);

  const { browser } = await acquireBrowser();
  const host = siteKeyFromUrl(url);
  const storageState = await loadStorageState(userId, host).catch(() => null);

  // Reusing a stored session IS a credential use, and a stronger one than a password: a live
  // cookie skips both the login form and 2FA. Logged, not gated — session reuse is how signed-in
  // work happens at all, and the log is what makes that an informed choice.
  if (storageState) {
    const { recordUse } = require('./credential-grants');
    const { getSupabase } = require('./browser-session');
    await recordUse(getSupabase(), userId, {
      site: host, taskId: null, outcome: 'used', reason: 'stored_session',
    }).catch(() => {});
  }
  const context = await browser.newContext({ viewport: VIEWPORT, ...(storageState ? { storageState } : {}) });
  const page = await context.newPage();
  await gotoBrowserPage(page, url);
  await settle(page, 150);
  await dismissConsent(page).catch(() => {});
  await settle(page, 100);

  const session = createSession(userId, {
    browser, context, page, site: host, goal: objective, workflowId,
    history: [], requestedUrl: url, usedStoredSession: Boolean(storageState),
  });
  const blocked = await detectBlockWall(page).catch(() => null);
  const observation = await observePage(page);
  return {
    ...observation,
    blocked: blocked || null,
    usedStoredSession: session.usedStoredSession,
    resolvedVia,
    // What is already known to work on this host, as hints rather than as a script the agent
    // is made to follow. Empty for an unknown host, which stays perfectly workable.
    hints: getSiteKnowledge().hintsFor(host),
  };
}

async function observe(userId, { includeScreenshot = false } = {}) {
  const session = requireSession(userId);
  return observePage(session.page, { includeScreenshot });
}

function resolveElement(session, elements, elementId) {
  const index = Number(elementId);
  if (!Number.isInteger(index) || index < 0 || index >= elements.length) {
    throw new Error(`elementId ${elementId} is not on the current page (0–${Math.max(0, elements.length - 1)}). Observe again before acting.`);
  }
  const el = elements[index];
  return session.page.locator(CLICKABLE_SELECTOR).nth(el.locatorIndex);
}

// Run one primitive against the live page and report what changed. `verify` is deliberately
// mechanical (url + element count + a text digest) — the agent decides what the change MEANS.
async function act(userId, step = {}) {
  const session = requireSession(userId);
  const page = session.page;
  const before = { url: page.url(), text: (await readPageText(page).catch(() => '')).slice(0, 2000) };
  const elements = await extractClickableElements(page).catch(() => []);
  const kind = String(step.action || '').toLowerCase();

  switch (kind) {
    case 'click':
      await resolveElement(session, elements, step.elementId).click({ timeout: 10000 });
      break;
    case 'type': {
      const target = resolveElement(session, elements, step.elementId);
      await target.fill(String(step.value ?? ''), { timeout: 10000 });
      if (step.submit !== false) await page.keyboard.press('Enter').catch(() => {});
      break;
    }
    case 'select':
      await resolveElement(session, elements, step.elementId)
        .selectOption({ label: String(step.value ?? '') }, { timeout: 10000 });
      break;
    case 'scroll': {
      const amount = SCROLL_DELTAS[String(step.amount || 'medium')] || SCROLL_DELTAS.medium;
      const delta = String(step.direction || 'down') === 'up' ? -amount : amount;
      await page.mouse.wheel(0, delta);
      break;
    }
    case 'back':
      await page.goBack({ timeout: 15000 }).catch(() => {});
      break;
    case 'navigate':
      if (!step.url || !/^https?:\/\//i.test(String(step.url))) throw new Error('navigate requires an absolute http(s) url.');
      await gotoBrowserPage(page, String(step.url));
      break;
    case 'wait':
      break;
    default:
      throw new Error(`Unknown browser action "${step.action}". Use click, type, select, scroll, back, navigate or wait.`);
  }

  await settle(page, Number(step.settleMs) || 400);
  await dismissConsent(page).catch(() => {});
  session.history = [...(session.history || []), `${kind}${step.elementId != null ? ` #${step.elementId}` : ''}${step.value ? ` "${step.value}"` : ''}`].slice(-40);

  const observation = await observePage(page);
  const blocked = await detectBlockWall(page).catch(() => null);
  await checkpointBrowserState(session, { lastObservation: observation.url });
  return {
    ...observation,
    blocked: blocked || null,
    changed: {
      url: before.url !== observation.url,
      urlBefore: before.url,
      content: before.text.slice(0, 400) !== observation.text.slice(0, 400),
    },
  };
}

async function close(userId) {
  const session = getSession(userId);
  if (!session) return { closed: false };
  await persistStorage(userId, session).catch(() => {});
  await closeSession(userId);
  return { closed: true };
}

module.exports = {
  // perception
  observePage,
  observe,
  extractClickableElements,
  captureMarkedScreenshot,
  renderElementLine,
  readPageText,
  safeFrameEvaluate,
  detectBlockWall,
  looksLikeBlockWall,
  dismissConsent,
  dismissConsentOnce,
  settle,
  CLICKABLE_SELECTOR,
  BLOCK_WALL_PATTERN,
  CONSENT_SELECTORS,
  CONSENT_NAMES,
  SCROLL_DELTAS,
  // primitives
  open,
  act,
  close,
  requireSession,
};

// ── Known details ───────────────────────────────────────────────────────────────────────
// A tenancy application, a claim and a checkout all ask for the same portable facts. This fills
// whatever the page asks for that is already known and reports the genuine gaps, so the agent
// asks the person once rather than guessing or asking for everything.

const IDENTITY_FIELD_SELECTOR = 'input, select, textarea';

function identityValuesFrom(profile = {}) {
  const values = {};
  if (profile.title) values.title = profile.title;
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

// Reads only field METADATA — never a value already on the page, and never a payment field.
async function observeFormFields(page) {
  return page.evaluate((selector) => {
    const out = [];
    const nodes = Array.from(document.querySelectorAll(selector));
    nodes.forEach((el, index) => {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'file'].includes(type)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
      const hint = [
        el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('autocomplete'),
        el.getAttribute('placeholder'), el.getAttribute('aria-label'), label, `input ${type}`,
      ].filter(Boolean).join(' ');
      out.push({
        index,
        hint,
        empty: !String(el.value || '').trim(),
        required: el.required || el.getAttribute('aria-required') === 'true',
      });
    });
    return out;
  }, IDENTITY_FIELD_SELECTOR).catch(() => []);
}

/**
 * Fill every field on the current page whose meaning matches something already known.
 * @returns {{filled: string[], missing: string[], observation: object}}
 */
async function fillKnownDetails(userId, { loadProfile } = {}) {
  const session = requireSession(userId);
  const {
    matchProfileFieldForInput, missingCheckoutInformation, loadCheckoutProfile,
  } = require('./checkout-profile');
  const { getSupabase } = require('./browser-session');

  const profile = await (loadProfile ? loadProfile(userId) : loadCheckoutProfile(getSupabase(), userId));
  const values = identityValuesFrom(profile || {});
  const fields = await observeFormFields(session.page);

  const filled = [];
  for (const field of fields) {
    if (!field.empty) continue;
    const key = matchProfileFieldForInput(field.hint);
    if (!key || values[key] == null) continue;
    try {
      await session.page.locator(IDENTITY_FIELD_SELECTOR).nth(field.index)
        .fill(String(values[key]), { timeout: 5000 });
      filled.push(key);
    } catch { /* a field that will not take a value is reported as unfilled, not fatal */ }
  }

  // What the page still requires that nothing on file can answer.
  const missing = missingCheckoutInformation(profile || {}, await observeFormFields(session.page));
  await settle(session.page, 250);
  return { filled: [...new Set(filled)], missing, observation: await observePage(session.page) };
}

module.exports.fillKnownDetails = fillKnownDetails;
module.exports.observeFormFields = observeFormFields;
module.exports.identityValuesFrom = identityValuesFrom;

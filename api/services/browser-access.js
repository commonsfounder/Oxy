'use strict';
// Getting past what a site puts in the way (sign-in walls, guest forks, consent, address
// widgets), and telling whether a step actually moved the page. General, not shopping-specific;
// some exported names still end in "checkout" because callers depend on them.

const {
  settle, readPageText, extractClickableElements, CLICKABLE_SELECTOR, dismissConsent,
} = require('./browser-environment');
const {
  getSession, getSupabase, envInt, loadStorageState, siteKeyFromUrl, acquireBrowser, VIEWPORT,
} = require('./browser-session');
const { getVaultCredential, saveVaultCredential, normalizeSite } = require('./vault-credentials');
const { authorizeCredentialUse, recordUse } = require('./credential-grants');
const { recordTaskStep } = require('./task-steps');
// Filling a sign-in form uses the same frame-aware input machinery as filling a card form.
const frameInputs = () => require('./transaction');
// Lazy: transaction.js requires browser-environment, which this file also uses. Requiring it
// at call time keeps the module graph acyclic.
const isPaymentUrl = (url) => require('./transaction').isCheckoutPaymentUrl(url);

// /callback/ paths are excluded: an auth callback carrying "login" in its path is guest auth
// completing, not a wall.
function isCheckoutLoginWallUrl(url) {
  const u = String(url || '');
  if (/\/callback\b/i.test(u)) return false;
  return /\/(?:login|signin|sign-in|account\/login|users\/login)(?:\b|\/|\?)/i.test(u);
}

// Re-auth detection: a stored session eventually expires and drops the agent on a sign-in
// wall. Spotting it means handing back to the user instead of burning the step budget.
const LOGIN_URL_PATTERN = /\/(login|log-?in|signin|sign-?in|auth|authenticate|account\/(login|signin))(\b|\/|\?|$)/i;

// Copy that, TOGETHER with a password field, marks a page as a login wall (not a header
// "Sign in" link on an otherwise-normal shopping page). Kept tight to avoid false pauses.
const LOGIN_COPY_PATTERN = /\b(sign in to|log in to|enter your password|incorrect password|forgot your password|keep me signed in|sign in to your account)\b/i;

// Stronger basket/checkout soft-gate (e.g. M&S "Sign in or create an account for faster checkout").
// These often appear without a visible password field until clicked — catch them for order goals.
const LOGIN_BASKET_PATTERN = /\b(sign in|log in|sign-in|log-in|create an account|register).*(?:basket|cart|checkout|to (?:continue|view|see|access)|for faster checkout)\b/i;

const PASSWORD_FIELD_SELECTOR = 'input[type="password"]';

// A wall is a login URL, a password field plus login copy (either alone is just an upsell or
// a nav link), or a strong "sign in to see your basket" soft gate. Pure, so it's testable.
function looksLikeLoginWall({ url, bodyText, hasPasswordField, goal } = {}) {
  const u = String(url || '');
  if (LOGIN_URL_PATTERN.test(u)) return true;
  const bt = String(bodyText || '');
  if (hasPasswordField && LOGIN_COPY_PATTERN.test(bt)) return true;
  if (LOGIN_BASKET_PATTERN.test(bt)) return true;
  return false;
}

// A real photo of what the agent found. og:image is the canonical shot on almost every
// storefront; the largest visible <img> is the fallback for sites that don't set it.
async function extractProductImageUrls(page) {
  try {
    return await page.evaluate(() => {
      const abs = src => { try { return new URL(src, document.baseURI).href; } catch { return null; } };
      const urls = [];
      for (const sel of ['meta[property="og:image"]', 'meta[property="og:image:secure_url"]', 'meta[name="og:image"]']) {
        const content = document.querySelector(sel)?.getAttribute('content');
        const u = content && abs(content);
        if (u && !urls.includes(u)) urls.push(u);
      }
      if (urls.length === 0) {
        const imgs = Array.from(document.querySelectorAll('img'))
          .filter(img => img.src && img.naturalWidth >= 200 && img.naturalHeight >= 200)
          .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
        for (const img of imgs.slice(0, 3)) {
          const u = abs(img.src);
          if (u && !urls.includes(u)) urls.push(u);
        }
      }
      return urls.slice(0, 3);
    });
  } catch {
    return [];
  }
}

// A login wall often still offers a guest path on the same page; taking it avoids asking the
// user to sign in for something that never needed an account.
const GUEST_CHECKOUT_PATTERN = /\b(guest checkout|continue as (?:a )?guest|checkout as (?:a )?guest|continue without (?:an )?account|shop as (?:a )?guest|guest order|order as (?:a )?guest|pay as (?:a )?guest|checkout without (?:signing in|an account)|continue without signing in|continue without logging in|shop without an account|skip sign[- ]?in|checkout without registering|order without (?:an )?account)\b/i;

const GUEST_FORK_URL_PATTERN = /login-or-guest|guest[-_]checkout|checkout\/guest|\/ciam\/|checkout\/login|checkout\/signin/i;

// `checkouts?` is plural-optional so Shopify's /checkouts/cn/<token> counts as checkout-ish;
// without it the whole generic checkout pipeline is skipped on every Shopify store.
const CHECKOUTISH_URL_PATTERN = /\/(?:checkouts?|basket|cart|bag|trolley|order)(?:\/|$|\?)/i;

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

// Postcode-lookup widgets can't be driven by the plain line1/city/postcode selectors, so
// prefer any "Enter address manually" control, which swaps in a form that can be.
const MANUAL_ADDRESS_PATTERN = /enter\s+(?:your\s+|the\s+)?address\s+manually|enter\s+manually|manual(?:ly)?\s+enter\s+address|type\s+(?:your\s+)?address/i;

async function tryManualAddressEntryClick(page, session, steps, onProgress) {
  if (session.manualAddressEntryDone) return false;
  // Playwright's getByText rather than the hand-rolled DOM walk: the custom extraction misses
  // this control on some sites for reasons that never resolved.
  const locator = page.getByText(MANUAL_ADDRESS_PATTERN).first();
  const visible = await locator.isVisible({ timeout: 2000 }).catch(() => false);
  if (!visible) return false;
  const text = await locator.innerText().catch(() => 'Enter address manually');
  onProgress(`Clicking "${text}"…`);
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await locator.click({ timeout: 10000, force: true }).catch(() => false);
  await settle(page, 600);
  session.manualAddressEntryDone = true;
  session.history.push(`Step ${steps}: clicked "${text.replace(/\s+/g, ' ').slice(0, 80)}" (address lookup widget → plain address form)`);
  session.lastWasRecipe = true;
  return true;
}

// DOM-based guest click, since extraction can yield only a couple of nodes while the guest
// CTA is still in the DOM. Skipped past the account fork, where clicking again goes backwards.
async function isGuestEmailSubmitStep(page) {
  const emailVisible = await page.locator('input[type="email"]:visible, input[name*="email" i]:visible')
    .first().isVisible({ timeout: 400 }).catch(() => false);
  if (!emailVisible) return false;
  const guestVisible = await pageHasGuestCheckoutCta(page).catch(() => false);
  return !guestVisible;
}

async function tryGuestCheckoutClick(page, session, steps, onProgress) {
  if (session.guestCheckoutDone) return false;
  if (await isGuestEmailSubmitStep(page)) return false;
  // Single object arg: Playwright rejects the multi-positional page.evaluate(fn, a, b, c) form,
  // and the .catch below would swallow the throw and return false forever.
  const hit = await page.evaluate(({ sel, patSource, patFlags }) => {
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
    // Some sites label the guest path as a heading next to a generic button, which the pattern
    // above can't match. Match the heading, then click the nearest CTA inside its own section.
    const headingHit = [...document.querySelectorAll('h1,h2,h3,h4,legend')].find((h) => pat.test((h.innerText || '').trim()));
    if (headingHit) {
      let section = headingHit.closest('section,div,fieldset') || headingHit.parentElement;
      for (let hops = 0; hops < 4 && section; hops++) {
        const btn = [...section.querySelectorAll(sel)].find(visible);
        if (btn) {
          const node = btn.closest(sel) || btn;
          const idx = all.indexOf(node);
          if (idx >= 0) return { idx, text: (btn.innerText || btn.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80) };
        }
        section = section.parentElement;
      }
    }
    return null;
  }, { sel: CLICKABLE_SELECTOR, patSource: GUEST_CHECKOUT_PATTERN.source, patFlags: GUEST_CHECKOUT_PATTERN.flags }).catch(() => null);
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

// JL / Auth0 checkout page: two collapsed radio cards — "Sign in" and "Guest checkout".
// Auth0's SPA needs the radio <input> clicked (not its label) to expand the email form.
// If the email form is already showing (second call after expansion), fill + submit.
async function tryAuth0GuestCheckout(page, session, steps, onProgress) {
  if (session.auth0GuestDone) return false;
  try {
    const parsed = new URL(page.url());
    if (!parsed.hostname.startsWith('auth.')) return false;
  } catch { return false; }

  // If an email input is already visible, we're past the radio step — fill & submit.
  const emailVisible = await page.locator('input[type="email"]:visible, input[name*="email" i]:visible').first().isVisible({ timeout: 800 }).catch(() => false);
  if (emailVisible) {
    // The caller supplies the identity; this module never reaches into a profile store.
    const email = session.checkoutProfile?.email || session.identityEmail || null;
    if (!email) return false;
    onProgress('Filling email on Auth0 page…');
    const emailInput = page.locator('input[type="email"]:visible, input[name*="email" i]:visible').first();
    await emailInput.fill(email, { timeout: 6000 }).catch(() => {});
    session.checkoutEmailFilled = true;
    // Click the Continue/Next/Submit button
    const continueBtn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Next")').first();
    const btnVisible = await continueBtn.isVisible({ timeout: 1000 }).catch(() => false);
    if (btnVisible) {
      onProgress('Submitting email on Auth0 page…');
      await continueBtn.click({ timeout: 8000 }).catch(() => {});
      session.guestCheckoutDone = true;
      session.checkoutEmailSubmitted = true;
      session.auth0GuestDone = true;
      session.history.push(`Step ${steps}: [auth0] filled email and submitted guest checkout form`);
      return true;
    }
    return true;
  }

  // Click the guest checkout radio <input> to expand the email form.
  if (session.auth0RadioClicked) return false;
  onProgress('Selecting guest checkout on Auth0 page…');
  const clicked = await page.evaluate(() => {
    // Find the radio whose label/sibling text contains "Guest checkout"
    const radios = [...document.querySelectorAll('input[type="radio"]')];
    for (const r of radios) {
      const card = r.closest('[class*="card"], [class*="option"], [class*="item"], label, li, div') || r.parentElement;
      const text = card ? card.innerText || '' : '';
      if (/guest checkout/i.test(text)) {
        r.click();
        return true;
      }
    }
    // Fallback: click any label/div whose text matches
    const all = document.querySelectorAll('label, [role="radio"], [role="option"]');
    for (const el of all) {
      if (/guest checkout/i.test(el.innerText || '')) { el.click(); return true; }
    }
    return false;
  }).catch(() => false);

  if (!clicked) return false;
  session.auth0RadioClicked = true;
  session.history.push(`Step ${steps}: [auth0] clicked guest checkout radio`);
  // Give the SPA time to render the email form
  await page.waitForSelector('input[type="email"], input[name*="email" i]', { state: 'visible', timeout: 5000 }).catch(() => {});
  return true;
}

// Live-page wrapper: gather the signals looksLikeLoginWall needs. Best-effort — any probe
// failure degrades to "not a wall" so a flaky read never blocks a legitimate order.
async function pageHasGuestCheckoutCta(page) {
  // Regression: multi-positional-arg page.evaluate(fn, a, b, c) throws "Too many arguments"
  // on the installed Playwright version — this silently returned false (via the .catch)
  // every single call. Single object-arg form fixes it (see tryGuestCheckoutClick above).
  return page.evaluate(({ sel, patSource, patFlags }) => {
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
  }, { sel: CLICKABLE_SELECTOR, patSource: GUEST_CHECKOUT_PATTERN.source, patFlags: GUEST_CHECKOUT_PATTERN.flags }).catch(() => false);
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

// No-progress detector inputs. `sig` is an exact fingerprint — repeats mean a frozen page;
// `stateKey` is coarse page identity, and revisiting one means cycling rather than advancing.
// Dialogs count towards both, so an item modal registers even when the URL doesn't move.
async function computeProgressSignature(page) {
  const fallback = (u) => ({ sig: u, stateKey: u, itemCount: 0, hasProducts: 0 });
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
      hasProducts: info.hasProducts || 0,
    };
  } catch {
    return fallback(page && typeof page.url === 'function' ? page.url() : 'err');
  }
}

// Pure verdict over the persisted counters; the thresholds are pinned by
// test/smoke/browser-progress-detector.test.js.
//  - stepsSinceProgress: identical sig repeating → a frozen page. Nudge at 4, stuck at 7.
//  - stepsSinceNewState: no unvisited stateKey → cycling. Nudge at 5, stuck at 9.
//  - stepsSinceCartProgress: order-only backstop for browsing without ever adding. A normal
//    flow needs 7-12 empty-cart steps, so it nudges at 8, bails at 16, and switches off once
//    the basket has ever been non-empty.
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

function findElementByText(elements, text) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return null;
  return elements.find(el => el.text.trim().toLowerCase() === needle)
    || elements.find(el => el.text.trim().toLowerCase().includes(needle))
    || null;
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
  if (isPaymentUrl(afterUrl)) return true;
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
// ── Signing in with a stored credential ─────────────────────────────────────────────────
// The other way past an access wall. The grant is the authority: authorizeCredentialUse is
// consulted every time and a refusal is reported, never worked around.

// Sign-in often lives on a subdomain of the granted domain, so a grant covers an exact match
// or a "." + entry suffix — the dot forces a label boundary, keeping "evildelta.com" out.
// Scope check only; the credential lookup still keys off the granted domain that matched.
function siteInScope(currentSite, allowedSites) {
  return (allowedSites || []).some((allowed) => currentSite === allowed || currentSite.endsWith(`.${allowed}`));
}

const LOGIN_INPUT_CLASSIFIERS = [
  { field: 'password', pattern: /\bpassword\b|\bpasswd\b|\bpwd\b/i },
  { field: 'username', pattern: /\b(user(?:name)?|e-?mail(?:\s*address)?|login.?id|account.?id)\b/i },
];

function classifyLoginInput(hintText) {
  const h = String(hintText || '');
  if (!h) return null;
  for (const { field, pattern } of LOGIN_INPUT_CLASSIFIERS) {
    if (pattern.test(h)) return field;
  }
  return null;
}

function formatLoginValue(field, credential) {
  if (field === 'username') return credential.username || null;
  if (field === 'password') return credential.password || null;
  return null;
}

async function fillLoginCredential(session, credential, onProgress = () => {}) {
  const page = session.page;
  const done = new Set();
  for (const frame of page.frames()) {
    const inputs = await frameInputs().enumeratePaymentInputs(frame);
    for (const input of inputs) {
      const field = classifyLoginInput(input.hint);
      if (!field || !input.empty || done.has(field)) continue;
      const value = formatLoginValue(field, credential);
      if (!value) continue;
      const ok = await frameInputs().fillFrameTextInput(frame, input.idx, value);
      if (ok) {
        done.add(field);
        onProgress(field === 'password' ? 'Filled password' : 'Filled username');
      }
    }
  }
  return done.size;
}

async function loginCredentialFieldsPresent(page) {
  for (const frame of page.frames()) {
    const inputs = await frameInputs().enumeratePaymentInputs(frame);
    if (inputs.some((inp) => inp.empty && classifyLoginInput(inp.hint) === 'password')) return true;
  }
  return false;
}

async function findAndClickSignInButton(page) {
  const elements = await extractClickableElements(page);
  const target = elements.find((el) => /^(sign in|log in|login|continue)$/i.test(el.text.trim()));
  if (!target) return null;
  const handle = await page.evaluateHandle(
    ({ selector, idx }) => document.querySelectorAll(selector)[idx] || null,
    { selector: CLICKABLE_SELECTOR, idx: target.locatorIndex }
  ).then((h) => h.asElement());
  if (!handle) return null;
  const disabled = await handle.evaluate((el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true').catch(() => false);
  if (disabled) {
    console.warn('[browser-task] pay button disabled', JSON.stringify({
      label: target.text, blockedBy: await frameInputs().describeBlockedPayment(page)
    }));
    return null;
  }
  await handle.click({ timeout: 10000 }).catch(() => null);
  return target.text;
}

const CREDENTIAL_WATCH_BUDGET_MS = envInt('OXY_BROWSER_CREDENTIAL_WATCH_MS', 20000);

// Sign in to the currently open page with a stored credential. authorizeCredentialUse decides
// whether that is allowed, every time.
async function signInWithStoredCredential(userId, { site: requestedSite = null, onProgress = () => {} } = {}) {
  const session = getSession(userId);
  if (!session) return { type: 'error', error: 'No page is open.' };

  const pageSite = siteKeyFromUrl(session.page.url());
  const site = normalizeSite(requestedSite || session.pendingCredentialSite || pageSite);
  if (!site) return { type: 'error', error: 'I could not tell which site to sign in to.' };

  // A credential scoped to one site must never be filled into whatever page happens to be
  // showing. siteInScope (not equality) so a sign-in subdomain of the granted domain passes.
  if (!siteInScope(pageSite, [site])) {
    return { type: 'error', error: `The page open right now (${pageSite}) is not ${site}, so I did not use that sign-in.` };
  }

  try {
    // The deterministic gate. No grant, an expired one, a revoked one, or one the user never
    // created means no sign-in — never a prompt the model can talk its way past.
    const authorized = await authorizeCredentialUse(getSupabase(), userId, {
      site,
      taskId: session.credentialTaskId || null,
      requestedSites: requestedSite ? [normalizeSite(requestedSite)] : undefined,
    }).catch(() => ({ allowed: false, reason: 'lookup_failed' }));
    if (!authorized?.allowed) {
      return {
        type: 'not_authorized',
        error: `I do not have your permission to use a saved sign-in for ${site} (${authorized?.reason || 'no_grant'}). You can grant it in the Vault.`,
        site,
        reason: authorized?.reason || 'no_grant',
      };
    }

    if (!(await loginCredentialFieldsPresent(session.page))) {
      return { type: 'error', error: 'I could not find a sign-in form on this page.' };
    }
    // A real sign-in form with nothing stored for it is not a dead end: the person can type
    // one into the native sheet, which posts to /browser-task/reauth-login.
    const credential = await getVaultCredential(getSupabase(), userId, site);
    if (!credential) return { type: 'no_credential', site };

    await fillLoginCredential(session, credential, onProgress);
    await settle(session.page, 800);
    const clickedLabel = await findAndClickSignInButton(session.page);

    await recordTaskStep(getSupabase(), {
      taskId: session.credentialTaskId || 'unknown',
      userId,
      stepName: `Signed in to ${credential.site} with saved credential`,
      phase: 'credential_use',
      detail: { credentialId: credential.id, site: credential.site },
    }).catch(() => {});
    await recordUse(getSupabase(), userId, {
      site, taskId: session.credentialTaskId || null, outcome: 'used', reason: 'stored_credential',
    }).catch(() => {});

    session.pendingCredentialSite = null;
    if (!clickedLabel) {
      return { type: 'done', text: `Filled in your saved ${site} sign-in — the page showed no button to submit it, so check it looks right.` };
    }

    // Verify rather than assume: the form disappearing is the evidence it was accepted.
    const deadline = Date.now() + CREDENTIAL_WATCH_BUDGET_MS;
    while (Date.now() < deadline) {
      await settle(session.page, 1000);
      if (!(await loginCredentialFieldsPresent(session.page))) {
        return { type: 'done', text: `Signed in to ${site}.` };
      }
    }
    return { type: 'done', text: `Submitted your saved ${site} sign-in, but the form is still showing — it may not have been accepted.` };
  } catch (error) {
    await recordUse(getSupabase(), userId, {
      site, taskId: session.credentialTaskId || null, outcome: 'failed', reason: error.message,
    }).catch(() => {});
    return { type: 'error', error: error.message };
  }
}

async function fillReauthLogin(userId, { username, password, saveToVault = false, label } = {}, onProgress = () => {}) {
  const trimmedPassword = String(password || '');
  if (!username || !trimmedPassword) {
    return { type: 'error', error: 'Username and password are both required.' };
  }
  const session = getSession(userId);
  if (!session || !session.page) {
    return { type: 'error', error: 'No active browser session to sign in to.' };
  }
  try {
    if (!(await loginCredentialFieldsPresent(session.page))) {
      return { type: 'error', error: "Couldn't find a sign-in form on the current page." };
    }
    const credential = { username: String(username), password: trimmedPassword };
    await fillLoginCredential(session, credential, onProgress);
    await settle(session.page, 800);
    const clickedLabel = await findAndClickSignInButton(session.page);

    const site = siteKeyFromUrl(session.page.url());
    await recordTaskStep(getSupabase(), {
      taskId: session.reauthTaskId || 'unknown',
      userId,
      stepName: `Signed in to ${site} with a freshly typed credential`,
      phase: 'credential_use',
      detail: { site, savedToVault: !!saveToVault }
    });

    if (saveToVault) {
      await saveVaultCredential(getSupabase(), userId, {
        site,
        label: label || site,
        username: credential.username,
        password: credential.password
      }).catch(() => {});
    }

    if (!clickedLabel) {
      return { type: 'done', text: `Filled in the ${site} sign-in — the page didn't show a button to submit, so check it looks right.` };
    }

    const deadline = Date.now() + CREDENTIAL_WATCH_BUDGET_MS;
    while (Date.now() < deadline) {
      await settle(session.page, 1000);
      if (!(await loginCredentialFieldsPresent(session.page))) {
        return { type: 'done', text: `Signed in to ${site}.` };
      }
    }
    return { type: 'done', text: `Signed in to ${site} — say "keep going" to continue.` };
  } catch (error) {
    return { type: 'error', error: error.message };
  }
}

/**
 * Open a site with the user's stored session and report what the page shows, to find out
 * whether it still works. Read-only: navigates and reads, never clicks, fills or submits.
 */
async function inspectStoredSession(userId, site, path = '/', { useStoredSession = true } = {}) {
  const storageState = await loadStorageState(userId, site);
  if (useStoredSession && !storageState) return { ok: false, error: `No stored session for ${site}.` };

  // A control run opens the same page with no session at all. Comparing the two is the
  // difference between knowing the site honoured the shared session and merely hoping it
  // did: a page that looks the same both ways proves nothing.
  const { browser } = await acquireBrowser();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    ...(useStoredSession && storageState ? { storageState } : {})
  });
  const page = await context.newPage();
  try {
    const target = `https://www.${site}${path.startsWith('/') ? path : `/${path}`}`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    // These are heavy client-rendered pages: the account area arrives well after first
    // paint, and reading too early sees an empty shell and calls it inconclusive. This is a
    // diagnostic, so waiting is cheap.
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await settle(page, 2500);
    await dismissConsent(page).catch(() => {});

    const [title, text, hasPasswordField] = await Promise.all([
      page.title().catch(() => ''),
      page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => ''),
      page.locator(PASSWORD_FIELD_SELECTOR).first().isVisible().catch(() => false)
    ]);

    return {
      ok: true,
      requested: target,
      landedOn: page.url(),
      title,
      text,
      hasPasswordField,
      usedStoredSession: Boolean(useStoredSession && storageState),
      cookieCount: useStoredSession && Array.isArray(storageState?.cookies) ? storageState.cookies.length : 0
    };
  } finally {
    await context.close().catch(() => {});
  }
}



// ── General access API ──────────────────────────────────────────────────────────────────

/**
 * Is the page refusing to go further without an account? Works on any site, and reports
 * WHICH kind of wall so the caller can choose: continue without an account, sign in with a
 * stored credential, or ask the person.
 */
async function detectAccessWall(page, objective = '') {
  const [bodyText, hasPasswordField] = await Promise.all([
    readPageText(page).catch(() => ''),
    page.locator(PASSWORD_FIELD_SELECTOR).first().isVisible({ timeout: 400 }).catch(() => false),
  ]);
  const url = page.url();
  const guestAvailable = await pageHasGuestCheckoutCta(page).catch(() => false);
  const wall = looksLikeLoginWall({ url, bodyText, hasPasswordField, goal: objective });
  if (!wall && !guestAvailable) return null;
  return {
    kind: guestAvailable ? 'account_optional' : 'sign_in_required',
    url,
    guestAvailable,
    hasPasswordField,
  };
}

/**
 * Continue without creating an account. Tries the ordinary "continue as guest" control and
 * the identity-provider fork some sites use, and reports honestly if neither is offered.
 */
async function continueWithoutAccount(userId, { onProgress = () => {} } = {}) {
  const session = getSession(userId);
  if (!session) return { moved: false, error: 'No page is open.' };
  const before = session.page.url();
  const direct = await tryGuestCheckoutClick(session.page, session, 0, onProgress).catch(() => null);
  if (direct) return { moved: true, via: 'guest_control', url: session.page.url(), from: before };
  const auth0 = await tryAuth0GuestCheckout(session.page, session, 0, onProgress).catch(() => null);
  if (auth0) return { moved: true, via: 'identity_provider_fork', url: session.page.url(), from: before };
  return { moved: false, error: 'This page does not offer a way to continue without an account.' };
}

/** Tick the consent/terms checkboxes a page requires before it will let a form through. */
async function acceptRequiredCheckboxes(page) {
  return tryAcceptCheckoutCheckboxes(page);
}

/**
 * Did a step actually advance? Compares a before/after snapshot of the things that mean
 * progress — url, form fields, headings — rather than trusting that a click worked.
 */
async function stepAdvanced(page, before) {
  return pageCheckoutStepAdvanced(page, before.url, before.snapshot);
}

/** Snapshot to hand back to stepAdvanced later. */
async function snapshot(page) {
  return { url: page.url(), snapshot: await checkoutPageSnapshot(page) };
}

/**
 * Wait for the page to stop moving, up to a bound. General replacement for a pile of
 * per-site sleeps: settle, clear any consent banner that appeared, and settle again.
 */
async function waitForSettled(page, { maxMs = 4000 } = {}) {
  const started = Date.now();
  await settle(page, Math.min(600, maxMs));
  await dismissConsent(page).catch(() => {});
  const left = maxMs - (Date.now() - started);
  if (left > 0) await settle(page, Math.min(600, left));
  return { waitedMs: Date.now() - started, url: page.url() };
}

module.exports = {
  // credentials
  signInWithStoredCredential,
  fillReauthLogin,
  siteInScope,
  classifyLoginInput,
  formatLoginValue,
  fillLoginCredential,
  loginCredentialFieldsPresent,
  findAndClickSignInButton,
  LOGIN_INPUT_CLASSIFIERS,
  inspectStoredSession,
  // access
  detectAccessWall,
  continueWithoutAccount,
  acceptRequiredCheckboxes,
  looksLikeLoginWall,
  detectLoginWall,
  isCheckoutLoginWallUrl,
  isGuestCheckoutUrl,
  isGuestEmailSubmitStep,
  findGuestCheckoutElement,
  isCheckoutishUrl,
  pageHasGuestCheckoutCta,
  tryGuestCheckoutClick,
  tryAuth0GuestCheckout,
  tryManualAddressEntryClick,
  tryAcceptCheckoutCheckboxes,
  LOGIN_URL_PATTERN,
  LOGIN_COPY_PATTERN,
  LOGIN_BASKET_PATTERN,
  PASSWORD_FIELD_SELECTOR,
  GUEST_CHECKOUT_PATTERN,
  GUEST_FORK_URL_PATTERN,
  CHECKOUTISH_URL_PATTERN,
  MANUAL_ADDRESS_PATTERN,
  // verification
  snapshot,
  stepAdvanced,
  waitForSettled,
  computeProgressSignature,
  assessProgress,
  checkoutPageSnapshot,
  pageCheckoutStepAdvanced,
  // shared page helpers
  extractProductImageUrls,
  findElementByText,
};

'use strict';
// Authorising and completing a transaction on a real web page — a checkout, a ticket, a fee or
// a donation alike; nothing here knows what a basket is. The three phases are separate because
// authority lives between them:
//   prepare() — ready the page and read the amount. Never commits.
//   commit()  — press the control that charges, reached only through action-execution.js's
//               review gate, and re-reading the amount first.
//   watch()   — what actually happened: confirmed, declined, or waiting on the bank.

const { readOrderTotal } = require('./order-total');
const {
  settle, readPageText, extractClickableElements, safeFrameEvaluate, CLICKABLE_SELECTOR,
} = require('./browser-environment');
const { getSession, touchSession, getSupabase } = require('./browser-session');
const receipts = require('./receipts');

const CONFIRM_WATCH_BUDGET_MS = Number(process.env.OXY_BROWSER_CONFIRM_WATCH_MS) || 45000;
const MAX_PAY_CLICKS = 3;

// a false negative is an unconfirmed charge. \bpay\b / \bbuy\b cover "pay now",
// "pay £9.50 now", "slide to pay", "confirm and pay", "buy now", etc.
const PAYMENT_KEYWORD_PATTERN = /\bpay\b|\bbuy\b|place\s+(your\s+)?order|order\s+now|complete\s+(your\s+)?(order|purchase|payment)|confirm\s+(your\s+)?(purchase|order|payment)|submit\s+(order|payment)|checkout\s*(and|&)?\s*pay|proceed\s+to\s+payment|continue\s+to\s+payment|go\s+to\s+payment|payment\s+method|pay\s+with\s+card|pay\s+securely|slide\s+to\s+pay/i;

// Navigation towards payment, not payment itself. Clicking one of these and then watching
// for an order confirmation waits forever, and it quotes the total before delivery is added.
const PAYMENT_ADVANCE_PATTERN = /(continue|proceed|go)\s+to\s+(payment|checkout)|payment\s+method|choose\s+payment/i;

function isPaymentAdvance(text) {
  return PAYMENT_ADVANCE_PATTERN.test(String(text || ''));
}

// Controls that actually charge, as opposed to navigating one step closer.
const PAYMENT_COMMIT_PATTERN = /\bpay\s*(now|£|\$|€)|\bpay$|place\s+(your\s+)?order|order\s+now|complete\s+(your\s+)?(order|purchase|payment)|confirm\s+(your\s+)?(purchase|order|payment)|confirm\s+and\s+pay|submit\s+(order|payment)|\bbuy\s*(now)?$|pay\s+securely|slide\s+to\s+pay/i;

// A saved card or the card option. Checkouts often show no pay button until one is chosen.
const CARD_OPTION_PATTERN = /(credit\s*\/?\s*(or\s+)?debit\s+card|debit\s*\/?\s*credit\s+card|\bcard\s+ending\b|ending\s+in\s+\d{3,4}|use\s+(this|saved)\s+card|new\s+card)/i;

function isCardPaymentOption(text) {
  const label = String(text || '').trim();
  if (isWalletPayment(label)) return false;
  return CARD_OPTION_PATTERN.test(label);
}

function isPaymentCommit(text) {
  const label = String(text || '').trim();
  if (isWalletPayment(label) || isPaymentAdvance(label)) return false;
  return PAYMENT_COMMIT_PATTERN.test(label);
}

// Wallets need device biometrics or a redirect a headless browser cannot complete, and they

const WALLET_PAYMENT_PATTERN = /\b(apple\s*pay|g\s*pay|google\s*pay|paypal|amazon\s*pay|shop\s*pay|klarna|clearpay|afterpay|venmo)\b/i;

function isWalletPayment(text) {
  return WALLET_PAYMENT_PATTERN.test(String(text || ''));
}

function matchesPaymentKeyword(text) {
  const label = String(text || '').trim();
  if (isWalletPayment(label)) return false;
  // Chiltern's ticket-results shell exposes "Quick buy" before it has found a fare or
  // added a ticket. It is a shopping shortcut, not a payment commitment; treating it as
  // a pay control produced a false ready-for-payment handoff on an empty £0.00 basket.
  if (/^quick\s+buy$/i.test(label)) return false;
  return PAYMENT_KEYWORD_PATTERN.test(label);
}

const TRANSIENT_CHECKOUT_PATTERN = /\b(?:loading,?\s*please wait|please wait while we search for tickets)\b/i;

async function isPaymentHandoffBlockedByLoading(page) {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return TRANSIENT_CHECKOUT_PATTERN.test(text);
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

// Order matters: cvc first ("card verification number" would otherwise hit 'number'),
// split expiry before combined, name before number ("name on card" contains "card").
const PAYMENT_INPUT_CLASSIFIERS = [
  { field: 'cvc', pattern: /\b(cvc|cvv|csc|cid)\b|security.?code|card.?verification|verification.?(?:code|value|number)/i },
  { field: 'exp_month', pattern: /exp(?:iry|iration)?[-_\s]?month|\bcc-exp-month\b|month.{0,12}expir/i },
  { field: 'exp_year', pattern: /exp(?:iry|iration)?[-_\s]?year|\bcc-exp-year\b|year.{0,12}expir/i },
  { field: 'expiry', pattern: /\bcc-exp\b|expir|exp.?date|valid.?(?:thru|to|until)|\bmm\s*\/?\s*yy/i },
  { field: 'name', pattern: /name.?on.?card|card.?holder|\bcc-name\b|holder.?name/i },
  { field: 'number', pattern: /card.?number|\bcc-number\b|\bpan\b|(?:credit|debit).?card.?no|\bcardnumber\b|long.?(?:card.?)?number/i },
  { field: 'postcode', pattern: /post.?code|postal.?code|\bzip\b/i },
];

function classifyPaymentInput(hintText) {
  const h = String(hintText || '');
  if (!h) return null;
  for (const { field, pattern } of PAYMENT_INPUT_CLASSIFIERS) {
    if (pattern.test(h)) return field;
  }
  return null;
}

function formatCardValue(field, card, profile) {
  switch (field) {
    case 'number': return card.number;
    case 'name': return card.name;
    case 'cvc': return card.cvc;
    case 'expiry': return `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`;
    case 'exp_month': return String(card.expMonth).padStart(2, '0');
    case 'exp_year': return String(card.expYear);
    // Billing postcode (AVS) sits inside most card forms — reuse the consented delivery
    // address, never guess. Returning null just leaves the field for the merchant to flag.
    case 'postcode': return profile?.consent ? (profile?.address?.postcode || null) : null;
    default: return null;
  }
}

// Fillable inputs in one frame, with enough surrounding text to classify them. Per-frame
// because PSP card fields each live in their own cross-origin iframe; the generic hint sources
// below cover all of them without PSP-specific branches.
async function enumeratePaymentInputs(frame) {
  return safeFrameEvaluate(frame, () => {
    const out = [];
    document.querySelectorAll('input, select').forEach((el, idx) => {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      let labelText = '';
      if (el.labels && el.labels.length) {
        labelText = Array.from(el.labels).map((l) => l.innerText || '').join(' ');
      } else if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) labelText = lab.innerText || '';
      }
      const hint = [
        el.name, el.id, el.placeholder,
        el.getAttribute('aria-label'), el.getAttribute('autocomplete'),
        el.getAttribute('data-elements-stable-field-name'), labelText
      ].filter(Boolean).join(' ');
      out.push({
        idx,
        tag: el.tagName.toLowerCase(),
        hint,
        empty: !(el.value || '').trim() || el.tagName === 'SELECT' && el.selectedIndex <= 0
      });
    });
    return out;
  }, undefined, []);
}

async function fillFrameTextInput(frame, idx, value) {
  const handle = await frame.evaluateHandle(
    (i) => document.querySelectorAll('input, select')[i] || null, idx
  ).then((h) => h.asElement()).catch(() => null);
  if (!handle) return false;
  try {
    await handle.click({ timeout: 3000 });
    // Type, don't set: card inputs are almost always masked/formatted by page JS
    // (spaces every 4 digits, MM/YY slash insertion) that only fires on key events.
    await handle.type(String(value), { delay: 25 });
    return true;
  } catch {
    return false;
  } finally {
    await handle.dispose().catch(() => {});
  }
}

async function fillFrameSelect(frame, idx, candidates) {
  return safeFrameEvaluate(frame, ({ i, wants }) => {
    const el = document.querySelectorAll('input, select')[i];
    if (!el || el.tagName !== 'SELECT') return false;
    for (const want of wants) {
      for (const opt of el.options) {
        const text = (opt.text || '').trim();
        if (opt.value === want || text === want || text.startsWith(`${want} `)) {
          el.value = opt.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }, { i: idx, wants: candidates }, false);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function selectCandidatesFor(field, card) {
  if (field === 'exp_month') {
    const m = card.expMonth;
    return [String(m).padStart(2, '0'), String(m), MONTH_NAMES[m - 1]];
  }
  if (field === 'exp_year') {
    return [String(card.expYear), String(card.expYear).slice(-2)];
  }
  return null;
}

async function paymentCardFieldsPresent(page) {
  for (const frame of page.frames()) {
    const inputs = await enumeratePaymentInputs(frame);
    // A saved card re-verification shows only a CVV box, no number field — that still
    // needs filling, and requiring a number field meant it never was.
    if (inputs.some((inp) => inp.empty && ['number', 'cvc'].includes(classifyPaymentInput(inp.hint)))) return true;
  }
  return false;
}

async function fillPaymentCard(session, card, onProgress = () => {}) {
  const page = session.page;
  const profile = session.checkoutProfile;
  const done = new Set();
  for (const frame of page.frames()) {
    const inputs = await enumeratePaymentInputs(frame);
    for (const input of inputs) {
      const field = classifyPaymentInput(input.hint);
      if (!field || !input.empty || done.has(field)) continue;
      // A combined MM/YY field and split month/year selects are alternatives —
      // whichever appears first on the page wins, the other never matches anyway.
      if (field === 'expiry' && (done.has('exp_month') || done.has('exp_year'))) continue;
      if ((field === 'exp_month' || field === 'exp_year') && done.has('expiry')) continue;
      const value = formatCardValue(field, card, profile);
      if (!value) continue;
      let ok = false;
      if (input.tag === 'select') {
        const candidates = selectCandidatesFor(field, card);
        if (candidates) ok = await fillFrameSelect(frame, input.idx, candidates);
      } else {
        ok = await fillFrameTextInput(frame, input.idx, value);
      }
      if (ok) {
        done.add(field);
        onProgress(`Filled ${field === 'number' ? 'card number' : field.replace('_', ' ')}`);
      }
    }
  }
  return done.size;
}

// Post-click classification, in this order: a confirmation page mentions "payment" freely so
// confirmed wins, and decline banners sit on the same page as a dismissed challenge so declined
// beats 3DS. Past-tense phrasings only — a checkout says "we'll send you a confirmation email"
// before payment, and a false confirmed closes the session without paying.
const ORDER_CONFIRMED_PATTERN = /order\s+(?:number|reference)\s*[:#]|thank you for your (?:order|purchase|booking)|booking (?:confirmed|reference:|complete)|payment (?:successful|was successful|complete)|your (?:order|booking) (?:is|has been) (?:confirmed|placed|received)|we(?:'|’)?ve (?:got|received) your order|order (?:is )?confirmed/i;
const PAYMENT_DECLINED_PATTERN = /\bdeclined\b|payment (?:failed|unsuccessful|was not successful|error)|invalid (?:card|security code|cv[cv])|check your card|could ?n(?:o|’|')t (?:be )?process|there was a problem (?:processing|with) your payment|card details (?:are|were) (?:incorrect|invalid)/i;
const THREEDS_CHALLENGE_PATTERN = /3-?d\s*secure|verify (?:your |a )?(?:payment|identity|purchase)|authentication (?:required|needed|in progress)|approve (?:this|the) (?:payment|purchase)|one[- ]?time (?:pass)?code|confirm (?:it(?:'|’)?s|this is) you|check your (?:phone|banking app)|open your banking app|waiting for (?:you|approval)|tap to verify/i;

async function classifyPaymentOutcome(page) {
  const texts = [];
  for (const frame of page.frames()) {
    const body = await safeFrameEvaluate(frame, () => (document.body ? document.body.innerText : '') || '', undefined, '');
    if (body) texts.push(body.slice(0, 20000));
  }
  const combined = `${page.url()}\n${texts.join('\n')}`;
  if (/order-?confirm(?:ed|ation)|booking-?confirm|thank-?you/i.test(page.url()) || ORDER_CONFIRMED_PATTERN.test(combined)) return 'confirmed';
  // Challenge before declined: a pending 3DS page routinely carries decline-ish wording,
  // and calling it a decline abandons a payment the user is about to approve on their phone.
  if (THREEDS_CHALLENGE_PATTERN.test(combined)) return 'challenge';
  const declined = PAYMENT_DECLINED_PATTERN.exec(combined);
  if (declined) {
    console.warn('[browser-task] payment declined', JSON.stringify({
      matched: declined[0].slice(0, 80), url: page.url(),
      context: combined.slice(Math.max(0, declined.index - 120), declined.index + 160).replace(/\s+/g, ' ')
    }));
    return 'declined';
  }
  return 'unknown';
}

// Tick a payment-method radio directly. Clicking the visible label left the radio
// unticked, so the pay button stayed "(unavailable)".
async function selectPaymentOptionRadio(page, last4) {
  for (const frame of page.frames()) {
    const picked = await safeFrameEvaluate(frame, (wanted) => {
      const radios = [...document.querySelectorAll('input[type="radio"]')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.height; });
      if (!radios.length) return null;
      const textFor = (el) => {
        const box = el.closest('label, li, [class*="option"], [class*="method"], div') || el.parentElement;
        return ((box && box.innerText) || '').replace(/\s+/g, ' ').trim();
      };
      const wallet = /apple pay|google pay|paypal|klarna|clearpay/i;
      const usable = radios.filter((el) => !wallet.test(textFor(el)));
      const byLast4 = wanted ? usable.find((el) => textFor(el).includes(wanted)) : null;
      const byCard = usable.find((el) => /credit|debit|card/i.test(textFor(el)));
      const target = byLast4 || byCard || usable[0];
      if (!target) return null;
      target.click();
      return textFor(target).slice(0, 60);
    }, last4 || '', null);
    if (picked) return picked;
  }
  return null;
}

// What is still blocking a disabled pay button: empty required inputs and unticked boxes.
async function describeBlockedPayment(page) {
  const notes = [];
  for (const frame of page.frames()) {
    const found = await safeFrameEvaluate(frame, () => {
      const out = { empty: [], unchecked: [] };
      for (const el of document.querySelectorAll('input, select, textarea')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const label = (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || el.id || '').slice(0, 40);
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (!el.checked) out.unchecked.push(label || el.type);
        } else if (!el.value) {
          out.empty.push(label || el.type);
        }
      }
      return out;
    }, undefined, null);
    if (found?.empty?.length) notes.push(`empty: ${found.empty.slice(0, 8).join(', ')}`);
    if (found?.unchecked?.length) notes.push(`unticked: ${found.unchecked.slice(0, 8).join(', ')}`);
  }
  return notes.join(' | ') || 'nothing obviously incomplete';
}



async function findAndClickPayButton(page, wantedLabel) {
  const elements = await extractClickableElements(page);
  // Exact match on the confirmed label first — never substring-fallback where a stored
  // "Pay" could match "Apple Pay"/"PayPal". If the page moved on (multi-step payment),
  // accept a fresh payment-keyword button as the new final control.
  const wanted = String(wantedLabel || '').trim().toLowerCase();
  const target = elements.find((el) => el.text.trim().toLowerCase() === wanted)
    || elements.find((el) => matchesPaymentKeyword(el.text));
  if (!target) return null;
  // Same-index-space resolve as the main loop: locator().nth() counts shadow-DOM nodes
  // that querySelectorAll (extraction) doesn't, and a mis-indexed click HERE is a wrong
  // click on a payment page — the one place that must never happen.
  const handle = await page.evaluateHandle(
    ({ selector, idx }) => document.querySelectorAll(selector)[idx] || null,
    { selector: CLICKABLE_SELECTOR, idx: target.locatorIndex }
  ).then((h) => h.asElement());
  if (!handle) return null;
  const disabled = await handle.evaluate((el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true').catch(() => false);
  if (disabled) {
    console.warn('[browser-task] pay button disabled', JSON.stringify({
      label: target.text, blockedBy: await describeBlockedPayment(page)
    }));
    return null;
  }
  await handle.click({ timeout: 10000 }).catch(() => null);
  return target.text;
}

// ── The transaction API ─────────────────────────────────────────────────────────────────

/**
 * Read the amount the page is currently asking for, using a parser rather than a model.
 * Returns nulls rather than a nearby number — a wrong figure shown as "approve this" is
 * worse than admitting it could not be read.
 */
async function readAmount(page) {
  const text = await readPageText(page).catch(() => '');
  const raw = readOrderTotal(text);
  if (!raw) return { raw: null, amount: null, currency: null };
  const amount = Number(String(raw).replace(/[^\d.]/g, ''));
  const symbol = String(raw).trim()[0];
  const currency = symbol === '£' ? 'GBP' : symbol === '$' ? 'USD' : symbol === '€' ? 'EUR' : null;
  return { raw, amount: Number.isFinite(amount) && amount > 0 ? amount : null, currency };
}

/**
 * PHASE 1. Get the page ready to be authorised, and report what it will cost. Fills stored
 * card details if the form is showing, picks the saved card option if there is one, and
 * finds the control that would commit. NEVER presses it.
 */
async function prepare(userId, { card = null, profile = null } = {}) {
  const session = getSession(userId);
  if (!session) return { ok: false, error: 'No page is open.' };
  touchSession(userId);
  const page = session.page;

  if (card?.last4) await selectPaymentOptionRadio(page, card.last4).catch(() => {});

  let filledCard = 0;
  if (card && await paymentCardFieldsPresent(page)) {
    filledCard = await fillPaymentCard({ ...session, checkoutProfile: profile }, card).catch(() => 0);
    await settle(page, 800);
  }

  const elements = await extractClickableElements(page).catch(() => []);
  const commit = elements.find((el) => isPaymentCommit(el.text));
  const advance = elements.find((el) => isPaymentAdvance(el.text));
  const wallet = elements.find((el) => isWalletPayment(el.text));
  const money = await readAmount(page);

  // Remember the control and figure so commit() re-finds the same one rather than whatever
  // happens to look clickable later.
  session.pendingPaymentLabel = commit?.text || null;
  session.pendingPaymentTotal = money.raw || session.pendingPaymentTotal || null;

  return {
    ok: true,
    ready: Boolean(commit),
    commitLabel: commit?.text || null,
    advanceLabel: !commit && advance ? advance.text : null,
    walletOnly: !commit && !advance && Boolean(wallet),
    filledCard,
    ...money,
    url: page.url(),
  };
}

/**
 * PHASE 2. Commit. Reached only through the deterministic review gate.
 * `authorize` is supplied by the caller and is the last word — this module never decides
 * whether an amount is allowed, it only reports what the page says.
 */
async function commit(userId, { authorize = null, card = null, onProgress = () => {} } = {}) {
  const session = getSession(userId);
  if (!session || !session.pendingPaymentLabel) {
    return { state: 'error', error: 'Nothing is waiting to be authorised — it may have expired.' };
  }
  const page = session.page;

  // Already done? A re-confirm after a bank approval, or a lost response, must not charge twice.
  if (await classifyPaymentOutcome(page) === 'confirmed') {
    return { state: 'confirmed', label: session.pendingPaymentLabel, amount: await readAmount(page) };
  }

  // Re-read the amount at the moment of commit. The page can change between approval and
  // commit (delivery added, promo expired, basket edited elsewhere).
  const money = await readAmount(page);
  if (typeof authorize === 'function') {
    const verdict = await authorize(money);
    if (verdict && verdict.ok === false) {
      touchSession(userId);
      return { state: 'refused', error: verdict.error || 'That amount is outside the approved limit — nothing was charged.' };
    }
  }
  session.committedTotal = money.raw || session.pendingPaymentTotal || null;

  const clicked = await findAndClickPayButton(page, session.pendingPaymentLabel);
  if (!clicked) {
    return { state: 'error', error: `Couldn't find the "${session.pendingPaymentLabel}" control anymore — the page may have changed.` };
  }
  return watch(userId, { card, clickedLabel: clicked, onProgress });
}

/**
 * PHASE 3. Watch the aftermath instead of declaring victory on the click. Many checkouts put
 * the card form BEHIND the commit button, and a bank challenge or a decline can follow it.
 */
async function watch(userId, { card = null, clickedLabel = null, onProgress = () => {} } = {}) {
  const session = getSession(userId);
  if (!session) return { state: 'error', error: 'The page closed before the outcome was known.' };
  const page = session.page;
  const deadline = Date.now() + CONFIRM_WATCH_BUDGET_MS;
  let clicks = 1;
  let sawChallenge = false;

  while (Date.now() < deadline) {
    await settle(page, 1500);
    const state = await classifyPaymentOutcome(page);

    if (state === 'confirmed') {
      return { state: 'confirmed', label: clickedLabel || session.pendingPaymentLabel, amount: await readAmount(page) };
    }
    if (state === 'declined') {
      touchSession(userId);
      return { state: 'declined', error: 'The payment was declined by the card issuer or the site — nothing further was attempted. The page is still open if you want to try a different card.' };
    }
    if (state === 'challenge') {
      sawChallenge = true; // the bank is asking the human; keep polling within budget
      continue;
    }

    // An empty card form appearing after the click means the form was behind the button.
    if (card && clicks < MAX_PAY_CLICKS && await paymentCardFieldsPresent(page)) {
      const filled = await fillPaymentCard(session, card, onProgress).catch(() => 0);
      if (filled > 0) {
        await settle(page, 800);
        const next = await findAndClickPayButton(page, session.pendingPaymentLabel);
        if (next) clicks += 1;
        continue;
      }
    }

    // The control may only have advanced a step ("Continue to payment").
    if (clicks < MAX_PAY_CLICKS) {
      const controls = await extractClickableElements(page).catch(() => []);
      const next = controls.find((el) => isPaymentCommit(el.text));
      if (next) {
        onProgress(`Confirming — ${next.text}`);
        const done = await findAndClickPayButton(page, next.text);
        if (done) { clicks += 1; session.pendingPaymentLabel = next.text; continue; }
      }
    }
  }

  touchSession(userId);
  if (sawChallenge) {
    return {
      state: 'awaiting_authorization',
      text: 'Your bank is asking you to approve this in your banking app. Nothing is charged until you do. Say "check now" once you have approved it and I will pick it up from here.',
    };
  }
  return { state: 'unknown', error: await describeBlockedPayment(page).catch(() => 'I could not tell whether that went through, so I have not tried again.') };
}

/** The amount actually charged, read before the page is closed. */
function chargedAmount(session) {
  const raw = session?.committedTotal || session?.pendingPaymentTotal;
  if (!raw) return null;
  const amount = Number(String(raw).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const symbol = String(raw).trim()[0];
  const currency = symbol === '£' ? 'GBP' : symbol === '$' ? 'USD' : symbol === '€' ? 'EUR' : null;
  return { total: amount, currency };
}

// Record a completed transaction the moment the confirmation page is seen, rather than waiting
// on a receipt email that may never arrive. Best effort: recording never turns a successful
// payment into a failure. Everything stored is observed — the total the user reviewed, the order
// id read off the page, the site the session was on — and an unreadable total is written as
// null, since a real order with an unknown total is the truth and a guess would not be.
async function recordConfirmedPurchase(userId, session, confirmationText = '') {
  try {
    const merchantHost = String(session?.site || '').replace(/^www\./, '');
    if (!merchantHost) return null;
    const haystack = `${confirmationText}`.slice(0, 20000);
    const reviewed = receipts.parseAmount(session?.pendingPaymentTotal || '');
    const pageTotalMatch = haystack.match(/(?:order\s+total|grand\s+total|total\s+(?:paid|charged|cost)|total|amount\s+(?:paid|charged)|you\s+paid)\s*[:\-–]?\s*([£$€¥]\s?\d[\d,]*(?:\.\d{2})?)/i);
    const total = reviewed || (pageTotalMatch ? receipts.parseAmount(pageTotalMatch[1]) : null);
    const orderId = receipts.extractOrderId(haystack);
    const label = merchantHost.split('.')[0];

    const { id } = await receipts.upsertPurchase(getSupabase(), userId, {
      source: 'millie_browser',
      merchant: label.charAt(0).toUpperCase() + label.slice(1),
      merchant_domain: merchantHost,
      purchased_at: new Date().toISOString(),
      total_amount: total ? total.amount : null,
      currency: total ? total.currency : null,
      order_id: orderId,
      description: String(session?.goal || '').slice(0, 400) || null,
      status: 'confirmed',
      source_ref: String(session?.page?.url?.() || '').slice(0, 500) || null,
      raw_total_text: total ? total.raw : null,
      extraction_confidence: total && orderId ? 'high' : 'medium',
      updated_at: new Date().toISOString()
    });
    return id || null;
  } catch {
    // Recording is bookkeeping — it must never turn a successful order into a failure.
    return null;
  }
}

module.exports = {
  recordConfirmedPurchase,
  // phases
  prepare,
  commit,
  watch,
  readAmount,
  chargedAmount,
  // outcome classification — general "did it actually work", not payment-only
  classifyPaymentOutcome,
  describeBlockedPayment,
  ORDER_CONFIRMED_PATTERN,
  PAYMENT_DECLINED_PATTERN,
  THREEDS_CHALLENGE_PATTERN,
  // control vocabulary
  matchesPaymentKeyword,
  isPaymentCommit,
  isPaymentAdvance,
  isCardPaymentOption,
  isWalletPayment,
  isPaymentHandoffBlockedByLoading,
  isCheckoutPaymentUrl,
  findAndClickPayButton,
  selectPaymentOptionRadio,
  // card entry
  classifyPaymentInput,
  formatCardValue,
  paymentCardFieldsPresent,
  fillPaymentCard,
  enumeratePaymentInputs,
  fillFrameTextInput,
  fillFrameSelect,
  selectCandidatesFor,
  PAYMENT_INPUT_CLASSIFIERS,
  CONFIRM_WATCH_BUDGET_MS,
  MAX_PAY_CLICKS,
};

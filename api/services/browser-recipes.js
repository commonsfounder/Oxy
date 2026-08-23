'use strict';
// Tier-2 deterministic recipes. See docs/superpowers/specs/2026-07-01-browser-task-tier2-recipes-design.md
// Pure helpers first (unit-tested); the DOM-touching executor lives lower down.

const { isDeliveryHost } = require('./retailer-sites');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Pull a size the user has already specified out of the goal/history text. Conservative:
// only recognised shapes, word-boundary anchored so "small" doesn't match "smallish".
// Returns a normalized token, or null when the user didn't say a size (→ the loop asks).
function parseSizeFromGoal(text, goalContext) {
  if (goalContext && typeof goalContext === 'object' && goalContext.size) return norm(goalContext.size);
  // also support when caller passes full context object from session
  const t = norm(text);
  if (!t) return null;
  // "size 10", "size m", "size uk 9"
  let m = t.match(/\bsize\s+((?:uk|eu)\s+)?([a-z0-9]{1,4})\b/);
  if (m) return norm(`${m[1] || ''}${m[2]}`);
  // "uk 9" / "eu 42" shoe sizes without the word "size"
  m = t.match(/\b(uk|eu)\s+(\d{1,2})\b/);
  if (m) return `${m[1]} ${m[2]}`;
  // "32 waist" jeans sizing (ASOS etc)
  m = t.match(/\b(\d{2})\s*waist\b/);
  if (m) return m[1];
  // spelled-out garment words
  m = t.match(/\b(extra small|extra large|small|medium|large)\b/);
  if (m) return m[1];
  // standalone letter sizes: xs s m l xl xxl (must be a lone token, not inside a word)
  m = t.match(/\b(xxl|xl|xs|s|m|l)\b/);
  if (m) return m[1];
  return null;
}

// Garment words ↔ letter chips: goals say "size medium" but most PDPs label the chip "M"
// (M&S, John Lewis) — and some label it "Medium". Try both spellings of the ask.
const SIZE_WORD_TO_LETTER = { 'extra small': 'xs', 'small': 's', 'medium': 'm', 'large': 'l', 'extra large': 'xl' };
const SIZE_LETTER_TO_WORD = Object.fromEntries(Object.entries(SIZE_WORD_TO_LETTER).map(([w, l]) => [l, w]));

// John Lewis size chips navigate via ?size= — pre-set on open so add can fire immediately.
function johnLewisSizeQueryValue(goal, goalContext) {
  const raw = parseSizeFromGoal(goal, goalContext);
  if (!raw) return null;
  if (SIZE_WORD_TO_LETTER[raw]) return SIZE_WORD_TO_LETTER[raw];
  return raw.replace(/\s+/g, '');
}

// Given the size the user asked for and the labels of the size chips on the page, return
// the index of the chip to click, or null. Exact (normalized) match wins; a contains match
// (e.g. "10" inside "Size 10") is the fallback.
function matchSizeChip(parsedSize, chipLabels) {
  const want = norm(parsedSize);
  if (!want) return null;
  const wants = [want];
  if (SIZE_WORD_TO_LETTER[want]) wants.push(SIZE_WORD_TO_LETTER[want]);
  if (SIZE_LETTER_TO_WORD[want]) wants.push(SIZE_LETTER_TO_WORD[want]);
  const labels = (chipLabels || []).map(norm);
  for (const w of wants) {
    const exact = labels.indexOf(w);
    if (exact !== -1) return exact;
  }
  for (const w of wants) {
    const contains = labels.findIndex((l) => l.split(/\s+/).includes(w) || l === `size ${w}`);
    if (contains !== -1) return contains;
  }
  // Waist jeans: goal "32" → chips "W32", "32", "32W"
  if (/^\d{2}$/.test(want)) {
    const waistAlts = [`w${want}`, `${want}w`, `waist ${want}`, `size ${want}`];
    for (const alt of waistAlts) {
      const idx = labels.findIndex((l) => norm(l) === alt || norm(l).includes(alt));
      if (idx !== -1) return idx;
    }
  }
  return null;
}

// Dismiss pattern: upsell/cross-sell drawers that appear after "Add to basket" on
// Currys (Care & Repair), Selfridges (accessories), etc. Matched against overlay text
// AND against aria-label="Close" / × symbols.
const UPSELL_DISMISS_PATTERN = /no,?\s*thanks|skip\b|maybe later|dismiss|close|continue without|go to basket|continue to basket|continue to checkout|no thanks|not (now|interested)|remind me later/i;

// Click the first dismiss-type affordance inside any large visible overlay.
// Fires up to 3 times per session (tracked via session.upsellDismissCount), then gives up.
async function resolveUpsellDismiss({ page, session, clickable }) {
  const count = session?.upsellDismissCount || 0;
  if (count >= 3) return null;
  const hit = await page.evaluate(({ sel, patSrc, patFlags }) => {
    const pat = new RegExp(patSrc, patFlags);
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const vw = window.innerWidth * window.innerHeight;
    const overlays = [
      ...document.querySelectorAll('dialog,[role="dialog"],[class*="modal" i],[class*="drawer" i]')
    ].filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width * r.height > vw * 0.04;
    });
    if (!overlays.length) return null;
    const all = [...document.querySelectorAll(sel)];
    for (const overlay of overlays) {
      const inside = [...overlay.querySelectorAll(sel)].filter(visible);
      // 1. Button/link with dismiss text
      for (const el of inside) {
        const t = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim();
        if (!pat.test(t)) continue;
        const idx = all.indexOf(el.closest(sel) || el);
        if (idx >= 0) return { idx, text: t.replace(/\s+/g, ' ').slice(0, 80) };
      }
      // 2. Explicit close button (aria-label="Close" or ×/✕ symbol)
      for (const el of inside) {
        const label = (el.getAttribute('aria-label') || '').trim();
        const t = (el.innerText || '').trim();
        if (/^close$/i.test(label) || /^[×✕✗]$/.test(t)) {
          const idx = all.indexOf(el.closest(sel) || el);
          if (idx >= 0) return { idx, text: label || t || 'Close' };
        }
      }
    }
    return null;
  }, { sel: clickable, patSrc: UPSELL_DISMISS_PATTERN.source, patFlags: UPSELL_DISMISS_PATTERN.flags }).catch(() => null);
  if (!hit) return null;
  if (session) session.upsellDismissCount = count + 1;
  return { action: 'click', locatorIndex: hit.idx, text: hit.text, stepName: 'upsell-dismiss' };
}

// Fill a visible email input with the stored checkout profile email.
// Returns a fill move so the standard executor handles the actual DOM interaction.
async function resolveEmailFill({ page, session, clickable }) {
  const email = session?.checkoutProfile?.email;
  if (!email || session?.checkoutEmailFilled) return null;
  const idx = await page.evaluate(({ sel }) => {
    const NON_EMAIL = /^(radio|checkbox|password|hidden|submit|button|reset)$/i;
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const all = [...document.querySelectorAll(sel)];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.tagName !== 'INPUT') continue;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (NON_EMAIL.test(type)) continue;
      if (type !== 'email') {
        const hint = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
        if (!/e-?mail/.test(hint)) continue;
      }
      if (!visible(el)) continue;
      return i;
    }
    return -1;
  }, { sel: clickable }).catch(() => -1);
  if (idx < 0) return null;
  return { action: 'fill', locatorIndex: idx, value: email, stepName: 'fill-email', text: 'Email address' };
}

// Guest-checkout selector list, byte-identical across CONVENTION (cart+checkout) and John
// Lewis (checkout) today. Other retailers use their own wording/order/count (e.g. M&S omits
// "Continue without an account", Currys/Selfridges/Wickes lead with "Continue as guest") —
// those are left as separate literals since they are NOT the same list and consolidating them
// would silently change which button text each site matches.
const STANDARD_GUEST_SELECTORS = [
  'text=Guest checkout',
  'text=Checkout as a guest',
  'text=Continue as a guest',
  'text=Continue without an account',
];

// "Advance past the guest-email step" selector list — byte-identical across all 5 retailers
// that have this step (CONVENTION, John Lewis, M&S, Currys, Selfridges), same `when` guard too.
const CHECKOUT_ADVANCE_SELECTORS = [
  'text=Continue to delivery',
  'text=Continue to payment',
  'text=Save and continue',
  'text=Continue to billing',
];

// Cart/checkout-only fallback kept for tests and backward compat.
const GENERIC = {
  phases: {
    checkout: (u) => /\/(?:checkout|order|pay(?:ment)?|purchase)\b/i.test(u.pathname),
    cart:     (u) => /\/(?:cart|basket|bag|trolley)\b/i.test(u.pathname),
  },
  size: { container: [], chip: [], selected: [] },
  steps: [
    { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
      'text=Proceed to Checkout',
      'text=Go to checkout',
      'text=Checkout securely',
      'text=Continue to checkout',
      'text=Secure checkout',
      'text=Checkout',
      'text=Place Order',
    ]},
  ],
};

// Convention-keyed recipe for unknown retail hosts. Uses common aria/data-testid/button-text
// patterns for size→add→basket→checkout→guest→fill-email→advance. Vision still picks the
// product; recipe drives the deterministic tail. Upsell-dismiss fires universally via
// nextRecipeMove's pre-phase check rather than as a step here.
const CONVENTION = {
  phases: {
    product:  (u) => /\/(?:p\/|product\/|products\/|item\/|sku\/|pd\/|dp\/|p\d+(?:\/|$))/i.test(u.pathname),
    // `checkouts?` (optional plural) so Shopify's real checkout path — /checkouts/cn/<token>,
    // where /checkout 302-redirects — classifies as 'checkout'. Without the plural, `checkout\b`
    // fails on "checkouts" (no word boundary between "t" and "s"), so the ENTIRE Shopify
    // checkout tail fell through to the vision loop — the dominant reason recipes never hit on
    // the platform-API tier's primary target. Regression: browser-recipes.test.js.
    checkout: (u) => /\/(?:checkouts?|order|pay(?:ment)?|purchase)\b/i.test(u.pathname),
    cart:     (u) => /\/(?:cart|basket|bag|trolley)\b/i.test(u.pathname),
  },
  size: {
    container: [
      '[data-testid*="size" i]',
      'fieldset[class*="size" i]',
      '[class*="size-selector" i]',
      'label[aria-label^="Size " i]',
    ],
    chip: [
      '[data-testid*="size" i] button',
      '[data-testid*="size" i] a',
      'label[aria-label^="Size " i]',
      'button[aria-label^="Size " i]',
      '[role="radio"][aria-label*="size" i]',
    ],
    selected: [
      '[aria-checked="true"]',
      '[aria-selected="true"]',
      '[data-selected="true"]',
      '[class*="selected" i][class*="size" i]',
    ],
    basketBadge: [
      '[data-testid*="basket" i]',
      '[data-testid*="cart" i]',
      '[data-testid*="bag" i]',
      'a[aria-label*="Shopping bag" i]',
      'a[aria-label*="basket" i]',
      'a[aria-label*="cart" i]',
    ],
  },
  steps: [
    { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
    { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
      '[data-testid*="add-to-basket" i]',
      '[data-testid*="add-to-bag" i]',
      '[data-testid*="add-to-cart" i]',
      'text=Add to basket',
      'text=Add to bag',
      'text=Add to cart',
      'text=Add for Delivery',
      'text=Add for Collection',
    ] },
    { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, action: 'click', selectorAny: [
      '[data-testid*="basket" i]',
      'text=View basket',
      'text=View bag',
      'text=Go to basket',
      'text=Go to bag',
      'text=Basket',
      'text=Bag',
      'text=Cart',
    ] },
    { phase: 'cart', name: 'guest', when: (ctx) => !ctx.isGuestEmailSubmit && !ctx.checkoutPastEmail, action: 'click', selectorAny: STANDARD_GUEST_SELECTORS },
    { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
      'text=Proceed to Checkout',
      'text=Go to checkout',
      'text=Checkout securely',
      'text=Continue to checkout',
      'text=Secure checkout',
      'text=Checkout',
    ] },
    { phase: 'checkout', name: 'guest', when: (ctx) => !ctx.isGuestEmailSubmit && !ctx.checkoutPastEmail, action: 'click', selectorAny: STANDARD_GUEST_SELECTORS },
    { phase: 'checkout', name: 'fill-email', when: (ctx) => ctx.checkoutEmailVisible && !ctx.isGuestEmailSubmit && !ctx.checkoutPastEmail, resolve: (a) => resolveEmailFill(a) },
    { phase: 'checkout', name: 'advance', when: (ctx) => ctx.checkoutPastEmail && !ctx.isGuestEmailSubmit, action: 'click', selectorAny: CHECKOUT_ADVANCE_SELECTORS },
  ],
};

// A visible "pay/place order" affordance means we've reached the payment step and must NOT
// drive the checkout any further — the loop's tryPaymentReady stops there for explicit user
// confirmation. Mirrors browser-task.js's PAYMENT_KEYWORD_PATTERN (kept as a local copy because
// browser-task requires THIS module, so importing the other way would be circular). Over-matching
// is the safe direction here: a false positive just hands off to tryPaymentReady one step early.
const RECIPE_PAY_BUTTON_PATTERN = /\bpay\b|\bpay now\b|place\s+(your\s+)?order|order\s+now|complete\s+(your\s+)?(order|purchase|payment)|confirm\s+(your\s+)?(purchase|order|payment)|submit\s+(order|payment)/i;

// Shopify checkout driver. The platform-API tier (browser-platform-commerce.js) already
// resolved the product and added it to the cart, so the ONLY work left is Shopify's checkout,
// which is highly standardized across ~every Shopify store — one resolver covers all of them.
// Selected by capability (session.isShopify), not by host. Safety is the whole design:
//   1. Fill the guest email if it's on the page and not yet filled (resolveEmailFill).
//   2. If ANY pay/place-order button is visible, return null — never advance on a page that
//      has a pay affordance. This is what keeps us off Shopify's one-page "Pay now" button:
//      we hand off to the loop's tryPaymentReady, which autofills remaining address fields and
//      stops for confirmation instead of submitting payment.
//   3. Otherwise (a contact / shipping-address / shipping-method page with no pay button yet),
//      emit an 'advance' move. The loop's advance handler autofills the address from the saved
//      checkout profile and clicks the real "Continue to shipping/payment" button. Because we
//      only reach here when NO pay button is present, the advance handler's submit-button
//      fallback can never be the pay button.
async function resolveShopifyCheckout({ page, session, clickable }) {
  const emailMove = await resolveEmailFill({ page, session, clickable });
  if (emailMove) return emailMove;

  const payButtonVisible = await page.evaluate(({ sel, patSource, patFlags }) => {
    const pat = new RegExp(patSource, patFlags);
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return [...document.querySelectorAll(sel)]
      .some((el) => visible(el) && pat.test((el.innerText || el.value || el.getAttribute('aria-label') || '').trim()));
  }, { sel: clickable, patSource: RECIPE_PAY_BUTTON_PATTERN.source, patFlags: RECIPE_PAY_BUTTON_PATTERN.flags }).catch(() => false);
  if (payButtonVisible) return null; // reached payment — let tryPaymentReady fill + stop for confirmation

  return { action: 'click', stepName: 'advance', text: 'Continue' };
}

// Capability-selected Shopify checkout recipe (see resolveShopifyCheckout). Checkout-only —
// product resolve + add-to-cart is the platform-API tier's job, so there are no size/add steps.
const SHOPIFY = {
  isShopify: true,
  phases: {
    product:  (u) => /\/products\//i.test(u.pathname),
    checkout: (u) => /\/checkouts?\b/i.test(u.pathname),
    cart:     (u) => /\/cart\b/i.test(u.pathname),
  },
  size: {
    container: [], chip: [], selected: [],
    basketBadge: ['[data-testid*="cart" i]', 'a[aria-label*="cart" i]', 'a[href="/cart"]'],
  },
  steps: [
    { phase: 'checkout', name: 'shopify-checkout', resolve: (a) => resolveShopifyCheckout(a) },
  ],
};

// Delivery-site recipe: commit items from the item-options modal (Uber Eats / Deliveroo / Just Eat).
const DELIVERY = {
  isDelivery: true,
  phases: {
    modal: (u) => true, // gated by ctx.dialogOpen in nextRecipeMove
    menu:  (u) => true,
  },
  size: {
    container: [],
    chip: [],
    selected: [],
    basketBadge: [
      '[data-testid*="cart" i]',
      '[aria-label*="cart" i]',
      '[aria-label*="basket" i]',
      '[class*="cart-count" i]',
      '[class*="basket-count" i]',
    ],
  },
  steps: [
    { phase: 'modal', name: 'modal-add', when: (ctx) => ctx.dialogOpen, action: 'click', selectorAny: [
      'text=Add to order',
      'text=Add item',
      'text=Add to basket',
      'text=Add to cart',
      'text=Add',
    ] },
    { phase: 'menu', name: 'view-basket', when: (ctx) => ctx.basketCount > 0, action: 'click', selectorAny: [
      'text=View basket',
      'text=View order',
      'text=Go to checkout',
      'text=Checkout',
      'text=View cart',
    ] },
  ],
};

// Host-keyed registry. Selectors prefer durable attributes; visible text is last.
// NOTE: John Lewis product-page URLs end in `/pNNNNNN`; basket is `/basket`; checkout `/checkout`.
const RECIPES = {
  'thetrainline.com': {
    phases: { journey: () => true },
    size: { container: [], chip: [], selected: [] },
    steps: [
      { phase: 'journey', name: 'trainline-journey', resolve: (a) => resolveTrainlineJourney(a) },
    ],
  },

  'chilternrailways.co.uk': {
    phases: { journey: () => true },
    size: { container: [], chip: [], selected: [] },
    steps: [
      { phase: 'journey', name: 'chiltern-journey', resolve: (a) => resolveChilternJourney(a) },
    ],
  },

  'johnlewis.com': {
    phases: {
      product:  (u) => /\/p\d+(?:\b|\/|$)/i.test(u.pathname),
      basket:   (u) => /\/basket(?:\b|\/|$)/i.test(u.pathname),
      checkout: (u) => /\/checkout(?:\b|\/|$)/i.test(u.pathname),
    },
    // Site-specific probes the generic size step uses. Finalized against the live John Lewis
    // DOM (Task 6): sizes are <a data-testid="size:option:button"> (text XS/S/L) inside
    // <li data-testid="size:option">; selection is href-based (?size=xs).
    size: {
      container: ['[data-testid="size:option"]'],
      chip:      ['a[data-testid="size:option:button"]'],
      selected:  ['[data-testid="size:option:button"][aria-current="true"]', '[data-testid="size:option"][class*="selected" i]'],
    },
    steps: [
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
      // Only add while nothing is in the basket yet, so this doesn't re-fire once the item's in.
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, resolve: (a) => resolveJohnLewisAdd(a) },
      // Once the item is in the basket, go to the basket page via the header anchor (or a
      // "View basket" affordance from the add interstitial).
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, action: 'click', selectorAny: [
        '[data-testid="basket-anchor"]',
        'text=View basket',
        'text=Basket',
      ] },
      { phase: 'basket', name: 'checkout', action: 'click', selectorAny: [
        '[data-testid*="checkout" i]',
        'text=Checkout',
        'text=Secure checkout',
        'text=Continue to checkout',
      ] },
      { phase: 'checkout', name: 'guest', when: (ctx) => !ctx.isGuestEmailSubmit && !ctx.checkoutPastEmail, action: 'click', selectorAny: STANDARD_GUEST_SELECTORS },
      { phase: 'checkout', name: 'advance', when: (ctx) => ctx.checkoutPastEmail && !ctx.isGuestEmailSubmit, action: 'click', selectorAny: CHECKOUT_ADVANCE_SELECTORS },
    ],
  },

  // M&S size chips are <label aria-label="Size X"> fronting a visually-hidden radio
  // (data-selected="true"/"false" tracks the pick — no ?size= URL marker like John Lewis).
  // Basket badge is the header bag link's aria-label ("Shopping bag with N items").
  'marksandspencer.com': {
    basketUrl: '/basket/view',
    phases: {
      product:  (u) => /\/p\/[a-z0-9]+(?:\b|\/|$)/i.test(u.pathname),
      basket:   (u) => /^\/basket(?:\/|$)/i.test(u.pathname),
      checkout: (u) => /^\/checkout(?:\/|$)/i.test(u.pathname),
    },
    size: {
      container: ['label[aria-label^="Size " i]'],
      chip:      ['label[aria-label^="Size " i]'],
      selected:  ['label[aria-label^="Size " i][data-selected="true"]'],
      basketBadge: ['a[aria-label*="Shopping bag" i]'],
    },
    steps: [
      { phase: 'checkout', name: 'guest', when: (ctx) => !ctx.isGuestEmailSubmit && !ctx.checkoutPastEmail, action: 'click', selectorAny: [
        'text=Guest checkout',
        'text=Checkout as a guest',
        'text=Continue as a guest',
      ] },
      { phase: 'checkout', name: 'advance', when: (ctx) => ctx.checkoutPastEmail && !ctx.isGuestEmailSubmit, action: 'click', selectorAny: CHECKOUT_ADVANCE_SELECTORS },
      { phase: 'basket', name: 'guest', action: 'click', selectorAny: [
        'text=Guest checkout',
        'text=Checkout as a guest',
        'text=Continue as a guest',
      ] },
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        '#add-to-bag-button',
        'text=Add to bag',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, resolve: (a) => resolveNavigateBasket(a) },
      { phase: 'basket', name: 'checkout', action: 'click', selectorAny: [
        'text=Checkout securely',
        'text=Checkout',
      ] },
    ],
  },

  'currys.co.uk': {
    basketUrl: '/basket',
    phases: {
      product:  (u) => /\/(gp\/product|products)\//i.test(u.pathname),
      cart:     (u) => /\/basket/i.test(u.pathname),
      checkout: (u) => /\/checkout/i.test(u.pathname),
    },
    size: {
      container: [],
      chip: [],
      selected: [],
      basketBadge: ['[data-test*="basket" i]', 'a[href*="/basket"]'],
    },
    steps: [
      { phase: 'checkout', name: 'guest', when: (ctx) => !ctx.isGuestEmailSubmit && !ctx.checkoutPastEmail, action: 'click', selectorAny: [
        'text=Continue as guest',
        'text=Guest checkout',
        'text=Checkout as a guest',
      ] },
      { phase: 'checkout', name: 'advance', when: (ctx) => ctx.checkoutPastEmail && !ctx.isGuestEmailSubmit, action: 'click', selectorAny: CHECKOUT_ADVANCE_SELECTORS },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        '[data-test*="add-to-basket" i]',
        'text=Add to basket',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, resolve: (a) => resolveNavigateBasket(a) },
      { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
        'text=Checkout',
        'text=Go to checkout',
        'text=Secure checkout',
      ] },
    ],
  },

  'screwfix.com': {
    basketUrl: '/basket',
    phases: {
      product:  (u) => /\/p\//i.test(u.pathname),
      cart:     (u) => /\/basket/i.test(u.pathname),
      checkout: (u) => /\/checkout/i.test(u.pathname),
    },
    size: {
      container: [],
      chip: [],
      selected: [],
      basketBadge: ['[class*="basket-count" i]', 'a[href*="/basket"]', '[id*="basketQty" i]', '#headerBasketCount', '[data-qaid*="basket" i]'],
    },
    steps: [
      { phase: 'product', name: 'fulfillment', when: (ctx) => ctx.needsScrewfixFulfillment && !ctx.basketCount, resolve: (a) => resolveScrewfixFulfillment(a) },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        '#add_to_basket_btn',
        '[id*="addToBasket" i]',
        'text=Add to basket',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, resolve: (a) => resolveNavigateBasket(a) },
      { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
        'text=Checkout securely',
        'text=Checkout',
        '#checkout_btn',
      ] },
    ],
  },

  'nike.com': {
    basketUrl: '/cart',
    phases: {
      product:  (u) => /\/t\//i.test(u.pathname),
      cart:     (u) => /\/cart/i.test(u.pathname),
      checkout: (u) => /\/checkout/i.test(u.pathname),
    },
    size: {
      container: ['[data-qa="size-dropdown"]', '[class*="size-grid" i]'],
      chip:      ['[data-qa="size-selector"] label', 'input[name="skuAndSize"]', 'label[class*="size" i]'],
      selected:  ['[data-qa="size-selector"] input:checked', 'input[name="skuAndSize"]:checked'],
      basketBadge: ['[data-qa="cart-count"]', 'a[href*="/cart"]'],
    },
    steps: [
      { phase: 'checkout', name: 'guest', action: 'click', selectorAny: [
        'text=Guest checkout',
        'text=Continue as guest',
      ] },
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        '[data-qa="atb-button"]',
        'text=Add to Bag',
        'text=Add to bag',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, resolve: (a) => resolveNavigateBasket(a) },
      { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
        'text=Checkout',
        'text=Member Checkout',
      ] },
    ],
  },

  'selfridges.com': {
    basketUrl: '/GB/en/cat/cart',
    phases: {
      product:  (u) => /\/[A-Z]\d+/i.test(u.pathname) || /\/p\//i.test(u.pathname),
      cart:     (u) => /\/cart/i.test(u.pathname) || /\/bag/i.test(u.pathname),
      checkout: (u) => /\/checkout/i.test(u.pathname),
    },
    size: {
      container: ['[class*="size" i] button', '[data-testid*="size" i]'],
      chip:      ['[class*="size" i] button', '[data-testid*="size" i] button'],
      selected:  ['[class*="size" i] [aria-checked="true"]', '[class*="selected" i][class*="size" i]'],
      basketBadge: ['a[href*="/cart" i]', 'a[href*="/bag" i]'],
    },
    steps: [
      { phase: 'checkout', name: 'guest', when: (ctx) => !ctx.isGuestEmailSubmit && !ctx.checkoutPastEmail, action: 'click', selectorAny: [
        'text=Guest checkout',
        'text=Continue as guest',
        'text=Checkout as a guest',
      ] },
      { phase: 'checkout', name: 'advance', when: (ctx) => ctx.checkoutPastEmail && !ctx.isGuestEmailSubmit, action: 'click', selectorAny: CHECKOUT_ADVANCE_SELECTORS },
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        'text=Add to bag',
        '[data-testid*="add-to-bag" i]',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, resolve: (a) => resolveNavigateBasket(a) },
      { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
        'text=Checkout',
        'text=Secure checkout',
      ] },
    ],
  },

  'toolstation.com': {
    basketUrl: '/basket',
    phases: {
      product:  (u) => /\/p\//i.test(u.pathname),
      cart:     (u) => /\/basket/i.test(u.pathname) || /\/cart/i.test(u.pathname),
      checkout: (u) => /\/checkout/i.test(u.pathname),
    },
    size: { container: [], chip: [], selected: [] },
    steps: [
      { phase: 'checkout', name: 'guest', action: 'click', selectorAny: [
        'text=Guest checkout',
        'text=Continue as guest',
        'text=Checkout as a guest',
      ] },
      { phase: 'product', name: 'collection', when: (ctx) => ctx.needsCollectionPostcode, resolve: (a) => resolveToolstationCollection(a) },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        'text=Add to basket',
        '[id*="addToBasket" i]',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, resolve: (a) => resolveNavigateBasket(a) },
      { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
        'text=Checkout',
        'text=Go to checkout',
      ] },
    ],
  },

  'asos.com': {
    basketUrl: '/bag',
    phases: {
      product:  (u) => /\/prd\//i.test(u.pathname) || /\/p\//i.test(u.pathname),
      cart:     (u) => /\/bag/i.test(u.pathname) || /\/cart/i.test(u.pathname),
      checkout: (u) => /\/checkout/i.test(u.pathname),
    },
    size: {
      container: ['[id*="size" i]', '[class*="size" i]', 'select[id*="size" i]', '[data-testid*="size" i]', '[data-auto-id*="size" i]'],
      chip:      ['[data-auto-id*="size" i] button', '[id*="size" i] button', '[class*="size" i] button', 'select[id*="size" i] option', '[data-testid*="size" i] button'],
      selected:  ['[class*="selected" i][class*="size" i]', '[aria-checked="true"]', '[aria-pressed="true"]', 'select[id*="size" i] option:checked'],
      basketBadge: ['[data-testid="bag-item-count"]', 'a[href*="/bag"]', '[data-testid="bag-link"]'],
    },
    steps: [
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        '[data-testid="addToBag"]',
        'text=Add to bag',
        'text=Add to Bag',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, resolve: (a) => resolveNavigateBasket(a) },
      { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
        'text=Checkout',
        'text=Go to checkout',
      ] },
    ],
  },

  'waitrose.com': {
    basketUrl: '/ecom/shop/trolley',
    phases: {
      product:  (u) => /\/products\//i.test(u.pathname),
      cart:     (u) => /\/trolley/i.test(u.pathname) || /\/basket/i.test(u.pathname),
      checkout: (u) => /\/checkout/i.test(u.pathname),
    },
    size: { container: [], chip: [], selected: [] },
    steps: [
      { phase: 'checkout', name: 'guest', action: 'click', selectorAny: [
        'text=Guest checkout',
        'text=Continue as guest',
        'text=Checkout as a guest',
        'text=Continue without signing in',
      ] },
      { phase: 'cart', name: 'guest', action: 'click', selectorAny: [
        'text=Guest checkout',
        'text=Continue as guest',
        'text=Checkout as a guest',
      ] },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        'text=Add to trolley',
        'text=Add',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, resolve: (a) => resolveNavigateBasket(a) },
      { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
        'text=Checkout',
        'text=Go to checkout',
      ] },
    ],
  },

  // Wickes reveals "View Basket"/"Checkout" links only inside a mini-cart overlay that the
  // header basket button toggles open (no URL change) — flyoutCheck gates a distinct
  // open-basket step before checkout can fire. basketCount comes from a same-origin JSON
  // endpoint (`totalItems`) since the header badge carries no visible count until opened.
  'wickes.co.uk': {
    phases: {
      product:  (u) => /\/p\/\d+(?:\b|\/|$)/i.test(u.pathname),
      cart:     (u) => /^\/cart\/?$/i.test(u.pathname),
      checkout: (u) => /^\/cart\/checkout/i.test(u.pathname) || /^checkout\.wickes\.co\.uk$/i.test(u.hostname),
    },
    size: {
      container: [], chip: [], selected: [],
      basketCountUrl: '/cart/enhancedMiniCart/SUBTOTAL/',
      basketCountField: 'totalItems',
      flyoutCheck: ['.btn-checkout'],
    },
    steps: [
      { phase: 'checkout', name: 'guest', action: 'click', selectorAny: [
        'text=Checkout as a guest',
        'text=Continue as a guest',
        'text=Guest checkout',
      ] },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        '.btn-add-to-basket',
        'text=Add for Delivery',
        'text=Add for Collection',
      ] },
      { phase: 'product', name: 'open-basket', when: (ctx) => ctx.basketCount > 0 && !ctx.flyoutOpen, action: 'click', selectorAny: [
        '.header-minicart__btn',
        'text=Basket',
      ] },
      { phase: 'product', name: 'checkout', when: (ctx) => ctx.basketCount > 0 && ctx.flyoutOpen, action: 'click', selectorAny: [
        '.btn-checkout',
        'text=Checkout',
      ] },
      { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
        '.btn-checkout',
        'text=Checkout',
      ] },
    ],
  },
};

// First phase whose predicate matches the url, or null. Never throws on a bad url.
function phaseFromUrl(recipe, url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  for (const [name, pred] of Object.entries(recipe.phases)) {
    if (pred(u)) return name;
  }
  return null;
}

const RECIPE_FAIL_DISABLE_THRESHOLD = 3;

// In-memory per-(host,step) health. A step whose selectors keep missing self-disables so a
// site redesign degrades to the vision loop instead of stalling. Not persisted (YAGNI).
function createRecipeHealth(threshold = RECIPE_FAIL_DISABLE_THRESHOLD) {
  const misses = new Map(); // `${host}:${step}` -> consecutive miss count
  const key = (host, step) => `${host}:${step}`;
  return {
    isDisabled: (host, step) => (misses.get(key(host, step)) || 0) >= threshold,
    recordMiss: (host, step) => { const k = key(host, step); misses.set(k, (misses.get(k) || 0) + 1); },
    recordHit:  (host, step) => { misses.set(key(host, step), 0); },
  };
}

// First step for this phase whose gate (when) passes and which isn't health-disabled.
function selectStep(recipe, phase, ctx, health, host) {
  for (const step of recipe.steps) {
    if (step.phase !== phase) continue;
    if (step.when && !step.when(ctx)) continue;
    if (health && health.isDisabled(host, step.name)) continue;
    return step;
  }
  return null;
}

// --- DOM probes (real in prod; scripted by the fake page in unit tests) -------------------
// Build the ctx the step gates read. `hasUnsatisfiedSize`: a size container is present AND
// nothing in it is selected yet. `basketCount`: read from a DOM badge by default (or a JSON
// fetch when the host doesn't expose one without opening the mini-cart — Wickes). `flyoutOpen`:
// some sites (Wickes) reveal the checkout link only inside a mini-cart overlay that a click
// toggles open; a distinct step opens it before the checkout step can fire.
async function readCtx(page, recipe, session) {
  const size = recipe.size;
  const ctx = await page.evaluate(({ probe, size }) => {
    void probe;
    const hasAny = (sels) => sels.some((s) => { try { return !!document.querySelector(s); } catch { return false; } });
    const container = hasAny(size.container);
    // A size is "chosen" either by a DOM marker (aria-current/selected class) or — on John
    // Lewis, where size chips are hrefs — by the ?size= query param the click navigates to.
    const selectedDom = hasAny(size.selected);
    const selectedUrl = /[?&]size=/i.test(location.search || '');
    const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let basketCount = 0;
    if (!size.basketCountUrl) {
      const badgeSels = size.basketBadge || ['[data-testid="basket-amount"]'];
      for (const s of badgeSels) {
        try {
          const el = document.querySelector(s);
          if (!el) continue;
          const text = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`;
          const m = text.match(/\d+/);
          if (m) { basketCount = parseInt(m[0], 10) || 0; break; }
        } catch { /* keep scanning other selectors */ }
      }
      // Some sites show a post-add "View basket/bag/cart/trolley" interstitial before the
      // header badge ticks up — generic across all of them, not just JL's "View basket".
      if (basketCount === 0) {
        for (const el of document.querySelectorAll('a, button')) {
          const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
          if (!/^(?:view|go to)\s+(?:your\s+)?(?:basket|bag|cart|trolley)$/i.test(t)) continue;
          if (!visible(el)) continue;
          basketCount = 1;
          break;
        }
      }
    }
    const flyoutOpen = (size.flyoutCheck || []).some((s) => { try { return visible(document.querySelector(s)); } catch { return false; } });
    const vw = window.innerWidth * window.innerHeight;
    const dialogOpen = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'))
      .filter(visible)
      .some((el) => { const r = el.getBoundingClientRect(); return r.width * r.height > vw * 0.12; });
    const needsCollectionPostcode = /\bcollection\b/i.test(location.pathname + (document.body?.innerText || '').slice(0, 2000))
      && !document.querySelector('input[value*=" " i][name*="postcode" i], input[name*="postcode" i]:not(:placeholder-shown)');
    const bodySnippet = (document.body?.innerText || '').slice(0, 4000);
    const needsScrewfixFulfillment = /\/p\//i.test(location.pathname)
      && /\b(deliver(?:y)?|click\s*&\s*collect|collect in store)\b/i.test(bodySnippet)
      && !document.querySelector('[class*="fulfil" i][class*="selected" i], [class*="fulfillment" i][aria-checked="true"], input[name*="fulfil" i]:checked');
    // Upsell/cross-sell overlay detection: any large visible drawer/modal that contains
    // a dismiss-type affordance (e.g. Currys' Care & Repair upsell after add-to-basket).
    const UPSELL_TEXT_PAT = /no,?\s*thanks|skip\b|maybe later|dismiss|close|continue without|go to basket|continue to basket|continue to checkout|no thanks|not (now|interested)|remind me later/i;
    const upsellModalOpen = (() => {
      const overlays = [
        ...document.querySelectorAll('dialog,[role="dialog"],[class*="modal" i],[class*="drawer" i]')
      ].filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width * r.height > vw * 0.04;
      });
      return overlays.some((el) => UPSELL_TEXT_PAT.test(el.innerText || ''));
    })();
    let checkoutEmailVisible = false;
    let checkoutIdentityFields = 0;
    let isGuestEmailSubmit = false;
    for (const inp of document.querySelectorAll('input[type="email"], input[name*="email" i]')) {
      if (!visible(inp)) continue;
      checkoutEmailVisible = true;
      if ((inp.value || '').trim().length > 3) {
        for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
          if (!visible(el)) continue;
          const t = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim();
          if (/continue as guest|guest checkout/i.test(t)) { isGuestEmailSubmit = true; break; }
        }
      }
      break;
    }
    for (const inp of document.querySelectorAll(
      'input[autocomplete="given-name"], input[name*="firstName" i], input[name*="first_name" i], select[name*="title" i], input[autocomplete="postal-code"], input[name*="postcode" i]'
    )) {
      if (visible(inp)) checkoutIdentityFields++;
    }
    const checkoutPastEmail = checkoutIdentityFields > 0 || (!checkoutEmailVisible && /\/checkout/i.test(location.pathname));
    return {
      hasUnsatisfiedSize: container && !selectedDom && !selectedUrl,
      basketCount, flyoutOpen, dialogOpen, needsCollectionPostcode, needsScrewfixFulfillment,
      upsellModalOpen,
      checkoutEmailVisible, checkoutIdentityFields, isGuestEmailSubmit, checkoutPastEmail,
    };
  }, { probe: 'ctx', size });
  if (size.basketCountUrl) {
    ctx.basketCount = await page.evaluate(async ({ probe, url, field }) => {
      void probe;
      try {
        const r = await fetch(url, { credentials: 'same-origin' });
        const j = await r.json();
        return parseInt(j[field], 10) || 0;
      } catch { return 0; }
    }, { probe: 'basketCountFetch', url: size.basketCountUrl, field: size.basketCountField || 'totalItems' });
  }
  // Regression: each recipe hand-writes its own `basketBadge` CSS selectors to detect a
  // non-empty cart, and they bit-rot independently of the site's actual markup (Nike's
  // recipe still looked for `[data-qa="cart-count"]`, which doesn't exist on the live site
  // any more, so ctx.basketCount stayed 0 forever and the recipe kept re-triggering `add` in
  // a loop even after the item was genuinely added). browser-task.js already maintains one
  // generic, actively-verified `session.cartAddConfirmed` flag for exactly this signal — an
  // out-of-band DOM-scan poll that isn't tied to any one site's selectors. Treat it as
  // authoritative here too instead of trusting only this recipe's own (possibly stale)
  // badge selectors, so a recipe can never disagree with the thing that actually clicked add.
  if (session?.cartAddConfirmed && ctx) ctx.basketCount = Math.max(ctx.basketCount || 0, 1);
  return ctx || {
    hasUnsatisfiedSize: false, basketCount: 0, flyoutOpen: false, dialogOpen: false,
    needsCollectionPostcode: false, needsScrewfixFulfillment: false, upsellModalOpen: false,
    checkoutEmailVisible: false, checkoutIdentityFields: 0, isGuestEmailSubmit: false, checkoutPastEmail: false,
  };
}

// Resolve a step's selectorAny to a { locatorIndex, text }, choosing the first candidate that
// maps to a VISIBLE, ENABLED element (locatorIndex = index into querySelectorAll(CLICKABLE_SELECTOR)).
// null if none match. `text` lets the loop apply the payment guardrail + write history without a
// re-read. CLICKABLE_SELECTOR must match browser-task.js's constant — passed in so there's one source.
async function resolveSelectorIndex(page, selectorAny, clickableSelector, tag) {
  const evalOnce = () => page.evaluate(({ probe, selectorAny, clickableSelector }) => {
    void probe;
    const all = Array.from(document.querySelectorAll(clickableSelector));
    const isEnabled = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const sel of selectorAny) {
      let node = null;
      let disabledMatch = null;
      if (sel.startsWith('text=')) {
        // Native exact-text candidate (case-insensitive, trimmed). Replaces Playwright's
        // :has-text pseudo — which document.querySelector cannot parse — and exact-matches so
        // "Add to basket" never picks a carousel "Add to basket , <product>" recommendation.
        const want = sel.slice(5).trim().toLowerCase();
        const candidates = all.filter((el) => (el.innerText || '').trim().toLowerCase() === want);
        node = candidates.find(isEnabled) || null;
        if (!node) disabledMatch = candidates[0] || null;
      } else {
        let match;
        try { match = document.querySelector(sel); } catch { continue; }
        if (match) {
          if (isEnabled(match)) node = match.closest(clickableSelector) || match;
          else disabledMatch = match;
        }
      }
      if (node) {
        const idx = all.indexOf(node);
        if (idx !== -1) {
          const text = (node.innerText || node.getAttribute('aria-label') || node.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          return { locatorIndex: idx, text };
        }
      }
      if (disabledMatch) return { disabled: true };
    }
    return null;
  }, { probe: tag, selectorAny, clickableSelector });
  const first = await evalOnce();
  if (first && !first.disabled) return first;
  if (!first) return null;
  // Regression: Nike's Checkout button exists in the DOM the instant the cart page loads,
  // but stays disabled for a beat while the page fetches the cart's actual contents — one
  // check right after navigation caught it mid-load and gave up (recorded a miss, fell back
  // to vision, which then wandered off into cross-sell products instead of waiting). The
  // matched-but-disabled case is a real, different signal from "not found at all": worth a
  // short poll for it to become interactive before conceding, on any site's checkout-style
  // button, not just Nike's.
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(300);
    const retry = await evalOnce();
    if (retry && !retry.disabled) return retry;
  }
  return null;
}

// Ship-from-store JL PDPs expose only express checkout — no standard add-to-basket CTA.
async function isJohnLewisExpressOnlyPdp(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const std = document.querySelector('[data-testid="basket:add"]');
    const express = document.querySelector('[data-testid="basket:add:express"]');
    return visible(express) && !visible(std);
  }).catch(() => false);
}

// Header bag icons often open a flyout without navigating — go straight to the basket page.
async function resolveNavigateBasket({ page, session, recipe, ctx }) {
  if (!ctx?.basketCount) return null;
  let origin;
  try { origin = new URL(page.url()).origin; } catch { return null; }
  const path = recipe.basketUrl || '/basket';
  const dest = `${origin}${path.startsWith('/') ? path : `/${path}`}`;
  try {
    const cur = new URL(page.url());
    if (cur.pathname.replace(/\/+$/, '') === new URL(dest).pathname.replace(/\/+$/, '')) return null;
  } catch { /* keep going */ }
  // Regression: a hard page.goto() is a full reload — for SPAs whose cart lives only in
  // client-side state until it syncs server-side (Nike), reloading can race that sync and
  // land on a basket page that reads as empty even though the add genuinely went through,
  // sending the loop back to square one. A same-origin client-side route change (clicking the
  // page's own "View Bag/Basket/Cart/Trolley" control) doesn't reload the JS bundle and so
  // can't lose that in-memory state — prefer it, and only fall back to the hard navigation
  // when no such control is visible.
  const beforeUrl = page.url();
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const el of document.querySelectorAll('a, button')) {
      const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (!/^(?:view|go to)\s+(?:your\s+)?(?:basket|bag|cart|trolley)$/i.test(t)) continue;
      if (!visible(el)) continue;
      el.click();
      return true;
    }
    return false;
  }).catch(() => false);
  if (clicked) {
    await page.waitForURL((u) => u.toString() !== beforeUrl, { timeout: 4000 }).catch(() => {});
    return { action: 'navigate', url: page.url(), text: 'Basket page', stepName: 'go-to-basket' };
  }
  await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  return { action: 'navigate', url: dest, text: 'Basket page', stepName: 'go-to-basket' };
}

// Screwfix PDP: choose Deliver or Click & Collect before add-to-basket is enabled.
async function resolveScrewfixFulfillment({ page, clickable }) {
  const hit = await page.evaluate((sel) => {
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const all = [...document.querySelectorAll(sel)];
    const want = [/^(?:home\s+)?deliver(?:y)?$/i, /^click\s*&\s*collect$/i, /^collect$/i];
    for (const pat of want) {
      for (const el of all) {
        const t = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
        if (!pat.test(t)) continue;
        if (!visible(el)) continue;
        const node = el.closest(sel) || el;
        const idx = all.indexOf(node);
        if (idx >= 0) return { idx, text: t };
      }
    }
    for (const inp of document.querySelectorAll('input[type="radio"]')) {
      if (!visible(inp)) continue;
      const label = inp.labels?.[0] || (inp.id && document.querySelector(`label[for="${CSS.escape(inp.id)}"]`));
      const t = (label?.innerText || inp.getAttribute('aria-label') || '').trim();
      if (!/\b(deliver|collect)\b/i.test(t)) continue;
      if (inp.checked) return null;
      const node = (label || inp).closest(sel) || label || inp;
      const idx = all.indexOf(node);
      if (idx >= 0) return { idx, text: t || 'Fulfillment' };
    }
    return null;
  }, clickable).catch(() => null);
  if (!hit) return null;
  return { action: 'click', locatorIndex: hit.idx, text: hit.text, stepName: 'fulfillment' };
}

// Toolstation collection: pick "Collection", fill postcode from goal/profile, confirm store.
async function resolveToolstationCollection({ page, session, clickable }) {
  const goal = `${session.goal || ''} ${(session.history || []).join(' ')}`;
  const postcodeMatch = goal.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})\b/i);
  const postcode = postcodeMatch ? postcodeMatch[1].toUpperCase() : null;
  const hit = await page.evaluate(({ sel, postcode }) => {
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const all = [...document.querySelectorAll(sel)];
    for (const el of all) {
      const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (/^collection$/i.test(t) && visible(el)) {
        const idx = all.indexOf(el.closest(sel) || el);
        if (idx >= 0) return { kind: 'collection', idx, text: t };
      }
    }
    if (postcode) {
      for (const inp of document.querySelectorAll('input')) {
        if (!visible(inp)) continue;
        const ph = (inp.placeholder || inp.getAttribute('aria-label') || '').toLowerCase();
        const name = (inp.name || inp.id || '').toLowerCase();
        if (ph.includes('postcode') || name.includes('postcode') || ph.includes('post code')) {
          inp.focus();
          inp.value = postcode;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return { kind: 'postcode', text: postcode };
        }
      }
    }
    for (const el of all) {
      const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (/find address/i.test(t) && visible(el)) {
        const idx = all.indexOf(el.closest(sel) || el);
        if (idx >= 0) return { kind: 'find', idx, text: t };
      }
    }
    for (const el of all) {
      const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (/collect from|select (?:this )?store|choose (?:this )?store/i.test(t) && visible(el)) {
        const idx = all.indexOf(el.closest(sel) || el);
        if (idx >= 0) return { kind: 'store', idx, text: t };
      }
    }
    for (const el of all) {
      const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (/\b(EC1A|toolstation)\b/i.test(t) && t.length < 80 && visible(el)) {
        const idx = all.indexOf(el.closest(sel) || el);
        if (idx >= 0) return { kind: 'store', idx, text: t };
      }
    }
    return null;
  }, { sel: clickable, postcode }).catch(() => null);
  if (!hit) return null;
  if (hit.kind === 'postcode') {
    return { action: 'wait', text: `Filled postcode ${hit.text}`, stepName: 'collection' };
  }
  return { action: 'click', locatorIndex: hit.idx, text: hit.text, stepName: 'collection' };
}

// John Lewis add: prefer the standard basket CTA. Ship-from-store SKUs that expose only
// express checkout are left to vision (headless express often does not advance the cart).
async function resolveJohnLewisAdd({ page, clickable }) {
  const hit = await resolveSelectorIndex(page, [
    '[data-testid="basket:add"]',
    '[data-testid="add-to-basket-ui"] [data-testid="basket:add"]',
    '[id="basket:add:button"]',
    '[id="basket:add"]',
  ], clickable, 'resolve:jl-add');
  if (!hit) return null;
  return { action: 'click', locatorIndex: hit.locatorIndex, text: hit.text, stepName: 'add' };
}

// The size step's resolve — the per-step escape hatch from the design. Size is a genuine
// choice, so we NEVER guess: if the goal names a size, click the matching chip; if it doesn't,
// ask. Reads chip labels from the page and maps the chosen one to a locatorIndex. Takes the
// single args bag the executor hands every resolve fn: { page, session, recipe, ctx, clickable }.
async function resolveSizeMove({ page, session, recipe, clickable }) {
  const want = parseSizeFromGoal(`${session.goal || ''} ${(session.history || []).join(' ')}`, session.goalContext);
  if (!want) return { action: 'ask', question: 'What size would you like?', stepName: 'size' };
  const chips = await page.evaluate(({ probe, chipSel, clickableSelector }) => {
    void probe;
    // Exclude nav-style links that share "size" vocabulary but aren't actual size chips.
    const NAV_EXCLUDE = /\b(size guide|size chart|fitting guide|view size guide|size info|size help)\b/i;
    const all = Array.from(document.querySelectorAll(clickableSelector));
    const out = [];
    for (const sel of chipSel) {
      for (const el of document.querySelectorAll(sel)) {
        const label = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().split(/\n/)[0].trim();
        if (!label || NAV_EXCLUDE.test(label)) continue;
        const idx = all.indexOf(el.closest(clickableSelector) || el);
        if (idx !== -1) out.push({ label, idx });
      }
      if (out.length) break; // first selector that yields chips wins
    }
    return out;
  }, { probe: 'sizeChips', chipSel: recipe.size.chip, clickableSelector: clickable });
  const pick = matchSizeChip(want, chips.map((c) => c.label));
  if (pick == null) return null; // asked-for size not offered → vision/ask fallback
  return { action: 'click', locatorIndex: chips[pick].idx, text: chips[pick].label, stepName: 'size' };
}

// Trainline's station autocomplete is a real choice, not free text. The generic loop can
// type both station names and then drift into a grouped suggestion such as "London (Any)".
// Keep the mechanical form work deterministic: fill one field, then select the exact
// station suggestion before moving on to the next field. The requested travel date is
// also a deterministic form value; time and the actual fare remain live decisions in
// the normal browser loop.
function parseTrainlineJourney(text) {
  const match = String(text || '').match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?=\s+(?:on|for|arriv(?:e|ing)|by)\b|[,.]|$)/i);
  if (!match) return null;
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const origin = clean(match[1]);
  const destination = clean(match[2]);
  return origin && destination ? { origin, destination } : null;
}

function parseTrainlineDate(text) {
  const months = 'january|february|march|april|may|june|july|august|september|october|november|december';
  const match = String(text || '').match(new RegExp(`\\b(?:on\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\\s*(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${months})(?:\\s+(20\\d{2}))?\\b`, 'i'));
  if (!match) return null;
  const day = Number(match[1]);
  if (day < 1 || day > 31) return null;
  return {
    day,
    month: match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase(),
    year: match[3] ? Number(match[3]) : new Date().getFullYear(),
  };
}

function parseTrainlineArrivalHour(text) {
  const match = String(text || '').match(/\barriv(?:e|ing)(?:\s+by)?\s+(\d{1,2})(?::\d{2})?\s*(am|pm)?\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (hour > 23) return null;
  if (/pm/i.test(match[2] || '') && hour < 12) hour += 12;
  if (/am/i.test(match[2] || '') && hour === 12) hour = 0;
  return hour;
}

// A return is a separate, material part of a rail search: stations and the outward
// arrival time alone are not enough to produce a usable round-trip fare. For an
// event-night request with no explicit return time, use 23:00 as a conservative
// *provisional* departure. The caller still stops at payment review, where the
// user can see and amend that assumption before any charge is possible.
function parseTrainReturn(text) {
  const goal = String(text || '');
  if (!/\b(?:return|round[ -]?trip)\b/i.test(goal)) return null;
  const match = goal.match(/\b(?:return(?:ing)?|back)\b[\s\S]{0,60}?\b(?:after|at)\s+(\d{1,2})(?::\d{2})?\s*(am|pm)?\b/i);
  let hour = match ? Number(match[1]) : null;
  if (hour != null && (hour > 23 || hour < 0)) hour = null;
  if (hour != null && /pm/i.test(match[2] || '') && hour < 12) hour += 12;
  if (hour != null && /am/i.test(match[2] || '') && hour === 12) hour = 0;
  return {
    // The supplied journey date is the only date in a same-night concert request.
    // This is deliberately surfaced in the payment-review receipt rather than hidden.
    hour: hour == null ? 23 : hour,
    assumedHour: hour == null,
  };
}

async function resolveTrainlineStation({ page, station, field, clickable }) {
  return page.evaluate(({ station, field, clickableSelector, probe }) => {
    const normalise = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const wanted = normalise(station);
    const visible = el => {
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const label = el => [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title')]
      .filter(Boolean).join(' ');
    const all = [...document.querySelectorAll(clickableSelector)];
    const fieldPattern = field === 'departure' ? /departure station/i : /arrival station/i;
    // Labels and wrapping buttons may share the station wording. Only the real combobox
    // exposes the selected state in aria-label, so examine it before those wrappers.
    const fields = [...document.querySelectorAll('input[aria-label], [role="combobox"][aria-label]')];
    const fieldElement = fields.find(el => fieldPattern.test(label(el)) && visible(el))
      || all.find(el => fieldPattern.test(label(el)) && visible(el));
    if (!fieldElement) return { kind: 'missing' };
    // `input.value` becomes the typed station before Trainline has accepted the autocomplete
    // option, so it must not count as selected. The control's aria label changes to
    // "<station> selected" only after the site has committed the choice.
    const fieldAria = normalise(fieldElement.getAttribute('aria-label'));
    if (fieldAria.includes(wanted) && /\bselected\b/.test(fieldAria)) return { kind: 'selected' };

    const suggestions = all
      .filter(el => visible(el) && !fieldPattern.test(label(el)))
      .map((el, locatorIndex) => ({ el, locatorIndex, text: String(el.innerText || el.getAttribute('aria-label') || el.value || '').trim() }))
      .filter(candidate => normalise(candidate.text).includes(wanted));
    if (suggestions.length) {
      suggestions.sort((a, b) => a.text.length - b.text.length);
      const choice = suggestions[0];
      return { kind: 'suggestion', locatorIndex: all.indexOf(choice.el), text: choice.text };
    }
    return { kind: 'input', locatorIndex: all.indexOf(fieldElement), text: field === 'departure' ? 'Departure station' : 'Arrival station', probe };
  }, { station, field, clickableSelector: clickable, probe: 'trainlineStation' }).catch(() => ({ kind: 'missing' }));
}

async function resolveTrainlineDate({ page, date, clickable }) {
  return page.evaluate(({ date, clickableSelector, probe }) => {
    const visible = el => {
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const text = el => String(el.innerText || el.getAttribute('aria-label') || el.value || '').replace(/\s+/g, ' ').trim();
    const all = [...document.querySelectorAll(clickableSelector)];
    // The visible month heading is occasionally aria-hidden, so body innerText alone is
    // not a reliable signal. The month-navigation control is an exposed, stable marker
    // for this popup on the production form.
    const calendarOpen = new RegExp(`\\b${date.month}\\s+${date.year}\\b`, 'i').test(document.body.innerText || '')
      || all.some(el => visible(el) && /go to the (?:previous|next) month/i.test(text(el)));
    if (!calendarOpen) {
      const opener = all.find(el => visible(el) && /date and time of departure|\bout\b/i.test(text(el)));
      return opener ? { kind: 'open', locatorIndex: all.indexOf(opener), text: text(opener) } : { kind: 'missing' };
    }
    // Calendar-day cells include a displayed fare (for example, "19 £18"). Pick only
    // the exact day at the start of the cell so no fare, month navigation, or time field
    // can be mistaken for the requested date.
    const dayPattern = new RegExp(`^${date.day}(?:\\s|$)`);
    const opener = all.find(el => visible(el) && /date and time of departure|\bout\b/i.test(text(el)));
    const day = all.find(el => visible(el) && dayPattern.test(text(el)));
    return day ? {
      kind: 'day', locatorIndex: all.indexOf(day), text: text(day),
      openerIndex: opener ? all.indexOf(opener) : -1, openerText: opener ? text(opener) : '',
    } : { kind: 'missing' };
  }, { date, clickableSelector: clickable, probe: 'trainlineDate' }).catch(() => ({ kind: 'missing' }));
}

async function resolveTrainlineJourney({ page, session, clickable }) {
  if (session?.trainlineJourneyDone) return null;
  const journey = parseTrainlineJourney(session?.goal);
  if (!journey) return null;

  const stages = [
    ['origin', journey.origin, 'departure'],
    ['destination', journey.destination, 'arrival'],
  ];
  for (const [key, station, field] of stages) {
    if (session[`trainline${key[0].toUpperCase()}${key.slice(1)}Selected`]) continue;
    const move = await resolveTrainlineStation({ page, station, field, clickable });
    if (move.kind === 'selected') {
      session[`trainline${key[0].toUpperCase()}${key.slice(1)}Selected`] = true;
      session.trainlineJourneyStage = `${key}-selected`;
      continue;
    }
    if (move.kind === 'suggestion') {
      session.trainlineJourneyStage = `${key}-selecting`;
      return { action: 'click', locatorIndex: move.locatorIndex, text: move.text, stepName: `trainline-${key}` };
    }
    if (move.kind === 'input') {
      // Trainline binds an autocomplete option to the field that currently owns keyboard
      // focus. Routing the option through the generic click executor can lose that focus
      // between a fill and click, assigning the station to the other field. Fill and accept
      // the first exact-match suggestion as one native interaction instead.
      if (page?.keyboard && typeof page.locator === 'function') {
        // Do not carry a broad selector index across an autocomplete re-render. Trainline
        // replaces the departure field after selection, so the old index can resolve to its
        // station-swap button. The field's accessible-name prefix and option role are stable.
        const ariaPrefix = field === 'departure' ? 'Departure station' : 'Arrival station';
        const input = page.locator(`input[aria-label^="${ariaPrefix}"]`).first();
        if (await input.count()) {
          await input.fill(station);
          await page.waitForTimeout(350);
          const option = page.locator('[role="option"]').filter({ hasText: station }).first();
          // Trainline keeps an XHR spinner alive after a choice; do not let Playwright wait
          // for that unrelated network activity before the next resolver pass checks the
          // field's selected aria label.
          if (await option.count()) await option.click({ noWaitAfter: true, timeout: 3000 });
          else {
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
          }
          await page.waitForTimeout(150);
          session.trainlineJourneyStage = `${key}-committed`;
          return { action: 'wait', text: `Selected ${station}`, stepName: `trainline-${key}` };
        }
      }
      const fillStage = `${key}-filled`;
      if (session.trainlineJourneyStage === fillStage) {
        session.trainlineJourneyStage = `${key}-waiting-for-suggestions`;
        return { action: 'wait', text: `Waiting for ${station} suggestions`, stepName: `trainline-${key}` };
      }
      session.trainlineJourneyStage = fillStage;
      return { action: 'fill', locatorIndex: move.locatorIndex, value: station, text: move.text, stepName: `trainline-${key}` };
    }
    return null;
  }
  if (!session.trainlineDateSelected) {
    const date = parseTrainlineDate(session.goal);
    if (date) {
      const move = await resolveTrainlineDate({ page, date, clickable });
      if (move.kind === 'open') {
        session.trainlineJourneyStage = 'date-opening';
        return { action: 'click', locatorIndex: move.locatorIndex, text: move.text, stepName: 'trainline-date' };
      }
      if (move.kind === 'day') {
        session.trainlineDateSelected = true;
        session.trainlineJourneyStage = 'date-selected';
        return { action: 'click', locatorIndex: move.locatorIndex, text: move.text, stepName: 'trainline-date' };
      }
      return null;
    }
  }
  // A click on Trainline's date control only closes the calendar while it is open; it
  // does not run the search. Close it once any requested arrival-hour constraint is
  // visibly satisfied, then leave one unambiguous "Find cheap tickets" click to submit.
  const selectedDate = parseTrainlineDate(session.goal);
  if (selectedDate) {
    const move = await resolveTrainlineDate({ page, date: selectedDate, clickable });
    if (move.kind === 'day') {
      const wantedHour = parseTrainlineArrivalHour(session.goal);
      const displayed = (move.openerText || '').match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
      let displayedHour = null;
      if (displayed) {
        displayedHour = Number(displayed[1]);
        if (/PM/i.test(displayed[3]) && displayedHour < 12) displayedHour += 12;
        if (/AM/i.test(displayed[3]) && displayedHour === 12) displayedHour = 0;
      }
      if ((wantedHour == null || displayedHour === wantedHour) && move.openerIndex >= 0) {
        session.trainlineJourneyStage = 'date-closing';
        return { action: 'click', locatorIndex: move.openerIndex, text: move.openerText, stepName: 'trainline-date' };
      }
      return null;
    }
  }
  session.trainlineJourneyDone = true;
  return null;
}

async function resolveChilternJourney({ page, session, clickable }) {
  const wantedHour = parseTrainlineArrivalHour(session?.goal);
  const returnJourney = parseTrainReturn(session?.goal);
  const journey = parseTrainlineJourney(session?.goal);
  // Chiltern's station widgets do not accept free text: they only become valid after
  // the highlighted autocomplete result is committed. Use the widget's native keyboard
  // behaviour so we are not relying on a vision model to spot a transient dropdown.
  const liveChiltern = Boolean(page?.keyboard && typeof page.locator === 'function');
  if (journey && liveChiltern) {
    const stations = [
      ['origin', '#qtt-widget-origin-station-input', journey.origin],
      ['destination', '#qtt-widget-destination-station-input', journey.destination],
    ];
    for (const [key, selector, station] of stations) {
      const selectedKey = `chiltern${key[0].toUpperCase()}${key.slice(1)}Selected`;
      if (session[selectedKey]) continue;
      const input = page.locator(selector).first();
      if (!(await input.count())) break;
      const value = await input.inputValue().catch(() => '');
      if (String(value).toLowerCase().includes(station.toLowerCase()) && /\([A-Z]{3}\)/.test(value)) {
        session[selectedKey] = true;
        continue;
      }
      await input.fill(station);
      // The destination suggestions arrive later than the origin on the production form;
      // committing earlier leaves a visually-filled but invalid station field.
      await page.waitForTimeout(800);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      return { action: 'wait', text: `Selected ${station}`, stepName: 'chiltern-journey' };
    }

    if (wantedHour != null && !session.chilternDateDone) {
      const done = page.getByText('Done', { exact: true }).last();
      if (await done.count()) {
        const nativeMove = await page.locator('select').evaluateAll((selects, hour) => {
          const optionList = select => [...select.options].map(option => ({ label: option.textContent.trim(), value: option.value }));
          const selected = select => select.options[select.selectedIndex]?.textContent.trim() || '';
          for (let index = 0; index < selects.length; index++) {
            const labels = optionList(selects[index]);
            if (labels.some(option => option.label === 'Depart after') && labels.some(option => option.label === 'Arrive before')) {
              const arrive = labels.find(option => option.label === 'Arrive before');
              if (selected(selects[index]) !== arrive.label) return { kind: 'select', index, value: arrive.value, label: arrive.label };
            }
          }
          const wanted = `${String(hour).padStart(2, '0')}:00`;
          for (let index = 0; index < selects.length; index++) {
            const labels = optionList(selects[index]);
            const time = labels.find(option => option.label === wanted) || labels.find(option => option.label.startsWith(`${String(hour).padStart(2, '0')}:`));
            if (time && selected(selects[index]) !== time.label) return { kind: 'select', index, value: time.value, label: time.label };
          }
          return { kind: 'done' };
        }, wantedHour).catch(() => null);
        if (nativeMove?.kind === 'select') {
          await page.locator('select').nth(nativeMove.index).selectOption({ value: nativeMove.value });
          return { action: 'wait', text: `Set ${nativeMove.label}`, stepName: 'chiltern-journey' };
        }
        if (nativeMove?.kind === 'done') {
          await done.click({ noWaitAfter: true });
          session.chilternDateDone = true;
          return { action: 'wait', text: 'Confirmed journey date and time', stepName: 'chiltern-journey' };
        }
        if (!session.chilternArrivalModeSelected) {
          const departAfter = page.getByText('Depart after', { exact: true }).last();
          const arriveBefore = page.getByText('Arrive before', { exact: true }).last();
          if (!(await departAfter.count()) && await arriveBefore.count()) {
            session.chilternArrivalModeSelected = true;
          }
          if (await departAfter.count()) {
            await departAfter.click({ noWaitAfter: true });
            await page.waitForTimeout(100);
            if (await arriveBefore.count()) {
              await arriveBefore.click({ noWaitAfter: true });
              session.chilternArrivalModeSelected = true;
              return { action: 'wait', text: 'Set arrival time', stepName: 'chiltern-journey' };
            }
          }
        }
        if (session.chilternArrivalModeSelected && !session.chilternArrivalTimeSelected) {
          const clock = page.locator('button').filter({ hasText: /^\d{2}:\d{2}$/ }).last();
          if (await clock.count()) {
            await clock.click({ noWaitAfter: true });
            await page.waitForTimeout(100);
            const wantedTime = `${String(wantedHour).padStart(2, '0')}:00`;
            const option = page.getByText(wantedTime, { exact: true }).last();
            if (await option.count()) {
              await option.click({ noWaitAfter: true });
              session.chilternArrivalTimeSelected = true;
              return { action: 'wait', text: `Set arrival by ${wantedTime}`, stepName: 'chiltern-journey' };
            }
          }
        }
        if (session.chilternArrivalModeSelected && session.chilternArrivalTimeSelected) {
          await done.click({ noWaitAfter: true });
          session.chilternDateDone = true;
          return { action: 'wait', text: 'Confirmed journey date and time', stepName: 'chiltern-journey' };
        }
      }
    }

    // The outbound calendar is now closed. Add the return journey and select a
    // same-night departure before the form is submitted. Chiltern exposes native
    // select controls here, which lets us set the option without guessing at a
    // visual menu state.
    if (returnJourney && !session.chilternReturnDone) {
      const returnToggle = page.locator('#qtt-widget-return-date-popup-toggle').first();
      const returnTime = page.locator('#qtt-widget-return-calendar-departure-time').first();
      const returnMode = page.locator('#qtt-widget-return-calendar-travel-option').first();
      if (await returnToggle.count() && !(await returnTime.count())) {
        await returnToggle.click({ noWaitAfter: true });
        await page.waitForTimeout(150);
        return { action: 'wait', text: 'Adding return journey', stepName: 'chiltern-return' };
      }
      if (await returnMode.count() && (await returnMode.inputValue().catch(() => '')) !== 'depart_after') {
        await returnMode.selectOption('depart_after');
        return { action: 'wait', text: 'Set return departure time', stepName: 'chiltern-return' };
      }
      const wantedReturnTime = `${String(returnJourney.hour).padStart(2, '0')}:00`;
      if (await returnTime.count() && (await returnTime.inputValue().catch(() => '')) !== wantedReturnTime) {
        await returnTime.selectOption(wantedReturnTime);
        return { action: 'wait', text: `Set return after ${wantedReturnTime}`, stepName: 'chiltern-return' };
      }
      const done = page.getByText('Done', { exact: true }).last();
      if (await done.count()) {
        await done.click({ noWaitAfter: true });
        session.chilternReturnDone = true;
        session.chilternReturnAssumedHour = returnJourney.assumedHour;
        return { action: 'wait', text: 'Confirmed return journey', stepName: 'chiltern-return' };
      }
    }
  }

  // A live picker that we cannot yet resolve is for the vision fallback. Do not use the
  // test-only native-select probe below to click Done prematurely on its custom controls.
  if (liveChiltern) return null;

  // Unit-test fallback: test pages deliberately have no Playwright locators. The live path
  // above is the authoritative interaction, while this keeps the decision shape testable.
  if (wantedHour == null) return null;
  return page.evaluate(({ wantedHour, clickableSelector, probe }) => {
    const visible = el => {
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const text = el => String(el.innerText || el.getAttribute('aria-label') || el.value || '').replace(/\s+/g, ' ').trim();
    const all = [...document.querySelectorAll(clickableSelector)];
    const selects = [...document.querySelectorAll('select')].filter(visible);
    const options = select => [...select.options].map(option => ({ label: text(option), value: option.value }));
    const selectedLabel = select => text(select.options[select.selectedIndex]);

    // The Chiltern date picker has a real Done button. Without it, this is the home form
    // and normal browsing should handle station autocomplete and opening the calendar.
    const done = all.find(el => visible(el) && /^done$/i.test(text(el)));
    if (!done) return { kind: 'missing' };

    const mode = selects.find(select => {
      const labels = options(select).map(option => option.label.toLowerCase());
      return labels.includes('depart after') && labels.includes('arrive before');
    });
    if (mode && !/^arrive before$/i.test(selectedLabel(mode))) {
      const arrive = options(mode).find(option => /^arrive before$/i.test(option.label));
      return { kind: 'select', locatorIndex: all.indexOf(mode), value: arrive.value, text: selectedLabel(mode) };
    }

    const wantedTime = `${String(wantedHour).padStart(2, '0')}:00`;
    const time = selects.find(select => options(select).some(option => new RegExp(`^${wantedTime}$`).test(option.label)));
    if (time) {
      const choice = options(time).find(option => option.label === wantedTime)
        || options(time).find(option => option.label.startsWith(`${String(wantedHour).padStart(2, '0')}:`));
      if (choice && selectedLabel(time) !== choice.label) {
        return { kind: 'select', locatorIndex: all.indexOf(time), value: choice.value, text: selectedLabel(time) };
      }
    }
    return { kind: 'done', locatorIndex: all.indexOf(done), text: text(done) };
  }, { wantedHour, clickableSelector: clickable, probe: 'chilternJourney' }).then(move => {
    if (!move || move.kind === 'missing') return null;
    if (move.kind === 'select') return { action: 'select', locatorIndex: move.locatorIndex, value: move.value, text: move.text, stepName: 'chiltern-journey' };
    return { action: 'click', locatorIndex: move.locatorIndex, text: move.text, stepName: 'chiltern-journey' };
  }).catch(() => null);
}

// CLICKABLE_SELECTOR is owned by browser-task.js; keep one copy here that MUST equal it.
// (Task 5 asserts they're identical so a future edit to one can't silently diverge.)
const CLICKABLE_SELECTOR = 'button, a, input, textarea, label, select, [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="combobox"]';

const recipeHealth = createRecipeHealth();

// The executor. Returns a move for the loop to execute, or null → vision fallback.
function selectRecipeForHost(host) {
  if (RECIPES[host]) return RECIPES[host];
  if (isDeliveryHost(host)) return DELIVERY;
  return CONVENTION;
}

async function nextRecipeMove(page, session, recipe, health = recipeHealth) {
  const host = hostOfRecipe(recipe, (session && session.site) || 'unknown');
  const ctx = await readCtx(page, recipe, session);
  const wantSize = parseSizeFromGoal(`${session?.goal || ''} ${(session?.history || []).join(' ')}`, session?.goalContext);
  // Once the page reports the requested size as selected, do not run the preflight resolver
  // again. John Lewis keeps the size chips in the DOM after a ?size= navigation, so the old
  // condition clicked the same size twice and burned a second recipe step/model fallback.
  if (wantSize && !ctx.basketCount && ctx.hasUnsatisfiedSize) {
    const phaseNow = phaseFromUrl(recipe, page.url());
    const sizeStep = recipe.steps.find((s) => s.name === 'size' && s.phase === phaseNow && s.resolve);
    if (sizeStep && (!sizeStep.when || sizeStep.when(ctx))) {
      const move = await sizeStep.resolve({ page, session, recipe, ctx, clickable: CLICKABLE_SELECTOR });
      if (move) { health.recordHit(host, sizeStep.name); return move; }
    }
  }
  // Delivery: item modal takes priority — URL doesn't change when a modal opens.
  if (recipe.isDelivery && ctx.dialogOpen) {
    const modalStep = selectStep(recipe, 'modal', ctx, health, host);
    if (modalStep) {
      if (modalStep.resolve) {
        const move = await modalStep.resolve({ page, session, recipe, ctx, clickable: CLICKABLE_SELECTOR });
        if (move) { health.recordHit(host, modalStep.name); return move; }
      } else if (modalStep.selectorAny) {
        const hit = await resolveSelectorIndex(page, modalStep.selectorAny, CLICKABLE_SELECTOR, `resolve:${modalStep.name}`);
        if (hit) { health.recordHit(host, modalStep.name); return { action: modalStep.action, locatorIndex: hit.locatorIndex, text: hit.text, stepName: modalStep.name }; }
      }
      health.recordMiss(host, modalStep.name);
    }
  }
  // Universal upsell-dismiss: fires for all retail recipes (not delivery) before phase dispatch.
  // Catches post-add drawers like Currys' Care & Repair / accessories cross-sell that block
  // the "Go to basket" affordance. Max 3 dismissals per session; resolveUpsellDismiss gives up
  // after that and falls through to vision.
  if (!recipe.isDelivery && ctx.upsellModalOpen && (session?.upsellDismissCount || 0) < 3) {
    const move = await resolveUpsellDismiss({ page, session, recipe, ctx, clickable: CLICKABLE_SELECTOR });
    if (move) { health.recordHit(host, 'upsell-dismiss'); return move; }
    health.recordMiss(host, 'upsell-dismiss');
  }
  const phase = phaseFromUrl(recipe, page.url());
  if (!phase) return null;
  let step = null;
  for (const candidate of recipe.steps) {
    if (candidate.phase !== phase) continue;
    if (candidate.name === 'guest' && session?.guestCheckoutDone) continue;
    if (candidate.when && !candidate.when(ctx)) continue;
    if (health && health.isDisabled(host, candidate.name)) continue;
    step = candidate;
    break;
  }
  if (!step && phase === 'product' && ctx.basketCount > 0 && recipe.basketUrl) {
    step = recipe.steps.find((s) => s.name === 'go-to-basket' && s.phase === 'product');
  }
  if (!step) return null;

  // Stall guard: a step can resolve to a move every turn (the selector keeps finding the
  // button) while the site silently rejects the click — e.g. a retailer's own "technical
  // problem, please refresh" banner swallows "Add to basket" and basketCount never moves.
  // recordHit above only proves the selector matched, not that the click did anything, so
  // that alone can loop forever. If we're about to hand back the exact same step on the
  // exact same page state (same URL + basketCount) we already returned last time, treat it
  // as a miss instead and let vision see the page and react.
  // Trainline's journey recipe is one named step with several material stages
  // (fill origin → choose origin → fill destination → choose destination). Include that
  // internal stage so the generic repeat guard does not abandon it midway through a valid
  // autocomplete interaction.
  const recipeStage = session?.trainlineJourneyStage || '';
  const stallSignature = `${host}:${step.name}:${page.url()}:${ctx.basketCount}:${recipeStage}`;
  // The Trainline journey resolver is its own bounded state machine: a successful
  // autocomplete commit can take several render frames before the accessible name flips
  // to "selected". Applying the generic same-stage click guard here disables the recipe
  // before that acknowledgement arrives. Its outer task watchdog remains the backstop.
  if (session && host !== 'thetrainline.com') {
    if (session._recipeStallSig === stallSignature) {
      session._recipeStallCount = (session._recipeStallCount || 0) + 1;
    } else {
      session._recipeStallSig = stallSignature;
      session._recipeStallCount = 0;
    }
    if (session._recipeStallCount >= 2) {
      health.recordMiss(host, step.name);
      return null;
    }
  }

  if (step.resolve) {
    // Escape hatch: the step supplies its own move (may be an "ask", which is a real move,
    // not a miss). Only a null return — the step couldn't resolve — counts as a miss.
    const move = await step.resolve({ page, session, recipe, ctx, clickable: CLICKABLE_SELECTOR });
    if (move) { health.recordHit(host, step.name); return move; }
  } else if (step.selectorAny) {
    const hit = await resolveSelectorIndex(page, step.selectorAny, CLICKABLE_SELECTOR, `resolve:${step.name}`);
    if (hit) { health.recordHit(host, step.name); return { action: step.action, locatorIndex: hit.locatorIndex, text: hit.text, stepName: step.name }; }
  }
  health.recordMiss(host, step.name);
  return null;
}

// Find the host key a recipe is registered under. Falls back to `fallback` for the GENERIC
// recipe (which isn't in RECIPES), letting health be tracked per actual site host.
function hostOfRecipe(recipe, fallback = 'unknown') {
  for (const [host, r] of Object.entries(RECIPES)) if (r === recipe) return host;
  return fallback;
}

module.exports = {
  parseSizeFromGoal, matchSizeChip, parseTrainlineJourney, parseTrainlineDate, parseTrainlineArrivalHour, parseTrainReturn, johnLewisSizeQueryValue, GENERIC, CONVENTION, DELIVERY, SHOPIFY, RECIPES,
  resolveNavigateBasket, resolveUpsellDismiss, resolveEmailFill, resolveShopifyCheckout,
  resolveTrainlineJourney, resolveTrainlineDate, resolveChilternJourney,
  UPSELL_DISMISS_PATTERN,
  phaseFromUrl, createRecipeHealth, selectStep, selectRecipeForHost,
  RECIPE_FAIL_DISABLE_THRESHOLD, nextRecipeMove, resolveSizeMove, recipeHealth, CLICKABLE_SELECTOR,
  isJohnLewisExpressOnlyPdp, readCtx,
};

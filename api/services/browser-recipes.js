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
// patterns for size→add→basket→checkout. Vision still picks the product; recipe drives the tail.
const CONVENTION = {
  phases: {
    product:  (u) => /\/(?:p\/|product\/|products\/|item\/|sku\/|pd\/|dp\/|p\d+(?:\/|$))/i.test(u.pathname),
    checkout: (u) => /\/(?:checkout|order|pay(?:ment)?|purchase)\b/i.test(u.pathname),
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
    { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, action: 'click', selectorAny: [
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
      'text=Basket',
      'text=Bag',
      'text=Cart',
    ] },
    { phase: 'cart', name: 'checkout', action: 'click', selectorAny: [
      'text=Proceed to Checkout',
      'text=Go to checkout',
      'text=Checkout securely',
      'text=Continue to checkout',
      'text=Secure checkout',
      'text=Checkout',
    ]},
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
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, resolve: (a) => resolveJohnLewisAdd(a) },
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
      { phase: 'checkout', name: 'guest', when: (ctx) => !ctx.isGuestEmailSubmit && !ctx.checkoutPastEmail, action: 'click', selectorAny: [
        'text=Guest checkout',
        'text=Checkout as a guest',
        'text=Continue as a guest',
        'text=Continue without an account',
      ] },
      { phase: 'checkout', name: 'advance', when: (ctx) => ctx.checkoutPastEmail && !ctx.isGuestEmailSubmit, action: 'click', selectorAny: [
        'text=Continue to delivery',
        'text=Continue to payment',
        'text=Save and continue',
        'text=Continue to billing',
      ] },
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
      { phase: 'checkout', name: 'advance', when: (ctx) => ctx.checkoutPastEmail && !ctx.isGuestEmailSubmit, action: 'click', selectorAny: [
        'text=Continue to delivery',
        'text=Continue to payment',
        'text=Save and continue',
        'text=Continue to billing',
      ] },
      { phase: 'basket', name: 'guest', action: 'click', selectorAny: [
        'text=Guest checkout',
        'text=Checkout as a guest',
        'text=Continue as a guest',
      ] },
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, action: 'click', selectorAny: [
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
      { phase: 'checkout', name: 'advance', when: (ctx) => ctx.checkoutPastEmail && !ctx.isGuestEmailSubmit, action: 'click', selectorAny: [
        'text=Continue to delivery',
        'text=Continue to payment',
        'text=Save and continue',
        'text=Continue to billing',
      ] },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, action: 'click', selectorAny: [
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
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, action: 'click', selectorAny: [
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
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, action: 'click', selectorAny: [
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
      { phase: 'checkout', name: 'advance', when: (ctx) => ctx.checkoutPastEmail && !ctx.isGuestEmailSubmit, action: 'click', selectorAny: [
        'text=Continue to delivery',
        'text=Continue to payment',
        'text=Save and continue',
        'text=Continue to billing',
      ] },
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, action: 'click', selectorAny: [
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
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, action: 'click', selectorAny: [
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
      container: ['[id*="size" i]', '[class*="size" i]', 'select[id*="size" i]', '[data-testid*="size" i]'],
      chip:      ['[id*="size" i] button', '[class*="size" i] button', 'select[id*="size" i] option', '[data-testid*="size" i] button'],
      selected:  ['[class*="selected" i][class*="size" i]', '[aria-checked="true"]', 'select[id*="size" i] option:checked'],
      basketBadge: ['[data-testid="bag-item-count"]', 'a[href*="/bag"]', '[data-testid="bag-link"]'],
    },
    steps: [
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, resolve: (a) => resolveSizeMove(a) },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, action: 'click', selectorAny: [
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
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, action: 'click', selectorAny: [
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
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount, action: 'click', selectorAny: [
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
async function readCtx(page, recipe) {
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
      // JL often shows a post-add "View basket" interstitial before the header badge ticks up.
      if (basketCount === 0) {
        for (const el of document.querySelectorAll('a, button')) {
          const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
          if (!/^view basket$/i.test(t)) continue;
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
  return ctx || {
    hasUnsatisfiedSize: false, basketCount: 0, flyoutOpen: false, dialogOpen: false,
    needsCollectionPostcode: false, needsScrewfixFulfillment: false,
    checkoutEmailVisible: false, checkoutIdentityFields: 0, isGuestEmailSubmit: false, checkoutPastEmail: false,
  };
}

// Resolve a step's selectorAny to a { locatorIndex, text }, choosing the first candidate that
// maps to a VISIBLE, ENABLED element (locatorIndex = index into querySelectorAll(CLICKABLE_SELECTOR)).
// null if none match. `text` lets the loop apply the payment guardrail + write history without a
// re-read. CLICKABLE_SELECTOR must match browser-task.js's constant — passed in so there's one source.
async function resolveSelectorIndex(page, selectorAny, clickableSelector, tag) {
  return page.evaluate(({ probe, selectorAny, clickableSelector }) => {
    void probe;
    const all = Array.from(document.querySelectorAll(clickableSelector));
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const sel of selectorAny) {
      let node = null;
      if (sel.startsWith('text=')) {
        // Native exact-text candidate (case-insensitive, trimmed). Replaces Playwright's
        // :has-text pseudo — which document.querySelector cannot parse — and exact-matches so
        // "Add to basket" never picks a carousel "Add to basket , <product>" recommendation.
        const want = sel.slice(5).trim().toLowerCase();
        node = all.find((el) => visible(el) && (el.innerText || '').trim().toLowerCase() === want) || null;
      } else {
        let match;
        try { match = document.querySelector(sel); } catch { continue; }
        if (match && visible(match)) node = match.closest(clickableSelector) || match;
      }
      if (!node) continue;
      const idx = all.indexOf(node);
      if (idx !== -1) {
        const text = (node.innerText || node.getAttribute('aria-label') || node.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        return { locatorIndex: idx, text };
      }
    }
    return null;
  }, { probe: tag, selectorAny, clickableSelector });
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
    'text=Add to basket',
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
    const all = Array.from(document.querySelectorAll(clickableSelector));
    const out = [];
    for (const sel of chipSel) {
      for (const el of document.querySelectorAll(sel)) {
        const label = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().split(/\n/)[0].trim();
        const idx = all.indexOf(el.closest(clickableSelector) || el);
        if (label && idx !== -1) out.push({ label, idx });
      }
      if (out.length) break; // first selector that yields chips wins
    }
    return out;
  }, { probe: 'sizeChips', chipSel: recipe.size.chip, clickableSelector: clickable });
  const pick = matchSizeChip(want, chips.map((c) => c.label));
  if (pick == null) return null; // asked-for size not offered → vision/ask fallback
  return { action: 'click', locatorIndex: chips[pick].idx, text: chips[pick].label, stepName: 'size' };
}

// CLICKABLE_SELECTOR is owned by browser-task.js; keep one copy here that MUST equal it.
// (Task 5 asserts they're identical so a future edit to one can't silently diverge.)
const CLICKABLE_SELECTOR = 'button, a, input, textarea, label, [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="combobox"]';

const recipeHealth = createRecipeHealth();

// The executor. Returns a move for the loop to execute, or null → vision fallback.
function selectRecipeForHost(host) {
  if (RECIPES[host]) return RECIPES[host];
  if (isDeliveryHost(host)) return DELIVERY;
  return CONVENTION;
}

async function nextRecipeMove(page, session, recipe, health = recipeHealth) {
  const host = hostOfRecipe(recipe, (session && session.site) || 'unknown');
  const ctx = await readCtx(page, recipe);
  const wantSize = parseSizeFromGoal(`${session?.goal || ''} ${(session?.history || []).join(' ')}`, session?.goalContext);
  if (wantSize && !ctx.basketCount) {
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
  parseSizeFromGoal, matchSizeChip, johnLewisSizeQueryValue, GENERIC, CONVENTION, DELIVERY, RECIPES,
  resolveNavigateBasket,
  phaseFromUrl, createRecipeHealth, selectStep, selectRecipeForHost,
  RECIPE_FAIL_DISABLE_THRESHOLD, nextRecipeMove, resolveSizeMove, recipeHealth, CLICKABLE_SELECTOR,
  isJohnLewisExpressOnlyPdp,
};

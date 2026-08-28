'use strict';
// Curated site knowledge, not an executor.
//
// These records describe page phases and labels historically observed on individual sites.
// The general agent receives them as hints and still acts exclusively through browser_open,
// browser_observe and browser_act. No recipe reads a page, chooses a next move, clicks, fills,
// or owns retry state.

const { isDeliveryHost } = require('./retailer-sites');

const STANDARD_GUEST_SELECTORS = [
  'text=Guest checkout',
  'text=Checkout as a guest',
  'text=Continue as a guest',
  'text=Continue without an account',
];

const CHECKOUT_ADVANCE_SELECTORS = [
  'text=Continue to delivery',
  'text=Continue to payment',
  'text=Save and continue',
  'text=Continue to billing',
];

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
// product; the agent decides each subsequent browser action from observation.
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
    { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize },
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
    { phase: 'checkout', name: 'fill-email', when: (ctx) => ctx.checkoutEmailVisible && !ctx.isGuestEmailSubmit && !ctx.checkoutPastEmail },
    { phase: 'checkout', name: 'advance', when: (ctx) => ctx.checkoutPastEmail && !ctx.isGuestEmailSubmit, action: 'click', selectorAny: CHECKOUT_ADVANCE_SELECTORS },
  ],
};

// Shopify is a platform fact. Its checkout controls remain ordinary browser controls.
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
    { phase: 'checkout', name: 'shopify-checkout' },
  ],
};

// Delivery-site recipe: commit items from the item-options modal (Uber Eats / Deliveroo / Just Eat).
const DELIVERY = {
  isDelivery: true,
  phases: {
    modal: (u) => true,
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
      { phase: 'journey', name: 'trainline-journey' },
    ],
  },

  'chilternrailways.co.uk': {
    phases: { journey: () => true },
    size: { container: [], chip: [], selected: [] },
    steps: [
      { phase: 'journey', name: 'chiltern-journey' },
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
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        'a[data-testid="size:option:button"]',
      ] },
      // Only add while nothing is in the basket yet, so this doesn't re-fire once the item's in.
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        'text=Add to basket',
      ] },
      // Once the item is in the basket, go to the basket page via the header anchor (or a
      // "View basket" affordance from the add interstitial).
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0, action: 'click', selectorAny: [
        '[data-testid="basket-anchor"]',
        'text=View basket',
        'text=Basket',
      ] },
      { phase: 'basket', name: 'checkout', action: 'click', selectorAny: [
        'text=Checkout',
        'text=Secure checkout',
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
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        '#add-to-bag-button',
        'text=Add to bag',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0 },
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
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0 },
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
      { phase: 'product', name: 'fulfillment', when: (ctx) => ctx.needsScrewfixFulfillment && !ctx.basketCount },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        '#add_to_basket_btn',
        '[id*="addToBasket" i]',
        'text=Add to basket',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0 },
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
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        '[data-qa="atb-button"]',
        'text=Add to Bag',
        'text=Add to bag',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0 },
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
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        'text=Add to bag',
        '[data-testid*="add-to-bag" i]',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0 },
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
      { phase: 'product', name: 'collection', when: (ctx) => ctx.needsCollectionPostcode },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        'text=Add to basket',
        '[id*="addToBasket" i]',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0 },
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
      { phase: 'product', name: 'size', when: (ctx) => ctx.hasUnsatisfiedSize },
      { phase: 'product', name: 'add', when: (ctx) => !ctx.basketCount && !ctx.hasUnsatisfiedSize, action: 'click', selectorAny: [
        '[data-testid="addToBag"]',
        'text=Add to bag',
        'text=Add to Bag',
      ] },
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0 },
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
      { phase: 'product', name: 'go-to-basket', when: (ctx) => ctx.basketCount > 0 },
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



function phaseFromUrl(recipe, url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  for (const [name, predicate] of Object.entries(recipe?.phases || {})) {
    if (predicate(parsed)) return name;
  }
  return null;
}

function selectRecipeForHost(host) {
  if (RECIPES[host]) return RECIPES[host];
  if (isDeliveryHost(host)) return DELIVERY;
  return CONVENTION;
}

module.exports = { GENERIC, CONVENTION, DELIVERY, SHOPIFY, RECIPES, phaseFromUrl, selectRecipeForHost };

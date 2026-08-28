'use strict';
// Platform-API commerce tier: a handful of e-commerce platforms expose a public JSON API for
// search and cart, so the search → pick size → add portion of the loop becomes two HTTP calls
// with no clicking, screenshots or bot-wall exposure. Checkout is untouched — once the cart is
// populated the same Playwright context navigates to the cart URL and the cart cookie carries
// over. Shopify only: WooCommerce and the rest need different detection and auth shapes.

// Consistent across themes: the `Shopify` global, the CDN asset host, and most reliably a
// working `/products.json` — a theme can strip the global but not disable the storefront API.
async function detectShopify(requestCtx, origin) {
  try {
    const res = await requestCtx.get(`${origin}/products.json?limit=1`, { timeout: 8000 });
    if (!res.ok()) return false;
    const body = await res.json().catch(() => null);
    return Boolean(body && Array.isArray(body.products));
  } catch {
    return false;
  }
}

// Shopify variant option values are free text set by the merchant ("10", "UK 10", "Medium",
// "M") — normalize both sides before comparing so "UK 10" (goal) matches "10" (option).
function normalizeOption(v) {
  return String(v || '').toLowerCase().replace(/^uk\s*/, '').trim();
}

// Spelled-out clothing sizes ↔ the single-letter option values merchants actually use.
const SIZE_WORD_TO_LETTER = {
  'extra small': 'xs', 'x-small': 'xs', 'xsmall': 'xs',
  small: 's', medium: 'm', large: 'l',
  'extra large': 'xl', 'x-large': 'xl', 'xlarge': 'xl', 'extra extra large': 'xxl',
};

// Does a normalized variant option value satisfy the wanted size? Handles three real shapes:
//  1. exact ("m" === "m", "9" === "9");
//  2. a letter option that carries a fit note — "m (w8-10 / m8)" — matched on its leading token;
//  3. a spelled-out goal ("medium") mapped to the letter the option uses ("m").
// Deliberately strict on numerics: "9" must not match "9.5" (leading token compare, no prefix).
function sizeMatches(optNorm, wantNorm) {
  if (!optNorm || !wantNorm) return false;
  const wants = new Set([wantNorm, SIZE_WORD_TO_LETTER[wantNorm]].filter(Boolean));
  const optHead = optNorm.split(/[\s/(]+/)[0]; // "m (w8-10 / m8)" -> "m", "9" -> "9"
  return wants.has(optNorm) || wants.has(optHead);
}

function pickVariant(product, goalContext) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const wantSize = goalContext && goalContext.size ? normalizeOption(goalContext.size) : null;
  const wantColor = goalContext && goalContext.color ? normalizeOption(goalContext.color) : null;

  const available = variants.filter(v => v.available !== false);
  const pool = available.length ? available : variants;
  if (!pool.length) return null;
  if (!wantSize && !wantColor) return pool.length === 1 ? pool[0] : null; // ambiguous, let the ask flow handle it

  const scored = pool.map(v => {
    const opts = [v.option1, v.option2, v.option3].map(normalizeOption).filter(Boolean);
    let score = 0;
    if (wantSize && opts.some(o => sizeMatches(o, wantSize))) score += 2;
    if (wantColor && opts.some(o => o.includes(wantColor) || wantColor.includes(o))) score += 1;
    return { v, score };
  }).sort((a, b) => b.score - a.score);

  // Size is the hard requirement; color is only a tiebreaker, since it is often folded into the
  // product title (and already scored there) rather than exposed as a variant option.
  const need = wantSize ? 2 : 0;
  return scored[0] && scored[0].score >= need ? scored[0].v : null;
}

// Search + score using the SAME relevance scorer the vision loop already uses for search
// results (scoreProductNameVsGoal, browser-task.js) — one scoring policy, not two divergent
// ones that could disagree about which product a goal means.
async function resolveAndAddToCart(requestCtx, origin, goal, goalContext, scoreFn) {
  const query = (goalContext && goalContext.searchTerm) || goal;
  const searchUrl = `${origin}/products.json?limit=50`;
  let products;
  try {
    const res = await requestCtx.get(searchUrl, { timeout: 10000 });
    if (!res.ok()) return { ok: false, reason: `products.json ${res.status()}` };
    const body = await res.json();
    products = Array.isArray(body.products) ? body.products : [];
  } catch (err) {
    return { ok: false, reason: `products.json fetch failed: ${err.message}` };
  }
  if (!products.length) return { ok: false, reason: 'no products returned' };

  const scored = products
    .map(p => ({ p, score: scoreFn(p.title, goal) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { ok: false, reason: 'no relevant product match' };

  const product = scored[0].p;
  const variant = pickVariant(product, goalContext);
  if (!variant) {
    return {
      ok: false,
      reason: 'variant ambiguous',
      needsAsk: true,
      product: { title: product.title, handle: product.handle },
      options: (product.variants || []).map(v => [v.option1, v.option2, v.option3].filter(Boolean).join(' / '))
    };
  }

  try {
    const addRes = await requestCtx.post(`${origin}/cart/add.js`, {
      timeout: 10000,
      data: { id: variant.id, quantity: 1 },
      headers: { 'Content-Type': 'application/json' }
    });
    if (!addRes.ok()) return { ok: false, reason: `cart/add.js ${addRes.status()}` };
  } catch (err) {
    return { ok: false, reason: `cart/add.js fetch failed: ${err.message}` };
  }

  return {
    ok: true,
    product: { title: product.title, handle: product.handle },
    variant: { id: variant.id, title: [variant.option1, variant.option2, variant.option3].filter(Boolean).join(' / ') },
    // /checkout (not /cart) — one fewer page for a marketing popup to intercept the loop on,
    // and Shopify honours the existing cart-session cookie there same as it does on /cart.
    cartUrl: `${origin}/cart`,
    checkoutUrl: `${origin}/checkout`
  };
}


// ── Product matching ────────────────────────────────────────────────────────────────────
// Domain knowledge, not architecture: a table of qualifier words and a scoring rule with no
// control flow. The platform-API tier takes it as a parameter so there is only one policy.

// Score a product name against the goal: goal words in the name score, differentiator words
// not in the goal ("Pro Max", "Wholesale") penalise. Single words only — each name word is
// tested alone after splitting on \W+, so a phrase like "case of" can never match — and never
// words too generic to punish on their own ("case", "pack" are ordinary product words).
const PRODUCT_DIFFERENTIATORS = /\b(pro\s*max|pro|max|ultra|plus|lite|mini|se|air|junior|premium|deluxe|standard|classic|base|wholesale|bulk)\b/i;

// A bare number or number+unit (256gb, 65in) proves nothing — two unrelated products can both
// be "256GB". Only a shared alphabetic word counts as evidence they are the same thing.
const GENERIC_SPEC_WORD = /^\d+[a-z]*$/i;

// A model number with a letter fused to it ("17e") is a different variant, just like "Pro" or
// "Max" — but as a token it equals neither "17" nor any differentiator word, so without this
// it scores positive against a goal asking for the plain model.
const SUFFIXED_MODEL_WORD = /^(\d{1,3})([a-z])$/i;

// The apparel analogue of PRODUCT_DIFFERENTIATORS: a goal naming the base line never means the
// waterproof/mid/trail variant, whose extra qualifiers are otherwise invisible to the scorer.
// A goal that does name one matches through goalWords before this branch. Distinctive model
// words only — "high", "low", "up" are ordinary product words, same caveat as above.
const MODEL_QUALIFIERS = /^(nz|mid|mizzle|waterproof|weatherproof|trail)$/i;

// Gender is a product axis like tier, but only penalised when the goal actually specifies one.
// \bmen\b doesn't match inside "women", so the two regexes are independent and a name with
// both or neither yields null.
function detectGender(s) {
  const t = String(s || '').toLowerCase();
  const female = /\b(women|womens|woman|womans|female|ladies|girls?)\b/.test(t);
  const male = /\b(men|mens|man|mans|male|boys?)\b/.test(t);
  if (female && !male) return 'female';
  if (male && !female) return 'male';
  return null;
}

// Trailing-s stemming, so a singular goal ("towel") matches a plural listing ("towels") instead
// of tying with something sharing only a generic word. "ss" endings are left alone.
function stemWord(w) {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

function scoreProductNameVsGoal(name, goal) {
  if (!name || !goal) return 0;
  const words = (s) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 1).map(stemWord));
  const goalWords = words(goal);
  const nameWords = words(name);
  let score = 0;
  let hasCoreMatch = false;
  let hasUnrequestedVariant = false;
  for (const w of nameWords) {
    if (goalWords.has(w)) {
      score += 2;
      if (!GENERIC_SPEC_WORD.test(w)) hasCoreMatch = true;
      continue;
    }
    const suffixed = w.match(SUFFIXED_MODEL_WORD);
    if (suffixed && goalWords.has(suffixed[1])) {
      hasUnrequestedVariant = true; // goal asked for plain "17", this is the "17e" tier
    } else if (PRODUCT_DIFFERENTIATORS.test(w) || MODEL_QUALIFIERS.test(w)) {
      hasUnrequestedVariant = true; // an unmentioned tier/model word (Pro/Max/NZ/Mid/...)
    }
  }
  // Gender contradiction (goal says one gender, name says the other) is an unrequested
  // variant just like a tier word. Only fires when the goal names a gender at all.
  const goalGender = detectGender(goal);
  const nameGender = detectGender(name);
  if (goalGender && nameGender && goalGender !== nameGender) hasUnrequestedVariant = true;
  // Both cases must land below the relevance floor rather than merely be discouraged: nothing
  // non-generic in common cannot be the same product, and an unrequested tier word can still
  // net positive on brand-plus-capacity overlap when it is the only candidate fetched.
  if (!hasCoreMatch || hasUnrequestedVariant) return Math.min(score, -1);
  return score;
}

module.exports = { detectShopify, pickVariant, resolveAndAddToCart, normalizeOption, scoreProductNameVsGoal };

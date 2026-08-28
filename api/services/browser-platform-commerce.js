'use strict';
// Platform-API commerce tier: most of "millions of sites" isn't millions of bespoke stacks —
// it's a handful of e-commerce platforms (Shopify, WooCommerce, ...) that expose a real,
// public JSON API for search + cart. Detecting the platform once and talking to that API
// directly replaces the search→click-size→click-add portion of the loop (the part that
// dominates flakiness and vision cost) with two HTTP calls and zero clicking, zero
// screenshots, zero bot-wall exposure. This does NOT touch checkout/payment — it hands off
// to the existing browser session (recipe/vision loop, checkout-profile autofill, payment
// guardrail) once the cart is populated, by navigating the same Playwright context to the
// cart URL so the platform's own cart cookie carries over.
//
// Shopify only for v1 — it's the single largest platform by independent-store count and has
// a stable, unauthenticated storefront API (`/products.json`, `/cart/add.js`) that's been
// public and unchanged for years. WooCommerce/Magento/BigCommerce are natural follow-ups but
// need different detection + auth shapes; not built here.

// Shopify's admin/theme footprint is consistent across storefronts regardless of theme:
// the `Shopify` global, the CDN asset host, and (most reliably) a working `/products.json`
// endpoint — themes can strip the JS global but can't disable the storefront API without
// losing normal site function.
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

  // Size is the hard requirement when given — color is only a tiebreaker bonus, never
  // required on its own, because color is frequently baked into the PRODUCT (already
  // matched by search/title scoring) rather than exposed as a separate variant option
  // (e.g. a single-option "Size" variant axis with color folded into the product title).
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
// Scoring a catalogue result against what was actually asked for. This is DOMAIN KNOWLEDGE,
// not execution architecture: a table of qualifier words and a scoring rule, with no control
// flow of its own. It lives next to its only caller rather than in a shared loop, and the
// platform-API tier takes it as a parameter so there is one scoring policy, not two.

// Score a product name against the goal for candidate ranking.
// Rewards goal words present in name; penalises differentiator words in name that aren't
// in the goal (e.g. "Pro Max" in name but not goal → negative score).
// wholesale/bulk added after a live WooCommerce catch (2026-07-11): "Wholesale Issue 60" and
// "Issue 60" share every goal word for "buy issue 60 magazine" (neither was in the original
// gadget-tier list), so they tied and the bulk/trade listing won on list order — a shopper
// asking for one issue never means a case. Kept to single words only: this function tests
// each NAME WORD individually after splitting on \W+, so a phrase like "case of" could never
// actually match here (each half is tested alone) — don't add multi-word phrases without
// accounting for that, and avoid words too generic to safely penalize alone (e.g. "case",
// "pack" are legitimate parts of many real product names).
const PRODUCT_DIFFERENTIATORS = /\b(pro\s*max|pro|max|ultra|plus|lite|mini|se|air|junior|premium|deluxe|standard|classic|base|wholesale|bulk)\b/i;

// A bare number or number+unit (256gb, 128gb, 5g, 65in) is too generic to prove two
// products are related — a Nintendo Switch and an iPhone can both be "256GB". Only an
// alphabetic word match (a shared brand/product noun like "iphone") counts as proof the
// candidate is actually the same kind of thing.
const GENERIC_SPEC_WORD = /^\d+[a-z]*$/i;

// A model number with a single-letter suffix (16e, 17e — Apple's cheaper tier, fused to
// the digits so it never equals the plain "17" token) is a different variant, exactly like
// "Pro"/"Max" being separate words. Regression: a live run's fastpath landed on "iPhone
// 17e, 256GB" for a goal that said plain "iPhone 17 256GB" — since "17e" !== "17" as a
// token, neither the match bonus nor PRODUCT_DIFFERENTIATORS caught it, so it slipped
// through with a positive score and nothing to out-rank it.
const SUFFIXED_MODEL_WORD = /^(\d{1,3})([a-z])$/i;

// Footwear/apparel base-vs-variant model qualifiers, the PRODUCT_DIFFERENTIATORS analogue
// for clothing. Regression (2026-07-13 allbirds trace): "order the Wool Runner shoes"
// tied the plain "Men's Wool Runner" against "Women's Wool Runner NZ Mid Waterproof" at
// score 4 — both share only "wool"+"runner", and the extra NZ/Mid/Waterproof qualifiers
// were invisible to the scorer, so platform-add could silently cart the wrong shoe. A goal
// asking for the base line never means the NZ/Mid/Mizzle/waterproof/trail variant; if the
// goal DOES name one of these it lands in goalWords and matches (scored, not penalized)
// before this branch is reached. Kept to distinctive model words only — "up" (Runner-up),
// "high", "low" are deliberately excluded, too common as ordinary product words to penalize
// blind, exactly like the "case"/"pack" caveat on PRODUCT_DIFFERENTIATORS above.
const MODEL_QUALIFIERS = /^(nz|mid|mizzle|waterproof|weatherproof|trail)$/i;

// Gender is a product axis like tier: "Men's Wool Runner" and "Women's Wool Runner" are
// different products. Penalize a name whose gender contradicts the goal's, but ONLY when
// the goal actually specifies one — a gender-neutral goal ("the Wool Runner shoes") must
// not punish either gender. Note \bmen\b does not match inside "women" (no word boundary
// before the 'm'), so the two regexes are independent; a name with both words (rare) or
// neither yields null and never triggers a penalty.
function detectGender(s) {
  const t = String(s || '').toLowerCase();
  const female = /\b(women|womens|woman|womans|female|ladies|girls?)\b/.test(t);
  const male = /\b(men|mens|man|mans|male|boys?)\b/.test(t);
  if (female && !male) return 'female';
  if (male && !female) return 'male';
  return null;
}

// Regression: John Lewis search for "plain white bath towel" picked "...Bath Mat" over the
// actual "...Towels" listing — "towel" (goal, singular) never matched "towels" (name, plural)
// with a bare word-set comparison, while "mat" tied on the shared generic word "bath". Cheap
// trailing-s stemming (not a real morphological analyzer) closes that gap; "ss" endings
// (glass/class) are left alone so they don't get mangled into "glas"/"clas".
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
  // Regression: "Nintendo Switch 2, 256GB Console" scored positively against "iPhone 17
  // 256GB" purely on the shared "256gb" token and got treated as a valid candidate.
  // Without any non-generic word in common, this can't be the same product.
  // Second regression: a candidate carrying an unrequested tier word ("Pro"/"Max"/"17e")
  // can still rack up enough generic-word overlap (brand + capacity) to net positive even
  // after a flat penalty, and — when it's the ONLY candidate fetched that run — nothing
  // else was around to out-rank it. Either case must force the score below the
  // pickFallbackCandidate/orderable relevance floor (score > 0), not just discourage it.
  if (!hasCoreMatch || hasUnrequestedVariant) return Math.min(score, -1);
  return score;
}

module.exports = { detectShopify, pickVariant, resolveAndAddToCart, normalizeOption, scoreProductNameVsGoal };

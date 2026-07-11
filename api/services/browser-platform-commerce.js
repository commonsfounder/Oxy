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
    if (wantSize && opts.some(o => o === wantSize)) score += 2;
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

module.exports = { detectShopify, pickVariant, resolveAndAddToCart, normalizeOption };

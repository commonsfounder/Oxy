'use strict';
// Platform-API commerce tier for WooCommerce — the same idea as browser-platform-commerce.js
// does for Shopify, on what is probably the largest platform by site count.
//
// Uses the public, unauthenticated Store API (/wp-json/wc/store/v1/*) that the Cart/Checkout
// blocks call from a customer's own browser, not the /wc/v3/* admin API, which needs merchant
// credentials. The shapes below are confirmed against a real store, not assumed from docs:
//   - products?per_page=1 is the detection probe.
//   - products?per_page=50, never ?search= — Woo's search is literal enough that a goal
//     sentence returns nothing, so list and score locally with the shared scorer. Variations
//     are embedded in each product, so no per-product call.
//   - Prices are minor-unit strings; divide by currency_minor_unit.
//   - GET cart returns a `nonce` RESPONSE HEADER that must be echoed back as the `Nonce`
//     request header on the add. Shopify has no equivalent step.
//   - POST cart/add-item with { id, quantity } — the variation id, or the product id for a
//     simple product — returns 201 on success.

async function detectWooCommerce(requestCtx, origin) {
  try {
    const res = await requestCtx.get(`${origin}/wp-json/wc/store/v1/products?per_page=1`, { timeout: 8000 });
    if (!res.ok()) return false;
    const body = await res.json().catch(() => null);
    return Array.isArray(body);
  } catch {
    return false;
  }
}

function normalizeOption(v) {
  return String(v || '').toLowerCase().replace(/^uk\s*/, '').trim();
}

// WordPress/WooCommerce product titles come through HTML-entity-encoded (e.g. "&#8211;" for
// an en dash) — verified live (woocommerce.com, 2026-07-11: "ProfitSync &#8211; Profit, COGS
// and Expense Tracker"). Decode the common cases rather than showing raw entities to the
// user; no existing decoder utility in this codebase to reuse.
const HTML_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, name) => HTML_ENTITIES[name]);
}

function minorToDisplay(minorStr, minorUnit, symbol) {
  const n = Number(minorStr);
  if (!Number.isFinite(n)) return '';
  const amount = (n / Math.pow(10, minorUnit || 2)).toFixed(minorUnit || 2);
  return `${symbol || ''}${amount}`;
}

// A variable product's `variations` entries carry {id, attributes: [{name, value}]} but NOT
// their own stock/availability in the products-list response — WooCommerce exposes that on
// deeper endpoints this tier deliberately skips (extra round-trip per candidate variation);
// the add-to-cart call itself is the authoritative stock check and fails cleanly if a
// specific variation turns out to be unavailable, same fail-safe shape as the Shopify tier.
function pickVariation(product, goalContext) {
  if (product.type !== 'variable') return { id: product.id, attributes: [] };
  const variations = Array.isArray(product.variations) ? product.variations : [];
  if (!variations.length) return null;

  const wantSize = goalContext && goalContext.size ? normalizeOption(goalContext.size) : null;
  const wantColor = goalContext && goalContext.color ? normalizeOption(goalContext.color) : null;
  if (!wantSize && !wantColor) return variations.length === 1 ? variations[0] : null;

  const scored = variations.map(v => {
    const opts = (v.attributes || []).map(a => normalizeOption(a.value)).filter(Boolean);
    let score = 0;
    if (wantSize && opts.some(o => o === wantSize)) score += 2;
    if (wantColor && opts.some(o => o.includes(wantColor) || wantColor.includes(o))) score += 1;
    return { v, score };
  }).sort((a, b) => b.score - a.score);

  const need = wantSize ? 2 : 0; // color is a soft tiebreaker only, same rationale as Shopify tier
  return scored[0] && scored[0].score >= need ? scored[0].v : null;
}

async function resolveAndAddToCart(requestCtx, origin, goal, goalContext, scoreFn) {
  // Never ?search=: Woo's search is literal enough that a goal sentence with its verb still in
  // it returns zero matches. List and score locally with scoreFn instead — one relevance
  // policy, no dependency on a store's own search quality.
  let products;
  try {
    const res = await requestCtx.get(`${origin}/wp-json/wc/store/v1/products?per_page=50`, { timeout: 10000 });
    if (!res.ok()) return { ok: false, reason: `products list ${res.status()}` };
    products = await res.json();
    if (!Array.isArray(products)) return { ok: false, reason: 'unexpected products response shape' };
  } catch (err) {
    return { ok: false, reason: `products list fetch failed: ${err.message}` };
  }
  if (!products.length) return { ok: false, reason: 'no products returned' };

  const scored = products
    .filter(p => p.is_purchasable !== false)
    .map(p => ({ p, score: scoreFn(p.name, goal) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { ok: false, reason: 'no relevant product match' };

  const product = scored[0].p;
  const variation = pickVariation(product, goalContext);
  if (!variation) {
    return {
      ok: false,
      reason: 'variant ambiguous',
      needsAsk: true,
      product: { title: decodeHtmlEntities(product.name), id: product.id },
      options: (product.variations || []).map(v => (v.attributes || []).map(a => a.value).join(' / '))
    };
  }

  let nonce;
  try {
    const cartRes = await requestCtx.get(`${origin}/wp-json/wc/store/v1/cart`, { timeout: 8000 });
    nonce = cartRes.headers()['nonce'];
    if (!nonce) return { ok: false, reason: 'no cart nonce returned — cannot add to cart safely' };
  } catch (err) {
    return { ok: false, reason: `cart nonce fetch failed: ${err.message}` };
  }

  try {
    const addRes = await requestCtx.post(`${origin}/wp-json/wc/store/v1/cart/add-item`, {
      timeout: 10000,
      data: { id: variation.id, quantity: 1 },
      headers: { 'Content-Type': 'application/json', 'Nonce': nonce }
    });
    if (!addRes.ok()) return { ok: false, reason: `cart/add-item ${addRes.status()}` };
  } catch (err) {
    return { ok: false, reason: `cart/add-item fetch failed: ${err.message}` };
  }

  const priceMinor = product.prices?.price;
  const price = priceMinor
    ? minorToDisplay(priceMinor, product.prices.currency_minor_unit, product.prices.currency_symbol)
    : '';

  return {
    ok: true,
    product: { title: decodeHtmlEntities(product.name), id: product.id },
    variant: { id: variation.id, title: (variation.attributes || []).map(a => a.value).join(' / ') },
    price,
    cartUrl: `${origin}/cart`,
    checkoutUrl: `${origin}/checkout`
  };
}

module.exports = { detectWooCommerce, pickVariation, resolveAndAddToCart, normalizeOption, minorToDisplay, decodeHtmlEntities };

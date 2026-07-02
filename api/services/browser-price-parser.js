'use strict';
// Tier-0 no-browser price lookup parser.
// Pure + unit-testable. Layered extraction:
// 1. schema.org/Product JSON-LD (offers.price / offers[0].price)
// 2. og:price:amount meta
// 3. microdata (itemprop=price content or text)
// Returns a normalized display price e.g. "£39.99" or null.

const CURRENCY_SYMBOL = {
  GBP: '£',
  USD: '$',
  EUR: '€',
  default: '£'
};

function getCurrencySymbol(code) {
  if (!code) return CURRENCY_SYMBOL.default;
  const up = String(code).trim().toUpperCase();
  return CURRENCY_SYMBOL[up] || up;
}

function normalizePrice(raw, currencyCode) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Already has a currency symbol — keep as-is (common in JSON-LD text)
  if (/[£$€]/.test(s)) {
    // clean up spaces etc.
    return s.replace(/\s+/g, '').replace(/([£$€])([0-9])/, '$1$2');
  }

  // Strip currency codes like GBP, USD if present in the value
  s = s.replace(/\b(GBP|USD|EUR|gbp|usd|eur)\b/gi, '').trim();

  // Extract numeric part; tolerate 1,234.56 or 1234,56 or 1234
  const numMatch = s.match(/([0-9]{1,3}(?:[,.][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)/);
  if (!numMatch) return null;
  let num = numMatch[1];

  // Normalize to decimal point
  // If it has both , and . assume , is thousands sep
  if (num.includes(',') && num.includes('.')) {
    num = num.replace(/,/g, '');
  } else if (num.includes(',') && !num.includes('.')) {
    // could be EU 1.234,56 or just 1,23 — treat trailing 2 digits after , as decimal
    const parts = num.split(',');
    if (parts[1] && parts[1].length <= 2) {
      num = parts[0] + '.' + parts[1];
    } else {
      num = num.replace(/,/g, '');
    }
  }

  const val = parseFloat(num);
  if (!Number.isFinite(val)) return null;

  const sym = getCurrencySymbol(currencyCode);
  // Format with 2 dp when it makes sense
  const hasDecimal = String(num).includes('.') || val % 1 !== 0;
  const formatted = hasDecimal ? val.toFixed(2) : String(Math.round(val));
  return `${sym}${formatted}`;
}

function matchesProductType(t) {
  if (!t) return false;
  const arr = Array.isArray(t) ? t : [t];
  return arr.some((x) => /Product|schema.org\/Product/i.test(String(x || '')));
}

function findProductNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (matchesProductType(node['@type'])) return node;
  // Recurse into arrays and objects (breadth-ish)
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const el of v) {
        const found = findProductNode(el);
        if (found) return found;
      }
    } else if (v && typeof v === 'object') {
      const found = findProductNode(v);
      if (found) return found;
    }
  }
  return null;
}

function getPriceFromOffers(offers) {
  if (!offers) return null;
  const arr = Array.isArray(offers) ? offers : [offers];
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    // Common shapes
    const direct = o.price ?? o.Price ?? o['price'];
    if (direct != null && String(direct).trim()) return direct;
    if (o.lowPrice) return o.lowPrice;
    if (o.priceSpecification && o.priceSpecification.price) return o.priceSpecification.price;
  }
  return null;
}

function extractFromJsonLd(html) {
  // Match script tags; non-greedy but handle nested-ish by taking content between
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    let content = m[1].trim();
    // Some pages wrap in CDATA or have HTML comments
    content = content.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim();
    if (!content || content[0] !== '{' && content[0] !== '[') continue;
    try {
      const data = JSON.parse(content);
      const prod = findProductNode(data);
      if (prod) {
        const rawPrice = getPriceFromOffers(prod.offers);
        if (rawPrice != null) {
          const curr = prod.offers?.priceCurrency || prod.priceCurrency || prod['@context']?.priceCurrency;
          const n = normalizePrice(rawPrice, curr);
          if (n) return n;
        }
        // Sometimes price is top level on the product (rare)
        if (prod.price != null) {
          const n = normalizePrice(prod.price, prod.priceCurrency);
          if (n) return n;
        }
      }
    } catch {
      // ignore bad JSON
    }
  }
  return null;
}

function extractFromOgMeta(html) {
  // og:price:amount (property or name)
  let m = html.match(/<meta[^>]+(?:property|name)=["']og:price:amount["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (!m) {
    // try reversed order of attrs
    m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:price:amount["'][^>]*>/i);
  }
  if (m) {
    const amount = m[1];
    let currM = html.match(/<meta[^>]+(?:property|name)=["']og:price:currency["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    if (!currM) {
      currM = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:price:currency["'][^>]*>/i);
    }
    const curr = currM ? currM[1] : '';
    return normalizePrice(amount, curr);
  }
  return null;
}

function extractFromMicrodata(html) {
  // <meta itemprop="price" content="..">
  let m = html.match(/<meta[^>]*itemprop=["']price["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  if (m) return normalizePrice(m[1]);

  // <span itemprop="price" content=".."> or >39.99<
  m = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i);
  if (m) return normalizePrice(m[1]);

  m = html.match(/itemprop=["']price["'][^>]*>([^<]{1,20})</i);
  if (m) return normalizePrice(m[1]);

  // offers block sometimes
  m = html.match(/itemprop=["']offers["'][^>]*>[\s\S]{0,200}?<meta[^>]*itemprop=["']price["'][^>]*content=["']([^"']+)["']/i);
  if (m) return normalizePrice(m[1]);

  return null;
}

/**
 * Last-resort visible text price grabber.
 * Catches the very common case on UK retail sites where price is just rendered as "£29.50"
 * in the HTML (search result cards or product page) without rich structured data.
 */
function extractFromVisibleText(html) {
  if (!html) return null;
  // Match £XX or £XX.XX , tolerate commas for thousands.
  const re = /£\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
  let m;
  const candidates = [];
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].replace(/,/g, '');
    const val = parseFloat(raw);
    if (val >= 1 && val < 8000) {
      candidates.push({ val, str: m[0].replace(/\s+/g, '') });
    }
  }
  if (candidates.length === 0) return null;

  // Prefer a substantial price (>= £4) — skips delivery £1.99, "from £2", etc.
  // If none, fall back to the largest (product price is usually the biggest number shown).
  const substantial = candidates.filter(c => c.val >= 4);
  const chosen = (substantial.length ? substantial[0] : candidates.sort((a,b) => b.val - a.val)[0]).str;
  return normalizePrice(chosen.replace('£', ''));
}

/**
 * Main export: given full page HTML, return best-effort price string or null.
 */
function extractPrice(html) {
  if (typeof html !== 'string' || !html) return null;
  // Layer order as specified + visible text fallback for the many sites that don't emit rich data on listings
  return (
    extractFromJsonLd(html) ||
    extractFromOgMeta(html) ||
    extractFromMicrodata(html) ||
    extractFromVisibleText(html) ||
    null
  );
}

/**
 * Best-effort product name for nicer "done" text. JSON-LD name > og:title > first decent h1.
 */
function extractProductName(html) {
  if (typeof html !== 'string' || !html) return null;

  // JSON-LD first (best)
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const prod = findProductNode(data);
      if (prod && prod.name) {
        const name = String(prod.name).trim();
        if (name.length > 1 && name.length < 120 && !/search results/i.test(name)) {
          return cleanName(name);
        }
      }
    } catch {}
  }

  // og:title, but skip obvious search / listing pages
  let titleM = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (!titleM) {
    titleM = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["'][^>]*>/i);
  }
  if (titleM) {
    const raw = titleM[1];
    if (!/search|results|category|browse/i.test(raw)) {
      const t = cleanName(raw);
      if (t && t.length > 1) return t;
    }
  }

  // First good h1 that isn't a generic listing header
  const h1 = html.match(/<h1[^>]*>([^<]{3,80})</i);
  if (h1) {
    const raw = h1[1];
    if (!/search|results|showing|items/i.test(raw)) {
      const t = cleanName(raw);
      if (t && t.length > 1) return t;
    }
  }

  // Try to find a product title near the first price (common on result cards)
  const priceIdx = html.search(/£\s*\d/);
  if (priceIdx > 100) {
    const around = html.slice(Math.max(0, priceIdx - 900), priceIdx + 200);
    // Look for a title-like thing: long-ish text in a heading, link, or span near the price
    const titleLike = around.match(/<(?:h2|h3|span|a)[^>]*class=["'][^"']*(?:title|name|product)[^"']*["'][^>]*>([^<]{4,70})</i) ||
                      around.match(/<a[^>]*>([^<]{5,60})<\/a>[^<]{0,30}£/i);
    if (titleLike) {
      const t = cleanName(titleLike[1]);
      if (t && t.length > 2) return t;
    }
  }

  // Amazon-specific: their search results often have product titles in h2.a-link-normal or data-cy="title-recipe"
  const amazonTitle = html.match(/<h2[^>]*>[\s\S]{0,100}?<a[^>]*class=["'][^"']*a-link-normal[^"']*["'][^>]*>([^<]{5,80})</i) ||
                      html.match(/data-cy=["']title-recipe["'][^>]*>([^<]{5,80})/i);
  if (amazonTitle) {
    const t = cleanName(amazonTitle[1]);
    if (t && t.length > 3) return t;
  }

  return null;
}

function cleanName(s) {
  let t = String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u00A0|•·]/g, '')
    .trim();

  // Strip leading retailer/brand noise (very common on search results)
  t = t.replace(/^(John Lewis|Selfridges|ASOS|Currys|Screwfix|Marks & Spencer|M&S|Waitrose|Tesco|Sainsbury'?s|Nike|Argos|Wickes|Toolstation)\s+[-–—|:]?\s*/i, '');

  // Strip trailing retailer after separator
  t = t.replace(/\s*[-–—|]\s*(John Lewis|Selfridges|ASOS|Currys|Screwfix|.*)$/i, '');

  return t.slice(0, 80);
}

/**
 * Extract the first plausible product detail page URL from a search/listing HTML.
 * Heuristic (no browser): prefers links whose path smells like a product page for common UK retailers.
 * Also uses price proximity: links that appear shortly before a £ price in the markup are strong signals.
 * Returns absolute URL or null. Pure except for URL constructor (safe).
 */
function extractFirstProductUrl(html, baseUrl) {
  if (typeof html !== 'string' || !html || !baseUrl) return null;
  let base;
  try { base = new URL(baseUrl); } catch { return null; }

  // Collect all hrefs
  const hrefRe = /<a[^>]+href=["']([^"']+)["']/gi;
  const candidates = [];
  let match;
  while ((match = hrefRe.exec(html)) !== null) {
    let href = match[1];
    if (!href || href.startsWith('javascript:') || href === '#' || href[0] === 'm' && href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    if (href.startsWith('data:')) continue;

    let u;
    try { u = new URL(href, base); } catch { continue; }
    // stay on same host (ignore external ads, trackers, social)
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;

    const p = u.pathname + u.search; // include ? for some
    // Skip obvious non-product paths
    if (/\/(search|cat|browse|filter|login|signup|account|cart|basket|checkout|bag|wishlist|help|about|stores)/i.test(p)) continue;
    if (/^\/(en|uk|gb|us|ie)?\/?$/.test(p) || p.length < 3) continue;

    // Strong product signals (order matters — first match wins bias to earlier in DOM)
    const isStrongProduct = /\/p\d{4,}/i.test(p) || // john lewis etc
      /\/product/i.test(p) ||
      /\/dp\//i.test(p) || // amazon style
      /\/item[s]?\//i.test(p) ||
      /\/detail/i.test(p) ||
      /\/pd\//i.test(p) ||
      /\/shop\/product/i.test(p) ||
      /\/p\/[a-z0-9-]{4,}/i.test(p); // some sites like M&S use /p/slug

    if (isStrongProduct) {
      candidates.push({ url: u.toString(), strong: true });
    } else if (candidates.length < 12) {
      // Weak but plausible internal path that isn't nav
      if (/^[\/][^?#]+\/[^?#/]{3,}/i.test(p) && !/(\.jpg|\.png|\.css|\.js|\.ico|rss|xml|json)$/i.test(p)) {
        candidates.push({ url: u.toString(), strong: false });
      }
    }
  }

  // NEW: price-proximity heuristic (very effective on result pages)
  // Find £ prices, then look backwards in the markup for the closest preceding <a href
  const priceRe = /£\s*\d/g;
  let pm;
  const pricePositions = [];
  while ((pm = priceRe.exec(html)) !== null) {
    pricePositions.push(pm.index);
  }

  for (const pos of pricePositions.slice(0, 8)) {  // limit work
    const lookback = Math.max(0, pos - 1600);
    const before = html.slice(lookback, pos);
    // Find the last <a that starts before this price
    const lastAnchorIdx = before.lastIndexOf('<a ');
    if (lastAnchorIdx > -1) {
      const anchor = before.slice(lastAnchorIdx, lastAnchorIdx + 600);
      const hrefM = anchor.match(/href=["']([^"']+)["']/i);
      if (hrefM) {
        try {
          const u = new URL(hrefM[1], base);
          const hostMatch = u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '');
          const p = u.pathname + u.search;
          if (hostMatch && p.length > 4 && !/\/(search|cat|browse|filter|login|basket)/i.test(p)) {
            const already = candidates.some(c => c.url === u.toString());
            if (!already) {
              candidates.unshift({ url: u.toString(), strong: false, via: 'price-proximity' });
            }
          }
        } catch {}
      }
    }
  }

  // Prefer strong product signals; take the first one we saw (usually first result)
  const strong = candidates.find(c => c.strong);
  if (strong) return strong.url;

  // Fallback to first plausible (price-proximity ones are now at front)
  if (candidates.length) return candidates[0].url;

  return null;
}

/**
 * Quick visible deal/coupon hunter from HTML (works on both search and product pages).
 * Tries hard to ignore JS code, analytics vars, etc.
 */
function extractVisibleDeals(html) {
  if (!html) return [];
  // Strip scripts and json blobs first to avoid matching "codeURIComponent" etc.
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/\{[\s\S]{0,200}code[A-Za-z]*[\s\S]{0,100}\}/g, ' ')
    .replace(/\b(function|var|let|const|window|document|encode|decode)[^<]{0,30}/g, ' ');

  const deals = [];
  const patterns = [
    /£\s*\d+(?:\.\d{2})?\s*(?:off|discount|save)/gi,
    /\d+%\s*off/gi,
    /(?:code|promo|discount code)[:\s]*([A-Z0-9]{4,12})/gi,
    /use (?:code|promo)[:\s]*([A-Z0-9]{4,12})/gi,
    /bogo|buy one get one|2 for 1|buy 2 get 1/gi,
    /free (?:delivery|shipping|gift|next day)/gi,
    /(?:sale|deal|offer|limited time|today only|save £\d+)/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(clean)) !== null) {
      let hit = (m[0] || m[1] || '').trim().replace(/\s+/g, ' ');
      if (hit && hit.length > 3 && hit.length < 50 && !/codeURIComponent|encoded|length|size/i.test(hit)) {
        deals.push(hit);
      }
    }
  }
  return Array.from(new Set(deals)).slice(0, 3);
}

module.exports = {
  extractPrice,
  extractProductName,
  extractFirstProductUrl,
  extractVisibleDeals,
  // exposed for tests
  _normalizePrice: normalizePrice,
  _extractFromJsonLd: extractFromJsonLd,
  _extractFromOgMeta: extractFromOgMeta,
  _extractFromMicrodata: extractFromMicrodata
};

'use strict';
// Retailer name → URL resolver. Supports UK + US retailers so "order me X from Target"
// works without the LLM guessing a homepage URL. Also centralises search-url seeds.

/** @typedef {'uk'|'us'|'both'} RetailRegion */
/** @typedef {{ names: string[], homeUrl: string, searchUrl?: (term: string) => string, kind?: 'retail'|'delivery'|'grocery', region?: RetailRegion, locales?: Record<string, { homeUrl: string, searchUrl?: (term: string) => string }> }} RetailerEntry */

const RETAILERS = {
  // --- UK retail ---
  'johnlewis.com': {
    names: ['john lewis', 'johnlewis'],
    region: 'uk',
    homeUrl: 'https://www.johnlewis.com',
    searchUrl: (term) => `https://www.johnlewis.com/search?search-term=${encodeURIComponent(term)}`,
  },
  'selfridges.com': {
    names: ['selfridges'],
    region: 'uk',
    homeUrl: 'https://www.selfridges.com',
    searchUrl: (term) => `https://www.selfridges.com/GB/en/cat/?freeText=${encodeURIComponent(term)}&srch=Y`,
  },
  'marksandspencer.com': {
    names: ['m&s', 'marks and spencer', 'marks & spencer', 'marksandspencer'],
    region: 'uk',
    homeUrl: 'https://www.marksandspencer.com',
    searchUrl: (term) => `https://www.marksandspencer.com/search?searchTerm=${encodeURIComponent(term)}`,
  },
  'sainsburys.co.uk': {
    names: ["sainsbury's", 'sainsburys', 'sainsbury'],
    region: 'uk',
    homeUrl: 'https://www.sainsburys.co.uk',
    searchUrl: (term) => `https://www.sainsburys.co.uk/gol-ui/SearchResults/${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'waitrose.com': {
    names: ['waitrose'],
    region: 'uk',
    homeUrl: 'https://www.waitrose.com',
    searchUrl: (term) => `https://www.waitrose.com/ecom/shop/search?searchTerm=${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'currys.co.uk': {
    names: ['currys', 'currys pc world'],
    region: 'uk',
    homeUrl: 'https://www.currys.co.uk',
    searchUrl: (term) => `https://www.currys.co.uk/search?q=${encodeURIComponent(term)}`,
  },
  'screwfix.com': {
    names: ['screwfix'],
    region: 'uk',
    homeUrl: 'https://www.screwfix.com',
    searchUrl: (term) => `https://www.screwfix.com/search?search=${encodeURIComponent(term)}`,
  },
  'wickes.co.uk': {
    names: ['wickes'],
    region: 'uk',
    homeUrl: 'https://www.wickes.co.uk',
    searchUrl: (term) => `https://www.wickes.co.uk/search?text=${encodeURIComponent(term)}`,
  },
  'toolstation.com': {
    names: ['toolstation'],
    region: 'uk',
    homeUrl: 'https://www.toolstation.com',
    searchUrl: (term) => `https://www.toolstation.com/search?q=${encodeURIComponent(term)}`,
  },
  'amazon.co.uk': {
    names: ['amazon uk', 'amazon.co.uk'],
    region: 'uk',
    homeUrl: 'https://www.amazon.co.uk',
    searchUrl: (term) => `https://www.amazon.co.uk/s?k=${encodeURIComponent(term)}`,
  },
  'boots.com': {
    names: ['boots'],
    region: 'uk',
    homeUrl: 'https://www.boots.com',
    searchUrl: (term) => `https://www.boots.com/sitesearch?searchTerm=${encodeURIComponent(term)}`,
  },
  'diy.com': {
    names: ['b&q', 'b and q', 'bandq', 'diy.com'],
    region: 'uk',
    homeUrl: 'https://www.diy.com',
    searchUrl: (term) => `https://www.diy.com/search?term=${encodeURIComponent(term)}`,
  },
  'very.co.uk': {
    names: ['very'],
    region: 'uk',
    homeUrl: 'https://www.very.co.uk',
    searchUrl: (term) => `https://www.very.co.uk/search?q=${encodeURIComponent(term)}`,
  },
  'tesco.com': {
    names: ['tesco'],
    region: 'uk',
    homeUrl: 'https://www.tesco.com/groceries',
    searchUrl: (term) => `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'groceries.asda.com': {
    names: ['asda'],
    region: 'uk',
    homeUrl: 'https://groceries.asda.com',
    searchUrl: (term) => `https://groceries.asda.com/search/${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'wilko.com': {
    names: ['wilko', 'wilkinsons'],
    region: 'uk',
    homeUrl: 'https://www.wilko.com',
    searchUrl: (term) => `https://www.wilko.com/search?q=${encodeURIComponent(term)}`,
  },
  'dunelm.com': {
    names: ['dunelm'],
    region: 'uk',
    homeUrl: 'https://www.dunelm.com',
    searchUrl: (term) => `https://www.dunelm.com/search?q=${encodeURIComponent(term)}`,
  },
  'argos.co.uk': {
    names: ['argos'],
    region: 'uk',
    homeUrl: 'https://www.argos.co.uk',
    searchUrl: (term) => `https://www.argos.co.uk/search/${encodeURIComponent(term)}/`,
  },
  'asos.com': {
    names: ['asos'],
    region: 'uk',
    homeUrl: 'https://www.asos.com',
  },
  'next.co.uk': {
    names: ['next'],
    region: 'uk',
    homeUrl: 'https://www.next.co.uk',
  },
  'superdrug.com': {
    names: ['superdrug'],
    region: 'uk',
    homeUrl: 'https://www.superdrug.com',
    searchUrl: (term) => `https://www.superdrug.com/search?text=${encodeURIComponent(term)}`,
  },
  'decathlon.co.uk': {
    names: ['decathlon uk'],
    region: 'uk',
    homeUrl: 'https://www.decathlon.co.uk',
    searchUrl: (term) => `https://www.decathlon.co.uk/search?Ntt=${encodeURIComponent(term)}`,
  },
  'deliveroo.co.uk': {
    names: ['deliveroo'],
    region: 'uk',
    homeUrl: 'https://deliveroo.co.uk',
    kind: 'delivery',
  },
  'just-eat.co.uk': {
    names: ['just eat', 'justeat'],
    region: 'uk',
    homeUrl: 'https://www.just-eat.co.uk',
    kind: 'delivery',
  },
  'dominos.co.uk': {
    names: ['dominos uk', "domino's uk"],
    region: 'uk',
    homeUrl: 'https://www.dominos.co.uk',
    kind: 'delivery',
  },

  // --- US retail ---
  'amazon.com': {
    names: ['amazon', 'amazon.com', 'amazon us'],
    region: 'us',
    homeUrl: 'https://www.amazon.com',
    searchUrl: (term) => `https://www.amazon.com/s?k=${encodeURIComponent(term)}`,
  },
  'walmart.com': {
    names: ['walmart', "wal-mart"],
    region: 'us',
    homeUrl: 'https://www.walmart.com',
    searchUrl: (term) => `https://www.walmart.com/search?q=${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'target.com': {
    names: ['target'],
    region: 'us',
    homeUrl: 'https://www.target.com',
    searchUrl: (term) => `https://www.target.com/s?searchTerm=${encodeURIComponent(term)}`,
  },
  'costco.com': {
    names: ['costco'],
    region: 'us',
    homeUrl: 'https://www.costco.com',
    searchUrl: (term) => `https://www.costco.com/CatalogSearch?keyword=${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'homedepot.com': {
    names: ['home depot', 'homedepot', 'the home depot'],
    region: 'us',
    homeUrl: 'https://www.homedepot.com',
    searchUrl: (term) => `https://www.homedepot.com/s/${encodeURIComponent(term)}`,
  },
  'lowes.com': {
    names: ["lowe's", 'lowes', 'lowes hardware'],
    region: 'us',
    homeUrl: 'https://www.lowes.com',
    searchUrl: (term) => `https://www.lowes.com/search?searchTerm=${encodeURIComponent(term)}`,
  },
  'bestbuy.com': {
    names: ['best buy', 'bestbuy'],
    region: 'us',
    homeUrl: 'https://www.bestbuy.com',
    searchUrl: (term) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(term)}`,
  },
  'cvs.com': {
    names: ['cvs'],
    region: 'us',
    homeUrl: 'https://www.cvs.com',
    searchUrl: (term) => `https://www.cvs.com/search?searchTerm=${encodeURIComponent(term)}`,
  },
  'walgreens.com': {
    names: ['walgreens'],
    region: 'us',
    homeUrl: 'https://www.walgreens.com',
    searchUrl: (term) => `https://www.walgreens.com/search/results.jsp?Ntt=${encodeURIComponent(term)}`,
  },
  'kroger.com': {
    names: ['kroger'],
    region: 'us',
    homeUrl: 'https://www.kroger.com',
    searchUrl: (term) => `https://www.kroger.com/search?query=${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'wholefoodsmarket.com': {
    names: ['whole foods', 'wholefoods'],
    region: 'us',
    homeUrl: 'https://www.wholefoodsmarket.com',
    searchUrl: (term) => `https://www.wholefoodsmarket.com/search?text=${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'safeway.com': {
    names: ['safeway'],
    region: 'us',
    homeUrl: 'https://www.safeway.com',
    searchUrl: (term) => `https://www.safeway.com/shop/search-results.html?q=${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'albertsons.com': {
    names: ['albertsons'],
    region: 'us',
    homeUrl: 'https://www.albertsons.com',
    searchUrl: (term) => `https://www.albertsons.com/shop/search-results.html?q=${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'macys.com': {
    names: ["macy's", 'macys'],
    region: 'us',
    homeUrl: 'https://www.macys.com',
    searchUrl: (term) => `https://www.macys.com/shop/featured/${encodeURIComponent(term)}`,
  },
  'nordstrom.com': {
    names: ['nordstrom'],
    region: 'us',
    homeUrl: 'https://www.nordstrom.com',
    searchUrl: (term) => `https://www.nordstrom.com/sr?keyword=${encodeURIComponent(term)}`,
  },
  'gap.com': {
    names: ['gap'],
    region: 'us',
    homeUrl: 'https://www.gap.com',
    searchUrl: (term) => `https://www.gap.com/browse/search.do?searchText=${encodeURIComponent(term)}`,
  },
  'oldnavy.com': {
    names: ['old navy', 'oldnavy'],
    region: 'us',
    homeUrl: 'https://oldnavy.gap.com',
    searchUrl: (term) => `https://oldnavy.gap.com/browse/search.do?searchText=${encodeURIComponent(term)}`,
  },
  'kohls.com': {
    names: ["kohl's", 'kohls'],
    region: 'us',
    homeUrl: 'https://www.kohls.com',
    searchUrl: (term) => `https://www.kohls.com/search.jsp?search=${encodeURIComponent(term)}`,
  },
  'sephora.com': {
    names: ['sephora'],
    region: 'us',
    homeUrl: 'https://www.sephora.com',
    searchUrl: (term) => `https://www.sephora.com/search?keyword=${encodeURIComponent(term)}`,
  },
  'ulta.com': {
    names: ['ulta'],
    region: 'us',
    homeUrl: 'https://www.ulta.com',
    searchUrl: (term) => `https://www.ulta.com/search?search=${encodeURIComponent(term)}`,
  },
  'wayfair.com': {
    names: ['wayfair'],
    region: 'us',
    homeUrl: 'https://www.wayfair.com',
    searchUrl: (term) => `https://www.wayfair.com/keyword.php?keyword=${encodeURIComponent(term)}`,
  },
  'chewy.com': {
    names: ['chewy'],
    region: 'us',
    homeUrl: 'https://www.chewy.com',
    searchUrl: (term) => `https://www.chewy.com/s?query=${encodeURIComponent(term)}`,
  },
  'staples.com': {
    names: ['staples'],
    region: 'us',
    homeUrl: 'https://www.staples.com',
    searchUrl: (term) => `https://www.staples.com/${encodeURIComponent(term)}/directory_${encodeURIComponent(term)}`,
  },
  'officedepot.com': {
    names: ['office depot', 'officedepot'],
    region: 'us',
    homeUrl: 'https://www.officedepot.com',
    searchUrl: (term) => `https://www.officedepot.com/catalog/search.do?Ntt=${encodeURIComponent(term)}`,
  },
  'rei.com': {
    names: ['rei'],
    region: 'us',
    homeUrl: 'https://www.rei.com',
    searchUrl: (term) => `https://www.rei.com/search?q=${encodeURIComponent(term)}`,
  },
  'dickssportinggoods.com': {
    names: ["dick's", 'dicks sporting goods', 'dickssportinggoods'],
    region: 'us',
    homeUrl: 'https://www.dickssportinggoods.com',
    searchUrl: (term) => `https://www.dickssportinggoods.com/search/SearchDisplay?searchTerm=${encodeURIComponent(term)}`,
  },
  'newegg.com': {
    names: ['newegg'],
    region: 'us',
    homeUrl: 'https://www.newegg.com',
    searchUrl: (term) => `https://www.newegg.com/p/pl?d=${encodeURIComponent(term)}`,
  },
  'ebay.com': {
    names: ['ebay'],
    region: 'us',
    homeUrl: 'https://www.ebay.com',
    searchUrl: (term) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(term)}`,
  },
  'apple.com': {
    names: ['apple store', 'apple.com'],
    region: 'us',
    homeUrl: 'https://www.apple.com/store',
    searchUrl: (term) => `https://www.apple.com/us/search/${encodeURIComponent(term)}`,
  },
  'samsclub.com': {
    names: ["sam's club", 'sams club', 'samsclub'],
    region: 'us',
    homeUrl: 'https://www.samsclub.com',
    searchUrl: (term) => `https://www.samsclub.com/s/${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'bjs.com': {
    names: ["bj's", 'bjs', 'bjs wholesale'],
    region: 'us',
    homeUrl: 'https://www.bjs.com',
    searchUrl: (term) => `https://www.bjs.com/search/${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'heb.com': {
    names: ['h-e-b', 'heb'],
    region: 'us',
    homeUrl: 'https://www.heb.com',
    searchUrl: (term) => `https://www.heb.com/search?q=${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'meijer.com': {
    names: ['meijer'],
    region: 'us',
    homeUrl: 'https://www.meijer.com',
    searchUrl: (term) => `https://www.meijer.com/shopping/search.html?query=${encodeURIComponent(term)}`,
    kind: 'grocery',
  },
  'jcpenney.com': {
    names: ['jcpenney', 'jcp', 'jc penney'],
    region: 'us',
    homeUrl: 'https://www.jcpenney.com',
    searchUrl: (term) => `https://www.jcpenney.com/s/${encodeURIComponent(term)}`,
  },
  'bathandbodyworks.com': {
    names: ['bath and body works', 'bath & body works'],
    region: 'us',
    homeUrl: 'https://www.bathandbodyworks.com',
    searchUrl: (term) => `https://www.bathandbodyworks.com/search?q=${encodeURIComponent(term)}`,
  },
  'crateandbarrel.com': {
    names: ['crate and barrel', 'crate & barrel'],
    region: 'us',
    homeUrl: 'https://www.crateandbarrel.com',
    searchUrl: (term) => `https://www.crateandbarrel.com/search?query=${encodeURIComponent(term)}`,
  },
  'potterybarn.com': {
    names: ['pottery barn', 'potterybarn'],
    region: 'us',
    homeUrl: 'https://www.potterybarn.com',
    searchUrl: (term) => `https://www.potterybarn.com/search/results.html?words=${encodeURIComponent(term)}`,
  },
  'decathlon.com': {
    names: ['decathlon', 'decathlon us'],
    region: 'us',
    homeUrl: 'https://www.decathlon.com',
    searchUrl: (term) => `https://www.decathlon.com/search?query=${encodeURIComponent(term)}`,
  },

  // --- Global / multi-region (locale picked from goal hints) ---
  'nike.com': {
    names: ['nike'],
    region: 'both',
    locales: {
      uk: {
        homeUrl: 'https://www.nike.com/gb',
        searchUrl: (term) => `https://www.nike.com/gb/w?q=${encodeURIComponent(term)}`,
      },
      us: {
        homeUrl: 'https://www.nike.com',
        searchUrl: (term) => `https://www.nike.com/w?q=${encodeURIComponent(term)}`,
      },
    },
  },
  'ikea.com': {
    names: ['ikea'],
    region: 'both',
    locales: {
      uk: {
        homeUrl: 'https://www.ikea.com/gb/en',
        searchUrl: (term) => `https://www.ikea.com/gb/en/search/?q=${encodeURIComponent(term)}`,
      },
      us: {
        homeUrl: 'https://www.ikea.com/us/en',
        searchUrl: (term) => `https://www.ikea.com/us/en/search/?q=${encodeURIComponent(term)}`,
      },
    },
  },
  'hm.com': {
    names: ['h&m', 'h and m', 'handm'],
    region: 'both',
    locales: {
      uk: {
        homeUrl: 'https://www2.hm.com/en_gb',
        searchUrl: (term) => `https://www2.hm.com/en_gb/search-results.html?q=${encodeURIComponent(term)}`,
      },
      us: {
        homeUrl: 'https://www2.hm.com/en_us',
        searchUrl: (term) => `https://www2.hm.com/en_us/search-results.html?q=${encodeURIComponent(term)}`,
      },
    },
  },
  'zara.com': {
    names: ['zara'],
    region: 'both',
    locales: {
      uk: {
        homeUrl: 'https://www.zara.com/uk',
        searchUrl: (term) => `https://www.zara.com/uk/en/search?searchTerm=${encodeURIComponent(term)}`,
      },
      us: {
        homeUrl: 'https://www.zara.com/us',
        searchUrl: (term) => `https://www.zara.com/us/en/search?searchTerm=${encodeURIComponent(term)}`,
      },
    },
  },

  // --- Delivery (US + global) ---
  'ubereats.com': {
    names: ['uber eats', 'ubereats'],
    region: 'both',
    homeUrl: 'https://www.ubereats.com',
    kind: 'delivery',
  },
  'doordash.com': {
    names: ['doordash', 'door dash'],
    region: 'us',
    homeUrl: 'https://www.doordash.com',
    kind: 'delivery',
  },
  'grubhub.com': {
    names: ['grubhub', 'grub hub'],
    region: 'us',
    homeUrl: 'https://www.grubhub.com',
    kind: 'delivery',
  },
  'instacart.com': {
    names: ['instacart'],
    region: 'us',
    homeUrl: 'https://www.instacart.com',
    kind: 'delivery',
  },
  'dominos.com': {
    names: ['dominos', "domino's", 'dominoes'],
    region: 'us',
    homeUrl: 'https://www.dominos.com',
    kind: 'delivery',
  },
};

const DELIVERY_HOSTS = new Set(
  Object.entries(RETAILERS).filter(([, r]) => r.kind === 'delivery').map(([h]) => h)
);

// Longest alias first so "marks and spencer" wins over "marks".
const ALIAS_INDEX = Object.entries(RETAILERS).flatMap(([host, entry]) =>
  entry.names.map((name) => ({
    host,
    name: name.toLowerCase().replace(/\s+/g, ' ').trim(),
    entry,
    region: entry.region || 'both',
  }))
).sort((a, b) => b.name.length - a.name.length);

const SOURCE_PATTERN = /\b(?:from|on|at|using|via)\s+/i;

function normalizeGoalText(goal) {
  return String(goal || '').trim().replace(/\s+/g, ' ');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Infer UK vs US from device coordinates (from iOS native_context). */
function inferRegionFromLocation(location) {
  const lat = Number(location?.latitude ?? location?.lat);
  const lng = Number(location?.longitude ?? location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // UK + Ireland (incl. NI). Rough bounding box — good enough for retailer locale.
  if (lat >= 49 && lat <= 61 && lng >= -11 && lng <= 2) return 'uk';
  // US + territories (continental, Alaska, Hawaii). Canada shares many US retailers.
  if (lat >= 18 && lat <= 72 && lng >= -170 && lng <= -50) return 'us';
  return null;
}

/**
 * Infer retail region: goal address hints beat device location (gift orders abroad).
 * Returns null only when neither text nor location gives a signal.
 */
function detectRegionFromGoal(goal, options = {}) {
  const text = normalizeGoalText(goal);
  if (/\b(uk|u\.k\.|britain|british|england|scotland|wales|northern ireland)\b/i.test(text)) return 'uk';
  if (/\b(us|u\.s\.|usa|america|american|united states)\b/i.test(text)) return 'us';
  if (/\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/i.test(text)) return 'uk';
  if (/\b\d{5}(?:-\d{4})?\b/.test(text)) return 'us';
  return inferRegionFromLocation(options.location);
}

function regionMatchesEntry(entryRegion, goalRegion) {
  if (!goalRegion) return true;
  const r = entryRegion || 'both';
  return r === 'both' || r === goalRegion;
}

function pickLocaleUrls(entry, region) {
  if (entry.locales) {
    const loc = (region && entry.locales[region]) || entry.locales.us || entry.locales.uk;
    if (loc) return { homeUrl: loc.homeUrl, searchUrl: loc.searchUrl };
  }
  return { homeUrl: entry.homeUrl, searchUrl: entry.searchUrl };
}

function matchAliasInText(text, goalRegion, startIndex = 0) {
  const slice = text.slice(startIndex);
  for (const { host, name, entry, region } of ALIAS_INDEX) {
    if (!regionMatchesEntry(region, goalRegion)) continue;
    const re = new RegExp(`\\b${escapeRegExp(name).replace(/\s+/g, '\\s+')}\\b`, 'i');
    const m = slice.match(re);
    if (m) return { host, entry, index: startIndex + m.index, matched: m[0] };
  }
  return null;
}

/**
 * Resolve a retailer mentioned in a natural-language goal to a homepage URL.
 * Returns null when no known retailer is named.
 */
function resolveRetailerFromGoal(goal, options = {}) {
  const text = normalizeGoalText(goal);
  if (!text) return null;
  const goalRegion = detectRegionFromGoal(text, options);

  const sourceMatch = text.match(SOURCE_PATTERN);
  if (sourceMatch) {
    const after = sourceMatch.index + sourceMatch[0].length;
    const hit = matchAliasInText(text, goalRegion, after);
    if (hit) return formatResolved(hit.host, hit.entry, hit.matched, goalRegion);
  }

  const hit = matchAliasInText(text, goalRegion);
  if (hit) return formatResolved(hit.host, hit.entry, hit.matched, goalRegion);

  return null;
}

function formatResolved(host, entry, matched, goalRegion) {
  const effective = goalRegion || (entry.region === 'both' ? null : entry.region);
  const { homeUrl, searchUrl } = pickLocaleUrls(entry, effective);
  return {
    host,
    homeUrl,
    displayName: matched.trim(),
    kind: entry.kind || 'retail',
    region: effective || entry.region || 'both',
    ...(searchUrl ? { searchUrl } : {}),
  };
}

function isDeliveryHost(host) {
  return DELIVERY_HOSTS.has(String(host || '').replace(/^www\./, ''));
}

/** Region-aware search config for a host (handles multi-locale brands like Nike/IKEA). */
function resolveSearchSite(host, goal, options = {}) {
  const entry = RETAILERS[host];
  if (!entry) return null;
  const region = detectRegionFromGoal(goal || '', options);
  const { searchUrl } = pickLocaleUrls(entry, region);
  if (!searchUrl) return null;
  return { names: entry.names, searchUrl };
}

/** Build the SEARCH_SITES map shape used by browser-task directSearchUrl. */
function buildSearchSites() {
  const out = {};
  for (const [host, entry] of Object.entries(RETAILERS)) {
    if (entry.locales) {
      // Default map entry uses US locale; directSearchUrl also calls resolveSearchSite for region.
      const loc = entry.locales.us || entry.locales.uk;
      if (loc?.searchUrl) out[host] = { names: entry.names, searchUrl: loc.searchUrl };
      continue;
    }
    if (!entry.searchUrl) continue;
    out[host] = { names: entry.names, searchUrl: entry.searchUrl };
  }
  return out;
}

/** Flat list of retailer aliases for intent-router shopping detection. */
function allRetailerAliases() {
  return ALIAS_INDEX.map((a) => a.name);
}

module.exports = {
  RETAILERS,
  DELIVERY_HOSTS,
  resolveRetailerFromGoal,
  resolveSearchSite,
  detectRegionFromGoal,
  inferRegionFromLocation,
  isDeliveryHost,
  buildSearchSites,
  allRetailerAliases,
};
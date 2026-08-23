'use strict';

// A terminal browser response is only useful if it contains the facts the person asked
// for. Keeping this policy independent of the browser driver means HTTP grounding, vision,
// and future connectors share one completion bar rather than each inventing “done”.

const TOKEN_STOP_WORDS = new Set([
  'find', 'look', 'search', 'report', 'tell', 'current', 'displayed', 'price', 'prices',
  'available', 'availability', 'stock', 'status', 'latest', 'current', 'cheapest', 'find',
  'with', 'from', 'that', 'this', 'their', 'there', 'what', 'about', 'next', 'first',
  'train', 'departure', 'depart', 'time', 'starting', 'option', 'options', 'rating',
  'review', 'reviews', 'customer', 'customers', 'shown', 'show', 'please', 'give', 'exact',
]);

function textOf({ text, summary, productName, price, total } = {}) {
  return [text, summary, productName, price, total].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function significantTokens(searchTerm) {
  return Array.from(new Set(
    String(searchTerm || '').toLowerCase().match(/[a-z0-9]+/g) || []
  )).filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token));
}

function requestedFacts(goal) {
  const g = String(goal || '').toLowerCase();
  return {
    price: /\b(price|cost|how much|cheapest|starting price|price range)\b/.test(g),
    availability: /\b(availability|available|in stock|stock status|out of stock|sold out)\b/.test(g),
    rating: /\b(rating|rated|star rating|stars?)\b/.test(g),
    reviews: /\b(review count|how many customer reviews|number of reviews)\b/.test(g),
    dimensions: /\b(dimensions?|measurements?|size)\b/.test(g),
    storage: /\b(storage|capacity|storage options)\b/.test(g),
    departureTime: /\b(train|rail)\b/.test(g) && /\b(depart(?:ure|s)?|next|first)\b/.test(g),
  };
}

function hasMatchingItem(text, searchTerm) {
  const tokens = significantTokens(searchTerm);
  if (!tokens.length) return true;
  const haystack = String(text || '').toLowerCase();
  const matched = tokens.filter((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack));
  return matched.length >= Math.min(2, tokens.length);
}

function assessLookupCompletion({ goal, searchTerm, text, summary, productName, price, total } = {}) {
  const evidence = textOf({ text, summary, productName, price, total });
  const facts = requestedFacts(goal);
  const missing = [];

  // A model sometimes wraps a plausible-looking value in “I could not verify this”.
  // That is explicitly not a result: preserve the uncertainty rather than converting it
  // into an apparently completed task because the sentence happened to include a price or time.
  if (/\b(?:couldn'?t|could not|can'?t|cannot|unable to|not able to|did not)\s+(?:verify|find|confirm|determine|locate)\b/i.test(evidence)) {
    return { complete: false, missing: ['verified result'] };
  }

  if (!hasMatchingItem(evidence, searchTerm)) missing.push('matching item');
  if (facts.price && !/£\s*[\d,]+(?:\.\d{1,2})?|\b[\d,.]+\s*(?:gbp|pounds?)\b/i.test(evidence)) missing.push('price');
  if (facts.availability && !/\b(in stock|out of stock|sold out|available|unavailable|pre[- ]?order)\b/i.test(evidence)) missing.push('availability');
  if (facts.rating && !/\b[0-5](?:\.\d)?\s*(?:\/\s*5|out of 5|stars?)\b|\brated\s+[0-5](?:\.\d)?\b/i.test(evidence)) missing.push('rating');
  if (facts.reviews && !/\b[\d,]+\s+(?:customer\s+)?reviews?\b/i.test(evidence)) missing.push('review count');
  if (facts.dimensions && !/\b\d+(?:\.\d+)?\s*(?:cm|mm|metres?|meters?|inches?|inch|ft)\b|\b\d+\s*[x×]\s*\d+/i.test(evidence)) missing.push('dimensions');
  if (facts.storage && !/\b\d+(?:\.\d+)?\s*(?:gb|tb)\b|\bstorage\b|\bcapacity\b/i.test(evidence)) missing.push('storage options');
  if (facts.departureTime && !/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(evidence)) missing.push('departure time');

  return { complete: missing.length === 0, missing };
}

function lookupCompletionCorrection(missing) {
  const list = (missing || []).join(', ');
  return `Do not finish yet. Your answer is missing: ${list}. Stay on the requested task and obtain only those facts from the page.`;
}

module.exports = { assessLookupCompletion, lookupCompletionCorrection, requestedFacts };

'use strict';
// Structured goal context — size, colour, deal preferences, budget — so the loop works from the
// user's stated intent rather than re-reading it off a screenshot each step. Pure and testable.

const SIZE_RE = /\b(?:size\s+)?((?:uk|eu)\s+)?([a-z0-9]{1,4})\b/i;
const STANDALONE_SIZE = /\b(xxs|xs|s|m|l|xl|xxl|uk\s*\d{1,2}|eu\s*\d{1,2})\b/i;
const COLOR_RE = /\b(black|white|navy|blue|red|green|grey|gray|brown|beige|pink|purple|yellow|orange|khaki|olive|denim|stone)\b/i;
const BUDGET_RE = /(?:under|below|less than|max|up to|budget of)\s*[£$]?\s*(\d+(?:\.\d{2})?)/i;
const DEAL_HINTS = [
  'coupon', 'code', 'promo', 'discount', 'deal', 'offer', 'sale', 'bogo', 'buy one get one',
  '2 for', 'cheapest', 'cheaper', 'lowest price', 'any deal', 'use code', 'apply code',
  'free delivery', 'student discount', 'first order'
];

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractSize(text) {
  const t = normalize(text);
  if (!t) return null;
  // "size 10", "size m", "size uk 9"
  let m = t.match(/\bsize\s+((?:uk|eu)\s+)?(xxs|xs|s|m|l|xl|xxl|\d{1,2}|uk\d+|eu\d+)\b/);
  if (m) return normalize(`${m[1] || ''}${m[2]}`);
  // uk/eu numbers
  m = t.match(/\b(uk|eu)\s+(\d{1,2})\b/);
  if (m) return `${m[1]} ${m[2]}`;
  // spelled
  m = t.match(/\b(extra small|extra large|small|medium|large)\b/);
  if (m) return m[1];
  // letters
  m = t.match(/\b(xxs|xs|s|m|l|xl|xxl)\b/);
  if (m) return m[1];
  // size word — only accept known short size tokens
  m = t.match(/\bsize\s+(xxs|xs|s|m|l|xl|xxl|\d{1,2}|uk\d{1,2}|eu\d{1,2})\b/);
  return m ? m[1] : null;
}

function extractColor(text) {
  const m = normalize(text).match(COLOR_RE);
  return m ? m[1] : null;
}

function extractBudget(text) {
  const m = text.match(BUDGET_RE);
  if (!m) return null;
  const val = parseFloat(m[1]);
  return Number.isFinite(val) ? val : null;
}

function extractDealHints(text) {
  const t = normalize(text);
  const hints = [];
  for (const hint of DEAL_HINTS) {
    if (t.includes(hint)) hints.push(hint);
  }
  // also catch "20% off" style
  if (/\d+%\s*off|\b(?:off|discount)\b/.test(t)) hints.push('percent-off');
  return Array.from(new Set(hints));
}

function parseGoalContext(goal, history = []) {
  const full = [goal, ...(history || [])].filter(Boolean).join(' ');
  if (!full.trim()) return { raw: goal || '' };

  return {
    raw: goal || '',
    item: null, // future: could LLM-extract core noun phrase
    size: extractSize(full),
    volume: extractVolume(full),
    color: extractColor(full),
    budget: extractBudget(full),
    dealHints: extractDealHints(full),
    wantsCheapest: /\b(cheapest|lowest|best price|cheaper)\b/.test(normalize(full)),
    wantsAnyDeal: extractDealHints(full).length > 0,
  };
}

function extractVolume(text) {
  const t = normalize(text);
  const m = t.match(/(\d+)\s*(ml|millilitre|liter|l|oz|ounce|fl oz|g|gram|kg)/i);
  return m ? `${m[1]}${m[2].toLowerCase()}` : null;
}

module.exports = {
  parseGoalContext,
  extractSize,
  extractColor,
  extractBudget,
  extractDealHints,
};

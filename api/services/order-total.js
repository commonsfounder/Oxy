'use strict';

// Read the amount before asking to spend it: a yes to an unknown sum is not consent, and a
// budget can't be honoured by something that never learns the price. Two rules:
//   - The most specific label wins, or a page's subtotal gets reported as the charge.
//   - No match returns null, never a nearby number — a wrong total shown as "approve this" is
//     worse than admitting it couldn't be read.

// Ordered most specific first. The first pattern that matches decides.
const TOTAL_PATTERNS = [
  /\b(?:amount|total)\s+to\s+pay\b[^0-9£$€]{0,20}([£$€]\s?[\d,]+\.\d{2})/i,
  /\border\s+total\b[^0-9£$€]{0,20}([£$€]\s?[\d,]+\.\d{2})/i,
  /\btotal\s+(?:cost|charge|due|payable)\b[^0-9£$€]{0,20}([£$€]\s?[\d,]+\.\d{2})/i,
  /\byou\s+(?:will\s+)?pay\b[^0-9£$€]{0,20}([£$€]\s?[\d,]+\.\d{2})/i,
  // Bare "Total" last: it also appears on basket subtotal rows.
  /\btotal\b[^0-9£$€a-z]{0,20}([£$€]\s?[\d,]+\.\d{2})/i
];

/**
 * @param {string} text visible page text
 * @returns {string|null} the total as shown (e.g. "£48.75"), or null if it cannot be read
 */
function readOrderTotal(text) {
  const haystack = String(text || '').replace(/\s+/g, ' ');
  if (!haystack) return null;

  for (const pattern of TOTAL_PATTERNS) {
    // Take the LAST match for a given label: checkout pages repeat the summary, and the
    // final one is the settled figure after discounts are applied.
    const matches = [...haystack.matchAll(new RegExp(pattern.source, 'gi'))];
    if (matches.length) {
      const raw = matches[matches.length - 1][1];
      return raw.replace(/\s+/g, '');
    }
  }
  return null;
}

module.exports = { TOTAL_PATTERNS, readOrderTotal };

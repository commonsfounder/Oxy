'use strict';

// Two tiers: 'ask' (the reply implies a decision, so check with the user first) and 'surface'
// (informational, nothing to decide). No auto-reply tier. Conservative on purpose — anything
// not confidently a plain confirmation or statement of fact defaults to 'ask'.

const ALTERNATIVE_OFFER_RE = /\b(instead|how about|we can do|can do|works for you|would.+work|available at)\b/i;
const QUESTION_BACK_RE = /\?\s*$/;
const PLAIN_CONFIRMATION_RE = /^\s*(confirmed|great|sounds good|see you|perfect|all set|you're all set|noted)\b/i;
const INFORMATIONAL_RE = /\b(closed|hours are|we don't|unfortunately|no longer|sorry,? we)\b/i;

function classifyReply(body) {
  const text = String(body || '').trim();
  if (!text) return 'surface';
  if (PLAIN_CONFIRMATION_RE.test(text) && !QUESTION_BACK_RE.test(text)) return 'surface';
  if (ALTERNATIVE_OFFER_RE.test(text)) return 'ask';
  if (QUESTION_BACK_RE.test(text)) return 'ask';
  if (INFORMATIONAL_RE.test(text)) return 'surface';
  // Unclassified content defaults to 'ask' — see file header.
  return 'ask';
}

module.exports = { classifyReply };

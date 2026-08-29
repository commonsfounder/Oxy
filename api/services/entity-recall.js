'use strict';

const { findRecentEntity, findMostRecentEntity } = require('./task-entities');

const OPENED_PATTERN = /\bthe (\w+) i (?:opened|saw|looked at|checked)\b/i;
const THAT_PATTERN = /\bthat (\w+)\b/i;

// The dominant real shape a shopping follow-up takes — "add it to my basket", "order that",
// "how much is it" — has no noun for the two patterns above to capture at all: the product was
// already named by Adam one turn ago, so the user just says "it". Scoped tightly to a
// commerce action verb or an explicit price question (the same order-intent vocabulary
// ORDER_GOAL_PATTERN in browser-task.js already uses) so an unrelated "it" — "what time is
// it", "is it going to rain" — never resolves to a stale product.
const COMMERCE_VERB_PATTERN = /\b(add|order|buy|book|get|checkout|reserve)\b/i;
const PRICE_QUERY_PATTERN = /\bhow much (?:is|was|does it cost)\b|\bwhat(?:'s| is| was) the price\b/i;
const BARE_PRONOUN_PATTERN = /\b(it|that|this)\b/i;

// Exported so the caller's message rewrite (api/index.js) replaces the exact span this module
// decided was a reference, instead of keeping a second hand-copied regex that can drift.
const REFERENTIAL_SUBSTITUTION_PATTERN = new RegExp(
  `${OPENED_PATTERN.source}|${THAT_PATTERN.source}|${BARE_PRONOUN_PATTERN.source}`,
  'i'
);

function extractReferentialPhrase(message) {
  const text = String(message || '');
  const openedMatch = text.match(OPENED_PATTERN);
  if (openedMatch) return openedMatch[1].toLowerCase();
  const thatMatch = text.match(THAT_PATTERN);
  if (thatMatch) return thatMatch[1].toLowerCase();
  return null;
}

function hasBareEntityReference(message) {
  const text = String(message || '');
  if (!BARE_PRONOUN_PATTERN.test(text)) return false;
  return COMMERCE_VERB_PATTERN.test(text) || PRICE_QUERY_PATTERN.test(text);
}

async function resolveEntityReference(supabase, userId, message) {
  const keyword = extractReferentialPhrase(message);
  if (keyword) {
    const entity = await findRecentEntity(supabase, userId, { keyword });
    if (entity) return { entityName: entity.entity_name, site: entity.site };
  }
  if (hasBareEntityReference(message)) {
    const entity = await findMostRecentEntity(supabase, userId);
    if (entity) return { entityName: entity.entity_name, site: entity.site };
  }
  return null;
}

module.exports = {
  extractReferentialPhrase,
  hasBareEntityReference,
  resolveEntityReference,
  REFERENTIAL_SUBSTITUTION_PATTERN
};

'use strict';

const { findRecentEntity } = require('./task-entities');

const OPENED_PATTERN = /\bthe (\w+) i (?:opened|saw|looked at|checked)\b/i;
const THAT_PATTERN = /\bthat (\w+)\b/i;

function extractReferentialPhrase(message) {
  const text = String(message || '');
  const openedMatch = text.match(OPENED_PATTERN);
  if (openedMatch) return openedMatch[1].toLowerCase();
  const thatMatch = text.match(THAT_PATTERN);
  if (thatMatch) return thatMatch[1].toLowerCase();
  return null;
}

async function resolveEntityReference(supabase, userId, message) {
  const keyword = extractReferentialPhrase(message);
  if (!keyword) return null;
  const entity = await findRecentEntity(supabase, userId, { keyword });
  if (!entity) return null;
  return { entityName: entity.entity_name, site: entity.site };
}

module.exports = { extractReferentialPhrase, resolveEntityReference };

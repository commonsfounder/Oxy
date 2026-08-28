'use strict';

// safeParseJSON returns the original value on failure (for db columns); parseLooseJson
// returns null and strips code fences (for model output). Not interchangeable.

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeParseJSON(val) {
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return val; }
}

function parseLooseJson(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

function parseJsonObject(value) {
  const parsed = safeParseJSON(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

// Postgres ILIKE treats % and _ as wildcards, so a user searching for "50%" or a name
// containing an underscore matches far more than they meant without this.
function escapeIlikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, match => `\\${match}`);
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const USER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function isValidUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

module.exports = {
  USER_ID_RE,
  base64UrlJson,
  escapeHtml,
  escapeIlikePattern,
  isValidUserId,
  parseJsonObject,
  parseLooseJson,
  safeParseJSON
};

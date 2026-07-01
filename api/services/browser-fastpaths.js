'use strict';
// Self-learning search-URL fast-paths.
// See docs/superpowers/specs/2026-07-01-self-learning-fastpaths-design.md
// Learns only the DURABLE thing — a site's search-results URL template — from the first
// successful manual search, so repeat visits skip the slow LLM loop. Never learns brittle
// selectors; the LLM loop is always the fallback, and a stale template self-heals.

const TERM = '{{term}}';
const FAIL_DISABLE_THRESHOLD = 3;

// Given a results URL and the text just typed into search, derive a reusable template
// (host + the query param that carried the term). Returns null unless the term is a
// query-param value — we only learn query-string search URLs in v1.
function learnTemplateFromUrl(url, filledValue) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const needle = String(filledValue || '').trim().toLowerCase();
  if (needle.length < 2) return null;
  for (const [key, val] of u.searchParams.entries()) {
    if (String(val).trim().toLowerCase() === needle) {
      const clone = new URL(u.toString());
      clone.searchParams.set(key, '__OXY_TERM__'); // sentinel has no special chars → stays literal
      return {
        host: u.hostname.replace(/^www\./, ''),
        param: key,
        template: clone.toString().replace('__OXY_TERM__', TERM)
      };
    }
  }
  return null;
}

// Fill a template with a real search term (URL-encoded). null if the template has no placeholder.
function applyTemplate(template, term) {
  if (!template || !template.includes(TERM)) return null;
  return template.replace(TERM, encodeURIComponent(String(term)));
}

module.exports = { learnTemplateFromUrl, applyTemplate, TERM, FAIL_DISABLE_THRESHOLD };

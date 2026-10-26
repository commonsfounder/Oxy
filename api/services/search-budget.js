'use strict';

// Web search is billed per call ($0.01 each on top of tokens), and Adam can run ten searches on one
// question. This remembers recent answers so a repeated search is free, and stops one question from
// running past a fixed number of searches.

const DEFAULT_CAP_PER_QUESTION = 6;
// Long enough to cover one question, short enough that asking again later gets fresh results.
const DEFAULT_TTL_MS = 3 * 60 * 1000;

function normaliseQuery(query) {
  return String(query || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function createSearchBudget({ now = () => Date.now(), cap = Number(process.env.OXY_SEARCH_CAP_PER_TURN) || DEFAULT_CAP_PER_QUESTION, ttlMs = DEFAULT_TTL_MS } = {}) {
  const answers = new Map();   // user|query -> { text, at }
  const questions = new Map(); // user|question -> { count, at }

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of answers) if (entry.at < cutoff) answers.delete(key);
    for (const [key, entry] of questions) if (entry.at < cutoff) questions.delete(key);
  }

  return {
    // A recent identical search: the answer, at no cost.
    cached(userId, query) {
      sweep();
      const entry = answers.get(`${userId}|${normaliseQuery(query)}`);
      return entry ? entry.text : null;
    },
    // Whether this question may run another real search.
    allow(userId, question) {
      sweep();
      const entry = questions.get(`${userId}|${normaliseQuery(question)}`);
      return !entry || entry.count < cap;
    },
    // Checks the limit and takes a slot in one step. Searches run side by side, so checking first
    // and counting afterwards let a whole batch past the cap.
    reserve(userId, question) {
      sweep();
      const key = `${userId}|${normaliseQuery(question)}`;
      const entry = questions.get(key) || { count: 0, at: now() };
      if (entry.count >= cap) return false;
      questions.set(key, { count: entry.count + 1, at: now() });
      return true;
    },
    // Keeps a search's answer. Counts it too unless a slot was already reserved.
    record(userId, question, query, text, { reserved = false } = {}) {
      const at = now();
      const key = `${userId}|${normaliseQuery(question)}`;
      const entry = questions.get(key) || { count: 0, at };
      questions.set(key, { count: entry.count + (reserved ? 0 : 1), at });
      if (text) answers.set(`${userId}|${normaliseQuery(query)}`, { text, at });
    },
    cap,
  };
}

module.exports = { createSearchBudget, normaliseQuery };

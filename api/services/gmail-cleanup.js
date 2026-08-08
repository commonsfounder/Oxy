'use strict';

// Pure decision logic for "clean my inbox"-shaped requests. Deliberately reuses the existing
// shared email classifier (emailTriageSignals in api/index.js) rather than building a second,
// parallel one — this module only decides what to DO with a triage verdict, and how to talk
// about the result truthfully. The actual Gmail I/O (search, archive, unsubscribe) lives in
// api/index.js's clean_inbox case handler and connectors/google.js's real mutation primitives.

function toGmailDateToken(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// Builds a real Gmail search query from natural, already-resolved constraints. `query`, if
// given, is an explicit override (an escape hatch for anything this can't express) and skips
// the rest entirely. Otherwise always scoped to the inbox — cleanup only ever touches mail
// that's actually sitting in the inbox, never the whole account.
function buildCleanupQuery({ sender, since, before, query } = {}) {
  if (query && String(query).trim()) return String(query).trim();
  const parts = ['in:inbox'];
  if (sender) parts.push(`from:${sender}`);
  const sinceToken = since ? toGmailDateToken(since) : null;
  if (sinceToken) parts.push(`after:${sinceToken}`);
  const beforeToken = before ? toGmailDateToken(before) : null;
  if (beforeToken) parts.push(`before:${beforeToken}`);
  return parts.join(' ');
}

// The actual cleanup decision, given one email and its ALREADY-COMPUTED triage signal
// (emailTriageSignals' output) — never re-classifies from scratch. Deliberately narrow:
// - isPrimary (looks like it needs a reply/action) -> never archived, regardless of sender.
// - category 'bulk updates' (the SAME bucket the dashboard already uses for low-priority
//   material) -> archive-eligible, and unsubscribe-eligible only if this specific message
//   actually carries a List-Unsubscribe header.
// - anything else (receipts, settled notifications, ordinary read mail with a neutral score)
//   -> preserved by default. "If uncertain, preserve" — this is the uncertain case.
// Per-message, not per-sender, on purpose: the same sender can have both junk and a genuine
// receipt, and only the individual message's own signal decides its fate.
function classifyForCleanup(email, triageSignal) {
  if (!triageSignal) return { archive: false, unsubscribeCandidate: false, reason: 'could not be classified' };
  if (triageSignal.isPrimary) {
    return { archive: false, unsubscribeCandidate: false, reason: 'looks like it needs your attention' };
  }
  if (triageSignal.category === 'bulk updates') {
    return { archive: true, unsubscribeCandidate: Boolean(email?.listUnsubscribe), reason: 'promotional or bulk mail' };
  }
  // Job alerts were classified into their own bucket and then never acted on, so the single
  // largest junk category in a real inbox (dozens of Indeed/StarNow/Workcircle digests a day)
  // survived every cleanup. They are already scored as explicitly low-value, and this is the
  // same reversible archive as any other bulk mail.
  if (triageSignal.category === 'job alerts') {
    return { archive: true, unsubscribeCandidate: Boolean(email?.listUnsubscribe), reason: 'automated job alert' };
  }
  return { archive: false, unsubscribeCandidate: false, reason: 'not clearly junk' };
}

// One unsubscribe attempt per distinct sender, never one per message — a sender with 40
// archived promotional emails should produce one unsubscribe attempt, not 40. Keeps the
// first candidate seen per sender (List-Unsubscribe is a sender/list property, any message
// from them carries the same one).
function dedupeSendersForUnsubscribe(candidates = []) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = String(candidate?.email?.senderAddress || candidate?.email?.from || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function senderLabel(email = {}) {
  return email.senderName || email.senderAddress || email.from || 'unknown sender';
}

// Truthful, compact completion summary — counts and reasons, not a dump of every message
// touched. Matches the exact shape asked for: "143 archived, 6 unsubscribed, 9 preserved
// because they looked important, 2 unsubscribes couldn't complete and why."
function summarizeCleanupResult({
  scanned = 0,
  archived = 0,
  archiveFailed = 0,
  preservedCount = 0,
  unsubscribed = [],
  unsubscribeFailed = [],
  needsBrowserUnsubscribe = []
} = {}) {
  const parts = [];
  if (archived > 0) parts.push(`archived ${archived} email${archived === 1 ? '' : 's'}`);
  if (archiveFailed > 0) parts.push(`${archiveFailed} could not be archived`);
  if (unsubscribed.length) {
    parts.push(`unsubscribed from ${unsubscribed.length} mailing list${unsubscribed.length === 1 ? '' : 's'} (${unsubscribed.map(u => u.sender).join(', ')})`);
  }
  if (needsBrowserUnsubscribe.length) {
    parts.push(`${needsBrowserUnsubscribe.length} more need a real page visit to finish unsubscribing (${needsBrowserUnsubscribe.map(u => u.sender).join(', ')})`);
  }
  if (unsubscribeFailed.length) {
    parts.push(`${unsubscribeFailed.length} unsubscribe attempt${unsubscribeFailed.length === 1 ? '' : 's'} failed (${unsubscribeFailed.map(u => `${u.sender}: ${u.reason}`).join('; ')})`);
  }
  if (preservedCount > 0) parts.push(`kept ${preservedCount} because ${preservedCount === 1 ? 'it looked' : 'they looked'} important`);
  if (!parts.length) return `Checked ${scanned} email${scanned === 1 ? '' : 's'} — nothing looked safe to clean up.`;
  const sentence = parts.join('; ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

module.exports = {
  buildCleanupQuery,
  classifyForCleanup,
  dedupeSendersForUnsubscribe,
  senderLabel,
  summarizeCleanupResult
};

'use strict';

// "Who's waiting on me?" — thread-level classification of whether a Gmail thread currently
// needs something FROM the user (a reply, or a small concrete action like signing something),
// as opposed to message-level triage (is THIS message promotional/urgent), which
// emailTriageSignals in api/index.js already answers. Genuinely a different question — no
// existing classifier answers "does this THREAD's current state require the user to do
// something" — so this is a new, thread-scoped layer, not a duplicate of the message-level one.
// The cheap pre-filter below deliberately reuses the SAME signal emailTriageSignals is built
// on (List-Unsubscribe / bulk wording / automated-sender shape) so obviously-noise threads
// never reach the more expensive LLM judgment call.

const MAX_THREAD_TEXT = 6000;

function isObviouslyNoReplyNeeded(latestMessage = {}) {
  const sender = String(latestMessage.senderAddress || latestMessage.from || '').toLowerCase();
  const subject = String(latestMessage.subject || '').toLowerCase();
  const snippet = String(latestMessage.snippet || latestMessage.body || '').toLowerCase();
  const haystack = `${subject} ${snippet}`;
  if (/\b(no-?reply|noreply|donotreply|mailer-daemon)\b/.test(sender)) return true;
  if (latestMessage.listUnsubscribe) return true;
  if (/\b(receipt|invoice|order confirm|has shipped|out for delivery|been delivered|tracking number|newsletter|digest|unsubscribe|promo(?:tion)?|% off|sale ends)\b/i.test(haystack)) return true;
  return false;
}

// Groups a flat list of messages (as returned by search_emails/get_emails, most-recent-first
// or not) into one entry per thread, keeping only the LATEST message — that's what determines
// whether the thread currently needs anything, not the thread's history.
function latestMessagePerThread(emails = []) {
  const byThread = new Map();
  for (const email of emails) {
    const threadId = email.threadId || email.id;
    if (!threadId) continue;
    const existing = byThread.get(threadId);
    const existingTime = existing ? Date.parse(existing.date || '') || 0 : -1;
    const currentTime = Date.parse(email.date || '') || 0;
    if (!existing || currentTime >= existingTime) byThread.set(threadId, email);
  }
  return [...byThread.values()];
}

function truncate(text, max = MAX_THREAD_TEXT) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// One prompt for the whole batch — cheaper than one call per thread, and lets the model see
// them side by side (helps consistency of the "needs response" bar across the batch).
function buildReplyNeededPrompt(threadContexts = [], { userEmail = '' } = {}) {
  const listing = threadContexts.map((t, i) => {
    const label = t.senderName || t.senderAddress || 'Unknown sender';
    return `THREAD ${i}\nParticipant: ${label}\nSubject: ${t.subject || '(no subject)'}\nLatest message date: ${t.date || 'unknown'}\nFull thread:\n${truncate(t.threadText)}`;
  }).join('\n\n---\n\n');

  return `You are deciding, for each numbered email thread below, whether the thread currently
requires something FROM the user (the account owner${userEmail ? `, ${userEmail}` : ''}) — a
reply, or a small concrete action like signing/confirming/sending something.

Judge each thread independently. Consider the FULL thread, not just the latest message:
- If the latest substantive message is from someone else, and it asks a question, requests
  information/a document/an action, proposes a time awaiting confirmation, or is a genuine
  follow-up chasing something — this needs a response.
- If the user's OWN last message already substantively answered/resolved it, this does NOT
  need a response — even if the other person hasn't replied again yet.
- If the user's own last message made a commitment ("I'll send this over", "let me check and
  get back to you", "I'll have it by Friday") and nothing has happened since, this DOES still
  need something from the user — they are the blocker, not the other person.
- Automated notifications, receipts, newsletters, and purely informational "FYI, nothing
  needed" messages do NOT need a response, even if unread.
- A thread that is clearly resolved/closed (thanks, confirmed, sorted) does NOT need a
  response.
- When genuinely unclear, prefer false — a missed real thread is worse than one extra check,
  but a list cluttered with things that don't actually need anything stops being useful.

Respond with ONLY a JSON array, one object per thread, same order and count as the input,
shape:
[{"needsResponse":true|false,"kind":"reply"|"action"|null,"whatTheyNeed":"short phrase, e.g. 'confirm the meeting time' or 'sign the attached form by Friday'","reasoning":"one short clause","urgency":"now"|"soon"|"whenever"|null}]

THREADS:
${listing}`;
}

function parseReplyNeededResponse(rawText, threadContexts = []) {
  const match = String(rawText || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  let judged;
  try {
    judged = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(judged)) return [];
  const items = [];
  for (let i = 0; i < threadContexts.length; i += 1) {
    const verdict = judged[i];
    if (!verdict || verdict.needsResponse !== true) continue;
    const t = threadContexts[i];
    items.push({
      threadId: t.threadId,
      sender: t.senderName || t.senderAddress || 'Unknown',
      subject: t.subject || '(no subject)',
      whatTheyNeed: String(verdict.whatTheyNeed || '').trim().slice(0, 200) || 'a response',
      reasoning: String(verdict.reasoning || '').trim().slice(0, 200),
      kind: verdict.kind === 'action' ? 'action' : 'reply',
      urgency: ['now', 'soon', 'whenever'].includes(verdict.urgency) ? verdict.urgency : null,
      waitingSince: t.date || null
    });
  }
  return items;
}

function daysSince(dateString) {
  const then = Date.parse(dateString || '');
  if (Number.isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / 86400000);
  return days >= 0 ? days : null;
}

// The natural-language, prioritized answer to "who's waiting on me?" — not a raw dump. Sorted
// urgency-first, capped so it stays a short, actually useful list rather than an inbox export.
function formatReplyNeededSummary(items = [], { maxItems = 8 } = {}) {
  if (!items.length) return "Nobody's waiting on you right now — nothing in your inbox needs a reply or action.";
  const order = { now: 0, soon: 1, whenever: 2, null: 3 };
  const sorted = [...items].sort((a, b) => (order[a.urgency] ?? 3) - (order[b.urgency] ?? 3));
  const shown = sorted.slice(0, maxItems);
  const lines = shown.map(item => {
    const days = daysSince(item.waitingSince);
    const since = days === null ? '' : days === 0 ? ' (today)' : ` (${days} day${days === 1 ? '' : 's'})`;
    const verb = item.kind === 'action' ? 'needs you to' : 'is waiting on you to';
    return `${item.sender} ${verb} ${item.whatTheyNeed}${since}`;
  });
  const more = items.length > shown.length ? ` (+${items.length - shown.length} more)` : '';
  return `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} your attention${more}: ${lines.join('; ')}.`;
}

module.exports = {
  isObviouslyNoReplyNeeded,
  latestMessagePerThread,
  buildReplyNeededPrompt,
  parseReplyNeededResponse,
  formatReplyNeededSummary,
  daysSince
};

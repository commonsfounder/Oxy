'use strict';

// Obligations the user has created for themselves.
//
// The hard part is not storing them, it is being conservative about what counts. "I'll have a
// look" is not a commitment; "I'll send the documents tomorrow" is. Getting this wrong in the
// generous direction produces a nagging list of things the user never actually promised, which
// is worse than tracking nothing — so capture is deliberately narrow and evidence-based:
// something the user explicitly stated, or something contained in a message they actually
// approved and sent. Nothing is captured by passively reading their mail.

const MAX_WHAT = 300;

// A real commitment needs a first-person future-tense undertaking AND a concrete action.
// Both halves matter: "I'll think about it" has the undertaking but no action, and "send the
// documents" has the action but might be the other person asking.
const UNDERTAKING = /\b(i(?:'| a)?ll|i will|i'm going to|i am going to|i shall|i promise|i'?ve got to|i need to|let me|i can (?:do|get|send|have)|will (?:send|get|have|call|pay|do|submit|book|bring|share|forward))\b/i;

// Deliberately excludes vague verbs. "Look", "check", "think", "see" and "consider" are how
// people decline politely, not how they commit.
const CONCRETE_ACTION = /\b(send|email|call|ring|pay|submit|book|deliver|drop off|bring|share|forward|return|sign|complete|finish|write|upload|post|transfer|refund|confirm|schedule|arrange|order|buy|fix|reply to)\b|\bget\s+(?:it|them|that|those|the\s+\w+(?:\s+\w+)?)\s+(?:to|over to|back to|across to)\b/i;

// Phrases that look like commitments but are hedges. Checked first.
const HEDGE = /\b(i'?ll (?:have a )?(?:look|think|see|check|consider)|might|maybe|possibly|if i (?:can|get|have)|no promises|try to|hopefully|at some point|when i get a chance|not sure)\b/i;

function clean(value, max = MAX_WHAT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

// Does this sentence contain a commitment the user genuinely made? Returns false for anything
// it is not confident about — the cost of a miss is a missing reminder, the cost of a false
// positive is nagging about something that was never promised.
function looksLikeCommitment(text = '') {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (HEDGE.test(value)) return false;
  if (!UNDERTAKING.test(value)) return false;
  return CONCRETE_ACTION.test(value);
}

// ── Due dates ──────────────────────────────────────────────────────────────────────────

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Only wording that names a real point in time. Anything vaguer stays null — a commitment
// with no due date is a perfectly good commitment, and an invented deadline is not.
// Day boundaries are computed in the USER'S timezone, not UTC. They used to be UTC while
// isDueToday/describeDue compared in Europe/London, so near midnight "tomorrow" came back
// reading as "due today" — caught by a real-clock test rather than a frozen one.
function localDayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// The UTC instant of HH:00 local time, on the local day `n` days from now.
function localDayAt(now, n, hour, timeZone) {
  const key = localDayKey(new Date(now.getTime() + n * 86400000), timeZone);
  const naive = new Date(`${key}T${String(hour).padStart(2, '0')}:00:00.000Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(naive).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(naive.getTime() - (asUTC - naive.getTime()));
}

function extractDueDate(text = '', now = new Date(), timeZone = process.env.TIMEZONE || 'Europe/London') {
  const value = String(text || '').toLowerCase();
  const addDays = (n) => localDayAt(now, n, 0, timeZone);

  if (/\btonight\b/.test(value)) {
    return { dueAt: localDayAt(now, 0, 21, timeZone), dateOnly: false };
  }
  if (/\btoday\b/.test(value)) return { dueAt: addDays(0), dateOnly: true };
  if (/\btomorrow\b/.test(value)) return { dueAt: addDays(1), dateOnly: true };
  if (/\bthis week\b/.test(value)) {
    // The end of the working week, not an arbitrary +7.
    const today = new Date(`${localDayKey(now, timeZone)}T12:00:00.000Z`).getUTCDay();
    const untilFriday = (5 - today + 7) % 7;
    return { dueAt: addDays(untilFriday || 0), dateOnly: true };
  }
  if (/\bnext week\b/.test(value)) return { dueAt: addDays(7), dateOnly: true };

  const byDay = value.match(/\b(?:by|on|before)?\s?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (byDay) {
    const target = DAY_NAMES.indexOf(byDay[1]);
    const today = new Date(`${localDayKey(now, timeZone)}T12:00:00.000Z`).getUTCDay();
    const delta = (target - today + 7) % 7 || 7;
    return { dueAt: addDays(delta), dateOnly: true };
  }

  const iso = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    const parsed = new Date(`${iso[1]}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return { dueAt: parsed, dateOnly: true };
  }
  return { dueAt: null, dateOnly: false };
}

// A date-only commitment is not late until its day is over. Without this, "send it Tuesday"
// would read as overdue from one minute past midnight on Tuesday.
function isOverdue(commitment, now = new Date()) {
  if (!commitment?.due_at || commitment.status !== 'open') return false;
  const due = new Date(commitment.due_at);
  if (Number.isNaN(due.getTime())) return false;
  if (commitment.due_is_date_only) {
    // The local day it falls on, not 23:59 UTC.
    const timeZone = process.env.TIMEZONE || 'Europe/London';
    const endOfDay = localDayAt(due, 1, 0, timeZone);
    return now.getTime() >= endOfDay.getTime();
  }
  return now.getTime() > due.getTime();
}

function isDueToday(commitment, now = new Date(), timeZone = process.env.TIMEZONE || 'Europe/London') {
  if (!commitment?.due_at || commitment.status !== 'open') return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date(commitment.due_at)) === fmt.format(now);
}

// ── Resolution ─────────────────────────────────────────────────────────────────────────

// Evidence strong enough to close a commitment without asking. Deliberately narrow: an
// outbound message to the right person about the right thing, or the user saying so. A
// vaguely-related email is NOT evidence — silently marking something done that was not done
// is the one failure this feature cannot afford.
function matchesSentEvidence(commitment, evidence = {}) {
  if (!commitment || commitment.status !== 'open') return false;
  const recipient = String(evidence.to || '').toLowerCase();
  const person = String(commitment.person_name || '').toLowerCase();
  const sameThread = evidence.threadId && commitment.thread_id && evidence.threadId === commitment.thread_id;
  const samePerson = person && recipient && (recipient.includes(person) || person.includes(recipient.split('@')[0]));
  if (!sameThread && !samePerson) return false;

  // The action word has to actually appear in what was sent, so replying "thanks" on the
  // thread does not close "send the documents".
  const action = (clean(commitment.what).match(CONCRETE_ACTION) || [])[0];
  if (!action) return false;
  const body = `${evidence.subject || ''} ${evidence.body || ''}`.toLowerCase();
  const nouns = clean(commitment.what).toLowerCase().split(/\s+/).filter(w => w.length > 3 && !CONCRETE_ACTION.test(w));
  const nounHit = nouns.length === 0 || nouns.some(noun => body.includes(noun));
  return body.includes(action.toLowerCase()) && nounHit;
}

// ── Formatting ─────────────────────────────────────────────────────────────────────────

function describeDue(commitment, now = new Date(), timeZone = process.env.TIMEZONE || 'Europe/London') {
  if (!commitment.due_at) return 'no date set';
  const due = new Date(commitment.due_at);
  if (isOverdue(commitment, now)) {
    const days = Math.floor((now.getTime() - due.getTime()) / 86400000);
    return days >= 1 ? `overdue by ${days} day${days === 1 ? '' : 's'}` : 'overdue';
  }
  if (isDueToday(commitment, now, timeZone)) return 'due today';
  // Calendar days, not elapsed hours: something due at noon tomorrow is 26 hours away but is
  // still "tomorrow", and rounding hours said "in 2 days".
  const dayKey = (date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const tomorrow = new Date(now.getTime() + 86400000);
  if (dayKey(due) === dayKey(tomorrow)) return 'due tomorrow';
  return `due ${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(due)}`;
}

function describeCommitment(commitment, now = new Date()) {
  const who = commitment.person_name ? ` (${commitment.person_name})` : '';
  return `${clean(commitment.what)}${who} — ${describeDue(commitment, now)}`;
}

// Sorted the way a person would care: late first, then today, then everything else.
function sortCommitments(list = [], now = new Date()) {
  const rank = (c) => (isOverdue(c, now) ? 0 : isDueToday(c, now) ? 1 : c.due_at ? 2 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b) ||
    (new Date(a.due_at || '2999-01-01').getTime() - new Date(b.due_at || '2999-01-01').getTime()));
}

function formatCommitmentList(list = [], { now = new Date(), person = '' } = {}) {
  if (!list.length) {
    return person
      ? `You haven't promised ${person} anything that's still outstanding.`
      : "You don't have anything outstanding that you said you'd do.";
  }
  const sorted = sortCommitments(list, now);
  const overdue = sorted.filter(c => isOverdue(c, now));
  const lines = sorted.slice(0, 10).map(c => describeCommitment(c, now));
  const lead = overdue.length
    ? `${overdue.length} thing${overdue.length === 1 ? ' is' : 's are'} overdue.`
    : `${sorted.length} thing${sorted.length === 1 ? '' : 's'} you said you'd do.`;
  return `${lead} ${lines.join('; ')}.`;
}

module.exports = {
  MAX_WHAT,
  looksLikeCommitment,
  extractDueDate,
  isOverdue,
  isDueToday,
  matchesSentEvidence,
  describeDue,
  describeCommitment,
  sortCommitments,
  formatCommitmentList
};

'use strict';

// Obligations the user has created for themselves. "I'll have a look" is not one; "I'll send
// the documents tomorrow" is. Capture is narrow and evidence-based — something the user said
// outright, or contained in a message they approved and sent. Never from passively read mail.

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

// Past-tense forms of the CONCRETE_ACTION verbs, for recognising completion language ("Sent
// the documents"). A substring check on the base form never matches these — "sent" and "send"
// share none. A fixed map for a fixed verb list, not a conjugator.
const PAST_TENSE = {
  send: 'sent', email: 'emailed', call: 'called', ring: 'rang', pay: 'paid', submit: 'submitted',
  book: 'booked', deliver: 'delivered', 'drop off': 'dropped off', bring: 'brought', share: 'shared',
  forward: 'forwarded', return: 'returned', sign: 'signed', complete: 'completed', finish: 'finished',
  write: 'wrote', upload: 'uploaded', post: 'posted', transfer: 'transferred', refund: 'refunded',
  confirm: 'confirmed', schedule: 'scheduled', arrange: 'arranged', order: 'ordered', buy: 'bought',
  fix: 'fixed', 'reply to': 'replied to'
};

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

// Only wording naming a real point in time; anything vaguer stays null, since an invented
// deadline is worse than none. Day boundaries are in the user's timezone, not UTC — in UTC,
// "tomorrow" reads back as "due today" near midnight.
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

// How confident the identity match is, independent of what the message says, strongest first:
//   thread       — the same conversation; the context is the promise.
//   participant  — the same person by stable id. A string match would only be a guess at that.
//   address      — no thread and no participant record: an exact recipient match, never a
//                  substring and never a display name.
//   none         — nothing ties them. Refused, not guessed.
function evidenceIdentity(commitment, evidence = {}) {
  if (evidence.threadId && commitment.thread_id && evidence.threadId === commitment.thread_id) {
    return 'thread';
  }
  if (commitment.participant_id && evidence.participantId && commitment.participant_id === evidence.participantId) {
    return 'participant';
  }
  const recipient = String(evidence.to || '').trim().toLowerCase();
  const recorded = String(commitment.person_name || '').trim().toLowerCase();
  if (recipient && recorded && recipient === recorded && recipient.includes('@')) {
    return 'address';
  }
  return 'none';
}

// Every word a sibling open commitment on the same thread is about. A word shared by two live
// promises ("board" in both board pack and board deck) can't tell them apart, so it can't
// close either on its own.
function ambiguousThreadWords(commitment, siblings = []) {
  const words = new Set();
  for (const other of siblings) {
    if (!other || other === commitment || other.id === commitment.id) continue;
    if (other.status !== 'open') continue;
    if (!other.thread_id || other.thread_id !== commitment.thread_id) continue;
    const otherSubject = commitmentSubject(other.what);
    if (!otherSubject) continue;
    for (const word of otherSubject.words) words.add(word);
  }
  return words;
}

// Evidence strong enough to close a commitment unasked: an outbound message to the right
// person about the right thing, or the user saying so. Marking something done that wasn't is
// the failure to avoid. `siblings` (the user's other open commitments, optional) is what lets
// a same-thread match check the matched word actually distinguishes this promise.
function matchesSentEvidence(commitment, evidence = {}, { siblings = [] } = {}) {
  if (!commitment || commitment.status !== 'open') return false;

  const identity = evidenceIdentity(commitment, evidence);
  if (identity === 'none') return false;

  // The action word must appear in what was sent, so "thanks" doesn't close "send the
  // documents". Quoted and forwarded text is stripped first, or the promise's own words come
  // back through the quote and satisfy the check on their own.
  const subject = commitmentSubject(commitment.what);
  if (!subject) return false;
  const rawBody = stripQuotedContent(`${evidence.subject || ''} ${evidence.body || ''}`).toLowerCase();
  // Body alone: a "Re:" subject is carried forward unedited and is not evidence of anything
  // freshly written. Only used by the same-thread tie-break below.
  const bodyOnly = stripQuotedContent(String(evidence.body || '')).toLowerCase();

  // A future-tense mention of the verb is a new undertaking, not evidence: "I will also send
  // the deck" contains "send" as much as "sending it now" does. Those are stripped first, and
  // only what remains is read for completion language.
  const action = subject.action.toLowerCase();
  const body = stripFuturePromiseOf(rawBody, action);
  const actionForms = [action, PAST_TENSE[action]].filter(Boolean);
  if (!actionForms.some(form => body.includes(form))) return false;

  // And about the same thing. Matching runs on the promise's subject words, not any long word
  // in it — otherwise "today" and "before end of play" close unrelated promises.
  if (!subject.words.size) return true;
  const matchedWords = [...subject.words].filter(word => body.includes(word));
  if (!matchedWords.length) return false;

  // Off-thread, identity alone isn't enough — the right person can email about anything else.
  // Every one of the promise's words has to appear, not just one.
  if (identity !== 'thread') return matchedWords.length === subject.words.size;

  // On-thread, one overlapping word is a fair check unless a sibling promise shares it — then
  // at least one matched word must be unique to this commitment, and must come from the body.
  // A carried-forward subject naming both would otherwise satisfy both siblings on every reply.
  const ambiguous = ambiguousThreadWords(commitment, siblings);
  const matchedBodyWords = [...subject.words].filter(word => bodyOnly.includes(word));
  return matchedBodyWords.some(word => !ambiguous.has(word));
}

// Lines a client adds when quoting ("On Tue, 12 Aug, Mia wrote:", "> "). Stripped for evidence
// matching only. Line heuristics, not a MIME parser — enough to keep a quoted promise from
// counting as its own fulfilment.
function stripQuotedContent(text = '') {
  const lines = String(text).split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}$/i.test(line.trim())) break;
    if (/^\s*On .{3,80} wrote:\s*$/i.test(line)) break;
    kept.push(line);
  }
  return kept.join(' ');
}

// Strips "I will/I'll/I'm going to ... ACTION": a future-tense verb is a new undertaking, not
// evidence. What survives is checked for real completion language ("sent X", "here it is").
function stripFuturePromiseOf(text, action) {
  const escapedAction = String(action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\b(?:i(?:'| a)?ll|i will|i'm going to|i am going to|i shall|i promise|i'?ve got to|i need to|let me|will)` +
    `\\s+(?:also\\s+|just\\s+|then\\s+)?${escapedAction}\\b`,
    'gi'
  );
  return String(text).replace(pattern, ' ');
}

// ── What a real, sent email means ──────────────────────────────────────────────────────

// What was promised, not the whole email and not the whole sentence: downstream copy already
// supplies "you told Mia you'd", so what is stored is the bare action ("send the board pack
// today"), not the undertaking around it.
function extractCommitmentSentence(text = '') {
  const sentence = String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(part => part.trim())
    .find(part => looksLikeCommitment(part));
  if (!sentence) return null;

  const undertaking = sentence.match(UNDERTAKING);
  if (!undertaking) return clean(sentence);
  // Drops the preamble before the promise ("One more thing — ") along with the undertaking.
  const action = sentence.slice(sentence.indexOf(undertaking[0]) + undertaking[0].length);
  const trimmed = action.replace(/^[\s,:—–-]+/, '').replace(/^(also|then|just|please)\b[\s,]*/i, '').trim();
  return clean(trimmed || sentence);
}

// Timing and glue words. They say nothing about what was promised, and without excluding them
// an invoice and a contract both reduce to {will, tomorrow} and read as duplicates.
const TIME_AND_GLUE = new Set([
  'will', 'shall', 'going', 'gonna', 'about', 'just', 'then', 'once', 'when', 'also', 'with',
  'today', 'tonight', 'tomorrow', 'morning', 'afternoon', 'evening', 'week', 'weekend',
  'later', 'soon', 'asap', 'first', 'thing', 'next', 'this', 'that', 'them', 'they', 'your',
  'yours', 'over', 'across', 'back', 'straight', 'right', 'away', 'monday', 'tuesday',
  'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // Politeness and idiom. "end of play" put "play" in the subject of a board-pack promise.
  'before', 'after', 'around', 'play', 'again', 'still', 'quick', 'quickly', 'sorry',
  'really', 'please', 'thanks', 'anything', 'something', 'everything', 'promised'
]);

// What a promise is ABOUT: the action verb, plus the meaningful words that follow it.
// Everything before the verb is the undertaking ("I will"), which is identical across every
// commitment and therefore useless for telling them apart.
function commitmentSubject(text = '') {
  const value = clean(text).toLowerCase();
  const match = value.match(CONCRETE_ACTION);
  if (!match) return null;
  const object = value.slice(value.indexOf(match[0]) + match[0].length);
  const words = object.split(/\s+/)
    .map(word => word.replace(/[^a-z0-9]/g, ''))
    .filter(word => word.length > 3 && !TIME_AND_GLUE.has(word) && !CONCRETE_ACTION.test(word));
  return { action: match[0], words: new Set(words) };
}

// Two phrasings of one promise on one thread are one promise, so an edited draft or a retry
// doesn't produce a second row. Matched on overlap, since a rewording is not word-for-word.
function duplicatesExisting(sentence, open = [], { threadId = null } = {}) {
  const candidate = commitmentSubject(sentence);
  if (!candidate) return false;
  return open.some(existing => {
    if (existing.status !== 'open') return false;
    // Same conversation, or no thread on either side to distinguish them by. Promising the
    // same thing to someone else is a second, real obligation.
    if (threadId && existing.thread_id && existing.thread_id !== threadId) return false;
    const other = commitmentSubject(existing.what);
    if (!other || other.action !== candidate.action) return false;
    // Nothing specific on either side: same verb on the same thread is as much as we know.
    if (!candidate.words.size && !other.words.size) return true;
    // Duplicate only when the smaller word set is fully contained in the larger: a rewording
    // reduces to the same set or a subset, while a board pack and a board deck share one word
    // and are two real promises.
    const [smaller, larger] = candidate.words.size <= other.words.size
      ? [candidate.words, other.words] : [other.words, candidate.words];
    return smaller.size > 0 && [...smaller].every(word => larger.has(word));
  });
}

// Given an email that was actually sent and the currently open commitments, decide what to
// record and what to close. Pure, so every judgement is testable without a mailbox; the caller
// must only call it on a send that genuinely succeeded, never a draft or a failed attempt.
function reconcileSentEmail({ sent = {}, open = [], now = new Date(), timeZone = process.env.TIMEZONE || 'Europe/London' } = {}) {
  const body = String(sent.body || '');
  const evidence = {
    to: sent.to, subject: sent.subject, body, threadId: sent.threadId,
    // The caller resolves this through the real people layer — pure code has no database to
    // ask. Absent (rather than guessed) whenever the recipient could not be resolved to a
    // saved person, which correctly drops evidenceIdentity to the address/none tiers.
    participantId: sent.participantId || null
  };

  // Closing comes first. Every commitment sees the full open list as siblings, so a same-thread
  // match can check the word it matched on is unique to this promise.
  const resolves = open.filter(commitment => matchesSentEvidence(commitment, evidence, { siblings: open }));

  // Capturing is independent — "here's the case study, and I'll send the deck Friday"
  // both closes one thing and opens another.
  const sentence = extractCommitmentSentence(body);
  let capture = null;
  if (sentence && !duplicatesExisting(sentence, open, { threadId: sent.threadId })) {
    const due = extractDueDate(sentence, now, timeZone);
    capture = {
      what: clean(sentence),
      dueAt: due.dueAt,
      dueIsDateOnly: due.dateOnly,
      threadId: sent.threadId || null,
      personEmail: sent.to || null,
      source: 'sent_email',
      sourceRef: { messageId: sent.messageId || null, threadId: sent.threadId || null, subject: sent.subject || null }
    };
  }

  return { capture, resolves };
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
  evidenceIdentity,
  ambiguousThreadWords,
  stripQuotedContent,
  stripFuturePromiseOf,
  extractCommitmentSentence,
  commitmentSubject,
  reconcileSentEmail,
  describeDue,
  describeCommitment,
  sortCommitments,
  formatCommitmentList
};

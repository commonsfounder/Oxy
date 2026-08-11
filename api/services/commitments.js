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

// The past-tense form of each CONCRETE_ACTION verb, used only to recognise completion
// language ("Sent the documents", "Paid the invoice"). Not a general conjugator — a fixed,
// small map for a fixed, small verb list. Found missing live-adjacent: a base-form substring
// check means "sent" never matches "send" (they don't share a substring at all), so the single
// most natural way to say a thing was done — the plain past tense — silently never counted as
// evidence, for every verb in this list, until now.
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

// How confident the identity match itself is, independent of what the message says. Ordered
// most to least stable:
//   thread       — the same real conversation. Not an identity claim at all, but stronger
//                   than one: the context IS the promise.
//   participant  — the same person, by the people layer's own stable id. Two people can
//                   share a nickname; the same person can be reached at more than one
//                   address. An id match is real identity; a string match is a guess about it.
//   address      — last resort: no thread, and no participant record to anchor to (a
//                   commitment captured before resolution existed, or a recipient with no
//                   saved contact). The recipient address matches the one the commitment was
//                   filed under, EXACTLY — never a substring, never a display-name guess.
//   none         — nothing ties this message to this commitment. Refused, not guessed.
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

// Every word a sibling open commitment ON THE SAME THREAD is about. A word that shows up in
// more than one live promise on that thread cannot tell them apart, so it must not be trusted
// alone — this is what stops "send Mia the board PACK" and "send Mia the board DECK", both
// open on one thread, from being confused by an email that only says "board" (found live: a
// reply that actually fulfilled the pack falsely resolved the deck too, because "board" alone
// satisfied the old any-word-on-thread rule for both).
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

// Evidence strong enough to close a commitment without asking. Deliberately narrow: an
// outbound message to the right person about the right thing, or the user saying so. A
// vaguely-related email is NOT evidence — silently marking something done that was not done
// is the one failure this feature cannot afford.
//
// `siblings` is every other OPEN commitment for this user, passed through so a same-thread
// match can tell whether the word that matched actually distinguishes this promise from
// another live one on the same conversation. Optional and defaults to none, so existing
// direct callers keep working exactly as before — they just lose the extra ambiguity check.
function matchesSentEvidence(commitment, evidence = {}, { siblings = [] } = {}) {
  if (!commitment || commitment.status !== 'open') return false;

  const identity = evidenceIdentity(commitment, evidence);
  if (identity === 'none') return false;

  // The action word has to actually appear in what was sent, so replying "thanks" on the
  // thread does not close "send the documents". Checked against content with quoted/forwarded
  // text removed — a reply that quotes the ORIGINAL promise back (Gmail includes the full
  // prior message by default) or a forward of an old email would otherwise trivially satisfy
  // both the action word and every subject word without the user having sent anything new.
  const subject = commitmentSubject(commitment.what);
  if (!subject) return false;
  const rawBody = stripQuotedContent(`${evidence.subject || ''} ${evidence.body || ''}`).toLowerCase();
  // The message BODY alone, no subject — Gmail (and most clients) carries a thread's original
  // subject line forward unedited on every reply ("Re: ..."), so unlike the body, it is not
  // evidence of anything the sender freshly wrote in THIS message. Needed only for the
  // same-thread disambiguation tie-break below.
  const bodyOnly = stripQuotedContent(String(evidence.body || '')).toLowerCase();

  // Found live, capturing a SECOND promise on the same thread as a first: "I will also send
  // the board deck tomorrow" resolved "send the board pack" — because the action word check
  // was a bare substring test, "will ALSO SEND" contains "send" exactly as much as "SENDING
  // it now" does. A future-tense mention of the verb is a NEW undertaking, not evidence
  // anything was done; only what remains after stripping "I will/I'll/... ACTION" occurrences
  // is checked for real completion language ("sending X now", "sent X", "here it is").
  const action = subject.action.toLowerCase();
  const body = stripFuturePromiseOf(rawBody, action);
  const actionForms = [action, PAST_TENSE[action]].filter(Boolean);
  if (!actionForms.some(form => body.includes(form))) return false;

  // And it has to be about the same THING. This used to accept any word over three letters
  // from the commitment, which meant "today", "before" and "play" all counted — so on a live
  // thread "I will send the revised slides today" closed "send the board pack today, before
  // end of play". Matching now runs on the promise's subject words, which exclude the timing
  // and glue vocabulary that every promise shares.
  if (!subject.words.size) return true;
  const matchedWords = [...subject.words].filter(word => body.includes(word));
  if (!matchedWords.length) return false;

  // Off-thread: identity alone — even a real participant id, even an exact address — is NOT
  // enough. "send Mia the board deck" and an unrelated "Board meeting agenda attached" share
  // both the recipient and a word, and are still two different things. Every one of the
  // promise's words has to show up, not just one.
  if (identity !== 'thread') return matchedWords.length === subject.words.size;

  // On-thread: a shared conversation is already strong evidence this message is about SOME
  // promise in it, so any one overlapping word is normally a fair sanity check. But if that
  // word is also what a sibling promise on the same thread is about, it cannot disambiguate
  // between them — at least one matched word has to be something ONLY this commitment is about.
  // That disambiguating word must come from the BODY: a static subject line ("Re: board deck
  // and board pack", unedited by the sender) would otherwise satisfy BOTH siblings' unique
  // word on every single reply, forever, which is exactly the false positive this check exists
  // to prevent — found live: a reply that only fulfilled the deck, with the original two-item
  // subject still attached by Gmail's own reply convention, falsely resolved the pack too.
  const ambiguous = ambiguousThreadWords(commitment, siblings);
  const matchedBodyWords = [...subject.words].filter(word => bodyOnly.includes(word));
  return matchedBodyWords.some(word => !ambiguous.has(word));
}

// Lines an email client adds when quoting a prior message — "On Tue, 12 Aug, Mia wrote:",
// "-----Original Message-----", or a line starting with the quote marker "> ". Stripped
// before evidence matching only; the full text is still what gets stored/displayed anywhere
// else. Deliberately simple line-based heuristics, not a MIME quote parser — good enough to
// stop an old promise's own words from re-triggering the check that promise's fulfillment.
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

// Strips "I will/I'll/I'm going to/... ACTION" occurrences — a future-tense mention of the
// verb is a NEW undertaking about whatever follows it, not evidence that action has happened.
// "I will also send the board deck tomorrow" must not read as completion evidence for a
// DIFFERENT, already-open "send the board pack" commitment merely because it contains the
// word "send" — it is a second promise, not a first one being kept. What survives stripping
// is checked for genuine completion language: "sending X now", "sent X", "here it is".
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

// The commitment is what was PROMISED, not the whole email and not the whole sentence.
//
// Two trims matter. Storing the body would put a paragraph of pleasantries into a to-do list.
// And storing the sentence verbatim keeps the undertaking in it — "I will send the board pack
// today" — which then reads back through the digest's own phrasing as "You told Mia you'd
// I will send the board pack today". Everything downstream already supplies the "you'd", so
// what is stored is the action: "send the board pack today".
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

// Words that say WHEN or merely glue a sentence together. They carry no information about
// what was promised, so they must not make two different promises look alike: without this,
// "I'll send the invoice tomorrow" and "I'll send the contract tomorrow" both reduce to
// {will, tomorrow} and the second would be swallowed as a duplicate of the first.
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

// Two phrasings of the same promise on the same thread are one promise — this is what stops
// an edited draft, or a retry after a transport error, from producing a second row. Matched
// on overlap rather than equality, because a reworded draft is not word-for-word: "I will
// send the case study tomorrow" and "Quick correction: I will send you the case study
// tomorrow morning" are the same undertaking.
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
    // One shared word used to be enough — found live: "I will send the board pack tomorrow"
    // then "I will also send the board deck tomorrow" on the same thread. Both share "board",
    // so the second was silently dropped as a "duplicate" of the first and never captured at
    // all, even though a pack and a deck are two different real promises. A genuine rewording
    // ("the case study" vs "you the case study tomorrow morning") reduces to the SAME word
    // set or a subset of it; two different objects that merely share one descriptor do not.
    // So: duplicate only when the smaller word set is fully contained in the larger one —
    // full containment survives paraphrase, and a single shared generic word no longer does.
    const [smaller, larger] = candidate.words.size <= other.words.size
      ? [candidate.words, other.words] : [other.words, candidate.words];
    return smaller.size > 0 && [...smaller].every(word => larger.has(word));
  });
}

// The whole point of this module, finally connected to something real: given an email that
// was ACTUALLY SENT (approved by the user, accepted by Gmail) and the commitments currently
// open, decide what to record and what to close.
//
// Pure on purpose — every judgement about a real-world obligation is testable without a
// mailbox. The caller is responsible for only invoking this on a send that genuinely
// succeeded; a draft, a queued message, or a failed attempt must never reach here.
function reconcileSentEmail({ sent = {}, open = [], now = new Date(), timeZone = process.env.TIMEZONE || 'Europe/London' } = {}) {
  const body = String(sent.body || '');
  const evidence = {
    to: sent.to, subject: sent.subject, body, threadId: sent.threadId,
    // The caller resolves this through the real people layer — pure code has no database to
    // ask. Absent (rather than guessed) whenever the recipient could not be resolved to a
    // saved person, which correctly drops evidenceIdentity to the address/none tiers.
    participantId: sent.participantId || null
  };

  // Closing comes first: an email that discharges a promise is evidence about that promise.
  // Every commitment sees the full open list as potential siblings, so same-thread matching
  // can tell whether the word it matched on actually distinguishes this promise from another
  // live one on the same conversation.
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

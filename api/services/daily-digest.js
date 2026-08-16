'use strict';

// "What do I need to know today?" — the composed answer, not a dump of every source.
//
// Deliberately NOT a second copy of life-briefing.js: that module renders the iOS Home
// card (hard cap of 3 items, `prompt` strings shaped for tappable cards) and its email
// source is the message-level triage signal, which cannot tell you whether a THREAD is
// still waiting on you. This is the conversational answer, which needs a different item
// budget, real follow-up handles (thread ids, scheduled-task ids) so "draft the reply to
// Mia" works straight after, and the thread-level judgment from reply-needed.js.
//
// What it DOES reuse from life-briefing.js: normalizeEvent and normalizeApproval, so a
// calendar event or a pending approval ranks the same whether the user reads it on the
// Home screen or asks in chat. Two ranking scales for the same object would be the actual
// silo.

const { normalizeEvent, normalizeApproval } = require('./life-briefing');
const { daysUntil, formatMonthDay } = require('./occasions');
const commitmentLogic = require('./commitments');

// A morning digest is about today. life-briefing's 48h calendar horizon is right for a
// card that sits on screen all day; for "what's on my plate" an event 40 hours out is
// noise the user has to mentally discard.
const CALENDAR_HORIZON_HOURS = 24;
// Birthdays/anniversaries need lead time to actually do something about (buy, post, book).
// Two weeks is the prep window; beyond that it is a fact, not something on today's plate.
const OCCASION_HORIZON_DAYS = 14;
// A watch result the user has not opened yet is news. After a day and a half it is history
// — surfacing it again just makes the digest feel stale.
const WATCH_UPDATE_MAX_AGE_HOURS = 36;
const MAX_ITEMS = 12;

// Priority tiers. Anything at or above NOW_TIER is something a person would want said
// first; below SOON_TIER is the honest answer to "what can wait?".
const NOW_TIER = 80;
const SOON_TIER = 60;

// The recurring morning digest is itself a scheduled task, and its own run writes a
// briefing row. Without this marker tomorrow's digest would list today's digest as
// something on the user's plate — a self-referencing loop that looks like a bug because
// it is one. Both the task instruction and the briefing title carry it.
const DIGEST_MARKER = 'daily_digest';

function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clean(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstName(value) {
  const name = displayPerson(value);
  if (!name) return name;
  return name.split(' ')[0];
}

// A commitment captured from a sent email records the recipient's ADDRESS, because that is
// what the mailbox gave us and what later evidence is matched against. Reading it back at the
// user as "You told chizigamonyewuchi@gmail.com you'd send the board pack" is nobody's idea
// of a useful sentence, so the local part is used for display while the row keeps the address.
function displayPerson(value) {
  const name = clean(value, 80);
  if (!name.includes('@')) return name;
  return clean(name.split('@')[0].replace(/[._+-]+/g, ' '), 60);
}

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

function describeAge(dateString, now) {
  const then = asDate(dateString);
  if (!then) return '';
  const days = daysBetween(then, now);
  if (days <= 0) return ' (today)';
  if (days === 1) return ' (yesterday)';
  return ` (${days} days)`;
}

function describeDueTime(date, now, timeZone) {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000);
  if (minutes < -24 * 60) return `overdue since ${new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(date)}`;
  if (minutes < -60) return `overdue by ${Math.round(-minutes / 60)} hours`;
  if (minutes < 0) return 'overdue';
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit' }).format(date);
  if (minutes < 60) return `due in ${minutes} minutes`;
  return `due at ${time}`;
}

function sameLocalDay(a, b, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(a) === fmt.format(b);
}

// ── Per-source normalizers ─────────────────────────────────────────────────────────────
// Each returns the shared item shape { id, kind, title, detail, priority, ref, followUp }
// or null when the thing does not belong on today's plate at all.

// Someone actively waiting on the user is the single most common real "thing on my plate",
// so it scores from a high base — but stays below an imminent meeting or a pending
// approval, which have a hard deadline the user cannot recover from by acting later.
function normalizeReplyItem(item = {}, now = new Date()) {
  if (!item.threadId) return null;
  const waitingDays = (() => {
    const since = asDate(item.waitingSince);
    return since ? Math.max(0, daysBetween(since, now)) : 0;
  })();

  let priority = 60;
  if (item.urgency === 'now') priority += 22;
  else if (item.urgency === 'soon') priority += 8;
  if (waitingDays >= 7) priority += 14;
  else if (waitingDays >= 3) priority += 8;
  else if (waitingDays >= 1) priority += 3;
  // A concrete action (sign this, send that) is harder to do later than a reply.
  if (item.kind === 'action') priority += 4;

  const sender = clean(item.sender, 80) || 'Someone';
  const verb = item.kind === 'action' ? 'needs you to' : 'is waiting on you to';
  return {
    id: `reply:${item.threadId}`,
    kind: 'reply_needed',
    title: sender,
    detail: `${sender} ${verb} ${clean(item.whatTheyNeed, 140) || 'reply'}${describeAge(item.waitingSince, now)}`,
    priority: Math.min(priority, 93),
    sortTime: asDate(item.waitingSince)?.getTime() || Number.MAX_SAFE_INTEGER,
    ref: { threadId: item.threadId, sender, subject: clean(item.subject, 140) },
    followUp: `Draft the reply to ${firstName(sender)}`
  };
}

// Proximity IS the priority here — a birthday tomorrow is a real problem, one in twelve
// days is a heads-up so there is still time to buy something.
function normalizeOccasionItem(occasion = {}, now = new Date()) {
  if (!occasion.personName || !occasion.month || !occasion.day) return null;
  const until = Number.isFinite(occasion.daysUntil)
    ? occasion.daysUntil
    : daysUntil(occasion.month, occasion.day, now);
  if (until > OCCASION_HORIZON_DAYS) return null;

  const priority = until === 0 ? 86 : until === 1 ? 80 : until <= 3 ? 70 : until <= 7 ? 60 : 48;
  const when = until === 0 ? 'today' : until === 1 ? 'tomorrow' : `in ${until} days`;
  const type = clean(occasion.occasionType || 'birthday', 40);
  const person = clean(occasion.personName, 80);
  return {
    id: `occasion:${person}:${type}`,
    kind: 'occasion',
    title: `${person}'s ${type}`,
    detail: `${person}'s ${type} is ${when} (${formatMonthDay(occasion.month, occasion.day)})${occasion.relationship ? ` — your ${clean(occasion.relationship, 40)}` : ''}`,
    priority,
    sortTime: until,
    ref: { personName: person, occasionType: type, month: occasion.month, day: occasion.day, daysUntil: until },
    followUp: /birthday|anniversary/i.test(type) ? `Find a gift for ${firstName(person)}` : `Remind me about ${firstName(person)}'s ${type}`
  };
}

// scheduled_tasks rows are the only durable, server-side reminder store (create_reminder
// is a device deep-link and leaves nothing behind here). A condition-bearing row is a
// watch, not a reminder: a watch that checked and found nothing is not news, so it only
// reaches the digest through a real state change (normalizeWatchUpdate below).
function normalizeReminderItem(task = {}, now = new Date(), timeZone = 'Europe/London') {
  if (!task?.title) return null;
  if (task.condition || task.recurrence === 'poll') return null;
  if (String(task.instruction || '').includes(DIGEST_MARKER)) return null;
  const due = asDate(task.next_run_at);
  if (!due) return null;

  const overdue = due.getTime() < now.getTime();
  const today = sameLocalDay(due, now, timeZone);
  // A reminder due next Tuesday is not on today's plate. Only overdue and today's count.
  if (!overdue && !today) return null;

  return {
    id: `reminder:${task.id || task.title}`,
    kind: 'reminder',
    title: clean(task.title, 140),
    detail: `${clean(task.title, 140)} — ${describeDueTime(due, now, timeZone)}`,
    priority: overdue ? 90 : 72,
    sortTime: due.getTime(),
    ref: { scheduledTaskId: task.id || null, title: clean(task.title, 140), dueAt: due.toISOString() },
    followUp: `Move "${clean(task.title, 60)}" to tomorrow`
  };
}

// The real record of "your parcel changed to out for delivery": a background watch run
// that genuinely triggered writes an unread briefing row. Nothing here invents a state —
// if the watch did not fire, there is no row, and the digest stays quiet about it.
function normalizeWatchUpdate(briefing = {}, now = new Date()) {
  const title = clean(briefing.title, 140);
  if (!title) return null;
  if (title.includes(DIGEST_MARKER)) return null;
  const created = asDate(briefing.created_at);
  if (created && (now.getTime() - created.getTime()) > WATCH_UPDATE_MAX_AGE_HOURS * 3600000) return null;

  const status = String(briefing.metadata?.status || 'completed');
  const body = clean(briefing.body, 220);
  // Ranking within triggered watches by how time-critical the transition is — a parcel
  // arriving today is actionable now, a price drop is actionable whenever.
  const timeCritical = /out for delivery|delivery attempted|delivered today|arriving today|collect(ion)? by|expires? (today|tomorrow)/i.test(body);
  const priority = status === 'waiting_approval' ? 88
    : status === 'failed' ? 46
      : status === 'triggered' ? (timeCritical ? 82 : 74)
        : 58;

  return {
    id: `watch:${briefing.id || title}`,
    kind: status === 'failed' ? 'watch_problem' : 'watch_update',
    title,
    detail: body || (status === 'failed' ? `Millie could not check "${title}".` : title),
    priority,
    sortTime: created?.getTime() || Number.MAX_SAFE_INTEGER,
    ref: { briefingId: briefing.id || null, scheduledTaskId: briefing.metadata?.scheduledTaskId || null, status },
    followUp: `What's happening with ${title}?`
  };
}

// Something the user themselves promised is the highest-value thing a digest can carry: it is
// the only category where they are the blocker AND someone else may be waiting. Overdue
// outranks everything except a pending approval and an imminent meeting.
function normalizeCommitmentItem(commitment = {}, now = new Date()) {
  if (!commitment.what || commitment.status !== 'open') return null;
  const overdue = commitmentLogic.isOverdue(commitment, now);
  const dueToday = commitmentLogic.isDueToday(commitment, now);
  // A promise with no date, or one due next week, is not on TODAY's plate.
  if (!overdue && !dueToday) return null;

  const person = displayPerson(commitment.person_name);
  return {
    id: `commitment:${commitment.id || commitment.what}`,
    kind: 'commitment',
    title: clean(commitment.what, 140),
    detail: person
      ? `You told ${person} you'd ${clean(commitment.what, 120)} — ${commitmentLogic.describeDue(commitment, now)}`
      : `You said you'd ${clean(commitment.what, 120)} — ${commitmentLogic.describeDue(commitment, now)}`,
    priority: overdue ? 92 : 78,
    sortTime: commitment.due_at ? new Date(commitment.due_at).getTime() : Number.MAX_SAFE_INTEGER,
    ref: { commitmentId: commitment.id || null, personName: person || null, threadId: commitment.thread_id || null },
    followUp: person ? `Draft the message to ${firstName(person)}` : `Mark "${clean(commitment.what, 50)}" done`
  };
}

// Calendar and approvals go through life-briefing's own normalizers so the ranking matches
// the Home card exactly; only the shape is adapted (digest items carry refs/follow-ups).
function adaptBriefingItem(item, extra = {}) {
  if (!item) return null;
  return {
    id: item.id,
    kind: item.kind,
    title: clean(item.title, 140),
    detail: clean(item.detail, 220),
    priority: item.priority,
    sortTime: item.sortTime ?? Number.MAX_SAFE_INTEGER,
    ...extra
  };
}

function normalizeCalendarItem(event, now, timeZone) {
  const base = normalizeEvent(event, now);
  if (!base) return null;
  const start = asDate(event?.start?.dateTime || event?.start?.date || event?.start);
  if (!start) return null;
  if ((start.getTime() - now.getTime()) > CALENDAR_HORIZON_HOURS * 3600000) return null;
  const tomorrow = !sameLocalDay(start, now, timeZone);
  return adaptBriefingItem(base, {
    // A tomorrow-morning event survives the 24h horizon but must not outrank today's work.
    priority: tomorrow ? Math.min(base.priority, 58) : base.priority,
    ref: { eventId: event?.id || null, startsAt: start.toISOString() },
    followUp: `Help me prepare for ${clean(base.title, 60)}`
  });
}

function normalizeApprovalItem(approval) {
  const base = normalizeApproval(approval);
  return adaptBriefingItem(base, {
    ref: { approvalId: approval?.approvalId || null, taskId: approval?.taskId || null },
    followUp: `Approve: ${clean(base?.title, 60)}`
  });
}

// ── Composition ────────────────────────────────────────────────────────────────────────

function tierOf(priority) {
  if (priority >= NOW_TIER) return 'now';
  if (priority >= SOON_TIER) return 'today';
  return 'soon';
}

function buildDailyDigest({
  replyNeeded = [],
  occasions = [],
  commitments = [],
  scheduledTasks = [],
  watchUpdates = [],
  calendarEvents = [],
  approvals = [],
  coverage = {},
  focus = 'all',
  now = new Date(),
  timeZone = process.env.TIMEZONE || 'Europe/London'
} = {}) {
  const reference = asDate(now) || new Date();

  const items = [
    ...approvals.map(normalizeApprovalItem),
    ...calendarEvents.map(event => normalizeCalendarItem(event, reference, timeZone)),
    ...replyNeeded.map(item => normalizeReplyItem(item, reference)),
    ...scheduledTasks.map(task => normalizeReminderItem(task, reference, timeZone)),
    ...commitments.map(commitment => normalizeCommitmentItem(commitment, reference)),
    ...watchUpdates.map(update => normalizeWatchUpdate(update, reference)),
    ...occasions.map(occasion => normalizeOccasionItem(occasion, reference))
  ].filter(Boolean).map(item => ({ ...item, urgency: tierOf(item.priority) }));

  // Collapse repeats of the SAME underlying thing before ranking. Found against real data: a
  // single price watch that had run nine times filled nine of the twelve slots with identical
  // "Track Brighton hotel price drops" cards and pushed a real birthday off the digest
  // entirely. One watch is one line, however many times it has reported.
  const deduped = [];
  const seen = new Set();
  const bySubject = new Map();
  for (const item of items.sort((a, b) => b.priority - a.priority || a.sortTime - b.sortTime)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    // Only watch updates repeat this way; a reminder and a calendar event are distinct
    // objects even when they share a title.
    const subject = item.kind === 'watch_update' || item.kind === 'watch_problem'
      ? `${item.kind}:${item.ref?.scheduledTaskId || item.title.toLowerCase()}`
      : null;
    if (subject) {
      const existing = bySubject.get(subject);
      if (existing) { existing.repeats = (existing.repeats || 1) + 1; continue; }
      bySubject.set(subject, item);
    }
    deduped.push(item);
  }
  for (const item of deduped) {
    if (item.repeats > 1) {
      item.detail = `${item.detail} (${item.repeats} updates from this watch)`;
    }
  }

  const focused = focus === 'urgent' ? deduped.filter(i => i.urgency === 'now')
    : focus === 'can_wait' ? deduped.filter(i => i.urgency === 'soon')
      : deduped;

  const shown = focused.slice(0, MAX_ITEMS);
  return {
    items: shown,
    hidden: Math.max(0, focused.length - shown.length),
    empty: shown.length === 0,
    focus,
    coverage,
    generatedAt: reference.toISOString(),
    text: formatDigest(shown, { focus, coverage, hidden: Math.max(0, focused.length - shown.length) })
  };
}

// Honest about what was actually checked. A digest that says "nothing needs you" while
// Gmail was unreachable is a lie by omission — the user would act on it.
function describeGaps(coverage = {}) {
  const gaps = Object.entries(coverage)
    .filter(([, value]) => value && value.ok === false && value.reason)
    .map(([source, value]) => `${source} (${clean(value.reason, 120)})`);
  if (!gaps.length) return '';
  return ` I could not check ${gaps.join(', ')}, so this may be incomplete.`;
}

function formatDigest(items = [], { focus = 'all', coverage = {}, hidden = 0 } = {}) {
  const gaps = describeGaps(coverage);
  if (!items.length) {
    const base = focus === 'urgent' ? 'Nothing urgent right now.'
      : focus === 'can_wait' ? 'Nothing sitting in the "can wait" pile.'
        : "Nothing waiting today.";
    return `${base}${gaps}`;
  }

  const sections = [
    ['Needs you now', items.filter(i => i.urgency === 'now')],
    ['Today', items.filter(i => i.urgency === 'today')],
    ['Can wait', items.filter(i => i.urgency === 'soon')]
  ].filter(([, list]) => list.length);

  const body = sections
    .map(([label, list]) => `${label}: ${list.map(i => i.detail).join('. ')}.`)
    .join(' ');
  const more = hidden > 0 ? ` (+${hidden} more)` : '';
  return `${body}${more}${gaps}`;
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function countWord(n) { return COUNT_WORDS[n] || String(n); }

// The digest as something a person would want to receive, rather than the in-app card text.
// The distinction matters: an outbound message arrives with no surrounding interface, so it
// has to say what it is, lead with what actually needs doing, and be skimmable. Returns null
// when there is nothing worth interrupting someone for — an empty digest is a fine thing to
// see in the app and a bad thing to be emailed.
function formatDigestNotification(digest = {}) {
  const items = digest.items || [];
  if (!items.length) return null;

  const pressing = items.filter(item => item.urgency === 'now' || item.urgency === 'today');
  const later = items.filter(item => item.urgency === 'soon');
  const lead = pressing.length ? pressing : items;

  const count = countWord(lead.length);
  const title = lead.length === 1
    ? 'One thing needs you today'
    : `${count.charAt(0).toUpperCase()}${count.slice(1)} things need you today`;

  const lines = lead.map(item => `• ${item.detail}`);
  if (pressing.length && later.length) {
    lines.push('');
    lines.push(`When you get a chance: ${later.map(item => item.title).join('; ')}.`);
  }
  if (digest.hidden > 0) lines.push(`(+${digest.hidden} more in the app.)`);

  const gaps = describeGaps(digest.coverage || {}).trim();
  if (gaps) lines.push(gaps);

  return { title, body: lines.join('\n') };
}

// What this digest has already told the user about, so a separate alert about the same thing
// can be folded into it rather than arriving twice. Keyed the same way the notification
// runtime keys its own subjects.
function digestCovers(digest = {}) {
  const covers = [];
  for (const item of digest.items || []) {
    const ref = item.ref || {};
    if (ref.commitmentId) covers.push(`commitment:${ref.commitmentId}`);
    if (ref.scheduledTaskId) covers.push(`task:${ref.scheduledTaskId}`);
    if (ref.threadId) covers.push(`thread:${ref.threadId}`);
  }
  return [...new Set(covers)];
}

module.exports = {
  DIGEST_MARKER,
  formatDigestNotification,
  digestCovers,
  CALENDAR_HORIZON_HOURS,
  OCCASION_HORIZON_DAYS,
  WATCH_UPDATE_MAX_AGE_HOURS,
  MAX_ITEMS,
  buildDailyDigest,
  formatDigest,
  normalizeReplyItem,
  normalizeOccasionItem,
  normalizeReminderItem,
  normalizeWatchUpdate,
  normalizeCommitmentItem,
  normalizeCalendarItem,
  normalizeApprovalItem
};

'use strict';

// Getting what Millie notices to the user without the user opening the app.
//
// The rules that matter here are all about NOT lying and NOT nagging:
//   - "Delivered" means a provider accepted it. Entering a queue is not delivery, and a
//     channel that is merely unconfigured must fail loudly rather than report success.
//   - One real-world event produces one notification. A parcel moving to "out for delivery"
//     is one thing that happened, not three ("watch triggered", "parcel changed", "out for
//     delivery"), and the morning digest is one message, not one per item inside it.
//   - Quiet hours defer, they do not drop — except for genuinely urgent things, and urgency
//     is grounded in facts (overdue, starting soon, a stated threshold crossed), never in the
//     model deciding something feels important.

const CATEGORIES = ['watch', 'digest', 'delivery', 'reply_needed', 'occasion', 'commitment', 'other'];
const URGENCIES = ['urgent', 'normal', 'low'];
const CHANNELS = ['push', 'email', 'telegram', 'in_app'];
const MAX_ATTEMPTS = 3;

// Preference keys, kept deliberately few. Everything is expressible as: which channel, which
// categories, which urgency, an optional fallback, and when to stay quiet.
const PREF = {
  channel: 'notify.channel',
  // Only consulted when an EXPLICIT preference (category, urgency, or global) named a
  // channel that turned out to be unavailable. "Telegram only" has to actually mean only
  // Telegram — falling back to email just because it happens to be configured would make
  // "don't email me" a preference the runtime doesn't actually keep. Comma-separated,
  // tried in order; in_app is always the last resort beneath it and needs no listing.
  fallback: 'notify.fallback',
  urgentOnly: 'notify.urgent_only',
  quietHours: 'notify.quiet_hours',
  emailTo: 'notify.email_to',
  category: (category) => `notify.category.${category}`,
  // "Send urgent alerts to Telegram" — a preference about how serious something is, not
  // what kind of thing it is. Checked between category (most specific) and the blanket
  // channel preference (least specific).
  urgency: (urgency) => `notify.urgency.${urgency}`
};

function clean(value, max = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeCategory(value) {
  const text = String(value || '').trim().toLowerCase();
  return CATEGORIES.includes(text) ? text : 'other';
}

function normalizeUrgency(value) {
  const text = String(value || '').trim().toLowerCase();
  return URGENCIES.includes(text) ? text : 'normal';
}

// ── Urgency, grounded ──────────────────────────────────────────────────────────────────

// Deliberately derived from facts the caller already knows, not from wording. A watch that
// crossed its stated threshold is urgent because the threshold is a fact; an email that
// merely says "URGENT" is not.
function gradeUrgency({ category, overdue = false, minutesUntil = null, terminalState = false, thresholdCrossed = false, exception = false } = {}) {
  if (overdue) return 'urgent';
  if (Number.isFinite(minutesUntil) && minutesUntil >= 0 && minutesUntil <= 120) return 'urgent';
  if (exception) return 'urgent';
  if (thresholdCrossed || terminalState) return 'normal';
  if (category === 'digest') return 'normal';
  return 'low';
}

// ── Dedupe ─────────────────────────────────────────────────────────────────────────────

// The key identifies the real-world event, so re-raising it is an update rather than a second
// alert. A watch keys on its own id plus the state it observed: the same transition seen
// twice collapses, a genuinely new transition does not.
function dedupeKeyFor({ category, scheduledTaskId, briefingId, threadId, personName, commitmentId, state, dateKey } = {}) {
  const parts = [normalizeCategory(category)];
  if (scheduledTaskId) parts.push(`task:${scheduledTaskId}`);
  if (briefingId) parts.push(`briefing:${briefingId}`);
  if (threadId) parts.push(`thread:${threadId}`);
  if (commitmentId) parts.push(`commitment:${commitmentId}`);
  if (personName) parts.push(`person:${String(personName).toLowerCase()}`);
  if (state) parts.push(`state:${String(state).toLowerCase().replace(/\s+/g, '-').slice(0, 60)}`);
  // A digest is one per day per user — recomputing it twice in a morning must not notify twice.
  if (dateKey) parts.push(`day:${dateKey}`);
  return parts.join('|');
}

// ── Preferences ────────────────────────────────────────────────────────────────────────

function parseQuietHours(value) {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return { start, end };
}

function minutesOfDay(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function inQuietHours(date, quiet, timeZone) {
  if (!quiet) return false;
  const now = minutesOfDay(date, timeZone);
  // A window like 22:00-07:00 wraps midnight.
  return quiet.start <= quiet.end
    ? now >= quiet.start && now < quiet.end
    : now >= quiet.start || now < quiet.end;
}

function nextQuietEnd(date, quiet, timeZone) {
  const now = minutesOfDay(date, timeZone);
  const minutesUntilEnd = quiet.end > now ? quiet.end - now : (24 * 60 - now) + quiet.end;
  return new Date(date.getTime() + minutesUntilEnd * 60000);
}

// The whole routing decision, pure so it is testable without a database or a provider.
// `available` says which channels are actually configured RIGHT NOW — an unconfigured
// channel is never chosen, and never silently treated as success.
function resolveDelivery({ event, prefs = {}, available = [], now = new Date(), timeZone = process.env.TIMEZONE || 'Europe/London' } = {}) {
  const category = normalizeCategory(event?.category);
  const urgency = normalizeUrgency(event?.urgency);

  const globalPref = String(prefs[PREF.channel] || 'auto').toLowerCase();
  const categoryPref = String(prefs[PREF.category(category)] || '').toLowerCase();
  const urgencyPref = String(prefs[PREF.urgency(urgency)] || '').toLowerCase();
  // Most specific wins: "price watches via Telegram" beats "urgent things via Telegram"
  // beats "everything via Telegram".
  const effective = categoryPref || urgencyPref || globalPref;

  if (effective === 'off') {
    return { deliver: false, status: 'suppressed', reason: `${category} notifications are turned off` };
  }
  // "Just show those in the app" — a real preference, and not a failure.
  if (effective === 'in_app') {
    return available.includes('in_app')
      ? { deliver: true, channel: 'in_app' }
      : { deliver: false, status: 'failed', reason: 'the in-app channel is unavailable' };
  }

  const urgentOnly = String(prefs[PREF.urgentOnly] || '') === 'true';
  if (urgentOnly && urgency !== 'urgent') {
    return { deliver: false, status: 'suppressed', reason: 'only urgent notifications are enabled' };
  }

  const quiet = parseQuietHours(prefs[PREF.quietHours]);
  if (quiet && urgency !== 'urgent' && inQuietHours(now, quiet, timeZone)) {
    return { deliver: false, status: 'deferred', deliverAfter: nextQuietEnd(now, quiet, timeZone), reason: 'quiet hours' };
  }

  if (CHANNELS.includes(effective)) {
    if (available.includes(effective)) return { deliver: true, channel: effective };
    // An explicit choice is not a suggestion. "Telegram only" must not silently leak to
    // email just because email happens to be configured — that would make the preference
    // a lie. Only a channel the user actually opted into as a fallback is tried next, and
    // only after that does the in-app card catch it, because in-app is the one channel
    // that does not reach them and is never itself a stated preference here.
    const fallbackChannels = String(prefs[PREF.fallback] || '')
      .split(',').map(c => c.trim().toLowerCase()).filter(c => CHANNELS.includes(c) && c !== 'in_app');
    for (const channel of fallbackChannels) {
      if (available.includes(channel)) return { deliver: true, channel, fellBackFrom: effective };
    }
    if (available.includes('in_app')) return { deliver: true, channel: 'in_app', fellBackFrom: effective };
    return { deliver: false, status: 'failed', reason: `${effective} is not available and no fallback is configured` };
  }

  // No explicit preference ('auto') — the default priority order.
  for (const channel of ['push', 'email', 'telegram', 'in_app']) {
    if (available.includes(channel)) return { deliver: true, channel };
  }
  return { deliver: false, status: 'failed', reason: 'no notification channel is configured' };
}

// ── Related-event collapsing ───────────────────────────────────────────────────────────

// Everything a pending event is "about", in the same vocabulary the digest uses to say what
// it already covers.
function subjectsOf(event = {}) {
  const ref = event.source_ref || {};
  const subjects = [];
  if (ref.commitmentId) subjects.push(`commitment:${ref.commitmentId}`);
  if (ref.scheduledTaskId) subjects.push(`task:${ref.scheduledTaskId}`);
  if (ref.threadId) subjects.push(`thread:${ref.threadId}`);
  return subjects;
}

// "Parcel changed", "watch triggered" and "out for delivery" are one thing that happened.
// Collapses pending events that share a subject, keeping the most specific body.
//
// The digest gets a second, stronger rule: it is a single message that already names several
// things, so anything else waiting to be sent about one of those things is folded into it.
// Otherwise a commitment due today arrives once as its own alert and again inside the
// morning digest — the same sentence, twice, which is exactly what makes proactive software
// feel like nagging.
// `alreadyCovered` carries the subjects of digests that have ALREADY been sent today. Without
// it the fold only worked when the digest happened to still be pending in the same sweep: a
// commitment alert raised an hour after the morning digest went out was delivered on its own,
// repeating a line the user had already read. Which duplicate you get should not depend on
// sweep timing.
function collapseRelated(events = [], { alreadyCovered = [] } = {}) {
  const coveredByDigest = new Set(alreadyCovered);
  for (const event of events) {
    if (normalizeCategory(event.category) !== 'digest') continue;
    for (const subject of event.source_ref?.covers || []) coveredByDigest.add(subject);
  }
  const remaining = coveredByDigest.size
    ? events.filter(event => normalizeCategory(event.category) === 'digest' ||
        !subjectsOf(event).some(subject => coveredByDigest.has(subject)))
    : events;

  const bySubject = new Map();
  for (const event of remaining) {
    const subject = event.source_ref?.scheduledTaskId || event.source_ref?.threadId || event.dedupe_key;
    const existing = bySubject.get(subject);
    if (!existing) { bySubject.set(subject, event); continue; }
    // Prefer the one that actually says what happened over the generic "something changed".
    const existingGeneric = /triggered|changed|updated/i.test(existing.title);
    const candidateGeneric = /triggered|changed|updated/i.test(event.title);
    if (existingGeneric && !candidateGeneric) bySubject.set(subject, event);
  }
  return [...bySubject.values()];
}

// ── Formatting ─────────────────────────────────────────────────────────────────────────

function formatNotificationEmail(event) {
  const title = clean(event.title, 140);
  const body = clean(event.body, 1500);
  return {
    subject: title,
    text: `${body}\n\n— Millie\n\nYou're getting this because you asked to be told about ${normalizeCategory(event.category).replace('_', ' ')} updates. Reply "stop <category>" or change it in the app.`
  };
}

// Telegram messages are read in a chat, not a mail client — no subject line to carry the
// title, so it leads the message instead. Kept short of Telegram's own 4096-character cap
// with headroom to spare; nothing here has ever been close to that length.
function formatNotificationTelegram(event) {
  const title = clean(event.title, 140);
  const body = clean(event.body, 1500);
  return { text: `${title}\n\n${body}` };
}

function describePreference(prefs = {}) {
  const channel = prefs[PREF.channel] || 'auto';
  const fallback = prefs[PREF.fallback];
  const quiet = prefs[PREF.quietHours];
  const urgentOnly = String(prefs[PREF.urgentOnly] || '') === 'true';
  const categoryOverrides = Object.entries(prefs)
    .filter(([key]) => key.startsWith('notify.category.'))
    .map(([key, value]) => `${key.replace('notify.category.', '').replace('_', ' ')}: ${value}`);
  const urgencyOverrides = Object.entries(prefs)
    .filter(([key]) => key.startsWith('notify.urgency.'))
    .map(([key, value]) => `${key.replace('notify.urgency.', '')}: ${value}`);
  const bits = [`channel ${channel}`];
  if (fallback) bits.push(`falls back to ${fallback}`);
  if (urgentOnly) bits.push('urgent only');
  if (quiet) bits.push(`quiet ${quiet}`);
  if (categoryOverrides.length) bits.push(categoryOverrides.join(', '));
  if (urgencyOverrides.length) bits.push(urgencyOverrides.join(', '));
  return bits.join(' · ');
}

module.exports = {
  CATEGORIES,
  URGENCIES,
  CHANNELS,
  MAX_ATTEMPTS,
  PREF,
  normalizeCategory,
  normalizeUrgency,
  gradeUrgency,
  dedupeKeyFor,
  parseQuietHours,
  inQuietHours,
  resolveDelivery,
  collapseRelated,
  subjectsOf,
  formatNotificationEmail,
  formatNotificationTelegram,
  describePreference
};

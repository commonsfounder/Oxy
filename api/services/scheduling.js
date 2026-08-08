'use strict';

// Real availability. The rule that matters: free time is computed by subtracting ACTUAL
// events from the user's working window — never suggested from a plausible-sounding guess.
// If the calendar could not be read, this returns nothing and the caller says so, because a
// suggested slot that turns out to be double-booked is worse than no suggestion.

const DEFAULT_WORKING = { startMinute: 9 * 60, endMinute: 18 * 60, days: [1, 2, 3, 4, 5] };
const DEFAULT_DURATION = 60;
// Real meetings need a gap either side; back-to-back suggestions are how a calendar becomes
// unusable. Applied to EXISTING events when carving out free space, not to the new block.
const DEFAULT_BUFFER = 10;

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function minutesInDay(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function weekdayOf(dayKeyString) {
  return new Date(`${dayKeyString}T12:00:00.000Z`).getUTCDay();
}

// The UTC instant of a given local minute-of-day on a given local day.
function localInstant(dayKeyString, minute, timeZone) {
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  const naive = new Date(`${dayKeyString}T${hh}:${mm}:00.000Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(naive).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(naive.getTime() - (asUTC - naive.getTime()));
}

// Normalizes whatever the calendar connector returned into busy intervals. An all-day event
// blocks its whole day: treating it as a zero-length marker is how you end up suggesting a
// meeting during someone's holiday.
function toBusyIntervals(events = [], timeZone) {
  const busy = [];
  for (const event of events) {
    const rawStart = event.start?.dateTime || event.start?.date || event.start;
    const rawEnd = event.end?.dateTime || event.end?.date || event.end;
    const start = toDate(rawStart);
    if (!start) continue;
    const allDay = typeof rawStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawStart);
    if (allDay) {
      const key = dayKey(start, timeZone);
      busy.push({
        start: localInstant(key, 0, timeZone),
        end: localInstant(key, 24 * 60, timeZone),
        title: event.title || event.summary || 'Busy',
        allDay: true
      });
      continue;
    }
    const end = toDate(rawEnd) || new Date(start.getTime() + 30 * 60000);
    busy.push({ start, end, title: event.title || event.summary || 'Busy', allDay: false });
  }
  return busy.sort((a, b) => a.start - b.start);
}

function mergeIntervals(intervals, bufferMinutes = 0) {
  const padded = intervals.map(i => ({
    ...i,
    start: new Date(i.start.getTime() - bufferMinutes * 60000),
    end: new Date(i.end.getTime() + bufferMinutes * 60000)
  })).sort((a, b) => a.start - b.start);

  const merged = [];
  for (const interval of padded) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

// The core: free slots of at least `durationMinutes`, inside the working window, with real
// events subtracted. Returns [] when there is genuinely nowhere — never a "well, maybe here".
function findFreeSlots({
  events = [],
  from = new Date(),
  days = 7,
  durationMinutes = DEFAULT_DURATION,
  working = DEFAULT_WORKING,
  bufferMinutes = DEFAULT_BUFFER,
  earliestMinute = null,
  latestMinute = null,
  timeZone = process.env.TIMEZONE || 'Europe/London',
  maxSlots = 8
} = {}) {
  const duration = Math.max(5, Number(durationMinutes) || DEFAULT_DURATION);
  const busy = mergeIntervals(toBusyIntervals(events, timeZone), bufferMinutes);
  const slots = [];

  const windowStart = Math.max(working.startMinute, earliestMinute ?? working.startMinute);
  const windowEnd = Math.min(working.endMinute, latestMinute ?? working.endMinute);
  if (windowEnd - windowStart < duration) return [];

  for (let dayOffset = 0; dayOffset < days && slots.length < maxSlots; dayOffset += 1) {
    const key = dayKey(new Date(from.getTime() + dayOffset * 86400000), timeZone);
    if (working.days && !working.days.includes(weekdayOf(key))) continue;

    let cursor = localInstant(key, windowStart, timeZone);
    const dayEnd = localInstant(key, windowEnd, timeZone);
    // Never suggest a slot in the past, including earlier today.
    if (cursor < from) cursor = new Date(Math.ceil(from.getTime() / (5 * 60000)) * 5 * 60000);

    for (const interval of busy) {
      if (interval.end <= cursor) continue;
      if (interval.start >= dayEnd) break;
      const gap = (Math.min(interval.start.getTime(), dayEnd.getTime()) - cursor.getTime()) / 60000;
      if (gap >= duration) {
        slots.push({ start: new Date(cursor), end: new Date(cursor.getTime() + duration * 60000), day: key });
        if (slots.length >= maxSlots) break;
      }
      if (interval.end > cursor) cursor = new Date(interval.end);
    }
    if (slots.length < maxSlots && (dayEnd.getTime() - cursor.getTime()) / 60000 >= duration) {
      slots.push({ start: new Date(cursor), end: new Date(cursor.getTime() + duration * 60000), day: key });
    }
  }
  return slots.slice(0, maxSlots);
}

// Does a proposed block actually collide with something real? Used before creating, so a
// direct "block 2pm tomorrow" cannot silently double-book.
function findConflicts({ start, end, events = [], timeZone = process.env.TIMEZONE || 'Europe/London' }) {
  const proposedStart = toDate(start);
  const proposedEnd = toDate(end);
  if (!proposedStart || !proposedEnd) return [];
  return toBusyIntervals(events, timeZone)
    .filter(interval => interval.start < proposedEnd && interval.end > proposedStart)
    .map(interval => ({ title: interval.title, start: interval.start.toISOString(), end: interval.end.toISOString() }));
}

// An event that already exists for the same thing at the same time — so "block two hours
// tomorrow for the case study" twice does not produce two blocks.
function findDuplicateEvent({ title, start, events = [] }) {
  const proposedStart = toDate(start);
  const wanted = String(title || '').trim().toLowerCase();
  if (!proposedStart || !wanted) return null;
  return events.find(event => {
    const eventStart = toDate(event.start?.dateTime || event.start?.date || event.start);
    if (!eventStart) return false;
    const sameTitle = String(event.title || event.summary || '').trim().toLowerCase() === wanted;
    return sameTitle && Math.abs(eventStart.getTime() - proposedStart.getTime()) < 60 * 60000;
  }) || null;
}

function parseTimeOfDay(value) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(value || '').trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const suffix = (match[3] || '').toLowerCase();
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

// ── Presentation ───────────────────────────────────────────────────────────────────────

function describeSlot(slot, timeZone = process.env.TIMEZONE || 'Europe/London') {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(slot.start);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit' }).format(slot.start);
  const end = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit' }).format(slot.end);
  return `${day} ${time}–${end}`;
}

function formatFreeSlots(slots = [], { durationMinutes = DEFAULT_DURATION, timeZone, calendarRead = true, reason = '' } = {}) {
  if (!calendarRead) {
    return `I couldn't read your calendar${reason ? ` (${reason})` : ''}, so I can't tell you when you're actually free — I'd only be guessing.`;
  }
  if (!slots.length) {
    return `I couldn't find a free ${durationMinutes}-minute slot in that window — your calendar is full across it.`;
  }
  return `${slots.length} option${slots.length === 1 ? '' : 's'}: ${slots.map(s => describeSlot(s, timeZone)).join('; ')}.`;
}

// The digest wants "leave by 12:50", not "Calendar event: Interview". Only produced when a
// real travel estimate exists — never an invented commute.
function describeEventWithPrep(event, { travelMinutes = null, timeZone = process.env.TIMEZONE || 'Europe/London' } = {}) {
  const start = toDate(event.start?.dateTime || event.start?.date || event.start);
  if (!start) return String(event.title || event.summary || 'Event');
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit' }).format(start);
  const title = event.title || event.summary || 'Event';
  if (!Number.isFinite(travelMinutes) || travelMinutes <= 0) return `${title} at ${time}`;
  const leaveBy = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(new Date(start.getTime() - travelMinutes * 60000));
  return `${title} at ${time}; leave by ${leaveBy}`;
}

module.exports = {
  DEFAULT_WORKING,
  DEFAULT_DURATION,
  DEFAULT_BUFFER,
  toBusyIntervals,
  mergeIntervals,
  findFreeSlots,
  findConflicts,
  findDuplicateEvent,
  parseTimeOfDay,
  describeSlot,
  formatFreeSlots,
  describeEventWithPrep
};

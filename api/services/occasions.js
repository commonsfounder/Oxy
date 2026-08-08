'use strict';

// Birthdays/anniversaries as durable, structured data (occasions table) — the memories table
// is free-text only (content, source, created_at, no date field), which can't reliably answer
// "whose birthday is coming up?" without re-parsing prose at query time on every request.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(month, year) {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function isValidMonthDay(month, day) {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(m) || m < 1 || m > 12) return false;
  if (!Number.isInteger(d) || d < 1) return false;
  // Generously allow Feb 29 regardless of the current year — it's a real, valid birthday
  // (see clampDay below for how a non-leap target year is handled).
  const maxDay = month === 2 ? 29 : daysInMonth(m, 2024);
  return d <= maxDay;
}

function utcMidnight(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
}

// The next real calendar date this month/day falls on, at or after `now`. Feb 29 clamps to
// Feb 28 in a non-leap target year — a date that doesn't exist can't be scheduled otherwise.
function nextOccurrenceDate(month, day, now = new Date()) {
  const clampDay = (year) => (month === 2 && day === 29 && !isLeapYear(year)) ? 28 : day;
  const thisYear = now.getUTCFullYear();
  const today = utcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  let candidate = utcMidnight(thisYear, month, clampDay(thisYear));
  if (candidate.getTime() < today.getTime()) {
    candidate = utcMidnight(thisYear + 1, month, clampDay(thisYear + 1));
  }
  return candidate;
}

function daysUntil(month, day, now = new Date()) {
  const target = nextOccurrenceDate(month, day, now);
  const today = utcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

// When the user asks to be reminded N days before, but N days before THIS year's occurrence
// has already passed (or is only hours away), waiting a full year for the first reminder
// would be silently useless — the point of the reminder is a heads-up, and they still need
// one now. Falls back to first thing tomorrow instead of missing this cycle entirely.
function computeReminderDueDate(month, day, remindDaysBefore = 0, now = new Date()) {
  const occurrence = nextOccurrenceDate(month, day, now);
  const ideal = new Date(occurrence.getTime() - Math.max(0, Number(remindDaysBefore) || 0) * 86400000);
  ideal.setUTCHours(9, 0, 0, 0);
  if (ideal.getTime() > now.getTime()) return ideal;
  const tomorrow = utcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate() + 1);
  tomorrow.setUTCHours(9, 0, 0, 0);
  return tomorrow;
}

function formatMonthDay(month, day) {
  return `${day} ${MONTH_NAMES[month - 1]}`;
}

// items: [{ personName, occasionType, month, day }] — daysUntil is computed here, not stored,
// so "whose birthday is coming up?" always reflects today, never a stale snapshot.
function formatOccasionsSummary(items = [], { maxItems = 8, now = new Date() } = {}) {
  if (!items.length) return "You don't have any birthdays or occasions saved yet.";
  const withDays = items.map(o => ({ ...o, daysUntil: daysUntil(o.month, o.day, now) }));
  const sorted = withDays.sort((a, b) => a.daysUntil - b.daysUntil);
  const shown = sorted.slice(0, maxItems);
  const lines = shown.map(o => {
    const when = o.daysUntil === 0 ? 'today' : o.daysUntil === 1 ? 'tomorrow' : `in ${o.daysUntil} days`;
    return `${o.personName}'s ${o.occasionType} is ${when} (${formatMonthDay(o.month, o.day)})`;
  });
  const more = items.length > shown.length ? ` (+${items.length - shown.length} more)` : '';
  return `${lines.join('. ')}.${more}`;
}

module.exports = {
  isValidMonthDay,
  nextOccurrenceDate,
  daysUntil,
  computeReminderDueDate,
  formatMonthDay,
  formatOccasionsSummary
};

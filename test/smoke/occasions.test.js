// Pure logic for durable birthday/occasion data (api/services/occasions.js): date math that
// must survive year wraparound and Feb 29, plus the reminder-timing edge case where the ideal
// lead time has already passed. The Supabase read/write is covered by the orchestration test
// (find-occasions-orchestration.test.js) and live verification.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isValidMonthDay,
  nextOccurrenceDate,
  daysUntil,
  computeReminderDueDate,
  formatMonthDay,
  formatOccasionsSummary
} = require('../../api/services/occasions');

// ── isValidMonthDay ─────────────────────────────────────────────────────────────────────
test('isValidMonthDay accepts real calendar dates and rejects impossible ones', () => {
  assert.equal(isValidMonthDay(7, 12), true);
  assert.equal(isValidMonthDay(2, 29), true, 'Feb 29 is a real birthday even outside a leap year');
  assert.equal(isValidMonthDay(2, 30), false);
  assert.equal(isValidMonthDay(4, 31), false, 'April has 30 days');
  assert.equal(isValidMonthDay(13, 1), false);
  assert.equal(isValidMonthDay(1, 0), false);
});

// ── nextOccurrenceDate / daysUntil ──────────────────────────────────────────────────────
test('nextOccurrenceDate returns this year when the date has not passed yet', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const next = nextOccurrenceDate(7, 12, now);
  assert.equal(next.toISOString().slice(0, 10), '2026-07-12');
});

test('nextOccurrenceDate rolls to next year once the date has passed', () => {
  const now = new Date('2026-08-08T12:00:00Z');
  const next = nextOccurrenceDate(7, 12, now);
  assert.equal(next.toISOString().slice(0, 10), '2027-07-12');
});

test('nextOccurrenceDate treats today itself as not yet passed', () => {
  const now = new Date('2026-07-12T23:00:00Z');
  const next = nextOccurrenceDate(7, 12, now);
  assert.equal(next.toISOString().slice(0, 10), '2026-07-12');
});

test('nextOccurrenceDate clamps Feb 29 to Feb 28 in a non-leap target year', () => {
  const now = new Date('2026-01-01T12:00:00Z'); // 2026 is not a leap year
  const next = nextOccurrenceDate(2, 29, now);
  assert.equal(next.toISOString().slice(0, 10), '2026-02-28');
});

test('nextOccurrenceDate uses the real Feb 29 in a leap year', () => {
  const now = new Date('2028-01-01T12:00:00Z'); // 2028 is a leap year
  const next = nextOccurrenceDate(2, 29, now);
  assert.equal(next.toISOString().slice(0, 10), '2028-02-29');
});

test('daysUntil counts correctly across a year boundary', () => {
  const now = new Date('2026-12-28T12:00:00Z');
  assert.equal(daysUntil(1, 5, now), 8); // Jan 5 next year
});

test('daysUntil is 0 on the day itself and 1 the day before', () => {
  const now = new Date('2026-07-12T08:00:00Z');
  assert.equal(daysUntil(7, 12, now), 0);
  assert.equal(daysUntil(7, 13, now), 1);
});

// ── computeReminderDueDate ───────────────────────────────────────────────────────────────
test('computeReminderDueDate schedules N days before this year\'s occurrence when there is time', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const due = computeReminderDueDate(7, 12, 14, now); // 2 weeks before July 12
  assert.equal(due.toISOString().slice(0, 10), '2026-06-28');
});

test('computeReminderDueDate falls back to tomorrow when the ideal lead time has already passed, rather than silently waiting a year', () => {
  const now = new Date('2026-07-09T12:00:00Z'); // birthday in 3 days
  const due = computeReminderDueDate(7, 12, 14, now); // "2 weeks before" already passed
  assert.equal(due.toISOString().slice(0, 10), '2026-07-10', 'reminds tomorrow, not next year');
});

test('computeReminderDueDate with 0 days before means "on the day"', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const due = computeReminderDueDate(7, 12, 0, now);
  assert.equal(due.toISOString().slice(0, 10), '2026-07-12');
});

// ── formatMonthDay / formatOccasionsSummary ─────────────────────────────────────────────
test('formatMonthDay is human readable', () => {
  assert.equal(formatMonthDay(7, 12), '12 July');
});

test('formatOccasionsSummary is honest when nothing is saved', () => {
  assert.match(formatOccasionsSummary([]), /don't have any birthdays or occasions saved yet/);
});

test('formatOccasionsSummary sorts soonest-first and gives real, specific dates', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const text = formatOccasionsSummary([
    { personName: 'Mum', occasionType: 'birthday', month: 10, day: 8 },
    { personName: 'Alisa', occasionType: 'birthday', month: 7, day: 12 }
  ], { now });
  assert.match(text, /Alisa's birthday is in \d+ days \(12 July\)/);
  assert.ok(text.indexOf('Alisa') < text.indexOf('Mum'), 'soonest occasion listed first');
});

test('formatOccasionsSummary caps the list and notes how many more exist', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const items = Array.from({ length: 12 }, (_, i) => ({ personName: `Person${i}`, occasionType: 'birthday', month: 1, day: (i % 28) + 1 }));
  const text = formatOccasionsSummary(items, { maxItems: 8, now });
  assert.match(text, /\(\+4 more\)/);
});

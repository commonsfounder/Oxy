// Real availability logic: free time is what is left after subtracting ACTUAL events, and
// nothing is ever suggested that has not been checked against them.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  toBusyIntervals, mergeIntervals, findFreeSlots, findConflicts,
  findDuplicateEvent, parseTimeOfDay, describeSlot, formatFreeSlots, describeEventWithPrep
} = require('../../api/services/scheduling');

const TZ = 'UTC';
// A Monday.
const MONDAY_8AM = new Date('2026-08-10T08:00:00.000Z');

function event(startIso, endIso, title = 'Busy') {
  return { id: title, title, start: { dateTime: startIso }, end: { dateTime: endIso } };
}

// ── Busy time comes from real events ───────────────────────────────────────────────────
test('an all-day event blocks the whole day, not a zero-length instant', () => {
  const busy = toBusyIntervals([{ title: 'Holiday', start: { date: '2026-08-11' }, end: { date: '2026-08-12' } }], TZ);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].allDay, true);
  assert.equal(busy[0].start.toISOString(), '2026-08-11T00:00:00.000Z');
  assert.equal(busy[0].end.toISOString(), '2026-08-12T00:00:00.000Z');
});

test('an event with no end is given a real length rather than being ignored', () => {
  const busy = toBusyIntervals([{ title: 'Call', start: { dateTime: '2026-08-10T10:00:00Z' } }], TZ);
  assert.equal(busy[0].end.toISOString(), '2026-08-10T10:30:00.000Z');
});

test('overlapping events merge, with a buffer either side', () => {
  const merged = mergeIntervals(toBusyIntervals([
    event('2026-08-10T10:00:00Z', '2026-08-10T11:00:00Z', 'A'),
    event('2026-08-10T10:30:00Z', '2026-08-10T12:00:00Z', 'B')
  ], TZ), 10);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].start.toISOString(), '2026-08-10T09:50:00.000Z');
  assert.equal(merged[0].end.toISOString(), '2026-08-10T12:10:00.000Z');
});

// ── Finding free time ──────────────────────────────────────────────────────────────────
test('free slots are the gaps between real events, inside working hours', () => {
  const slots = findFreeSlots({
    events: [
      event('2026-08-10T09:00:00Z', '2026-08-10T10:00:00Z', 'Standup'),
      event('2026-08-10T14:00:00Z', '2026-08-10T15:00:00Z', 'Interview')
    ],
    from: MONDAY_8AM, days: 1, durationMinutes: 60, timeZone: TZ, bufferMinutes: 10, maxSlots: 5
  });
  assert.ok(slots.length >= 2);
  // The first gap starts after the standup plus its buffer, never during it.
  assert.equal(slots[0].start.toISOString(), '2026-08-10T10:10:00.000Z');
  for (const slot of slots) {
    assert.equal(findConflicts({
      start: slot.start, end: slot.end,
      events: [event('2026-08-10T09:00:00Z', '2026-08-10T10:00:00Z'), event('2026-08-10T14:00:00Z', '2026-08-10T15:00:00Z')],
      timeZone: TZ
    }).length, 0, 'a suggested slot must never overlap a real event');
  }
});

test('a full day yields NO slots rather than a hopeful suggestion', () => {
  const slots = findFreeSlots({
    events: [event('2026-08-10T09:00:00Z', '2026-08-10T18:00:00Z', 'All-day workshop')],
    from: MONDAY_8AM, days: 1, durationMinutes: 60, timeZone: TZ
  });
  assert.deepEqual(slots, []);
  assert.match(formatFreeSlots(slots, { durationMinutes: 60 }), /couldn't find a free 60-minute slot/);
});

test('a long block only fits where there is genuinely room for it', () => {
  const events = [
    event('2026-08-10T09:00:00Z', '2026-08-10T10:00:00Z'),
    event('2026-08-10T11:00:00Z', '2026-08-10T12:00:00Z')
  ];
  // The 10:00–11:00 gap is an hour, so a two-hour block cannot start there.
  const twoHours = findFreeSlots({ events, from: MONDAY_8AM, days: 1, durationMinutes: 120, timeZone: TZ, maxSlots: 3 });
  assert.ok(twoHours.every(s => s.start.toISOString() >= '2026-08-10T12:10:00.000Z'));
});

test('nothing is ever suggested in the past, including earlier today', () => {
  const noon = new Date('2026-08-10T12:00:00.000Z');
  const slots = findFreeSlots({ events: [], from: noon, days: 1, durationMinutes: 60, timeZone: TZ });
  assert.ok(slots.every(s => s.start >= noon));
});

test('an all-day event genuinely blocks that day out', () => {
  const slots = findFreeSlots({
    events: [{ title: 'Holiday', start: { date: '2026-08-10' }, end: { date: '2026-08-11' } }],
    from: MONDAY_8AM, days: 1, durationMinutes: 30, timeZone: TZ
  });
  assert.deepEqual(slots, []);
});

test('stated time constraints are respected, not merely preferred', () => {
  const afterFour = findFreeSlots({
    events: [], from: MONDAY_8AM, days: 1, durationMinutes: 60,
    earliestMinute: 16 * 60, timeZone: TZ, maxSlots: 3
  });
  assert.ok(afterFour.every(s => s.start.getUTCHours() >= 16));

  const beforeEleven = findFreeSlots({
    events: [], from: MONDAY_8AM, days: 1, durationMinutes: 60,
    latestMinute: 11 * 60, timeZone: TZ, maxSlots: 3
  });
  assert.ok(beforeEleven.every(s => s.end.getUTCHours() <= 11));
});

test('a window narrower than the duration yields nothing', () => {
  const slots = findFreeSlots({
    events: [], from: MONDAY_8AM, days: 3, durationMinutes: 120,
    earliestMinute: 10 * 60, latestMinute: 11 * 60, timeZone: TZ
  });
  assert.deepEqual(slots, []);
});

test('weekends are excluded unless asked for', () => {
  const friday = new Date('2026-08-14T08:00:00.000Z');
  const weekdaysOnly = findFreeSlots({ events: [], from: friday, days: 3, durationMinutes: 60, timeZone: TZ, maxSlots: 20 });
  assert.ok(weekdaysOnly.every(s => ![0, 6].includes(s.start.getUTCDay())));

  const withWeekends = findFreeSlots({
    events: [], from: friday, days: 3, durationMinutes: 60, timeZone: TZ, maxSlots: 20,
    working: { startMinute: 9 * 60, endMinute: 18 * 60, days: [0, 1, 2, 3, 4, 5, 6] }
  });
  assert.ok(withWeekends.some(s => [0, 6].includes(s.start.getUTCDay())));
});

// ── Conflicts and duplicates ───────────────────────────────────────────────────────────
test('a proposed block that overlaps a real event is reported as a conflict', () => {
  const conflicts = findConflicts({
    start: '2026-08-10T14:30:00Z', end: '2026-08-10T15:30:00Z',
    events: [event('2026-08-10T14:00:00Z', '2026-08-10T15:00:00Z', 'Interview')], timeZone: TZ
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].title, 'Interview');
});

test('a block that merely touches the end of another is not a conflict', () => {
  assert.deepEqual(findConflicts({
    start: '2026-08-10T15:00:00Z', end: '2026-08-10T16:00:00Z',
    events: [event('2026-08-10T14:00:00Z', '2026-08-10T15:00:00Z')], timeZone: TZ
  }), []);
});

test('booking the same block twice finds the one that is already there', () => {
  const existing = [event('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z', 'Case study')];
  assert.ok(findDuplicateEvent({ title: 'Case study', start: '2026-08-11T14:00:00Z', events: existing }));
  assert.ok(findDuplicateEvent({ title: 'case study', start: '2026-08-11T14:30:00Z', events: existing }), 'same thing, roughly the same time');
  assert.equal(findDuplicateEvent({ title: 'Case study', start: '2026-08-12T14:00:00Z', events: existing }), null, 'a different day is a different block');
  assert.equal(findDuplicateEvent({ title: 'Something else', start: '2026-08-11T14:00:00Z', events: existing }), null);
});

// ── Parsing and presentation ───────────────────────────────────────────────────────────
test('stated times parse in the ways people write them', () => {
  assert.equal(parseTimeOfDay('9am'), 540);
  assert.equal(parseTimeOfDay('4pm'), 960);
  assert.equal(parseTimeOfDay('16:30'), 990);
  assert.equal(parseTimeOfDay('12am'), 0);
  assert.equal(parseTimeOfDay('noonish'), null);
});

test('an unreadable calendar is admitted, never filled in with guesses', () => {
  const text = formatFreeSlots([], { calendarRead: false, reason: 'Google is not connected' });
  assert.match(text, /couldn't read your calendar \(Google is not connected\)/);
  assert.match(text, /I'd only be guessing/);
});

test('a slot reads as a time a person would recognise', () => {
  const slot = { start: new Date('2026-08-11T14:00:00Z'), end: new Date('2026-08-11T15:00:00Z') };
  assert.equal(describeSlot(slot, TZ), 'Tue 11 Aug 14:00–15:00');
});

test('an event is described with travel time only when travel time is actually known', () => {
  const interview = { title: 'Interview', start: { dateTime: '2026-08-11T14:00:00Z' } };
  assert.equal(describeEventWithPrep(interview, { timeZone: TZ }), 'Interview at 14:00');
  assert.equal(describeEventWithPrep(interview, { travelMinutes: 70, timeZone: TZ }), 'Interview at 14:00; leave by 12:50');
  // No invented commute.
  assert.equal(describeEventWithPrep(interview, { travelMinutes: 0, timeZone: TZ }), 'Interview at 14:00');
});

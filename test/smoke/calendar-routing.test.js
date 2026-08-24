const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractRelativeDateYMD,
  extractCalendarEventInput,
  inferExplicitCalendarMutationTurn
} = require('../../api/index');

test('relative calendar dates understand the next weekday in the user timezone', () => {
  const monday = new Date('2026-08-24T12:00:00.000Z');
  assert.equal(extractRelativeDateYMD('next Tuesday', monday), '2026-08-25');
  assert.equal(extractRelativeDateYMD('next Monday', monday), '2026-08-31');
});

test('calendar writes preserve weekday and explicit time ranges', () => {
  // Pinned to a known Monday. Without a fixed reference this asserted a hard-coded date
  // against "now", so it passed only on the day it was written and failed every day after.
  const monday = new Date('2026-08-24T12:00:00.000Z');
  const input = extractCalendarEventInput(
    'Put a dentist appointment in my calendar next Tuesday from 2pm to 3pm.',
    '',
    monday
  );
  assert.deepEqual(input, {
    title: 'dentist appointment',
    start_date: '2026-08-25T14:00:00',
    end_date: '2026-08-25T15:00:00',
    timezone: 'Europe/London'
  });
});

test('calendar move and cancel requests reach their existing review-gated actions', () => {
  assert.deepEqual(
    inferExplicitCalendarMutationTurn('Move my dentist appointment next Tuesday to 4pm.', new Date('2026-08-24T12:00:00.000Z')),
    {
      reason: 'calendar_move',
      spoken: "I'll move that calendar event for review.",
      actions: [{ type: 'move_calendar_event', input: { title: 'dentist appointment', start: '2026-08-25T16:00:00' } }]
    }
  );
  assert.deepEqual(
    inferExplicitCalendarMutationTurn('Cancel my dentist appointment next Tuesday.', new Date('2026-08-24T12:00:00.000Z')),
    {
      reason: 'calendar_cancel',
      spoken: "I'll prepare that cancellation for review.",
      actions: [{ type: 'cancel_calendar_event', input: { title: 'dentist appointment', date: '2026-08-25' } }]
    }
  );
});

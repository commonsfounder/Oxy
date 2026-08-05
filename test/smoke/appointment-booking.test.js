const assert = require('node:assert/strict');
const test = require('node:test');

const { createAppointmentBookingService } = require('../../api/services/appointment-booking');

test('a vague request asks only for the missing appointment detail', async () => {
  const service = createAppointmentBookingService({ provider: { id: 'sandbox', findSlots: async () => [], book: async () => ({}) } });
  const result = await service.findChoices({ request: 'Book me an appointment next week' });
  assert.equal(result.kind, 'missing_details');
  assert.deepEqual(result.missing, ['service']);
  assert.equal(result.text, 'What kind of appointment should I look for?');
});

test('a slot cannot be booked until approval is explicit', async () => {
  let bookings = 0;
  const service = createAppointmentBookingService({
    provider: { id: 'sandbox', findSlots: async () => [], book: async choice => { bookings += 1; return { id: 'b1', reference: 'Sandbox 0001', choice }; } },
    calendar: { add: async () => ({ id: 'c1' }) }
  });
  const choice = { id: 'slot-1', service: 'dentist', start: '2026-08-11T18:00:00.000Z', end: '2026-08-11T18:30:00.000Z' };
  const result = await service.commitChoice({ choice });
  assert.equal(result.kind, 'approval_required');
  assert.equal(bookings, 0);
});

test('an approved booking is added once even if calendar add needs a retry', async () => {
  let bookings = 0;
  let calendarAttempts = 0;
  const service = createAppointmentBookingService({
    provider: { id: 'sandbox', findSlots: async () => [], book: async choice => { bookings += 1; return { id: 'b1', reference: 'Sandbox 0001', choice }; } },
    calendar: { add: async () => { calendarAttempts += 1; if (calendarAttempts === 1) throw new Error('unavailable'); return { id: 'c1' }; } }
  });
  const choice = { id: 'slot-1', service: 'dentist', start: '2026-08-11T18:00:00.000Z', end: '2026-08-11T18:30:00.000Z' };
  const first = await service.commitChoice({ choice, approved: true });
  assert.equal(first.kind, 'calendar_failed');
  assert.equal(bookings, 1);
  const retry = await service.addBookingToCalendar({ booking: first.booking });
  assert.equal(retry.ok, true);
  assert.equal(bookings, 1);
});

test('after-work choices exclude a busy calendar slot', async () => {
  const service = createAppointmentBookingService({
    provider: { id: 'sandbox', findSlots: async () => [
      { id: 'busy', start: '2026-08-10T17:30:00.000Z', end: '2026-08-10T18:00:00.000Z' },
      { id: 'free', start: '2026-08-11T18:00:00.000Z', end: '2026-08-11T18:30:00.000Z' }
    ], book: async () => ({}) }
  });
  const result = await service.findChoices({
    request: 'Get me a dentist appointment next week after work',
    calendarEvents: [{ start: '2026-08-10T17:00:00.000Z', end: '2026-08-10T18:00:00.000Z' }],
    now: new Date('2026-08-03T10:00:00.000Z')
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.choices.map(choice => choice.id), ['free']);
});

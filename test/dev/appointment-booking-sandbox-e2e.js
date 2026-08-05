'use strict';

// This only uses in-memory appointment and calendar adapters.
const assert = require('node:assert/strict');
const { createAppointmentBookingService, createSandboxAppointmentProvider, createSandboxCalendar } = require('../../api/services/appointment-booking');

async function main() {
  const provider = createSandboxAppointmentProvider();
  const calendar = createSandboxCalendar();
  const service = createAppointmentBookingService({ provider, calendar });
  const found = await service.findChoices({
    request: 'Millie, get me a dentist appointment next week after work',
    calendarEvents: [{ start: '2026-08-11T17:00:00.000Z', end: '2026-08-11T18:00:00.000Z' }],
    now: new Date('2026-08-05T12:00:00.000Z')
  });
  assert.equal(found.ok, true);
  assert.ok(found.choices.length >= 1 && found.choices.length <= 3);
  const held = await service.commitChoice({ choice: found.choices[0] });
  assert.equal(held.kind, 'approval_required');
  assert.equal(provider.bookings().length, 0);
  const booked = await service.commitChoice({ choice: found.choices[0], approved: true });
  assert.equal(booked.ok, true);
  assert.equal(provider.bookings().length, 1);
  assert.equal(calendar.events().length, 1);
  console.log(`Sandbox appointment booking E2E passed: ${found.choices[0].label}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeHouseholdEvent,
  normalizeHouseholdEvents,
  decideIntervention,
  interventionReceipt,
  householdEventDedupeKey,
  notificationCategoryForHouseholdEvent
} = require('../../api/services/household-events');

const NOW = new Date('2026-08-30T12:00:00.000Z');

test('household events are a bounded generic envelope, not a raw sensor payload', () => {
  const event = normalizeHouseholdEvent({
    id: 'arrival-1',
    type: 'person_arrived',
    title: 'Tom is home',
    body: 'Tom arrived at the front door.',
    person_name: 'Tom',
    room: 'hallway',
    source: 'native_location',
    confidence: 1.4,
    relevance: 0.8,
    rawCoordinates: { latitude: 51.5, longitude: -0.1 },
    occurredAt: NOW.toISOString()
  }, NOW);

  assert.deepEqual(event, {
    id: 'arrival-1',
    type: 'person_arrived',
    subject: 'Tom is home',
    title: 'Tom is home',
    body: 'Tom arrived at the front door.',
    personName: 'Tom',
    room: 'hallway',
    occurredAt: NOW.toISOString(),
    expiresAt: null,
    source: 'native_location',
    confidence: 1,
    relevance: 0.8,
    actionable: true,
    urgent: false,
    requiresNow: false,
    solveSilently: false,
    interruptionCost: 'normal'
  });
  assert.equal(JSON.stringify(event).includes('rawCoordinates'), false);
});

test('proactivity surfaces a confident actionable event and suppresses weak or annoying ones', () => {
  const useful = normalizeHouseholdEvent({
    type: 'commitment_due', subject: 'Take the parcel', confidence: 0.9, relevance: 1,
    actionable: true, interruptionCost: 'low'
  }, NOW);
  assert.deepEqual(decideIntervention({ event: useful, now: NOW }), {
    surface: true, urgency: 'low', reason: 'relevant_actionable_event'
  });

  const weak = normalizeHouseholdEvent({ type: 'sound_detected', subject: 'A noise', confidence: 0.4 }, NOW);
  assert.deepEqual(decideIntervention({ event: weak, now: NOW }), { surface: false, reason: 'low_confidence' });

  const annoying = normalizeHouseholdEvent({
    type: 'device_state_changed', subject: 'The lamp changed', interruptionCost: 'high'
  }, NOW);
  assert.deepEqual(decideIntervention({ event: annoying, now: NOW }), { surface: false, reason: 'high_interruption_cost' });
});

test('intervention receipts keep bounded event identity metadata', () => {
  const receipt = interventionReceipt({
    id: 'event-1', type: 'delivery_arrived', title: 'Parcel', body: 'At the door.', secret: 'no'
  });
  assert.deepEqual(receipt, {
    title: 'Parcel',
    body: 'At the door.',
    sourceRef: { householdEventId: 'event-1', eventType: 'delivery_arrived' }
  });
});

test('native observations normalize into a bounded event batch with stable dedupe keys', () => {
  const events = normalizeHouseholdEvents([
    { id: 'door-1', type: 'person_near_door', subject: 'Tom is near the door' },
    { id: 'delivery-1', type: 'delivery_arrived', subject: 'Parcel at the door' },
    { type: 'not-an-event', subject: 'ignore me' },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `noise-${index}`,
      type: 'sound_detected',
      subject: `Sound ${index}`
    }))
  ], NOW);

  assert.equal(events.length, 12);
  assert.equal(events[0].id, 'door-1');
  assert.equal(householdEventDedupeKey(events[0]), 'household:person_near_door:door-1');
  assert.equal(notificationCategoryForHouseholdEvent(events[1]), 'delivery');
  assert.equal(notificationCategoryForHouseholdEvent({ type: 'commitment_due' }), 'commitment');
  assert.equal(notificationCategoryForHouseholdEvent({ type: 'sound_detected' }), 'other');
});

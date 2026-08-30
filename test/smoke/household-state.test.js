'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeHouseholdState } = require('../../api/services/household-state');

const HOME = { latitude: 51.5007, longitude: -0.1246 };
const AWAY = { latitude: 51.5207, longitude: -0.1246 };

test('household state turns current context and obligations into useful, bounded facts', () => {
  const now = new Date('2026-08-30T12:00:00.000Z');
  const state = normalizeHouseholdState({
    nativeContext: {
      location: HOME,
      settings: { homeLocation: HOME, locationReminders: true },
      updated_at: now.toISOString()
    },
    people: [
      { display_name: 'Sarah Jones', relationship: 'partner', phone: '+441234567890' },
      { display_name: 'Ben', relationship: 'friend' }
    ],
    commitments: [
      { what: 'send the school forms', person_name: 'Sarah', due_at: '2026-08-30T15:00:00.000Z', status: 'open' },
      { what: 'already done', person_name: 'Ben', due_at: '2026-08-30T10:00:00.000Z', status: 'done' }
    ],
    scheduledTasks: [
      { title: 'Take the parcel', recurrence: 'once', next_run_at: '2026-08-30T13:00:00.000Z', active: true },
      { title: 'Old watch', recurrence: 'once', next_run_at: '2026-08-30T11:00:00.000Z', active: false }
    ],
    now
  });

  assert.deepEqual(state.presence, {
    state: 'home',
    observedAt: now.toISOString(),
    homeConfigured: true,
    locationRemindersEnabled: true
  });
  assert.deepEqual(state.people, [
    { name: 'Sarah Jones', relationship: 'partner' },
    { name: 'Ben', relationship: 'friend' }
  ]);
  assert.deepEqual(state.openCommitments, [{
    what: 'send the school forms', personName: 'Sarah', dueAt: '2026-08-30T15:00:00.000Z'
  }]);
  assert.deepEqual(state.activePlans, [{
    title: 'Take the parcel', recurrence: 'once', nextRunAt: '2026-08-30T13:00:00.000Z', contextEvent: null
  }]);
  assert.equal(JSON.stringify(state).includes('+441234567890'), false, 'contact details must not enter ambient context');
  assert.equal(JSON.stringify(state).includes('already done'), false, 'closed obligations must not enter current state');
});

test('household state never claims presence from stale or incomplete location evidence', () => {
  const now = new Date('2026-08-30T12:00:00.000Z');
  const stale = normalizeHouseholdState({
    nativeContext: {
      location: AWAY,
      settings: { homeLocation: HOME },
      updated_at: '2026-08-30T10:00:00.000Z'
    },
    now
  });
  const missing = normalizeHouseholdState({ nativeContext: {}, now });

  assert.equal(stale.presence.state, 'unknown');
  assert.equal(stale.presence.homeConfigured, true);
  assert.equal(missing.presence.state, 'unknown');
  assert.equal(missing.presence.homeConfigured, false);
});

test('household state fails closed on malformed collections', () => {
  const state = normalizeHouseholdState({ people: null, commitments: {}, scheduledTasks: 'not a list' });
  assert.deepEqual(state.people, []);
  assert.deepEqual(state.openCommitments, []);
  assert.deepEqual(state.activePlans, []);
});

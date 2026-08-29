'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const contextWatches = require('../../api/services/context-watches');

const HOME = { latitude: 51.5007, longitude: -0.1246 };
const AWAY = { latitude: 51.5207, longitude: -0.1246 };

function native(location, now, settings = {}) {
  return {
    location,
    settings: { locationReminders: true, homeLocation: HOME, ...settings },
    updated_at: now.toISOString()
  };
}

function watch(event, notifyRule = 'once') {
  return {
    type: 'context',
    notifyRule,
    context: contextWatches.buildContextConfig({ event, radiusMetres: 250 }),
    history: []
  };
}

function metricWatch(metric, threshold, comparator = 'below', notifyRule = 'once') {
  return {
    type: 'context',
    notifyRule,
    context: contextWatches.buildContextConfig({ metric, threshold, comparator }),
    history: []
  };
}

function health(values, now, capabilities = { healthKit: true }) {
  const recordedAt = now.toISOString();
  return {
    health: {
      capturedAt: recordedAt,
      latestHeartRateRecordedAt: recordedAt,
      restingHeartRateRecordedAt: recordedAt,
      ...values
    },
    capabilities,
    updated_at: recordedAt
  };
}

test('arriving home fires only on an outside-to-inside transition', () => {
  const firstAt = new Date('2026-08-29T17:00:00.000Z');
  const baseline = contextWatches.evaluateContextWatch(watch('arrive_home'), native(AWAY, firstAt), { now: firstAt });
  assert.equal(baseline.notify, false);
  assert.equal(baseline.kind, 'baseline');
  assert.equal(baseline.state.context.lastInside, false);

  const arrivalAt = new Date('2026-08-29T17:20:00.000Z');
  const arrival = contextWatches.evaluateContextWatch(baseline.state, native(HOME, arrivalAt), { now: arrivalAt });
  assert.equal(arrival.notify, true);
  assert.equal(arrival.kind, 'context_triggered');
  assert.equal(arrival.terminal, true);
  assert.equal(arrival.state.context.transitionCount, 1);

  const stillHome = contextWatches.evaluateContextWatch(arrival.state, native(HOME, arrivalAt), { now: arrivalAt });
  assert.equal(stillHome.notify, false);
  assert.equal(stillHome.state.context.transitionCount, 1);
});

test('leaving home fires only on an inside-to-outside transition', () => {
  const firstAt = new Date('2026-08-29T08:00:00.000Z');
  const baseline = contextWatches.evaluateContextWatch(watch('leave_home'), native(HOME, firstAt), { now: firstAt });
  const leaveAt = new Date('2026-08-29T08:10:00.000Z');
  const departure = contextWatches.evaluateContextWatch(baseline.state, native(AWAY, leaveAt), { now: leaveAt });
  assert.equal(departure.notify, true);
  assert.equal(departure.reason, 'left home');
});

test('ongoing context watches remain active across repeated arrivals', () => {
  const at = new Date('2026-08-29T17:00:00.000Z');
  let result = contextWatches.evaluateContextWatch(watch('arrive_home', 'ongoing'), native(AWAY, at), { now: at });
  result = contextWatches.evaluateContextWatch(result.state, native(HOME, at), { now: at });
  assert.equal(result.notify, true);
  assert.equal(result.terminal, false);
  result = contextWatches.evaluateContextWatch(result.state, native(AWAY, at), { now: at });
  assert.equal(result.notify, false);
  result = contextWatches.evaluateContextWatch(result.state, native(HOME, at), { now: at });
  assert.equal(result.notify, true);
  assert.equal(result.state.context.transitionCount, 2);
});

test('stale or missing context never fabricates a transition and reports one blockage', () => {
  const now = new Date('2026-08-29T18:00:00.000Z');
  const stale = native(AWAY, new Date('2026-08-29T16:00:00.000Z'));
  const first = contextWatches.evaluateContextWatch(watch('arrive_home'), stale, { now });
  assert.equal(first.notify, true);
  assert.equal(first.kind, 'blocked');
  assert.match(first.reason, /too old/);

  const repeated = contextWatches.evaluateContextWatch(first.state, stale, { now });
  assert.equal(repeated.notify, false);
  assert.equal(repeated.kind, 'blocked');
  assert.equal(repeated.state.context.lastInside, null);
});

test('location-reminder permission and a saved home are deterministic prerequisites', () => {
  const now = new Date('2026-08-29T18:00:00.000Z');
  const disabled = contextWatches.evaluateContextWatch(
    watch('arrive_home'),
    native(AWAY, now, { locationReminders: false }),
    { now }
  );
  assert.equal(disabled.kind, 'blocked');
  assert.match(disabled.reason, /turned off/);

  const noHome = contextWatches.evaluateContextWatch(
    watch('arrive_home'),
    { location: AWAY, settings: { locationReminders: true }, updated_at: now.toISOString() },
    { now }
  );
  assert.equal(noHome.kind, 'blocked');
  assert.match(noHome.reason, /home location is not set/);
});

test('context configuration rejects unknown events and bounds the radius', () => {
  assert.equal(contextWatches.buildContextConfig({ event: 'near_shop' }), null);
  assert.equal(contextWatches.buildContextConfig({ event: 'arrive_home', radiusMetres: 99999 }).radiusMetres, 5000);
  assert.equal(contextWatches.buildContextConfig({ event: 'leave_home', radiusMetres: 0 }).radiusMetres, 200);
});

test('a health threshold fires only on a fresh, real crossing', () => {
  const firstAt = new Date('2026-08-29T18:00:00.000Z');
  const baseline = contextWatches.evaluateContextWatch(
    metricWatch('resting_heart_rate', 45),
    health({ restingHeartRate: 52 }, firstAt),
    { now: firstAt }
  );
  assert.equal(baseline.notify, false);
  assert.equal(baseline.kind, 'baseline');
  assert.equal(baseline.state.context.lastMet, false);

  const crossedAt = new Date('2026-08-29T18:10:00.000Z');
  const crossed = contextWatches.evaluateContextWatch(
    baseline.state,
    health({ restingHeartRate: 44 }, crossedAt),
    { now: crossedAt }
  );
  assert.equal(crossed.notify, true);
  assert.equal(crossed.terminal, true);
  assert.equal(crossed.value, 44);
  assert.match(crossed.reason, /went below 45 bpm/);
});

test('metric watches require an explicit supported metric and numeric threshold', () => {
  assert.equal(contextWatches.buildContextConfig({ metric: 'blood_pressure', threshold: 120 }), null);
  assert.equal(contextWatches.buildContextConfig({ metric: 'latest_heart_rate' }), null);
  assert.equal(contextWatches.buildContextConfig({ event: 'arrive_home', metric: 'steps_today', threshold: 10000 }), null);
  assert.equal(
    contextWatches.buildContextConfig({ metric: 'steps_today', threshold: 10000, comparator: 'above' }).comparator,
    'above'
  );
});

test('missing HealthKit evidence blocks once and cannot fabricate a crossing', () => {
  const now = new Date('2026-08-29T18:00:00.000Z');
  const first = contextWatches.evaluateContextWatch(
    metricWatch('latest_heart_rate', 45),
    health({}, now),
    { now }
  );
  assert.equal(first.notify, true);
  assert.equal(first.kind, 'blocked');
  assert.match(first.reason, /latest heart rate is unavailable/);

  const repeated = contextWatches.evaluateContextWatch(first.state, health({}, now), { now });
  assert.equal(repeated.notify, false);
  assert.equal(repeated.state.context.lastMet, null);
});

test('a freshly synced phone cannot make an old HealthKit sample look current', () => {
  const now = new Date('2026-08-29T18:00:00.000Z');
  const result = contextWatches.evaluateContextWatch(
    metricWatch('latest_heart_rate', 45),
    {
      health: {
        latestHeartRate: 44,
        latestHeartRateRecordedAt: '2026-08-29T16:00:00.000Z',
        capturedAt: now.toISOString()
      },
      capabilities: { healthKit: true },
      updated_at: now.toISOString()
    },
    { now }
  );
  assert.equal(result.notify, true);
  assert.equal(result.kind, 'blocked');
  assert.match(result.reason, /too old to prove a change/);
  assert.equal(result.state.context.lastMet, null);
});

test('health-watch authority comes from the current user message, not model intent', () => {
  const requested = { metric: 'resting_heart_rate', threshold: 45, comparator: 'below' };
  assert.equal(
    contextWatches.explicitMetricWatchRequest(requested, 'Tell me if my resting heart rate drops below 45 bpm.'),
    true
  );
  assert.equal(
    contextWatches.explicitMetricWatchRequest(requested, 'Is a resting heart rate of 45 okay?'),
    false,
    'a health question is not permission to monitor'
  );
  assert.equal(
    contextWatches.explicitMetricWatchRequest(requested, 'If my resting heart rate is 45, is that okay?'),
    false,
    'conditional wording alone is not permission to monitor'
  );
  assert.equal(
    contextWatches.explicitMetricWatchRequest(requested, 'Tell me if my resting heart rate drops below 50 bpm.'),
    false,
    'the model cannot substitute a different threshold'
  );
  assert.equal(
    contextWatches.explicitMetricWatchRequest({ metric: 'steps_today', threshold: 10000, comparator: 'above' }, 'Let me know when I pass 10,000 steps.'),
    true
  );
});

test('location-watch authority comes from the current user message and exact radius', () => {
  assert.equal(
    contextWatches.explicitLocationWatchRequest({ event: 'arrive_home' }, 'Remind me to take the parcel when I get home.'),
    true
  );
  assert.equal(
    contextWatches.explicitLocationWatchRequest({ event: 'leave_home' }, 'Tell me about the bins when I leave home.'),
    true
  );
  assert.equal(
    contextWatches.explicitLocationWatchRequest({ event: 'arrive_home' }, 'Am I home right now?'),
    false,
    'a location question is not permission to monitor'
  );
  assert.equal(
    contextWatches.explicitLocationWatchRequest({ event: 'leave_home' }, 'Remind me when I get home.'),
    false,
    'the model cannot reverse the requested transition'
  );
  assert.equal(
    contextWatches.explicitLocationWatchRequest(
      { event: 'arrive_home', radiusMetres: 500 },
      'Notify me when I get within 500 metres of home.'
    ),
    true
  );
  assert.equal(
    contextWatches.explicitLocationWatchRequest(
      { event: 'arrive_home', radiusMetres: 500 },
      'Notify me when I get home.'
    ),
    false,
    'the model cannot invent a custom radius'
  );
});

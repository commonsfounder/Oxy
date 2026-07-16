const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const { getStructuredDataResults, buildConciseDataAnswer } = require('../../api/index.js');

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function mockGoogleConnectorDeps(request, parent, isMain) {
  if (request === 'axios') {
    return { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
  }
  if (request === '../runtime') {
    return {
      createSupabaseServiceClient: () => ({}),
      logMissingRuntimeEnvOnce: () => {}
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const google = require('../../connectors/google');
Module._load = originalLoad;
const { calendarWindow } = google._private;

test('a calendar summary for an unbounded "check my calendar" request does not claim "Tomorrow"', () => {
  // Reproduces the reported bug: user said "Check my calendar" (no today/tomorrow),
  // so no day bound applies, yet the far-future events that leak through (a recurring
  // "Happy birthday!" event expanded years into the future by Google's singleEvents
  // expansion) got mislabeled as "Tomorrow has N calendar items."
  const actionResults = [{
    action: 'get_calendar_events',
    input: { when: '' },
    result: {
      success: true,
      when: null,
      events: [
        { title: 'A-level Results Day', start: '2026-08-13T08:00:00+01:00', end: '2026-08-13T09:00:00+01:00' },
        { title: 'Happy birthday!', start: '2027-06-04', end: '2027-06-05' },
        { title: 'Happy birthday!', start: '2028-06-04', end: '2028-06-05' }
      ]
    }
  }];

  const dataResults = getStructuredDataResults(actionResults, 'Check my calendar');
  const answer = buildConciseDataAnswer(dataResults);

  assert.ok(
    !/^Tomorrow has/.test(answer),
    `summary falsely claims "Tomorrow" when no day was requested:\n${answer}`
  );
  assert.match(answer, /^You have 3 upcoming calendar items\.$/m);
});

test('a calendar summary for an explicit "tomorrow" request still says "Tomorrow"', () => {
  const actionResults = [{
    action: 'get_calendar_events',
    input: { when: 'tomorrow' },
    result: {
      success: true,
      when: 'tomorrow',
      events: [
        { title: 'Standup', start: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }
      ]
    }
  }];

  const dataResults = getStructuredDataResults(actionResults, 'What is on my calendar tomorrow?');
  const answer = buildConciseDataAnswer(dataResults);

  assert.match(answer, /^Tomorrow has 1 calendar item\.$/m);
});

test('calendar queries without an explicit day are still bounded to a near-term window', () => {
  // Reproduces the other half of the bug: with no timeMax, Google's API happily
  // returns a recurring event's instances years into the future, which then out-rank
  // real near-term events in the "next N events" list.
  const window = calendarWindow({});
  assert.ok(window.timeMax, `expected a bounded timeMax for an unspecified "when", got ${window.timeMax}`);
});

test('the prep-advice line only mentions categories that actually returned items', () => {
  // Reproduces the second half of the reported bug: calendar-only results still told
  // the user to "Start with the email items" even though zero emails were shown.
  const actionResults = [{
    action: 'get_calendar_events',
    input: { when: 'tomorrow' },
    result: {
      success: true,
      when: 'tomorrow',
      events: [{ title: 'Standup', start: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }]
    }
  }];

  const dataResults = getStructuredDataResults(actionResults, 'What is on my calendar tomorrow?');
  const answer = buildConciseDataAnswer(dataResults);

  assert.ok(
    !/email items/i.test(answer),
    `advice line references email items that were never fetched:\n${answer}`
  );
});

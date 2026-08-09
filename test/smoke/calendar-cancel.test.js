// Real calendar cancellation primitives (connectors/google.js's delete_calendar_event and
// end_recurring_series), tested against a FAKE calendar that implements real Google Calendar
// semantics — sendUpdates only fires when there is a real attendee, deleting is genuinely
// gone rather than hidden, and ending a series edits the RRULE the way Google's own UI does
// — rather than a static stub. No real Google API access is available in this environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let events; // Map<id, event resource>
let deleteLog; // [{id, sendUpdates}]
let patchLog;  // [{id, body, sendUpdates}]

function resetCalendar() {
  events = new Map();
  deleteLog = [];
  patchLog = [];
}

function seedEvent(id, data = {}) {
  events.set(id, { id, status: 'confirmed', summary: 'Untitled', ...data });
}

const mockAxios = {
  async get(url) {
    const match = url.match(/\/events\/([^/?]+)$/);
    if (!match) throw new Error(`mockAxios.get: unhandled URL ${url}`);
    const event = events.get(decodeURIComponent(match[1]));
    if (!event) {
      const err = new Error('Not Found');
      err.response = { status: 404, data: { error: { message: 'Not Found' } } };
      throw err;
    }
    return { data: { ...event } };
  },
  async delete(url, config) {
    const match = url.match(/\/events\/([^/?]+)$/);
    const id = decodeURIComponent(match[1]);
    if (!events.has(id)) {
      const err = new Error('Not Found');
      err.response = { status: 404, data: { error: { message: 'Not Found' } } };
      throw err;
    }
    deleteLog.push({ id, sendUpdates: config?.params?.sendUpdates });
    events.delete(id);
    return { status: 204, data: '' };
  },
  async patch(url, body, config) {
    const match = url.match(/\/events\/([^/?]+)$/);
    const id = decodeURIComponent(match[1]);
    const existing = events.get(id);
    if (!existing) {
      const err = new Error('Not Found');
      err.response = { status: 404, data: { error: { message: 'Not Found' } } };
      throw err;
    }
    const updated = { ...existing, ...body };
    events.set(id, updated);
    patchLog.push({ id, body, sendUpdates: config?.params?.sendUpdates });
    return { data: { ...updated } };
  },
  async post(url) {
    if (url === 'https://oauth2.googleapis.com/token') {
      return { data: { access_token: 'fake-access-token', expires_in: 3600 } };
    }
    throw new Error(`mockAxios.post: unhandled URL ${url}`);
  }
};

const originalLoad = Module._load;
Module._load = function mockGoogleConnectorDeps(request, parent, isMain) {
  if (request === 'axios') return mockAxios;
  if (request === '../runtime') {
    return {
      createSupabaseServiceClient: () => ({
        from: () => ({
          select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
          upsert: async () => ({ error: null })
        })
      }),
      logMissingRuntimeEnvOnce: () => {}
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const google = require('../../connectors/google');
Module._load = originalLoad;

process.env.GMAIL_REFRESH_TOKEN = 'test-refresh-token';
process.env.GMAIL_CLIENT_ID = 'test-client-id';
process.env.GMAIL_CLIENT_SECRET = 'test-client-secret';

test.beforeEach(() => resetCalendar());

// ── delete_calendar_event ────────────────────────────────────────────────────────────────
test('a personal block with no attendees is deleted with no attendee notification', async () => {
  seedEvent('e1', { summary: 'Focus time', attendees: [] });
  const result = await google.execute('user-1', 'delete_calendar_event', { event_id: 'e1' });
  assert.equal(result.success, true);
  assert.equal(result.hadAttendees, false);
  assert.equal(result.notifiedAttendees, false);
  assert.equal(events.has('e1'), false, 'genuinely gone, not hidden');
  assert.equal(deleteLog[0].sendUpdates, 'none');
});

test('an event with real attendees notifies them by default', async () => {
  seedEvent('e2', { summary: 'Planning sync', attendees: [{ email: 'ben@example.com' }] });
  const result = await google.execute('user-1', 'delete_calendar_event', { event_id: 'e2' });
  assert.equal(result.hadAttendees, true);
  assert.equal(result.notifiedAttendees, true);
  assert.equal(deleteLog[0].sendUpdates, 'all');
});

test('notify_attendees:false is honoured even with real attendees', async () => {
  seedEvent('e3', { summary: 'Quiet cancel', attendees: [{ email: 'ben@example.com' }] });
  const result = await google.execute('user-1', 'delete_calendar_event', { event_id: 'e3', notify_attendees: false });
  assert.equal(result.notifiedAttendees, false);
  assert.equal(deleteLog[0].sendUpdates, 'none');
});

test('the organizer themselves is not counted as an attendee to notify', async () => {
  seedEvent('e4', { summary: 'Solo block', attendees: [{ email: 'me@example.com', self: true }] });
  const result = await google.execute('user-1', 'delete_calendar_event', { event_id: 'e4' });
  assert.equal(result.hadAttendees, false);
  assert.equal(deleteLog[0].sendUpdates, 'none');
});

test('deleting an event that no longer exists is reported honestly', async () => {
  const result = await google.execute('user-1', 'delete_calendar_event', { event_id: 'ghost' });
  assert.equal(result.success, false);
  assert.match(result.error, /no longer exists/);
});

test('an already-cancelled event is not treated as a fresh success', async () => {
  seedEvent('e5', { summary: 'Already gone', status: 'cancelled' });
  const result = await google.execute('user-1', 'delete_calendar_event', { event_id: 'e5' });
  assert.equal(result.success, true);
  assert.equal(result.alreadyCancelled, true);
});

test('delete_calendar_event requires event_id', async () => {
  const result = await google.execute('user-1', 'delete_calendar_event', {});
  assert.equal(result.success, false);
  assert.match(result.error, /requires event_id/);
});

// ── end_recurring_series ──────────────────────────────────────────────────────────────────
test('ending a timed series sets UNTIL to the end of the day before the given occurrence', async () => {
  seedEvent('master1', {
    summary: 'Weekly standup',
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
    start: { dateTime: '2026-08-03T09:00:00+01:00' },
    attendees: []
  });
  const result = await google.execute('user-1', 'end_recurring_series', {
    event_id: 'master1', from_date: '2026-08-17T09:00:00+01:00'
  });
  assert.equal(result.success, true);
  const patched = events.get('master1');
  assert.match(patched.recurrence[0], /^RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260816T235959Z$/);
});

test('ending an all-day series uses a bare date, not a datetime, for UNTIL', async () => {
  seedEvent('master2', {
    summary: 'Annual leave',
    recurrence: ['RRULE:FREQ=DAILY'],
    start: { date: '2026-08-03' },
    attendees: []
  });
  const result = await google.execute('user-1', 'end_recurring_series', {
    event_id: 'master2', from_date: '2026-08-10'
  });
  assert.equal(result.success, true);
  assert.match(events.get('master2').recurrence[0], /^RRULE:FREQ=DAILY;UNTIL=20260809$/);
});

test('COUNT is dropped when UNTIL is added — RFC 5545 forbids both on one rule', async () => {
  seedEvent('master3', {
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=20'],
    start: { dateTime: '2026-08-03T09:00:00+01:00' }
  });
  await google.execute('user-1', 'end_recurring_series', { event_id: 'master3', from_date: '2026-08-17T09:00:00+01:00' });
  const rule = events.get('master3').recurrence[0];
  assert.equal(/COUNT=/.test(rule), false);
  assert.match(rule, /UNTIL=/);
});

test('a non-RRULE line (EXDATE) survives untouched', async () => {
  seedEvent('master4', {
    recurrence: ['RRULE:FREQ=WEEKLY', 'EXDATE:20260810T080000Z'],
    start: { dateTime: '2026-08-03T09:00:00+01:00' }
  });
  await google.execute('user-1', 'end_recurring_series', { event_id: 'master4', from_date: '2026-08-17T09:00:00+01:00' });
  const recurrence = events.get('master4').recurrence;
  assert.ok(recurrence.some(line => line === 'EXDATE:20260810T080000Z'));
});

test('ending a series notifies real attendees, same as a delete', async () => {
  seedEvent('master5', {
    recurrence: ['RRULE:FREQ=WEEKLY'],
    start: { dateTime: '2026-08-03T09:00:00+01:00' },
    attendees: [{ email: 'ben@example.com' }]
  });
  const result = await google.execute('user-1', 'end_recurring_series', { event_id: 'master5', from_date: '2026-08-17T09:00:00+01:00' });
  assert.equal(result.notifiedAttendees, true);
  assert.equal(patchLog[0].sendUpdates, 'all');
});

test('ending a series on an event that is not actually recurring is refused', async () => {
  seedEvent('plain1', { summary: 'One-off', start: { dateTime: '2026-08-03T09:00:00+01:00' } });
  const result = await google.execute('user-1', 'end_recurring_series', { event_id: 'plain1', from_date: '2026-08-17T09:00:00+01:00' });
  assert.equal(result.success, false);
  assert.match(result.error, /not part of a recurring series/);
});

test('end_recurring_series requires event_id and from_date', async () => {
  const result = await google.execute('user-1', 'end_recurring_series', { event_id: 'master1' });
  assert.equal(result.success, false);
  assert.match(result.error, /requires event_id and from_date/);
});

// ── The RRULE-trimming utility directly ───────────────────────────────────────────────────
const { trimRecurrenceUntil, formatUntilUTC } = google._private;

test('formatUntilUTC produces the two RFC 5545 value forms', () => {
  const d = new Date('2026-08-16T23:59:59Z');
  assert.equal(formatUntilUTC(d, false), '20260816T235959Z');
  assert.equal(formatUntilUTC(d, true), '20260816');
});

test('trimRecurrenceUntil reports whether it actually found an RRULE to touch', () => {
  const untouched = trimRecurrenceUntil(['EXDATE:20260810T080000Z'], new Date('2026-08-16T23:59:59Z'), false);
  assert.equal(untouched.touched, false);
  const touched = trimRecurrenceUntil(['RRULE:FREQ=DAILY'], new Date('2026-08-16T23:59:59Z'), false);
  assert.equal(touched.touched, true);
});

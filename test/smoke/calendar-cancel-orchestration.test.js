// cancel_calendar_event end-to-end through the real executeAction path, with the Google
// connector's registry entries replaced by a fake calendar — the same pattern
// scheduling-orchestration.test.js uses for create/move. Resolution (title/date/attendee/id
// matching, ambiguity refusal, the recurring-series clarification gate) is real code; the
// connector itself is faked.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');
const { dispatchOverrides } = require('../../connectors');

const USER_ID = 'demo-test-user';
const CALENDAR_ACTIONS = ['get_calendar_events', 'delete_calendar_event', 'end_recurring_series'];
const originals = Object.fromEntries(CALENDAR_ACTIONS.map(a => [a, dispatchOverrides[a]]));

let calendar;
function installFakeCalendar(events = []) {
  calendar = { events: [...events], deleted: [], seriesEnded: [] };
  const fake = {
    async execute(_userId, action, params) {
      if (action === 'get_calendar_events') return { success: true, events: calendar.events };
      if (action === 'delete_calendar_event') {
        // A real Calendar master event is a fully addressable resource by its own id even
        // when it never appears in a singleEvents(true) listing — the fixture only tracks
        // listed occurrences, so a target may legitimately not be found here (scope:
        // 'series' addresses the MASTER id, which the fixture never seeded as its own
        // event). This orchestration test's job is which id gets passed, not full calendar
        // realism — the real delete semantics (404 vs success) are covered at the connector
        // level in calendar-cancel.test.js.
        const target = calendar.events.find(e => e.id === params.event_id);
        calendar.deleted.push(params.event_id);
        calendar.events = calendar.events.filter(e => e.id !== params.event_id);
        return {
          success: true, eventId: params.event_id, title: target?.title || null,
          hadAttendees: (target?.attendees || []).length > 0,
          notifiedAttendees: (target?.attendees || []).length > 0 && params.notify_attendees !== false,
          text: `Cancelled "${target?.title || 'the event'}"`
        };
      }
      if (action === 'end_recurring_series') {
        calendar.seriesEnded.push(params);
        // Everything from from_date onward (same series) is removed, mirroring what a real
        // UNTIL edit does to a later singleEvents listing.
        calendar.events = calendar.events.filter(e =>
          e.recurringEventId !== params.event_id || new Date(e.start) < new Date(params.from_date));
        return { success: true, eventId: params.event_id, hadAttendees: false, notifiedAttendees: false, text: 'Ended the series' };
      }
      return { success: false, error: 'unexpected action' };
    }
  };
  for (const action of CALENDAR_ACTIONS) dispatchOverrides[action] = fake;
}

test.afterEach(() => {
  for (const action of CALENDAR_ACTIONS) dispatchOverrides[action] = originals[action];
});

const FUTURE = new Date(Date.now() + 3 * 86400000);
const dayIso = (h, m = 0) => {
  const d = new Date(FUTURE);
  d.setUTCHours(h, m, 0, 0);
  return d.toISOString();
};

function event(id, title, opts = {}) {
  return { id, title, start: dayIso(15), end: dayIso(16), attendees: [], ...opts };
}

// ── Resolution ─────────────────────────────────────────────────────────────────────────
test('cancelling by title deletes the real event, not a Millie-side hide', async () => {
  installFakeCalendar([event('e1', 'Millie test block')]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'Millie test' });
  assert.equal(result.success, true);
  assert.equal(result.eventId, 'e1');
  assert.deepEqual(calendar.deleted, ['e1']);
  assert.equal(calendar.events.length, 0, 'genuinely removed from the calendar, not just from the response');
});

test('cancelling by event_id skips title matching entirely', async () => {
  installFakeCalendar([event('e1', 'Standup'), event('e2', 'Standup')]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { event_id: 'e2' });
  assert.equal(result.success, true);
  assert.deepEqual(calendar.deleted, ['e2']);
});

test('an ambiguous title is refused rather than guessed', async () => {
  installFakeCalendar([event('e1', 'Client call'), event('e2', 'Client call — different one')]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'client call' });
  assert.equal(result.success, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(calendar.deleted, [], 'nothing is deleted while ambiguous');
});

test('no match at all is a plain failure, not a silent no-op success', async () => {
  installFakeCalendar([event('e1', 'Standup')]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'nonexistent thing' });
  assert.equal(result.success, false);
  assert.match(result.error, /couldn't find/);
});

test('with nothing to identify the event at all, it asks rather than matching everything', async () => {
  installFakeCalendar([event('e1', 'Standup'), event('e2', 'Retro')]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', {});
  assert.equal(result.success, false);
  assert.match(result.error, /which event/i);
  assert.deepEqual(calendar.deleted, []);
});

// ── Date filtering ─────────────────────────────────────────────────────────────────────
test('"cancel my meeting tomorrow" only matches events on that day', async () => {
  const today = new Date();
  const todayIso = new Date(today.getTime()).toISOString();
  installFakeCalendar([
    event('e1', 'Recurring standup', { start: todayIso, end: todayIso }),
    event('e2', 'Recurring standup', { start: dayIso(15), end: dayIso(16) }) // 3 days out, "not today"
  ]);
  // Both share a title, so date narrows it to exactly one — otherwise this would be ambiguous.
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'Recurring standup', when: 'today' });
  assert.equal(result.success, true);
  assert.deepEqual(calendar.deleted, ['e1']);
});

// ── Attendee filtering ─────────────────────────────────────────────────────────────────
test('"cancel the meeting with Ben" matches on a real attendee address', async () => {
  installFakeCalendar([
    event('e1', 'Planning', { attendees: ['ben@example.com'] }),
    event('e2', 'Planning', { attendees: ['mia@example.com'] })
  ]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'Planning', person_name: 'ben@example.com' });
  assert.equal(result.success, true);
  assert.deepEqual(calendar.deleted, ['e1']);
});

// ── Recurring series — the genuinely consequential ambiguity ────────────────────────────
test('a recurring occurrence with no stated scope asks, and deletes nothing yet', async () => {
  installFakeCalendar([event('inst1', 'Weekly standup', { recurringEventId: 'master1' })]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'Weekly standup' });
  assert.equal(result.success, false);
  assert.equal(result.needsClarification, true);
  assert.equal(result.recurring, true);
  assert.equal(result.masterEventId, 'master1');
  assert.deepEqual(calendar.deleted, []);
  assert.deepEqual(calendar.seriesEnded, []);
});

test('scope "this" deletes only the specific occurrence id, never the master', async () => {
  installFakeCalendar([event('inst1', 'Weekly standup', { recurringEventId: 'master1' })]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'Weekly standup', scope: 'this' });
  assert.equal(result.success, true);
  assert.deepEqual(calendar.deleted, ['inst1']);
  assert.deepEqual(calendar.seriesEnded, []);
});

test('scope "series" deletes the MASTER id, not the occurrence', async () => {
  installFakeCalendar([event('inst1', 'Weekly standup', { recurringEventId: 'master1' })]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'Weekly standup', scope: 'series' });
  assert.equal(result.success, true);
  assert.deepEqual(calendar.deleted, ['master1'], 'the whole series, addressed by its own id');
});

test('scope "future" ends the series rather than deleting a single event', async () => {
  installFakeCalendar([event('inst1', 'Weekly standup', { recurringEventId: 'master1', start: dayIso(9) })]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'Weekly standup', scope: 'future' });
  assert.equal(result.success, true);
  assert.equal(calendar.seriesEnded.length, 1);
  assert.equal(calendar.seriesEnded[0].event_id, 'master1');
  assert.equal(calendar.seriesEnded[0].from_date, dayIso(9));
  assert.deepEqual(calendar.deleted, [], 'not a delete call — a series edit');
});

test('a non-recurring event needs no scope and no clarification', async () => {
  installFakeCalendar([event('e1', 'One-off review')]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'One-off review' });
  assert.equal(result.success, true);
  assert.deepEqual(calendar.deleted, ['e1']);
});

test('notify_attendees:false reaches the connector call', async () => {
  installFakeCalendar([event('e1', 'Client call', { attendees: ['ben@example.com'] })]);
  const result = await app.executeAction(USER_ID, 'cancel_calendar_event', { title: 'Client call', notify_attendees: false });
  assert.equal(result.success, true);
  assert.equal(result.notifiedAttendees, false);
});

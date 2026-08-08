// The calendar actions end-to-end through the real executeAction path, with the Google
// connector's registry entry replaced by a fake calendar. Everything between the action and
// the calendar API — availability, conflict refusal, duplicate refusal, the move-not-recreate
// rule — is the real code.
//
// The connector itself (the actual HTTP calls to Google) is NOT exercised: this environment
// has no Google OAuth, so no real calendar was ever read or written.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');
const { registry } = require('../../connectors');

const USER_ID = 'demo-test-user';
const CALENDAR_ACTIONS = ['get_calendar_events', 'create_calendar_event', 'update_calendar_event'];
const originals = Object.fromEntries(CALENDAR_ACTIONS.map(a => [a, registry[a]]));

let calendar;
function installFakeCalendar(events = []) {
  calendar = { events: [...events], created: [], updated: [], readFails: false };
  const fake = {
    async execute(_userId, action, params) {
      if (action === 'get_calendar_events') {
        if (calendar.readFails) return { success: false, error: 'Google is not connected' };
        return { success: true, events: calendar.events };
      }
      if (action === 'create_calendar_event') {
        const id = `ev${calendar.created.length + 1}`;
        calendar.created.push({ id, ...params });
        // The real connector returns FLAT ISO strings, not Google's nested shape.
        calendar.events.push({ id, title: params.title, start: params.start_date, end: params.end_date });
        const invited = String(params.attendees || '').split(',').map(a => a.trim()).filter(Boolean);
        return { success: true, eventId: id, invited };
      }
      if (action === 'update_calendar_event') {
        calendar.updated.push(params);
        const existing = calendar.events.find(e => e.id === params.event_id);
        if (existing) {
          existing.start = params.start_date;
          existing.end = params.end_date;
        }
        return { success: true, eventId: params.event_id };
      }
      return { success: false, error: 'unexpected action' };
    }
  };
  for (const action of CALENDAR_ACTIONS) registry[action] = fake;
}

test.afterEach(() => {
  for (const action of CALENDAR_ACTIONS) registry[action] = originals[action];
});

// Exactly the shape connectors/google.js's get_calendar_events returns.
function busy(id, startIso, endIso, title) {
  return { id, title, start: startIso, end: endIso };
}

// A working day far enough ahead that "not in the past" never interferes.
const FUTURE = new Date(Date.now() + 3 * 86400000);
FUTURE.setUTCHours(9, 0, 0, 0);
const dayIso = (h, m = 0) => {
  const d = new Date(FUTURE);
  d.setUTCHours(h, m, 0, 0);
  return d.toISOString();
};

test('"when am I free?" answers from real events, and never proposes a busy time', async () => {
  installFakeCalendar([busy('a', dayIso(10), dayIso(11), 'Standup')]);
  const result = await app.executeAction(USER_ID, 'find_free_time', { duration_minutes: 60, days: 3 });
  assert.equal(result.success, true);
  assert.equal(result.calendarRead, true);
  assert.ok(result.slots.length > 0);
  for (const slot of result.slots) {
    const overlapsStandup = new Date(slot.start) < new Date(dayIso(11)) && new Date(slot.end) > new Date(dayIso(10));
    assert.equal(overlapsStandup, false, 'a proposed slot must never sit inside a real meeting');
  }
});

test('an unreadable calendar produces no suggestions at all', async () => {
  installFakeCalendar([]);
  calendar.readFails = true;
  const result = await app.executeAction(USER_ID, 'find_free_time', { duration_minutes: 60 });
  assert.equal(result.success, false);
  assert.equal(result.calendarRead, false);
  assert.match(result.text, /I'd only be guessing/);
});

test('a fully-booked window says so instead of offering something', async () => {
  installFakeCalendar([busy('a', dayIso(9), dayIso(18), 'Workshop')]);
  const result = await app.executeAction(USER_ID, 'find_free_time', { duration_minutes: 120, days: 1 });
  assert.deepEqual(result.slots, []);
  assert.match(result.text, /calendar is full across it/);
});

test('booking with no stated time picks a genuinely free slot and creates it', async () => {
  installFakeCalendar([busy('a', dayIso(9), dayIso(12), 'Morning block')]);
  const result = await app.executeAction(USER_ID, 'schedule_block', { title: 'Case study', duration_minutes: 120 });
  assert.equal(result.success, true);
  assert.equal(calendar.created.length, 1);
  assert.match(result.text, /Booked "Case study"/);
  // The property that matters is not WHICH free slot it chose (the earliest genuinely free
  // one may well be today) but that the slot it chose is genuinely free.
  const overlaps = new Date(result.start) < new Date(dayIso(12)) && new Date(result.end) > new Date(dayIso(9));
  assert.equal(overlaps, false, 'the booked slot must not overlap the existing block');
});

test('booking a time that clashes is refused and names the clash', async () => {
  installFakeCalendar([busy('a', dayIso(14), dayIso(15), 'Interview')]);
  const result = await app.executeAction(USER_ID, 'schedule_block', {
    title: 'Gym', duration_minutes: 60, start: dayIso(14, 30)
  });
  assert.equal(result.success, false);
  assert.match(result.error, /clashes with Interview/);
  assert.equal(calendar.created.length, 0, 'nothing may be created when it would double-book');
});

test('a clash can be overridden, but only explicitly', async () => {
  installFakeCalendar([busy('a', dayIso(14), dayIso(15), 'Interview')]);
  const result = await app.executeAction(USER_ID, 'schedule_block', {
    title: 'Gym', duration_minutes: 60, start: dayIso(14, 30), allow_conflict: true
  });
  assert.equal(result.success, true);
  assert.equal(calendar.created.length, 1);
});

test('booking the same block twice does not create a second one', async () => {
  installFakeCalendar([]);
  await app.executeAction(USER_ID, 'schedule_block', { title: 'Case study', duration_minutes: 60, start: dayIso(14) });
  const again = await app.executeAction(USER_ID, 'schedule_block', { title: 'Case study', duration_minutes: 60, start: dayIso(14) });
  assert.equal(again.duplicate, true);
  assert.equal(calendar.created.length, 1);
  assert.match(again.text, /already in your calendar/);
});

test('a calendar that cannot be read means nothing is booked blind', async () => {
  installFakeCalendar([]);
  calendar.readFails = true;
  const result = await app.executeAction(USER_ID, 'schedule_block', { title: 'Anything', start: dayIso(14) });
  assert.equal(result.success, false);
  assert.match(result.error, /won't book anything blind/);
  assert.equal(calendar.created.length, 0);
});

test('inviting someone passes real addresses through to the invitation', async () => {
  installFakeCalendar([]);
  const result = await app.executeAction(USER_ID, 'schedule_block', {
    title: 'Call with Ben', duration_minutes: 30, start: dayIso(15), attendees: 'ben@example.com'
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.invited, ['ben@example.com']);
  assert.match(result.text, /invited ben@example\.com/);
});

// ── Replanning ─────────────────────────────────────────────────────────────────────────
test('moving an event modifies it rather than creating a second one', async () => {
  installFakeCalendar([busy('gym1', dayIso(9), dayIso(10), 'Gym')]);
  const result = await app.executeAction(USER_ID, 'move_calendar_event', { title: 'Gym', start: dayIso(17) });
  assert.equal(result.success, true);
  assert.equal(calendar.updated.length, 1);
  assert.equal(calendar.created.length, 0, 'the old time must not be left behind next to a new event');
  assert.equal(calendar.updated[0].event_id, 'gym1');
  assert.match(result.text, /Moved "Gym"/);
});

test('a moved event keeps its original length unless a new one is given', async () => {
  installFakeCalendar([busy('gym1', dayIso(9), dayIso(10, 30), 'Gym')]);
  await app.executeAction(USER_ID, 'move_calendar_event', { title: 'Gym', start: dayIso(17) });
  const { start_date, end_date } = calendar.updated[0];
  assert.equal(new Date(end_date) - new Date(start_date), 90 * 60000);

  installFakeCalendar([busy('gym1', dayIso(9), dayIso(10), 'Gym')]);
  await app.executeAction(USER_ID, 'move_calendar_event', { title: 'Gym', start: dayIso(17), duration_minutes: 120 });
  assert.equal(new Date(calendar.updated[0].end_date) - new Date(calendar.updated[0].start_date), 120 * 60000);
});

test('an event is not treated as a conflict with itself when moved', async () => {
  installFakeCalendar([busy('gym1', dayIso(9), dayIso(10), 'Gym')]);
  const result = await app.executeAction(USER_ID, 'move_calendar_event', { title: 'Gym', start: dayIso(9, 30) });
  assert.equal(result.success, true, 'nudging an event slightly must not clash with its own old slot');
});

test('moving into a clash is refused and names what it would hit', async () => {
  installFakeCalendar([
    busy('gym1', dayIso(9), dayIso(10), 'Gym'),
    busy('int1', dayIso(14), dayIso(15), 'Interview')
  ]);
  const result = await app.executeAction(USER_ID, 'move_calendar_event', { title: 'Gym', start: dayIso(14, 15) });
  assert.equal(result.success, false);
  assert.match(result.error, /clash with Interview/);
  assert.equal(calendar.updated.length, 0);
});

test('an ambiguous event description asks which one', async () => {
  installFakeCalendar([
    busy('a', dayIso(9), dayIso(10), 'Team call'),
    busy('b', dayIso(11), dayIso(12), 'Client call')
  ]);
  const result = await app.executeAction(USER_ID, 'move_calendar_event', { title: 'call', start: dayIso(16) });
  assert.equal(result.success, false);
  assert.match(result.error, /More than one event matches/);
});

test('moving something that does not exist says so', async () => {
  installFakeCalendar([]);
  const result = await app.executeAction(USER_ID, 'move_calendar_event', { title: 'nothing like this', start: dayIso(16) });
  assert.equal(result.success, false);
  assert.match(result.error, /couldn't find an event matching/);
});

test('scheduling work for a commitment fits it around real events', async () => {
  installFakeCalendar([busy('a', dayIso(9), dayIso(15), 'Booked solid')]);
  const result = await app.executeAction(USER_ID, 'schedule_block', {
    title: 'Work on the case study', duration_minutes: 60
  });
  assert.equal(result.success, true);
  const overlaps = new Date(result.start) < new Date(dayIso(15)) && new Date(result.end) > new Date(dayIso(9));
  assert.equal(overlaps, false, 'work time must be found around what is already booked');
});

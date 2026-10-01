// Activity must read as Adam's record of the world, not the chat transcript, and must never show
// impossible chronology. Home is current state, not history.

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildActivityFeed, classifyAction, describeAction } = require('../../api/services/activity-feed');
const { buildHomeModel, normalizeObservation } = require('../../api/services/home-model');
const { isRoutineChatTurn } = require('../../api/services/home-state');

const NOW = new Date('2026-10-02T12:00:00.000Z');
const row = (type, input, status = 'executed', minutesAgo = 5, extra = {}) => ({
  id: `${type}-${minutesAgo}`,
  action: JSON.stringify({ type, input, status, resultText: extra.resultText || '' }),
  status,
  error: extra.error || null,
  created_at: new Date(NOW.getTime() - minutesAgo * 60000).toISOString()
});

test('actions are told apart by what they do to the world', () => {
  assert.equal(classifyAction('send_message'), 'did');
  assert.equal(classifyAction('create_calendar_event'), 'did');
  assert.equal(classifyAction('web_search'), 'checked');
  assert.equal(classifyAction('get_calendar_events'), 'checked');
  assert.equal(classifyAction('search_trains'), 'checked');
});

test('titles are plain past tense, never internal names', () => {
  assert.equal(describeAction('send_message', { contact: 'Arina' }), 'Sent a message to Arina');
  assert.equal(describeAction('web_search', { query: 'AirPods case under £50' }), 'Looked up “AirPods case under £50”');
  assert.equal(describeAction('some_new_thing', {}), 'Some new thing');
});

test('memory saves, browser plumbing and pending asks are not activity', () => {
  const feed = buildActivityFeed({
    now: NOW,
    actionRows: [
      row('remember_person', { name: 'Arina' }),
      row('browser_close', {}),
      row('send_message', { contact: 'Arina' }, 'pending'),
      row('send_message', { contact: 'Arina' })
    ]
  });
  assert.deepEqual(feed.events.map(e => e.title), ['Sent a message to Arina']);
});

test('reactions and chat never become events: only recorded actions do', () => {
  const feed = buildActivityFeed({
    now: NOW,
    actionRows: [row('web_search', { query: 'lanterns' }, 'executed', 3)],
    board: { completed: [], needsYou: [] }
  });
  assert.equal(feed.events.length, 1);
  assert.equal(feed.events[0].type, 'checked');
  assert.ok(feed.events.every(e => !/^Reacted/.test(e.title)));
});

test('a failed action says it failed instead of claiming success', () => {
  const feed = buildActivityFeed({ now: NOW, actionRows: [row('send_message', { contact: 'Arina' }, 'failed', 2, { error: 'No number' })] });
  assert.equal(feed.events[0].failed, true);
  assert.equal(feed.events[0].detail, 'No number');
});

test('repeated identical checks collapse into one row', () => {
  const feed = buildActivityFeed({
    now: NOW,
    actionRows: [row('web_search', { query: 'case' }, 'executed', 2), row('web_search', { query: 'case' }, 'executed', 4)]
  });
  assert.equal(feed.events.length, 1);
});

test('nothing is dated in the future, and a stale schedule is never shown as a date to wait for', () => {
  const feed = buildActivityFeed({
    now: NOW,
    actionRows: [{ ...row('send_message', { contact: 'A' }), created_at: '2026-12-01T00:00:00.000Z' }],
    scheduledRows: [
      { id: 'a', title: 'Bin day', recurrence: 'weekly', next_run_at: '2026-09-10T08:00:00.000Z', active: true },
      { id: 'b', title: 'Leave for work', recurrence: null, next_run_at: '2026-10-03T06:25:00.000Z', active: true }
    ]
  });
  assert.equal(feed.events.length, 0);
  const bin = feed.upcoming.find(u => u.id === 'scheduled-a');
  assert.equal(bin.at, null);
  assert.equal(bin.stale, true);
  assert.equal(feed.upcoming.find(u => u.id === 'scheduled-b').at, '2026-10-03T06:25:00.000Z');
});

test('only some notices count as Adam noticing something', () => {
  const feed = buildActivityFeed({
    now: NOW,
    noticeRows: [
      { id: 1, category: 'watch', title: 'Washing machine finished', body: 'Done', created_at: new Date(NOW - 60000).toISOString() },
      { id: 2, category: 'digest', title: 'Morning digest', body: 'x', created_at: new Date(NOW - 120000).toISOString() }
    ]
  });
  assert.deepEqual(feed.events.map(e => [e.type, e.title]), [['noticed', 'Washing machine finished']]);
});

test('an approval waiting on the user is an ask, not history', () => {
  const feed = buildActivityFeed({ now: NOW, approvals: [{ approvalId: 'a1', detail: 'Arina · £120', createdAt: NOW.toISOString() }] });
  assert.equal(feed.asks[0].type, 'asked');
  assert.equal(feed.asks[0].open, true);
});

test('a chat turn that only talked is not work; one that changed the world, or planned, is', () => {
  const turn = { metadata: { origin: 'chat_turn' }, results: [] };
  assert.equal(isRoutineChatTurn(turn), true);
  assert.equal(isRoutineChatTurn({ metadata: { modelRoute: {}, guardMode: false, useSearch: false } }), true);
  assert.equal(isRoutineChatTurn({ metadata: { origin: 'chat_turn' }, results: [{ action: 'web_search' }] }), true);
  assert.equal(isRoutineChatTurn({ metadata: { origin: 'chat_turn' }, results: [{ action: 'send_message' }] }), false);
  assert.equal(isRoutineChatTurn({ metadata: { origin: 'chat_turn' }, plan: [{ step: 1 }] }), false);
  assert.equal(isRoutineChatTurn({ metadata: {}, results: [] }), false);
});

test('home with nothing connected has no devices, rooms or sensed events', () => {
  const home = buildHomeModel({ now: NOW });
  assert.deepEqual([home.devices, home.rooms, home.watches, home.observations], [[], [], [], []]);
  assert.equal(home.presence.state, 'unknown');
});

test('home groups devices into rooms only when a device says which room it is in', () => {
  const recent = new Date(NOW - 30000).toISOString();
  const home = buildHomeModel({
    now: NOW,
    displays: [
      { id: 'd1', name: 'Living room speaker', type: 'speaker', room: 'Living room', lastSeenAt: recent, capabilities: { text: true, audio: true } },
      { id: 'd2', name: 'Speaker', type: 'speaker', lastSeenAt: '2026-09-01T00:00:00.000Z', capabilities: {} }
    ]
  });
  assert.equal(home.rooms.length, 1);
  assert.equal(home.rooms[0].name, 'Living room');
  assert.equal(home.rooms[0].active, true);
  assert.deepEqual(home.unassignedDevices.map(d => d.id), ['d2']);
  assert.equal(home.devices.find(d => d.id === 'd2').online, false);
});

test('observations must be dated, non-empty and say how they were known; they are never taken from chat', () => {
  assert.equal(normalizeObservation({ at: 'nope', summary: 'x' }, NOW), null);
  assert.equal(normalizeObservation({ at: NOW.toISOString(), summary: '' }, NOW), null);
  assert.equal(normalizeObservation({ at: '2027-01-01T00:00:00.000Z', summary: 'future' }, NOW), null);
  const ok = normalizeObservation({ at: new Date(NOW - 60000).toISOString(), summary: 'Kitchen became occupied', room: 'Kitchen', source: 'sensor' }, NOW);
  assert.equal(ok.source, 'sensor');
  assert.equal(normalizeObservation({ at: NOW.toISOString(), summary: 'x', source: 'chat' }, NOW).source, 'reported');
});

test('watches are only scheduled checks with something to look for', () => {
  const home = buildHomeModel({
    now: NOW,
    scheduledRows: [
      { id: 'w', title: 'Front door', condition: 'opens after 22:00', next_run_at: new Date(NOW.getTime() + 60000).toISOString(), active: true },
      { id: 'r', title: 'Bin day', recurrence: 'weekly', next_run_at: new Date(NOW.getTime() + 60000).toISOString(), active: true }
    ]
  });
  assert.deepEqual(home.watches.map(w => w.title), ['Front door']);
});

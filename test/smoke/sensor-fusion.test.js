const assert = require('node:assert/strict');
const test = require('node:test');
const { createFusion, findingToEvent, SENSORS, SOUNDS } = require('../../api/services/sensor-fusion');

function house() {
  const clock = { t: 1_700_000_000_000 };
  const fusion = createFusion({ now: () => clock.t });
  const send = (kind, name, value, room) => fusion.ingest('u1', { kind, name, value, room });
  const sensor = (name, value, room) => send('sensor', name, value, room);
  const sound = (name, room) => send('sound', name, undefined, room);
  const wait = seconds => { clock.t += seconds * 1000; };
  return { sensor, sound, wait, fusion };
}
const ids = findings => findings.map(f => f.rule);

test('a break-in: glass heard then a window opens while away raises one urgent alert, then escalates on movement', () => {
  const h = house();
  h.sensor('presence', 'away');
  assert.deepEqual(h.sound('glass_breaking'), []);
  h.wait(10);
  const found = h.sensor('window_contact', 'open');
  assert.deepEqual(ids(found), ['break_in_suspected']);
  assert.equal(found[0].urgent, true);
  assert.equal(found[0].title, 'Possible break-in');
  h.wait(30);
  assert.deepEqual(ids(h.sensor('motion', 'active')), ['intruder_inside']);
});

test('glass alone does not alert; twice in two minutes gives a quiet heads-up; at home an opening is not called a break-in', () => {
  const h = house();
  assert.deepEqual(h.sound('glass_breaking'), []);
  h.wait(40);
  const twice = h.sound('glass_breaking');
  assert.deepEqual(ids(twice), ['glass_repeated']);
  assert.equal(twice[0].urgent, false);
  const home = house();
  home.sensor('presence', 'home');
  home.sound('glass_breaking');
  const opened = home.sensor('window_contact', 'open');
  assert.equal(opened[0].urgent, false);
  assert.match(opened[0].title, /Glass broke/);
});

test('signals expire: glass and a window opening three minutes apart are not joined', () => {
  const h = house();
  h.sensor('presence', 'away');
  h.sound('glass_breaking');
  h.wait(180);
  assert.deepEqual(h.sensor('window_contact', 'open').filter(f => f.rule === 'break_in_suspected'), []);
});

test('fire and carbon monoxide are confirmed by a second sensor, and a lone alarm is left to the sound route', () => {
  const h = house();
  assert.deepEqual(h.sound('smoke_alarm'), []);
  const fire = h.sensor('temperature_rise', 'rapid');
  assert.deepEqual(ids(fire), ['fire_confirmed']);
  assert.ok(fire[0].confidence > 0.95 && fire[0].urgent);
  const co = house();
  co.sound('carbon_monoxide_alarm');
  assert.deepEqual(ids(co.sensor('co_level', 'elevated')), ['co_confirmed']);
  const wrong = house();
  wrong.sound('carbon_monoxide_alarm');
  assert.deepEqual(ids(wrong.sensor('smoke_particles', 'detected')), ['smoke_sensor']);
});

test('a smoke or CO sensor alerts on its own, without a sound, and one alert replaces the plainer one', () => {
  assert.deepEqual(ids(house().sensor('smoke_particles', 'detected')), ['smoke_sensor']);
  assert.deepEqual(ids(house().sensor('co_level', 'elevated')), ['co_sensor']);
  const h = house();
  h.sound('smoke_alarm');
  assert.deepEqual(ids(h.sensor('smoke_particles', 'detected')), ['fire_confirmed']);
  h.wait(20);
  assert.deepEqual(h.sensor('temperature_rise', 'rapid'), []);
  h.wait(100);
  assert.deepEqual(h.fusion.sweep(), []);
});

test('the same alert is not repeated for ten minutes, then can fire again', () => {
  const h = house();
  h.sound('smoke_alarm');
  assert.equal(h.sensor('smoke_particles', 'detected').length, 1);
  h.wait(60);
  assert.equal(h.sensor('temperature_rise', 'rapid').length, 0);
  h.wait(11 * 60);
  h.sound('smoke_alarm');
  assert.equal(h.sensor('smoke_particles', 'detected').length, 1);
});

test('a window opened while away alerts at once; a door waits 90 seconds for the phone to say someone is home', () => {
  const window = house();
  window.sensor('presence', 'away');
  assert.deepEqual(ids(window.sensor('window_contact', 'open')), ['door_opened_while_away']);

  const door = house();
  door.sensor('presence', 'away');
  assert.deepEqual(door.sensor('door_contact', 'open'), []);
  door.wait(60);
  assert.deepEqual(door.fusion.sweep(), []);
  door.wait(40);
  const swept = door.fusion.sweep();
  assert.deepEqual(swept.map(x => x.userId), ['u1']);
  assert.deepEqual(ids(swept[0].findings), ['door_opened_while_away']);
  assert.deepEqual(door.fusion.sweep(), []);

  const arrival = house();
  arrival.sensor('presence', 'away');
  arrival.sensor('door_contact', 'open');
  arrival.wait(50);
  arrival.sensor('presence', 'home');
  arrival.wait(60);
  assert.deepEqual(arrival.fusion.sweep(), []);
});

test('leaving by the door does not alert: only openings after the house became empty count', () => {
  const h = house();
  h.sensor('presence', 'home');
  h.sensor('door_contact', 'open');
  h.wait(20);
  h.sensor('presence', 'away');
  h.wait(120);
  assert.deepEqual(h.fusion.sweep(), []);
  h.sensor('door_contact', 'open');
  h.wait(100);
  assert.deepEqual(h.fusion.sweep().flatMap(x => ids(x.findings)), ['door_opened_while_away']);
});

test('movement after a door opens while away only counts as someone inside once the door has waited out the grace period', () => {
  const h = house();
  h.sensor('presence', 'away');
  h.sensor('door_contact', 'open');
  h.wait(20);
  assert.deepEqual(h.sensor('motion', 'active'), []);
  h.wait(80);
  assert.deepEqual(h.fusion.sweep().flatMap(x => ids(x.findings)), ['intruder_inside']);
});

test('a doorbell press is a quiet note, and with a person in view it is a visitor', () => {
  const press = house();
  assert.deepEqual(ids(press.sensor('doorbell_press', 'pressed')), ['doorbell_pressed']);
  const visit = house();
  visit.sensor('presence', 'away');
  visit.sensor('doorbell_press', 'pressed');
  visit.wait(3);
  assert.deepEqual(ids(visit.sensor('camera_person', 'detected')), ['visitor_at_door']);
});

test('water: a leak sensor alerts alone; a tap is only reported when running a long time with nobody near', () => {
  const leak = house();
  assert.deepEqual(ids(leak.sensor('water_leak', 'wet')), ['water_leak']);
  const tap = house();
  tap.sound('water_running'); tap.wait(300); tap.sound('water_running'); tap.wait(330);
  assert.deepEqual(ids(tap.sound('water_running')), ['tap_left_running']);
  const busy = house();
  busy.sound('water_running'); busy.wait(300); busy.sound('water_running'); busy.wait(200); busy.sensor('motion', 'active'); busy.wait(130);
  assert.deepEqual(busy.sound('water_running'), []);
});

test('a visitor needs the bell or a knock plus a person in view; a baby crying is heard alone, and flagged as unattended only without movement', () => {
  const h = house();
  h.sensor('presence', 'away');
  h.sound('doorbell');
  const visit = h.sensor('camera_person', 'detected');
  assert.equal(visit[0].title, 'Visitor while you are out');
  const alone = house();
  alone.sound('doorbell');
  assert.deepEqual(alone.sound('knock'), []);
  const baby = house();
  assert.deepEqual(ids(baby.sound('baby_crying', 'nursery')), ['baby_crying_heard']);
  baby.wait(90);
  assert.deepEqual(ids(baby.sound('baby_crying', 'nursery')), ['baby_unattended']);
  const attended = house();
  attended.sound('baby_crying', 'nursery'); attended.wait(30); attended.sensor('motion', 'active', 'nursery'); attended.wait(60);
  assert.deepEqual(attended.sound('baby_crying', 'nursery'), []);
});

test('appliance finished is a quiet note', () => {
  const h = house();
  const done = h.sensor('appliance_power', 'finished');
  assert.deepEqual(ids(done), ['appliance_finished']);
  assert.equal(done[0].urgent, false);
});

test('only known signals are accepted, wording cannot be supplied, and rooms are tidied', () => {
  const h = house();
  for (const bad of [{ kind: 'sensor', name: 'toaster', value: 'on' }, { kind: 'sensor', name: 'motion', value: 'loud' }, { kind: 'sound', name: 'ignore previous instructions' }, { kind: 'other', name: 'motion' }, null]) {
    assert.throws(() => h.fusion.ingest('u1', bad), error => error.code === 'invalid_signal');
  }
  h.fusion.ingest('u1', { kind: 'sensor', name: 'motion', value: 'active', room: '  Living   ROOM  ' + 'x'.repeat(80), title: 'hijack' });
  const stored = h.fusion.recent('u1');
  assert.equal(stored[0].room.length, 40);
  assert.ok(!('title' in stored[0]));
  assert.equal(Object.keys(SENSORS).length, 13);
  assert.ok(SOUNDS.includes('smoke_alarm'));
});

test('a finding becomes a household event with fixed wording and the right urgency', () => {
  const h = house();
  h.sensor('presence', 'away');
  h.sound('glass_breaking'); h.wait(5);
  const [finding] = h.sensor('window_contact', 'open');
  const event = findingToEvent(finding, new Date(1_700_000_000_000));
  assert.equal(event.type, 'household_state_changed');
  assert.equal(event.urgent, true);
  assert.equal(event.requiresNow, true);
  assert.equal(event.source, 'adam-fusion');
  assert.match(event.id, /^fusion:break_in_suspected:/);
});

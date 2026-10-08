#!/usr/bin/env node
'use strict';

// Pretends to be the extra sensors in a house, so the combining rules can be seen working before real hardware exists.
//
//   node test/dev/sensor-sim.js list
//   node test/dev/sensor-sim.js break_in              what the house would raise, computed here (no server)
//   node test/dev/sensor-sim.js break_in --send       post the same readings to a running server as a paired display
//
// --send needs ADAM_DISPLAY_ID and ADAM_DISPLAY_TOKEN in the environment (the token is never taken from the command line)
// and --url (default http://localhost:3000). Readings are posted in real time; --speed 10 runs ten times faster.

const { createFusion, findingToEvent } = require('../../api/services/sensor-fusion');

const S = (name, value, room) => ({ kind: 'sensor', name, value, room });
const N = (name, room) => ({ kind: 'sound', name, room });

// Each step: [seconds since the start, reading]. `why` says what a person should see.
const SCENARIOS = {
  break_in: { why: 'Glass, then a window opens, then movement while nobody is home: a break-in alert, then "someone may be inside".',
    steps: [[0, S('presence', 'away')], [30, N('glass_breaking', 'kitchen')], [34, S('window_contact', 'open', 'kitchen')], [70, S('motion', 'active', 'hall')]] },
  glass_false_alarm: { why: 'Glass heard once and nothing else happens: no alert.',
    steps: [[0, S('presence', 'home')], [10, N('glass_breaking', 'living room')]] },
  window_opened_away: { why: 'A window opens while nobody is home, even if the sound model missed any glass.',
    steps: [[0, S('presence', 'away')], [20, S('window_contact', 'open', 'bedroom')]] },
  kitchen_fire: { why: 'The alarm is heard (raised at once elsewhere), then smoke is detected: "Fire likely".',
    steps: [[0, N('smoke_alarm', 'kitchen')], [12, S('temperature_rise', 'rapid', 'kitchen')], [20, S('smoke_particles', 'detected', 'kitchen')]] },
  co_leak: { why: 'A CO alarm is heard and the level is raised: confirmed.',
    steps: [[0, N('carbon_monoxide_alarm', 'hall')], [15, S('co_level', 'elevated', 'hall')]] },
  arriving_home: { why: 'The door opens before the phone says someone is home: the 90-second wait avoids a false alarm.',
    steps: [[0, S('presence', 'away')], [60, S('door_contact', 'open', 'front door')], [75, S('door_lock', 'unlocked', 'front door')], [100, S('presence', 'home')], [110, S('motion', 'active', 'hall')]] },
  door_forced_while_away: { why: 'A door opens while nobody is home and nobody arrives: an alert after the 90-second wait, then movement inside.',
    steps: [[0, S('presence', 'away')], [30, S('door_contact', 'open', 'back door')], [150, S('motion', 'active', 'kitchen')]] },
  doorbell_visitor: { why: 'The bell is pressed and the camera sees a person while you are out.',
    steps: [[0, S('presence', 'away')], [20, S('doorbell_press', 'pressed', 'front door')], [24, S('camera_person', 'detected', 'front door')]] },
  visitor: { why: 'The bell rings and a person is in view while you are out.',
    steps: [[0, S('presence', 'away')], [20, N('doorbell', 'front door')], [24, S('camera_person', 'detected', 'front door')]] },
  tap_left_running: { why: 'Water runs for more than ten minutes and nobody goes near.',
    steps: [[0, N('water_running', 'kitchen')], [300, N('water_running', 'kitchen')], [640, N('water_running', 'kitchen')]] },
  water_leak: { why: 'A leak sensor goes wet.', steps: [[0, S('water_leak', 'wet', 'bathroom')]] },
  baby_alone: { why: 'Crying repeats and nobody goes into the nursery.',
    steps: [[0, N('baby_crying', 'nursery')], [95, N('baby_crying', 'nursery')]] },
  washer_done: { why: 'The washing machine finishes.', steps: [[0, S('appliance_power', 'finished', 'utility room')]] }
};

function runLocal(name) {
  const clock = { t: 1_700_000_000_000 };
  const fusion = createFusion({ now: () => clock.t });
  const start = clock.t;
  let raised = 0;
  const show = findings => {
    for (const finding of findings) {
      raised += 1;
      const event = findingToEvent(finding, new Date(clock.t));
      console.log(`           -> ${event.urgent ? 'URGENT' : 'note  '}  ${event.title}: ${event.body}`);
    }
  };
  const steps = SCENARIOS[name].steps;
  for (const [at, reading] of steps) {
    // the server re-checks every 15 s, so alerts that were waiting out a grace period appear between readings
    for (let tick = Math.ceil((clock.t - start) / 15000) * 15000; tick < at * 1000; tick += 15000) { clock.t = start + tick; for (const x of fusion.sweep()) { console.log(`  t+${String(Math.round(tick / 1000)).padStart(4)}s  (re-check)`); show(x.findings); } }
    clock.t = start + at * 1000;
    const label = reading.kind === 'sound' ? `heard ${reading.name}` : `${reading.name} ${reading.value}`;
    console.log(`  t+${String(at).padStart(4)}s  ${label}${reading.room ? ` (${reading.room})` : ''}`);
    if (reading.kind === 'sound' && ['smoke_alarm', 'carbon_monoxide_alarm', 'sustained_beeping'].includes(reading.name)) console.log('           -> URGENT  (alarm heard: raised at once by the alarm route)');
    show(fusion.ingest('sim', reading));
  }
  const last = steps[steps.length - 1][0];
  for (let tick = (Math.floor(last / 15) + 1) * 15; tick <= last + 150; tick += 15) { clock.t = start + tick * 1000; for (const x of fusion.sweep()) { console.log(`  t+${String(tick).padStart(4)}s  (re-check)`); show(x.findings); } }
  if (!raised) console.log('           (nothing raised)');
}

async function runSend(name, base, speed) {
  const id = process.env.ADAM_DISPLAY_ID, token = process.env.ADAM_DISPLAY_TOKEN;
  if (!id || !token) throw new Error('Set ADAM_DISPLAY_ID and ADAM_DISPLAY_TOKEN first.');
  let previous = 0;
  for (const [at, reading] of SCENARIOS[name].steps) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, (at - previous) * 1000 / speed)));
    previous = at;
    const alarm = reading.kind === 'sound' && ['smoke_alarm', 'carbon_monoxide_alarm', 'sustained_beeping'].includes(reading.name);
    const [route, body] = alarm ? ['sound', { type: reading.name }] : ['signal', reading];
    const response = await fetch(`${base}/display/${encodeURIComponent(id)}/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body)
    });
    console.log(`  t+${String(at).padStart(4)}s  ${route} ${JSON.stringify(reading)} -> ${response.status} ${(await response.text()).slice(0, 80)}`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const option = key => { const i = rest.indexOf(key); return i >= 0 ? rest[i + 1] : undefined; };
  if (!command || command === 'list') {
    for (const [name, scenario] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(20)} ${scenario.why}`);
    return;
  }
  if (!SCENARIOS[command]) { console.error(`Unknown scenario "${command}". Run "list".`); process.exitCode = 1; return; }
  console.log(`${command}: ${SCENARIOS[command].why}`);
  if (rest.includes('--send')) await runSend(command, option('--url') || 'http://localhost:3000', Number(option('--speed')) || 1);
  else runLocal(command);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { SCENARIOS, runLocal };

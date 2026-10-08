#!/usr/bin/env node
'use strict';

// Compares "a sound alone raises an alert" with "sounds and sensors are combined", on a simulated house.
//
//   node test/dev/fusion-eval.js [days] [scale]
//
// EVERYTHING HERE IS ASSUMED, not measured in a home. The sound figures come from our own tests (see ASSUMPTIONS) and
// the sensors are imagined, so the result shows how much a second sensor *could* help if the sensors behave as stated.
// `scale` multiplies the false-sound rates (try 1 and 0.1: real homes are likely quieter than our dense test stream).

const { createFusion } = require('../../api/services/sensor-fusion');

const days = Number(process.argv[2]) || 30;
const scale = Number(process.argv[3]) || 1;
const MODEL = process.argv[4] || 'phone';   // 'phone' (measured) or 'large' (estimate: phone recall scaled by large/small 8-bit recall from the hard-conditions test)

const ASSUMPTIONS = {
  // False sound detections per hour, and the share of real events the sound model catches (from our 30-minute stream and
  // the beep detector's 3 of 12 real recordings). These are the sound-only weaknesses.
  falsePerHour: { glass_breaking: 6, baby_crying: 6, knock: 2, doorbell: 0.2, smoke_alarm: 0.05 },
  recall: { glass_breaking: 16 / 36, baby_crying: 20 / 36, knock: 12 / 36, doorbell: 8 / 36, smoke_alarm: 3 / 12 },
  sensorReliability: 0.97,          // a door/window/smoke sensor reports a real event
  awayHoursPerDay: 9,
  doorOpeningsPerDay: 14, windowOpeningsPerDay: 5,
  arrivalsPerDay: 2, phoneArrivalLateShare: 0.3, phoneLateMaxSeconds: 120,   // the phone is sometimes slow to say "home"
  trials: 2000
};

if (MODEL === 'large') {
  // Recall at 1% false alarms, hard-conditions test: small 8-bit -> large 8-bit. The phone-model rates above are scaled by this ratio; false-alarm rates are assumed unchanged.
  const gain = { glass_breaking: .66 / .62, baby_crying: .72 / .60, knock: .71 / .69, doorbell: .32 / .24 };
  for (const [name, g] of Object.entries(gain)) ASSUMPTIONS.recall[name] = Math.min(0.98, ASSUMPTIONS.recall[name] * g);
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const random = rng(2026);
const poisson = mean => { let k = 0, p = 1; const l = Math.exp(-mean); do { k += 1; p *= random(); } while (p > l); return k - 1; };

function newHouse() {
  const clock = { t: 1_700_000_000_000 };
  const fusion = createFusion({ now: () => clock.t });
  const alerts = [];
  const send = (at, reading) => {
    clock.t = at;
    const found = fusion.ingest('h', reading);
    for (const f of found) alerts.push({ at, rule: f.rule, urgent: f.urgent });
    return found;
  };
  const sweep = at => { clock.t = at; for (const x of fusion.sweep()) for (const f of x.findings) alerts.push({ at, rule: f.rule, urgent: f.urgent }); };
  return { send, sweep, alerts, clock };
}

// 1) A quiet stretch of days: how many alerts are raised when nothing real is happening?
function falseAlerts() {
  const house = newHouse();
  const start = house.clock.t;
  const events = [];
  const DAY = 86400e3;
  for (let day = 0; day < days; day++) {
    const base = start + day * DAY;
    const awayFrom = base + 8.5 * 3600e3, awayTo = awayFrom + ASSUMPTIONS.awayHoursPerDay * 3600e3;
    events.push([awayFrom - 30e3, { kind: 'sensor', name: 'door_contact', value: 'open' }], [awayFrom, { kind: 'sensor', name: 'presence', value: 'away' }]);
    // coming home: the door opens, and the phone sometimes says "home" a little late
    const late = random() < ASSUMPTIONS.phoneArrivalLateShare ? random() * ASSUMPTIONS.phoneLateMaxSeconds * 1000 : -5000;
    events.push([awayTo, { kind: 'sensor', name: 'door_contact', value: 'open' }], [awayTo + late, { kind: 'sensor', name: 'presence', value: 'home' }]);
    const extraArrivals = poisson(Math.max(0, ASSUMPTIONS.arrivalsPerDay - 1));
    for (let i = 0; i < extraArrivals; i++) { const at = base + 18.5 * 3600e3 + random() * 4 * 3600e3; events.push([at, { kind: 'sensor', name: 'door_contact', value: 'open' }]); }
    for (let i = 0; i < poisson(ASSUMPTIONS.windowOpeningsPerDay); i++) events.push([base + 18.5 * 3600e3 + random() * 4 * 3600e3, { kind: 'sensor', name: 'window_contact', value: 'open' }]);
    for (const [name, perHour] of Object.entries(ASSUMPTIONS.falsePerHour)) {
      for (let i = 0; i < poisson(perHour * scale * 24); i++) events.push([base + random() * DAY, { kind: 'sound', name }]);
    }
  }
  for (const [at, r] of [...events]) if (r.name === 'door_contact') events.push([at + 95e3, { tick: true }]);
  events.sort((a, b) => a[0] - b[0]);
  // A: every detected sound of these kinds raises an alert on its own.
  const soundOnly = events.filter(([, r]) => r.kind === 'sound').length;
  // B: the same detections, combined with the sensors by the real rules. Smoke alarms are raised on their own as before.
  const lifeSafety = events.filter(([, r]) => r.name === 'smoke_alarm').length;
  for (const [at, reading] of events) { if (reading.tick) house.sweep(at); else house.send(at, reading); }
  const byRule = {};
  for (const a of house.alerts) byRule[a.rule] = (byRule[a.rule] || 0) + 1;
  return { soundOnly, fusedAlerts: house.alerts.length + lifeSafety, byRule, lifeSafety };
}

// 2) Real events: how often is each one caught?
function caught(kind) {
  let sound = 0, fused = 0;
  const { recall, sensorReliability: r } = ASSUMPTIONS;
  for (let i = 0; i < ASSUMPTIONS.trials; i++) {
    const house = newHouse();
    const t0 = house.clock.t;
    let heard = false, aloneAlert = false, f = [];
    if (kind === 'break_in') {
      house.send(t0, { kind: 'sensor', name: 'presence', value: 'away' });
      heard = random() < recall.glass_breaking; aloneAlert = heard;
      if (heard) f = f.concat(house.send(t0 + 60e3, { kind: 'sound', name: 'glass_breaking' }));
      if (random() < r) f = f.concat(house.send(t0 + 65e3, { kind: 'sensor', name: 'window_contact', value: 'open' }));
    } else if (kind === 'kitchen_fire') {
      heard = random() < recall.smoke_alarm; aloneAlert = heard;
      if (heard) f = f.concat(house.send(t0, { kind: 'sound', name: 'smoke_alarm' }));
      if (random() < r) f = f.concat(house.send(t0 + 10e3, { kind: 'sensor', name: 'smoke_particles', value: 'detected' }));
      fused += (heard || f.length) ? 1 : 0; sound += aloneAlert ? 1 : 0; continue;   // the alarm sound alone is raised at once in both
    } else if (kind === 'baby_alone') {
      // a real crying episode: four chances for the sound model, 45 seconds apart. A cry alerts on its own, in both policies.
      for (let k = 0; k < 4; k++) {
        if (random() < recall.baby_crying) { aloneAlert = true; f = f.concat(house.send(t0 + k * 45e3, { kind: 'sound', name: 'baby_crying' })); }
      }
    } else if (kind === 'visitor') {
      house.send(t0, { kind: 'sensor', name: 'presence', value: 'away' });
      heard = random() < recall.doorbell; aloneAlert = heard;
      if (heard) f = f.concat(house.send(t0 + 60e3, { kind: 'sound', name: 'doorbell' }));
      if (random() < r) f = f.concat(house.send(t0 + 61e3, { kind: 'sensor', name: 'doorbell_press', value: 'pressed' }));
      if (random() < r) f = f.concat(house.send(t0 + 63e3, { kind: 'sensor', name: 'camera_person', value: 'detected' }));
    } else if (kind === 'door_forced') {
      // no glass, no alarm: someone comes in through a door while nobody is home. The sound model hears nothing it is built for.
      house.send(t0, { kind: 'sensor', name: 'presence', value: 'away' });
      if (random() < r) { house.send(t0 + 30e3, { kind: 'sensor', name: 'door_contact', value: 'open' }); house.sweep(t0 + 30e3 + 95e3); }
      f = house.alerts.slice();
    }
    sound += aloneAlert ? 1 : 0; fused += f.length ? 1 : 0;
  }
  return { sound: sound / ASSUMPTIONS.trials, fused: fused / ASSUMPTIONS.trials };
}

const pct = x => `${Math.round(x * 100)}%`;
const quiet = falseAlerts();
console.log(`Sound model: ${MODEL === 'large' ? 'LARGE 8-bit (estimated recall)' : 'phone model (measured recall)'}`);
console.log(`Simulated ${days} quiet days, false sound detections at ${scale}x the rate seen in our dense test stream.\n`);
console.log(`Alerts when nothing real is happening (per day):`);
console.log(`  sound alone (glass, baby, knock, doorbell, alarm): ${(quiet.soundOnly / days).toFixed(1)}`);
console.log(`  sounds + sensors combined:                         ${(quiet.fusedAlerts / days).toFixed(2)}   (${Object.entries(quiet.byRule).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; ${quiet.lifeSafety} smoke-alarm sounds raised on their own)\n`);
console.log(`Real events caught (${ASSUMPTIONS.trials} trials each; sensors ${pct(ASSUMPTIONS.sensorReliability)} reliable):`);
console.log('  event                    sound alone   sounds + sensors');
for (const [kind, label] of [['break_in', 'break-in (glass, window)'], ['door_forced', 'door forced, no sound'], ['kitchen_fire', 'kitchen fire'], ['baby_alone', 'baby crying (4 chances)'], ['visitor', 'visitor while away']]) {
  const c = caught(kind);
  console.log(`  ${label.padEnd(24)} ${pct(c.sound).padStart(10)}   ${pct(c.fused).padStart(12)}`);
}
console.log('\nAssumptions: ' + JSON.stringify(ASSUMPTIONS));

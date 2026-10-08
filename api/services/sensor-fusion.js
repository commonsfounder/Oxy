'use strict';

// Combines what the house reports (sounds and other sensors) over a short window, so a sound alone does not
// have to carry the whole decision. Corroboration can raise an alert or add detail; it never cancels a
// life-safety alert (a smoke or CO alarm heard on its own is raised elsewhere, at once). The wording is fixed
// here: nothing a sensor sends can change what a person reads.

const SENSORS = Object.freeze({
  door_contact: ['open', 'closed'],
  window_contact: ['open', 'closed', 'broken'],
  door_lock: ['locked', 'unlocked'],
  presence: ['home', 'away'],
  motion: ['active'],
  camera_person: ['detected'],
  smoke_particles: ['detected'],
  co_level: ['elevated'],
  temperature_rise: ['rapid'],
  water_leak: ['wet'],
  vibration: ['impact'],
  appliance_power: ['running', 'finished'],
  doorbell_press: ['pressed']
});

const SOUNDS = Object.freeze([
  'smoke_alarm', 'carbon_monoxide_alarm', 'sustained_beeping', 'glass_breaking', 'knock', 'door_slam', 'doorbell',
  'baby_crying', 'scream', 'water_running', 'microwave'
]);

// When a more specific finding fires, the broader ones it covers are not raised as well.
const SUPERSEDES = Object.freeze({ intruder_inside: ['break_in_suspected', 'door_opened_while_away'], break_in_suspected: ['door_opened_while_away'], fire_confirmed: ['smoke_sensor'], co_confirmed: ['co_sensor'], visitor_at_door: ['doorbell_pressed'] });
// Someone arriving opens the door a little before their phone says they are home, so a door alone waits this long.
const ENTRY_GRACE_MS = 90 * 1000;
const KEEP_MS = 30 * 60 * 1000;
const MAX_SIGNALS = 400;
const COOLDOWN_MS = 10 * 60 * 1000;
const MAX_ROOM = 40;

function fusionError(message) {
  const error = new Error(message);
  error.code = 'invalid_signal';
  return error;
}

function normalizeSignal(input, now) {
  const kind = input?.kind;
  const name = String(input?.name || '');
  if (kind === 'sensor') {
    if (!Object.hasOwn(SENSORS, name)) throw fusionError('That is not a sensor this house reports.');
    const value = String(input?.value ?? '');
    if (!SENSORS[name].includes(value)) throw fusionError('That is not a value this sensor reports.');
  } else if (kind === 'sound') {
    if (!SOUNDS.includes(name)) throw fusionError('That is not a sound this house reports.');
  } else throw fusionError('A signal is a sensor reading or a sound.');
  const at = Number.isFinite(Number(input?.at)) ? Math.min(Number(input.at), now) : now;
  const room = String(input?.room ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ROOM).toLowerCase() || null;
  return { kind, name, value: kind === 'sensor' ? String(input.value) : null, room, at };
}

const sameRoom = (a, b) => !a?.room || !b?.room || a.room === b.room;

// One finding per rule; `evidence` lists the signals that led to it.
const RULES = [
  {
    id: 'intruder_inside',
    run(ctx) {
      if (!ctx.away) return null;
      const entry = ctx.entry(3 * 60000);
      const motion = entry && ctx.last(s => s.name === 'motion' && s.at >= entry.at, 3 * 60000);
      if (!entry || !motion) return null;
      return { title: 'Someone may be inside', body: 'A door or window was opened and there is movement indoors while you are out. Check now.', urgent: true, confidence: 0.9, evidence: [entry, motion] };
    }
  },
  {
    id: 'break_in_suspected',
    run(ctx) {
      const breakage = ctx.last(s => (s.name === 'glass_breaking' && s.kind === 'sound') || s.name === 'vibration' || (s.name === 'window_contact' && s.value === 'broken'), 60000);
      const opening = breakage && ctx.last(s => (s.name === 'window_contact' && (s.value === 'open' || s.value === 'broken')) || (s.name === 'door_contact' && s.value === 'open'), 60000, breakage);
      if (!breakage || !opening || breakage === opening) return null;
      if (ctx.home) return { title: 'Glass broke and something opened', body: 'Glass was heard and a window or door opened. Check it is safe.', urgent: false, confidence: 0.75, evidence: [breakage, opening] };
      return { title: 'Possible break-in', body: 'Glass was heard and a window or door opened while no one is confirmed home. Check now.', urgent: true, confidence: 0.9, evidence: [breakage, opening] };
    }
  },
  {
    id: 'glass_repeated',
    run(ctx) {
      const hits = ctx.all(s => s.name === 'glass_breaking' && s.kind === 'sound', 2 * 60000);
      if (hits.length < 2) return null;
      return { title: 'Glass may have broken', body: 'Glass breaking was heard more than once in two minutes.', urgent: false, confidence: 0.6, evidence: hits.slice(-2) };
    }
  },
  {
    id: 'door_opened_while_away',
    run(ctx) {
      if (!ctx.away) return null;
      const opened = ctx.entry(5 * 60000);
      if (!opened) return null;
      return { title: 'Opened while you are out', body: 'A door or window was opened, or a door unlocked, and no one is confirmed home.', urgent: true, confidence: 0.8, evidence: [opened] };
    }
  },
  {
    id: 'fire_confirmed',
    run(ctx) {
      const alarm = ctx.last(s => s.name === 'smoke_alarm', 90000);
      const proof = alarm && ctx.last(s => s.name === 'smoke_particles' || s.name === 'temperature_rise', 90000);
      if (!alarm || !proof) return null;
      return { title: 'Fire likely', body: 'A smoke alarm is sounding and another sensor agrees. Get everyone out and call emergency services.', urgent: true, confidence: 0.97, evidence: [alarm, proof] };
    }
  },
  {
    id: 'co_confirmed',
    run(ctx) {
      const alarm = ctx.last(s => s.name === 'carbon_monoxide_alarm', 90000);
      const proof = alarm && ctx.last(s => s.name === 'co_level', 90000);
      if (!alarm || !proof) return null;
      return { title: 'Carbon monoxide confirmed', body: 'A CO alarm is sounding and the level is raised. Get everyone into fresh air and call emergency services.', urgent: true, confidence: 0.97, evidence: [alarm, proof] };
    }
  },
  {
    id: 'smoke_sensor',
    run(ctx) {
      const smoke = ctx.last(s => s.name === 'smoke_particles', 5 * 60000);
      if (!smoke) return null;
      return { title: 'Smoke detected', body: 'A smoke sensor has triggered. Check now and get everyone out if there is a fire.', urgent: true, confidence: 0.9, evidence: [smoke] };
    }
  },
  {
    id: 'co_sensor',
    run(ctx) {
      const co = ctx.last(s => s.name === 'co_level', 5 * 60000);
      if (!co) return null;
      return { title: 'Carbon monoxide detected', body: 'A carbon monoxide sensor reads high. Get everyone into fresh air.', urgent: true, confidence: 0.9, evidence: [co] };
    }
  },
  {
    id: 'water_leak',
    run(ctx) {
      const wet = ctx.last(s => s.name === 'water_leak', 5 * 60000);
      if (!wet) return null;
      return { title: 'Water leak', body: 'A leak sensor is wet.', urgent: true, confidence: 0.9, evidence: [wet] };
    }
  },
  {
    id: 'tap_left_running',
    run(ctx) {
      const water = ctx.all(s => s.name === 'water_running' && s.kind === 'sound', 20 * 60000);
      if (water.length < 3 || water[water.length - 1].at - water[0].at < 10 * 60000) return null;
      if (ctx.last(s => s.name === 'motion' || s.name === 'camera_person', 10 * 60000)) return null;
      return { title: 'Water has been running', body: 'Water has been running for over ten minutes and nobody has been near.', urgent: false, confidence: 0.7, evidence: water.slice(-3) };
    }
  },
  {
    id: 'visitor_at_door',
    run(ctx) {
      const bell = ctx.last(s => s.name === 'doorbell' || s.name === 'knock' || s.name === 'doorbell_press', 30000);
      const person = bell && ctx.last(s => s.name === 'camera_person', 30000);
      if (!bell || !person) return null;
      return { title: ctx.away ? 'Visitor while you are out' : 'Someone is at the door', body: 'The bell or a knock was heard and a person is in view.', urgent: false, confidence: 0.9, evidence: [bell, person] };
    }
  },
  {
    id: 'doorbell_pressed',
    run(ctx) {
      const press = ctx.last(s => s.name === 'doorbell_press', 30000);
      if (!press) return null;
      return { title: ctx.away ? 'Someone rang while you are out' : 'Someone rang the bell', body: 'The doorbell was pressed.', urgent: false, confidence: 0.9, evidence: [press] };
    }
  },
  {
    id: 'baby_unattended',
    run(ctx) {
      const cries = ctx.all(s => s.name === 'baby_crying', 3 * 60000);
      if (cries.length < 2) return null;
      if (ctx.last(s => s.name === 'motion' && sameRoom(s, cries[0]) && s.at >= cries[0].at, 3 * 60000)) return null;
      return { title: 'Crying, and no one has gone in', body: 'A baby has been heard crying for a few minutes and there has been no movement in the room.', urgent: true, confidence: 0.75, evidence: cries.slice(-2) };
    }
  },
  {
    id: 'appliance_finished',
    run(ctx) {
      const done = ctx.last(s => s.name === 'appliance_power' && s.value === 'finished', 2 * 60000);
      if (!done) return null;
      return { title: 'An appliance has finished', body: 'A machine has finished its cycle.', urgent: false, confidence: 0.8, evidence: [done] };
    }
  }
];

const ORDER = ['intruder_inside', 'break_in_suspected', 'glass_repeated', 'door_opened_while_away', 'fire_confirmed', 'co_confirmed', 'smoke_sensor', 'co_sensor', 'visitor_at_door', 'doorbell_pressed'];
RULES.sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99));

function createFusion({ now = () => Date.now() } = {}) {
  const buffers = new Map();   // userId -> signals, oldest first
  const presence = new Map();  // userId -> 'home' | 'away'
  const fired = new Map();     // userId:rule -> time

  function context(userId, signals, at) {
    const state = presence.get(userId)?.value || null;
    const awaySince = presence.get(userId)?.at ?? -Infinity;
    const matches = (predicate, windowMs) => signals.filter(s => at - s.at <= windowMs && predicate(s));
    const last = (predicate, windowMs, other) => {
      const found = matches(predicate, windowMs).filter(s => s !== other);
      return found.length ? found[found.length - 1] : null;
    };
    return {
      now: at,
      away: state === 'away',
      home: state === 'home',
      // The latest way in: a window at once, a door or lock only once it has waited long enough for a late "home" from the phone.
      entry: windowMs => {
        const window = last(s => s.at >= awaySince && s.name === 'window_contact' && (s.value === 'open' || s.value === 'broken'), windowMs);
        const door = matches(s => s.at >= awaySince && ((s.name === 'door_contact' && s.value === 'open') || (s.name === 'door_lock' && s.value === 'unlocked')), windowMs).filter(s => at - s.at >= ENTRY_GRACE_MS).pop() || null;
        return [window, door].filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
      },
      all: (predicate, windowMs) => matches(predicate, windowMs),
      last: (predicate, windowMs, other) => {
        const found = matches(predicate, windowMs).filter(s => s !== other);
        return found.length ? found[found.length - 1] : null;
      }
    };
  }

  function evaluate(userId, at) {
    const signals = buffers.get(userId) || [];
    const findings = [];
    const ctx = context(userId, signals, at);
    const covered = new Set();
    for (const rule of RULES) {
      const finding = rule.run(ctx);
      if (!finding) continue;
      const key = `${userId}:${rule.id}`;
      const wasCovered = covered.has(rule.id);
      for (const other of SUPERSEDES[rule.id] || []) covered.add(other);   // still covers while its own alert is cooling down
      if (wasCovered || at - (fired.get(key) || -Infinity) < COOLDOWN_MS) continue;
      fired.set(key, at);
      for (const other of SUPERSEDES[rule.id] || []) fired.set(`${userId}:${other}`, at);   // the plainer alerts stay quiet for the cooldown too
      findings.push({ id: `fusion:${rule.id}:${Math.floor(at / COOLDOWN_MS)}`, rule: rule.id, requiresNow: finding.urgent, ...finding });
    }
    return findings;
  }

  function ingest(userId, input) {
    const at = now();
    const signal = normalizeSignal(input, at);
    const signals = buffers.get(userId) || [];
    signals.push(signal);
    signals.sort((a, b) => a.at - b.at);
    while (signals.length > MAX_SIGNALS || (signals.length && at - signals[0].at > KEEP_MS)) signals.shift();
    buffers.set(userId, signals);
    if (signal.name === 'presence' && signal.value !== presence.get(userId)?.value) presence.set(userId, { value: signal.value, at: signal.at });
    if (buffers.size > 500) for (const [id, list] of buffers) if (!list.length || at - list[list.length - 1].at > KEEP_MS) buffers.delete(id);

    return evaluate(userId, at);
  }

  // Re-checks every house with no new reading, so a door that has waited out its grace period can raise its alert.
  function sweep() {
    const at = now();
    const out = [];
    for (const userId of buffers.keys()) {
      const findings = evaluate(userId, at);
      if (findings.length) out.push({ userId, findings });
    }
    return out;
  }

  return { ingest, sweep, recent: userId => (buffers.get(userId) || []).slice(), presence: userId => presence.get(userId)?.value || null, _reset() { buffers.clear(); presence.clear(); fired.clear(); } };
}

function findingToEvent(finding, now = new Date()) {
  return {
    id: finding.id, type: 'household_state_changed', title: finding.title, subject: finding.title, body: finding.body,
    occurredAt: now.toISOString(), source: 'adam-fusion', confidence: finding.confidence, relevance: 1, actionable: true,
    urgent: finding.urgent, requiresNow: finding.requiresNow
  };
}

module.exports = { SENSORS, SOUNDS, RULES, createFusion, findingToEvent, normalizeSignal };

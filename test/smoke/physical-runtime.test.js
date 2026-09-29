'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PhysicalStore } = require('../../api/physical/store');
const { PhysicalRuntime } = require('../../api/physical/runtime');
const { SimulatorAdapter } = require('../../api/physical/adapters');
const { createPhysicalServer } = require('../../api/physical/server');
const { createAgent } = require('../../api/physical/agent');
const { executeTool } = require('../../api/physical/tools');
const { detectSpeechWindow } = require('../../api/physical/voice-activity');
const http = require('node:http');

function fixture(environment = 'development') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adam-physical-'));
  const filename = path.join(directory, 'state.sqlite');
  let time = Date.parse('2026-09-29T17:25:00.000Z');
  const store = new PhysicalStore(filename);
  const runtime = new PhysicalRuntime({ store, environment, now: () => new Date(time) });
  return { runtime, filename, setTime: value => { time = Date.parse(value); }, close: () => { runtime.store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

function pcmWav(sampleCount, sampleAt) {
  const output = Buffer.alloc(44 + sampleCount * 2);
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8);
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22); output.writeUInt32LE(16000, 24); output.writeUInt32LE(32000, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36);
  output.writeUInt32LE(sampleCount * 2, 40);
  for (let i = 0; i < sampleCount; i++) output.writeInt16LE(sampleAt(i), 44 + i * 2);
  return output;
}

test('voice activity detector rejects silence and bounds a spoken segment', () => {
  assert.equal(detectSpeechWindow(pcmWav(16000, () => 0)), null);
  const clip = pcmWav(16000, i => i >= 4800 && i < 12800 ? Math.round(6000 * Math.sin(2 * Math.PI * i / 80)) : 0);
  const window = detectSpeechWindow(clip);
  assert.ok(window.startSeconds >= 0.1 && window.startSeconds <= 0.3);
  assert.ok(window.endSeconds >= 0.8 && window.endSeconds <= 1);
});

test('simulated evidence survives into inference, watch, and action without becoming a real notification', () => {
  const f = fixture();
  try {
    const room = f.runtime.createRoom({ name: 'Kitchen' });
    const registered = f.runtime.registerDevice({ roomId: room.id, capabilities: ['button'] }, { simulator: true });
    const adapter = new SimulatorAdapter(f.runtime, registered.device.id, registered.secret);
    const watch = f.runtime.createWatch({ roomId: room.id, condition: { kind: 'state_equals', key: 'occupancy', value: 'probably_occupied' }, action: { type: 'notify', text: 'Someone may be in the kitchen.' } });
    const result = adapter.emitObservation('motion_detected', true, { sensor: 'motion' });
    const state = f.runtime.roomState(room.id).state.find(item => item.key === 'occupancy');
    assert.equal(result.observation.source.origin, 'simulator');
    assert.equal(result.observation.source.environment, 'development');
    assert.equal(state.kind, 'inference');
    assert.deepEqual(state.evidenceIds, [result.observation.id]);
    assert.equal(f.runtime.store.get('watches', watch.id).status, 'triggered');
    const action = f.runtime.store.all('actions')[0];
    assert.equal(action.status, 'simulated');
    assert.deepEqual(action.evidenceIds, [result.observation.id]);
    adapter.emitObservation('motion_detected', true);
    assert.equal(f.runtime.store.all('actions').length, 1);
  } finally { f.close(); }
});

test('stale signals become unknown, conflicting signals keep evidence, watches survive restart', () => {
  const f = fixture();
  try {
    const room = f.runtime.createRoom({ name: 'Hall' });
    const registered = f.runtime.registerDevice({ roomId: room.id }, { simulator: true });
    const adapter = new SimulatorAdapter(f.runtime, registered.device.id, registered.secret);
    adapter.emitObservation('motion_detected', true);
    adapter.emitObservation('BLE_device_lost', true);
    const occupancy = f.runtime.roomState(room.id).state.find(item => item.key === 'occupancy');
    assert.equal(occupancy.value, 'unknown');
    assert.equal(occupancy.evidenceIds.length, 2);
    const watch = f.runtime.createWatch({ roomId: room.id, condition: { kind: 'deadline_state', at: '2026-09-29T17:30:00.000Z', key: 'occupancy', value: 'probably_occupied' }, action: { type: 'notify', text: 'Time to leave.' } });
    f.runtime.store.close();
    f.runtime.store = new PhysicalStore(f.filename);
    assert.equal(f.runtime.store.get('watches', watch.id).status, 'active');
    f.setTime('2026-09-29T17:40:00.000Z');
    assert.equal(f.runtime.roomState(room.id).state.find(item => item.key === 'motion').value, 'unknown');
    assert.equal(f.runtime.tick().length, 0);
  } finally { f.close(); }
});

test('deadline watch triggers once after process restart while evidence is fresh', () => {
  const f = fixture();
  try {
    const room = f.runtime.createRoom({ name: 'Hall' });
    const registered = f.runtime.registerDevice({ roomId: room.id }, { simulator: true });
    const watch = f.runtime.createWatch({ roomId: room.id, condition: { kind: 'deadline_state', at: '2026-09-29T17:30:00Z', key: 'occupancy', value: 'probably_occupied' }, action: { type: 'speak', text: 'Time to leave.' } });
    const observation = new SimulatorAdapter(f.runtime, registered.device.id, registered.secret).emitObservation('motion_detected', true).observation;
    f.runtime.store.close(); f.runtime.store = new PhysicalStore(f.filename);
    f.setTime('2026-09-29T17:30:00Z');
    const triggers = f.runtime.tick();
    assert.equal(triggers.length, 1);
    assert.deepEqual(triggers[0].evidenceIds, [observation.id]);
    assert.equal(f.runtime.store.get('watches', watch.id).status, 'triggered');
    assert.equal(f.runtime.store.all('actions')[0].status, 'simulated');
    assert.equal(f.runtime.tick().length, 0);
  } finally { f.close(); }
});

test('generic state transition watch links the before and after observations', () => {
  const f = fixture();
  try {
    const room = f.runtime.createRoom({ name: 'Utility' });
    const registered = f.runtime.registerDevice({ roomId: room.id }, { simulator: true });
    const adapter = new SimulatorAdapter(f.runtime, registered.device.id, registered.secret);
    const running = adapter.emitObservation('appliance_state_changed', { running: true }).observation;
    const watch = f.runtime.createWatch({ roomId: room.id,
      condition: { kind: 'state_transition', key: 'appliance', from: { running: true }, to: { running: false } },
      action: { type: 'notify', text: 'The appliance stopped.' } });
    const stopped = adapter.emitObservation('appliance_state_changed', { running: false }).observation;
    assert.deepEqual(f.runtime.store.get('watches', watch.id).triggerEvidenceIds, [running.id, stopped.id]);
    assert.equal(f.runtime.store.all('actions')[0].status, 'simulated');
  } finally { f.close(); }
});

test('production rejects simulator and replay; device identity is authenticated', () => {
  const f = fixture('production');
  try {
    const room = f.runtime.createRoom({ name: 'Office' });
    assert.throws(() => f.runtime.registerDevice({ roomId: room.id }, { simulator: true }), /disabled/);
    const registered = f.runtime.registerDevice({ roomId: room.id, adapter: 'esp32-box3', capabilities: ['motion'] });
    assert.equal(f.runtime.authenticateDevice(registered.device.id, 'wrong'), null);
    assert.equal(f.runtime.authenticateDevice(registered.device.id, registered.secret).id, registered.device.id);
    assert.throws(() => f.runtime.ingest({ type: 'motion_detected', value: true, roomId: room.id, source: { origin: 'simulator', adapter: 'simulator' } }, { origin: 'simulator' }), /disabled/);
    assert.throws(() => f.runtime.ingest({ type: 'motion_detected', value: true, roomId: room.id, source: { origin: 'hardware', adapter: 'esp32-box3', deviceId: 'imposter' } }, { device: f.runtime.authenticateDevice(registered.device.id, registered.secret) }), /identity mismatch/);
    assert.throws(() => f.runtime.ingest({ type: 'door_opened', value: true }, { device: f.runtime.authenticateDevice(registered.device.id, registered.secret) }), /capability not announced/);
  } finally { f.close(); }
});

test('replay retains original source and marks new provenance as replay', () => {
  const f = fixture();
  try {
    const room = f.runtime.createRoom({ name: 'Study' });
    const registered = f.runtime.registerDevice({ roomId: room.id }, { simulator: true });
    const original = new SimulatorAdapter(f.runtime, registered.device.id, registered.secret).emitObservation('sound_detected', true).observation;
    const before = f.runtime.roomState(room.id).state.find(item => item.key === 'sound');
    const replay = f.runtime.replay(original.id).observation;
    assert.equal(replay.source.origin, 'replay');
    assert.equal(replay.metadata.originalObservationId, original.id);
    assert.deepEqual(replay.metadata.originalSource, original.source);
    assert.deepEqual(f.runtime.roomState(room.id).state.find(item => item.key === 'sound'), before);
  } finally { f.close(); }
});

test('sequence replay recomputes state and watch outcome in an isolated store', () => {
  const f = fixture();
  try {
    const room = f.runtime.createRoom({ name: 'Kitchen' });
    const registered = f.runtime.registerDevice({ roomId: room.id }, { simulator: true });
    const original = new SimulatorAdapter(f.runtime, registered.device.id, registered.secret).emitObservation('motion_detected', true).observation;
    f.runtime.createWatch({ roomId: room.id, condition: { kind: 'state_equals', key: 'occupancy', value: 'probably_occupied' }, action: { type: 'notify', text: 'Occupancy changed.' } });
    const before = f.runtime.roomState(room.id);
    const replay = f.runtime.replaySequence([original.id]);
    assert.equal(replay.state.find(item => item.key === 'occupancy').value, 'probably_occupied');
    assert.equal(replay.triggers.length, 1);
    assert.equal(replay.actions[0].status, 'simulated');
    assert.equal(replay.inferences[0].evidenceIds[0], replay.replayObservationIds[0]);
    assert.equal(replay.observations[0].source.origin, 'replay');
    assert.equal(replay.observations[0].metadata.originalObservationId, original.id);
    assert.deepEqual(f.runtime.roomState(room.id), before);
    assert.equal(f.runtime.store.all('actions').length, 0);
  } finally { f.close(); }
});

test('agent failure cannot mutate world state', async () => {
  const f = fixture();
  try {
    f.runtime.agent = async () => { throw new Error('provider unavailable'); };
    const before = f.runtime.store.all('world_state');
    await assert.rejects(f.runtime.chat('What is happening?'), /provider unavailable/);
    assert.deepEqual(f.runtime.store.all('world_state'), before);
  } finally { f.close(); }
});

test('model tool calls can read but cannot perform write tools', async () => {
  const f = fixture();
  try {
    const room = f.runtime.createRoom({ name: 'Study' });
    f.runtime.agent = async () => ({ kind: 'tool', toolName: 'queryRoomState', input: { roomId: room.id }, response: null });
    const turn = await f.runtime.chat('What is the room state?', { roomId: room.id });
    assert.equal(turn.result.room.id, room.id);
    f.runtime.agent = async () => ({ kind: 'tool', toolName: 'cancelWatch', input: { watchId: 'anything' }, response: null });
    await assert.rejects(f.runtime.chat('Cancel it', { roomId: room.id }), /explicit authorization/);
    assert.throws(() => executeTool(f.runtime, 'createWatch', {}), /explicit authorization/);
  } finally { f.close(); }
});

test('provider-neutral agent uses Oxy local model transport and validates its decision', async () => {
  let requested = null;
  const provider = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requested = { url: request.url, body: JSON.parse(raw) };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'answer', response: 'The room state is unknown.' }) } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const previous = process.env.OXY_LOCAL_MODEL_BASE_URL;
  process.env.OXY_LOCAL_MODEL_BASE_URL = `http://127.0.0.1:${provider.address().port}`;
  try {
    const decision = await createAgent({ provider: 'local', model: 'fixture-model' })({ message: 'Is someone here?', context: { room: null } });
    assert.equal(decision.kind, 'answer');
    assert.equal(requested.url, '/chat/completions');
    assert.equal(requested.body.model, 'fixture-model');
    assert.match(JSON.stringify(requested.body.messages), /Is someone here/);
  } finally {
    if (previous === undefined) delete process.env.OXY_LOCAL_MODEL_BASE_URL;
    else process.env.OXY_LOCAL_MODEL_BASE_URL = previous;
    await new Promise(resolve => provider.close(resolve));
  }
});

test('device command requires announced capability and records acknowledgement', async () => {
  const f = fixture();
  try {
    const registered = f.runtime.registerDevice({ capabilities: ['display'] }, { simulator: true });
    await assert.rejects(f.runtime.command(registered.device.id, 'unlock'), /reviewed action contract/);
    const command = await f.runtime.command(registered.device.id, 'display', { text: 'Hello' });
    assert.equal(f.runtime.pendingCommands(registered.device.id).length, 1);
    const ack = new SimulatorAdapter(f.runtime, registered.device.id, registered.secret).executeCommand(command);
    assert.equal(ack.status, 'acknowledged');
    assert.equal(f.runtime.pendingCommands(registered.device.id).length, 0);
    const late = await f.runtime.command(registered.device.id, 'display', { text: 'Later' });
    f.setTime('2026-09-29T17:26:00.000Z');
    f.runtime.tick();
    assert.equal(f.runtime.store.get('commands', late.id).status, 'timed_out');
  } finally { f.close(); }
});

test('durable memory separates user facts from simulated evidence', () => {
  const f = fixture();
  try {
    const memory = f.runtime.remember({ kind: 'user', content: 'Prefer quiet reminders', source: { origin: 'user_report' } });
    assert.equal(f.runtime.searchMemory('quiet reminders')[0].id, memory.id);
    assert.throws(() => f.runtime.remember({ kind: 'environmental', content: 'Someone lives here', source: { origin: 'simulator' } }), /Untrusted memory source/);
    assert.throws(() => f.runtime.remember({ kind: 'episodic', content: 'Door opened', source: { origin: 'hardware', observationId: 'unknown' } }), /physical evidence/);
  } finally { f.close(); }
});

test('proactive speech respects quiet hours and explicit preference', () => {
  const f = fixture();
  try {
    const room = f.runtime.createRoom({ name: 'Bedroom' });
    const registered = f.runtime.registerDevice({ roomId: room.id }, { simulator: true });
    f.runtime.setPreferences('local', { timeZone: 'UTC', quietHours: { start: '17:00', end: '18:00' }, speechEnabled: true });
    f.runtime.createWatch({ roomId: room.id, createdBy: 'local', condition: { kind: 'observation_type', type: 'motion_detected' }, action: { type: 'speak', text: 'Motion seen.' } });
    new SimulatorAdapter(f.runtime, registered.device.id, registered.secret).emitObservation('motion_detected', true);
    assert.equal(f.runtime.store.all('actions')[0].status, 'suppressed');
    assert.equal(f.runtime.store.all('actions')[0].reason, 'quiet_hours');
  } finally { f.close(); }
});

test('trusted device evidence can deliver a local notification and record the outcome', async () => {
  const f = fixture();
  try {
    const room = f.runtime.createRoom({ name: 'Hall' });
    const registered = f.runtime.registerDevice({ roomId: room.id, capabilities: ['motion'] });
    const device = f.runtime.authenticateDevice(registered.device.id, registered.secret);
    const delivered = [];
    f.runtime.notification = async message => { delivered.push(message); };
    f.runtime.createWatch({ roomId: room.id, condition: { kind: 'observation_type', type: 'motion_detected' }, action: { type: 'notify', text: 'Motion seen.' } });
    f.runtime.ingest({ type: 'motion_detected', value: true, source: { sensor: 'motion' } }, { device });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(delivered, ['Motion seen.']);
    assert.equal(f.runtime.store.all('actions')[0].status, 'executed');
    assert.equal(f.runtime.store.all('actions')[0].simulated, false);
  } finally { f.close(); }
});

test('HTTP device protocol requires identity and unique message IDs', async () => {
  const f = fixture();
  const { server } = createPhysicalServer({ runtime: f.runtime });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (route, payload, secret) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(payload) });
    const roomResponse = await post('/v1/rooms', { name: 'Kitchen' });
    assert.equal(roomResponse.status, 201);
    const room = await roomResponse.json();
    const deviceResponse = await post('/v1/simulator/devices', { id: 'sim-kitchen', roomId: room.id });
    const registered = await deviceResponse.json();
    const capabilityResponse = await post('/v1/devices/sim-kitchen/capabilities', { protocolVersion: 1, messageId: 'capabilities', timestamp: '2026-09-29T17:25:00Z', capabilities: ['motion'] }, registered.secret);
    assert.equal(capabilityResponse.status, 200);
    assert.deepEqual((await capabilityResponse.json()).capabilities, ['motion']);
    const envelope = { protocolVersion: 1, messageId: 'first', timestamp: '2026-09-29T17:25:00Z', type: 'motion_detected', value: true };
    assert.equal((await post('/v1/devices/sim-kitchen/observations', envelope, 'wrong')).status, 401);
    const accepted = await post('/v1/devices/sim-kitchen/observations', envelope, registered.secret);
    assert.equal(accepted.status, 201);
    const result = await accepted.json();
    assert.equal(result.observation.source.origin, 'simulator');
    assert.equal((await post('/v1/devices/sim-kitchen/observations', envelope, registered.secret)).status, 400);
    const spoof = await post('/v1/devices/sim-kitchen/observations', { ...envelope, messageId: 'second', source: { origin: 'hardware' } }, registered.secret);
    assert.equal(spoof.status, 400);
    assert.equal((await fetch(`${base}/v1/snapshot`)).status, 200);
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); f.close(); }
});

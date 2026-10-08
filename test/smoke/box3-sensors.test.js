'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PhysicalRuntime } = require('../../api/physical/runtime');
const { PhysicalStore } = require('../../api/physical/store');
const { sensorObservations, ingestSensors } = require('../../api/physical/box3-sensors');

test('BOX device movement stays separate from room movement and absence', () => {
  const readings = sensorObservations({ uptimeMs: 1000, imu: { available: true, accelerationG: [1, 0, 0], rotationDps: [20, 0, 0] }, radar: { available: true, configured: true, verification: 'register_readback', motionSignal: false } });
  assert.deepEqual(readings.map(item => item.type), ['imu.reading', 'radar.motion_signal']);
  assert.equal(readings[1].value.active, false);
  assert.match(readings[1].value.meaning, /does not establish an empty room/);
});

test('unavailable, stale or unverified sensors cannot become physical observations', () => {
  assert.deepEqual(sensorObservations({ uptimeMs: 1000, imu: { available: true, accelerationG: [NaN, 0, 1], rotationDps: [0, 0, 0] }, environment: { available: true, ageMs: 10000, temperatureC: 26, humidityPercent: 50 }, radar: { available: true, configured: false, verification: 'signal_pin_only', motionSignal: true } }), []);
  assert.throws(() => sensorObservations({}), /Invalid BOX-3/);
});

test('sensor ingest retains hardware provenance and does not project radar silence into empty occupancy', () => {
  const store = new PhysicalStore(':memory:');
  try {
    const runtime = new PhysicalRuntime({ store });
    const room = runtime.createRoom({ name: 'Test room' });
    const identity = runtime.registerDevice({ hardwareType: 'ESP32-S3-BOX-3', adapter: 'usb-box3-v1', roomId: room.id, capabilities: ['temperature', 'humidity_changed', 'radar.motion_signal'] });
    const device = runtime.authenticateDevice(identity.device.id, identity.secret);
    const observations = ingestSensors(runtime, device, { uptimeMs: 1000, environment: { available: true, ageMs: 20, temperatureC: 26.5, humidityPercent: 56 }, radar: { available: true, configured: true, verification: 'register_readback', motionSignal: false } });
    assert.equal(observations.length, 3);
    assert.ok(observations.every(item => item.source.origin === 'hardware' && item.source.deviceId === device.id));
    assert.equal(runtime.roomState(room.id).state.find(item => item.key === 'temperature').value, 26.5);
    assert.equal(runtime.roomState(room.id).state.some(item => item.key === 'occupancy'), false);
  } finally { store.close(); }
});

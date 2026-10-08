'use strict';

function finiteVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function sensorObservations(snapshot) {
  if (!snapshot || !Number.isFinite(snapshot.uptimeMs)) throw new Error('Invalid BOX-3 sensor snapshot');
  const observations = [];
  if (snapshot.imu?.available && finiteVector(snapshot.imu.accelerationG) && finiteVector(snapshot.imu.rotationDps)) {
    observations.push({ type: 'imu.reading', capability: 'imu.reading', sensor: 'imu', value: { accelerationG: snapshot.imu.accelerationG, rotationDps: snapshot.imu.rotationDps, chipId: snapshot.imu.chipId } });
  }
  const environment = snapshot.environment;
  if (environment?.available && Number.isFinite(environment.ageMs) && environment.ageMs >= 0 && environment.ageMs < 10000) {
    if (Number.isFinite(environment.temperatureC)) observations.push({ type: 'temperature_changed', capability: 'temperature', sensor: 'temperature', value: environment.temperatureC });
    if (Number.isFinite(environment.humidityPercent) && environment.humidityPercent >= 0 && environment.humidityPercent <= 100) observations.push({ type: 'humidity_changed', capability: 'humidity_changed', sensor: 'humidity', value: environment.humidityPercent });
  }
  if (snapshot.radar?.available && snapshot.radar.configured && snapshot.radar.verification === 'register_readback' && typeof snapshot.radar.motionSignal === 'boolean') {
    observations.push({ type: 'radar.motion_signal', capability: 'radar.motion_signal', sensor: 'AT581x', value: { active: snapshot.radar.motionSignal, meaning: 'movement signal; no signal does not establish an empty room' } });
  }
  return observations;
}

function ingestSensors(runtime, device, snapshot) {
  return sensorObservations(snapshot).map(item => runtime.ingest({ type: item.type, value: item.value,
    source: { sensor: item.sensor }, metadata: { deviceUptimeMs: snapshot.uptimeMs, sampleAgeMs: item.sensor === 'temperature' || item.sensor === 'humidity' ? snapshot.environment.ageMs : 0 } }, { device }).observation);
}

module.exports = { sensorObservations, ingestSensors };

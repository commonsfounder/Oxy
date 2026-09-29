'use strict';

class SimulatorAdapter {
  constructor(runtime, deviceId, secret) { this.runtime = runtime; this.deviceId = deviceId; this.secret = secret; }
  connect() { return this.runtime.heartbeat(this.deviceId, this.secret); }
  disconnect() { const device = this.runtime.store.get('devices', this.deviceId); device.connectionState = 'disconnected'; this.runtime.store.put('devices', device); }
  getCapabilities() { return this.runtime.store.get('devices', this.deviceId)?.capabilities || []; }
  emitObservation(type, value, options = {}) {
    const device = this.runtime.authenticateDevice(this.deviceId, this.secret);
    if (!device || device.origin !== 'simulator') throw new Error('Simulator device authentication failed');
    return this.runtime.ingest({ type, value, confidence: options.confidence ?? 1, timestamp: options.timestamp || this.runtime.now().toISOString(), source: { deviceId: device.id, adapter: device.adapter, origin: 'simulator', sensor: options.sensor || null } }, { device });
  }
  receiveTelemetry(message) { return this.emitObservation(message.type, message.value, message); }
  executeCommand(command) { return this.runtime.acknowledgeCommand(this.deviceId, command.id, 'acknowledged'); }
  healthCheck() { return { connected: this.runtime.store.get('devices', this.deviceId)?.connectionState === 'connected' }; }
}

class ESP32Box3Adapter {
  constructor(runtime, deviceId) { this.runtime = runtime; this.deviceId = deviceId; }
  connect() { throw new Error('ESP32-S3-BOX-3 firmware transport is not connected'); }
  disconnect() { throw new Error('ESP32-S3-BOX-3 firmware transport is not connected'); }
  getCapabilities() { return this.runtime.store.get('devices', this.deviceId)?.capabilities || []; }
  receiveTelemetry() { throw new Error('ESP32-S3-BOX-3 firmware transport is not connected'); }
  emitObservation() { throw new Error('ESP32-S3-BOX-3 firmware transport is not connected'); }
  executeCommand() { throw new Error('ESP32-S3-BOX-3 firmware transport is not connected'); }
  healthCheck() { return { connected: false, reason: 'firmware_transport_pending' }; }
}

module.exports = { SimulatorAdapter, ESP32Box3Adapter };

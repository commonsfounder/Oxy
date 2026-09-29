'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { canonicalObservation, currentState, id, iso, text, ENVIRONMENTS } = require('./model');
const { PhysicalStore } = require('./store');
const { decideIntervention } = require('../services/household-events');
const { executeTool } = require('./tools');

const execFileAsync = promisify(execFile);
const STATE_TTL_MS = { motion_detected: 10 * 60_000, motion_stopped: 2 * 60_000, occupancy_signal: 10 * 60_000, BLE_device_seen: 5 * 60_000, BLE_device_lost: 5 * 60_000, sound_detected: 2 * 60_000, door_opened: 5 * 60_000, door_closed: 5 * 60_000, device_state_changed: 60 * 60_000, appliance_state_changed: 60 * 60_000, temperature_changed: 60 * 60_000 };
const STATE_KEYS = { motion_detected: ['motion', true], motion_stopped: ['motion', false], occupancy_signal: ['occupancySignal', null], BLE_device_seen: ['blePresence', true], BLE_device_lost: ['blePresence', false], sound_detected: ['sound', true], door_opened: ['door', 'open'], door_closed: ['door', 'closed'], device_state_changed: ['device', null], appliance_state_changed: ['appliance', null], temperature_changed: ['temperature', null] };
const SAFE_COMMANDS = new Set(['display', 'play_audio', 'volume', 'flash_led', 'request_reading', 'start_scan', 'stop_scan']);
const MEMORY_KINDS = new Set(['user', 'environmental', 'episodic']);
const OBSERVATION_CAPABILITIES = { motion_detected: 'motion', motion_stopped: 'motion', occupancy_signal: 'occupancy', sound_detected: 'microphone', speech_detected: 'microphone', speech_transcript: 'microphone', button_pressed: 'button', temperature_changed: 'temperature', BLE_device_seen: 'BLE_scan', BLE_device_lost: 'BLE_scan', device_state_changed: 'device_state', appliance_state_changed: 'appliance_state', door_opened: 'door', door_closed: 'door' };

function safeEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function authHash(secret) { return crypto.createHash('sha256').update(secret).digest('hex'); }
function timeMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) throw new Error('Invalid quiet-hours time');
  const [hour, minute] = value.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error('Invalid quiet-hours time');
  return hour * 60 + minute;
}
function withinQuietHours(preferences, now) {
  const quiet = preferences?.quietHours;
  if (!quiet) return false;
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: preferences.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const current = timeMinutes(clock);
  const start = timeMinutes(quiet.start);
  const end = timeMinutes(quiet.end);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}
function occurrence(event, evidence = [], now = new Date()) {
  return { id: id(), type: event, timestamp: now.toISOString(), evidenceIds: evidence, payload: {} };
}

class PhysicalRuntime extends EventEmitter {
  constructor({ store = new PhysicalStore(), environment = process.env.NODE_ENV === 'production' ? 'production' : 'development', now = () => new Date(), agent = null, speech = null, notification = null, allowReplayProjection = false } = {}) {
    super();
    if (!ENVIRONMENTS.has(environment)) throw new Error('Invalid environment');
    this.store = store;
    this.environment = environment;
    this.now = now;
    this.agent = agent;
    this.speech = speech;
    this.notification = notification;
    this.allowReplayProjection = allowReplayProjection;
    this.adapters = new Map();
  }

  emitStored(type, record) {
    this.emit('event', { type, record });
    console.log(JSON.stringify({ component: 'adam.physical', type, id: record.id, at: this.now().toISOString(), origin: record.source?.origin || null, evidenceIds: record.evidenceIds || null, status: record.status || null, reason: record.reason || null }));
  }

  createUser(input) {
    const user = { id: text(input.id || id(), 'user ID'), name: text(input.name, 'user name'), createdAt: this.now().toISOString() };
    if (this.store.get('users', user.id)) throw new Error('User already exists');
    return this.store.put('users', user);
  }

  createRoom(input) {
    const room = { id: input.id || id(), name: text(input.name, 'room name'), createdAt: this.now().toISOString() };
    if (this.store.get('rooms', room.id)) throw new Error('Room already exists');
    return this.store.put('rooms', room);
  }

  registerDevice(input, { simulator = false } = {}) {
    const deviceId = text(input.id || id(), 'device ID');
    if (this.store.get('devices', deviceId)) throw new Error('Device already registered');
    if (input.roomId && !this.store.get('rooms', input.roomId)) throw new Error('Unknown room');
    if (simulator && this.environment === 'production') throw new Error('Simulator disabled in production');
    if (input.capabilities !== undefined && !Array.isArray(input.capabilities)) throw new Error('Invalid capabilities');
    const secret = crypto.randomBytes(32).toString('hex');
    const device = {
      id: deviceId, hardwareType: text(input.hardwareType || (simulator ? 'simulator' : 'unknown'), 'hardware type'),
      adapter: text(input.adapter || (simulator ? 'simulator' : 'http-v1'), 'adapter'),
      origin: simulator ? 'simulator' : 'hardware', roomId: input.roomId || null,
      ownerId: input.ownerId || null, capabilities: [...new Set(input.capabilities || [])].map(item => text(item, 'capability')),
      firmwareVersion: input.firmwareVersion || null, protocolVersion: 1,
      connectionState: 'connected', lastHeartbeat: this.now().toISOString(),
      networkState: null, recordingState: (input.capabilities || []).includes('microphone') ? 'unknown' : 'not_applicable',
      secretHash: authHash(secret), createdAt: this.now().toISOString()
    };
    this.store.put('devices', device);
    this.emitStored('DeviceConnected', { ...device, secretHash: undefined });
    return { device: this.publicDevice(device), secret };
  }

  publicDevice(device) { if (!device) return null; const { secretHash, ...safe } = device; return safe; }
  authenticateDevice(deviceId, secret) {
    const device = this.store.get('devices', deviceId);
    if (!device || !secret) return null;
    const expected = Buffer.from(device.secretHash, 'hex');
    const actual = Buffer.from(authHash(secret), 'hex');
    return crypto.timingSafeEqual(expected, actual) ? device : null;
  }

  heartbeat(deviceId, secret, update = {}) {
    const device = this.authenticateDevice(deviceId, secret);
    if (!device) throw new Error('Device authentication failed');
    device.lastHeartbeat = this.now().toISOString();
    device.connectionState = 'connected';
    device.networkState = update.networkState || device.networkState;
    if (update.recordingState !== undefined) {
      if (!['off', 'active', 'unknown'].includes(update.recordingState)) throw new Error('Invalid recording state');
      if (!device.capabilities.includes('microphone')) throw new Error('Recording state requires microphone capability');
      device.recordingState = update.recordingState;
    }
    this.store.put('devices', device);
    return this.publicDevice(device);
  }

  announceCapabilities(deviceId, secret, capabilities) {
    const device = this.authenticateDevice(deviceId, secret);
    if (!device) throw new Error('Device authentication failed');
    if (!Array.isArray(capabilities) || capabilities.length > 64) throw new Error('Invalid capabilities');
    device.capabilities = [...new Set(capabilities.map(item => text(item, 'capability')))];
    if (!device.capabilities.includes('microphone')) device.recordingState = 'not_applicable';
    else if (device.recordingState === 'not_applicable') device.recordingState = 'unknown';
    this.store.put('devices', device);
    this.emitStored('CapabilitiesAnnounced', this.publicDevice(device));
    return this.publicDevice(device);
  }

  disconnectStaleDevices(maxAgeMs = 90_000) {
    const changed = [];
    for (const device of this.store.all('devices')) {
      if (device.connectionState === 'connected' && this.now().getTime() - Date.parse(device.lastHeartbeat) > maxAgeMs) {
        device.connectionState = 'disconnected';
        this.store.put('devices', device);
        changed.push(this.publicDevice(device));
        this.emitStored('DeviceDisconnected', this.publicDevice(device));
      }
    }
    return changed;
  }

  ingest(input, { origin, device = null } = {}) {
    if (device) {
      const required = OBSERVATION_CAPABILITIES[input.type] || input.type;
      if (device.origin === 'hardware' && !device.capabilities.includes(required)) throw new Error('Observation capability not announced');
      if (input.source?.deviceId && input.source.deviceId !== device.id) throw new Error('Device identity mismatch');
      if (input.source?.adapter && input.source.adapter !== device.adapter) throw new Error('Adapter mismatch');
      if (input.source?.origin && input.source.origin !== device.origin) throw new Error('Origin mismatch');
      if (input.roomId && input.roomId !== device.roomId) throw new Error('Device room mismatch');
      origin = device.origin;
      input = { ...input, roomId: device.roomId,
        metadata: { ...(input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {}), transport: input.messageId ? { messageId: input.messageId, protocolVersion: input.protocolVersion } : null },
        source: { ...input.source, deviceId: device.id, adapter: device.adapter, origin } };
    }
    if (!origin) throw new Error('Trusted ingress origin required');
    const observation = canonicalObservation(input, { environment: this.environment, now: this.now(), trustedOrigin: origin });
    if (observation.roomId && !this.store.get('rooms', observation.roomId)) throw new Error('Unknown room');
    const updates = this.store.transaction(() => {
      this.store.put('observations', observation);
      const event = occurrence('ObservationReceived', [observation.id], this.now());
      event.payload = { observationId: observation.id, origin: observation.source.origin, originalSource: observation.metadata.originalSource || null };
      this.store.put('events', event);
      const isolatedReplay = observation.source.origin === 'replay' && !this.allowReplayProjection;
      const changed = isolatedReplay ? [] : this.updateWorld(observation);
      const triggers = isolatedReplay ? [] : this.evaluateWatches(observation);
      return { event, changed, triggers };
    });
    this.emitStored('ObservationReceived', observation);
    for (const state of updates.changed) this.emitStored(state.kind === 'inference' ? 'InferenceCreated' : 'StateChanged', state);
    for (const trigger of updates.triggers) {
      this.emitStored('WatchTriggered', trigger);
      const action = this.store.get('actions', trigger.payload.actionId);
      if (action) this.emitStored('ActionRequested', action);
    }
    this.dispatchQueuedActions();
    return { observation, ...updates };
  }

  updateWorld(observation) {
    if (!observation.roomId || !STATE_KEYS[observation.type]) return [];
    const [key, fixed] = STATE_KEYS[observation.type];
    const value = fixed === null ? observation.value : fixed;
    const at = Date.parse(observation.timestamp);
    const stateId = `${observation.roomId}:${key}`;
    const previous = this.store.get('world_state', stateId);
    if (previous && Date.parse(previous.observedAt) > at) return [];
    const state = {
      id: stateId, roomId: observation.roomId, key, value, confidence: observation.confidence,
      observedAt: observation.timestamp, updatedAt: this.now().toISOString(),
      expiresAt: new Date(at + STATE_TTL_MS[observation.type]).toISOString(),
      evidenceIds: [observation.id], source: observation.source,
      kind: 'observed_signal'
    };
    this.store.put('world_state', state);
    const changed = [state];
    if (key === 'motion' || key === 'occupancySignal' || key === 'blePresence') changed.push(this.inferOccupancy(observation.roomId));
    for (const item of changed) {
      const event = occurrence(item.kind === 'inference' ? 'InferenceCreated' : 'StateChanged', item.evidenceIds, this.now());
      event.payload = { stateId: item.id, value: item.value };
      this.store.put('events', event);
    }
    return changed;
  }

  inferOccupancy(roomId) {
    const signals = ['motion', 'occupancySignal', 'blePresence'].map(key => currentState(this.store.get('world_state', `${roomId}:${key}`), this.now())).filter(Boolean);
    const positive = signals.filter(item => !item.stale && (item.value === true || item.value === 'present' || item.value === 'occupied'));
    const negative = signals.filter(item => !item.stale && (item.value === false || item.value === 'absent' || item.value === 'empty'));
    const support = positive.reduce((sum, item) => sum + item.confidence, 0);
    const oppose = negative.reduce((sum, item) => sum + item.confidence, 0);
    const value = support > 0 && support >= oppose * 1.5 ? 'probably_occupied' : oppose > 0 && oppose >= support * 1.5 ? 'probably_empty' : 'unknown';
    const evidenceIds = [...positive, ...negative].flatMap(item => item.evidenceIds);
    const winning = value === 'probably_occupied' ? { weight: support, count: positive.length } : { weight: oppose, count: negative.length };
    const confidence = value === 'unknown' ? 0 : Math.min(0.95, (0.4 + 0.2 * winning.count) * winning.weight / Math.max(1, support + oppose));
    const inference = {
      id: id(), roomId, key: 'occupancy', value, confidence,
      observedAt: this.now().toISOString(), updatedAt: this.now().toISOString(),
      expiresAt: evidenceIds.length ? new Date(Math.min(...[...positive, ...negative].map(item => Date.parse(item.expiresAt)))).toISOString() : this.now().toISOString(),
      evidenceIds, kind: 'inference', contradictingEvidenceIds: value === 'probably_occupied' ? negative.flatMap(x => x.evidenceIds) : positive.flatMap(x => x.evidenceIds)
    };
    this.store.put('inferences', inference);
    this.store.put('world_state', { ...inference, id: `${roomId}:occupancy`, inferenceId: inference.id });
    return inference;
  }

  roomState(roomId) {
    if (!this.store.get('rooms', roomId)) throw new Error('Unknown room');
    const state = this.store.all('world_state').filter(item => item.roomId === roomId).map(item => currentState(item, this.now()));
    return { room: this.store.get('rooms', roomId), state };
  }

  createWatch(input) {
    const condition = input.condition || {};
    if (!['observation_type', 'state_equals', 'state_transition', 'deadline_state'].includes(condition.kind)) throw new Error('Unsupported watch condition');
    if (condition.kind === 'observation_type') text(condition.type, 'observation type');
    if (condition.kind !== 'observation_type') { text(condition.key, 'state key'); if (condition.kind !== 'state_transition' && condition.value === undefined) throw new Error('Watch value required'); }
    if (condition.kind === 'state_transition' && (condition.from === undefined || condition.to === undefined)) throw new Error('Transition values required');
    if (condition.kind !== 'observation_type' && !input.roomId) throw new Error('State watch requires a room');
    if (condition.kind === 'deadline_state') iso(condition.at);
    if (input.roomId && !this.store.get('rooms', input.roomId)) throw new Error('Unknown room');
    const baseline = condition.kind === 'state_transition' ? currentState(this.store.get('world_state', `${input.roomId}:${condition.key}`), this.now()) : null;
    const watch = {
      id: id(), createdAt: this.now().toISOString(), createdBy: input.createdBy || 'user',
      roomId: input.roomId || null, condition, status: 'active',
      expiresAt: input.expiresAt ? iso(input.expiresAt) : null,
      action: input.action || { type: 'notify', text: 'A watched condition changed.' },
      provenance: input.provenance || { origin: 'user_report' },
      lastEvaluatedAt: null, triggeredAt: null, triggerEvidenceIds: [],
      lastValue: baseline?.value ?? null, lastEvidenceIds: baseline?.evidenceIds || []
    };
    if (!['notify', 'speak'].includes(watch.action.type)) throw new Error('Unsupported watch action');
    text(watch.action.text, 'action text', 500);
    return this.store.put('watches', watch);
  }

  cancelWatch(watchId) {
    const watch = this.store.get('watches', watchId);
    if (!watch) throw new Error('Unknown watch');
    watch.status = 'cancelled';
    this.store.put('watches', watch);
    return watch;
  }

  remember(input) {
    if (!MEMORY_KINDS.has(input.kind)) throw new Error('Invalid memory kind');
    const content = text(input.content, 'memory content', 2000);
    const source = input.source || {};
    if (!['user_report', 'hardware', 'external_service'].includes(source.origin)) throw new Error('Untrusted memory source');
    if (source.origin === 'hardware' && (!source.observationId || this.store.get('observations', source.observationId)?.source.origin !== 'hardware')) throw new Error('Hardware memory requires physical evidence');
    const memory = { id: id(), kind: input.kind, content, scope: input.scope || 'local', source,
      confidence: input.confidence === undefined ? 1 : Number(input.confidence), createdAt: this.now().toISOString() };
    if (!Number.isFinite(memory.confidence) || memory.confidence < 0 || memory.confidence > 1) throw new Error('Invalid memory confidence');
    return this.store.put('memories', memory);
  }

  searchMemory(query, limit = 5) {
    const words = String(query || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    if (!words.length) return [];
    return this.store.list('memories', 1000).filter(item => words.some(word => item.content.toLowerCase().includes(word))).slice(0, Math.min(limit, 20));
  }

  setPreferences(userId, input) {
    const idValue = text(userId, 'user ID');
    const timeZone = text(input.timeZone || 'UTC', 'time zone');
    try { new Intl.DateTimeFormat('en-GB', { timeZone }); } catch { throw new Error('Invalid time zone'); }
    const quietHours = input.quietHours ? { start: input.quietHours.start, end: input.quietHours.end } : null;
    if (quietHours) { timeMinutes(quietHours.start); timeMinutes(quietHours.end); }
    const preference = { id: idValue, createdAt: this.now().toISOString(), timeZone, quietHours,
      speechEnabled: input.speechEnabled !== false, minConfidence: input.minConfidence ?? 0.6,
      cooldownMs: input.cooldownMs ?? 30 * 60_000 };
    if (!Number.isFinite(preference.minConfidence) || preference.minConfidence < 0 || preference.minConfidence > 1) throw new Error('Invalid confidence preference');
    if (!Number.isInteger(preference.cooldownMs) || preference.cooldownMs < 0 || preference.cooldownMs > 24 * 60 * 60_000) throw new Error('Invalid cooldown preference');
    return this.store.put('preferences', preference);
  }

  evaluateWatches(observation = null) {
    const triggers = [];
    for (const watch of this.store.all('watches')) {
      if (watch.status !== 'active') continue;
      watch.lastEvaluatedAt = this.now().toISOString();
      if (watch.expiresAt && Date.parse(watch.expiresAt) <= this.now().getTime()) {
        watch.status = 'expired'; this.store.put('watches', watch); continue;
      }
      if (watch.roomId && observation?.roomId !== watch.roomId && watch.condition.kind !== 'deadline_state') continue;
      const condition = watch.condition;
      let evidenceIds = [];
      let matched = false;
      if (condition.kind === 'observation_type' && observation) {
        matched = observation.type === condition.type && (condition.value === undefined || safeEqual(observation.value, condition.value));
        if (matched) evidenceIds = [observation.id];
      } else if (condition.kind === 'state_equals' && observation && watch.roomId) {
        const state = currentState(this.store.get('world_state', `${watch.roomId}:${condition.key}`), this.now());
        matched = Boolean(state && !state.stale && safeEqual(state.value, condition.value));
        if (matched) evidenceIds = state.evidenceIds;
      } else if (condition.kind === 'state_transition' && observation && watch.roomId) {
        const state = currentState(this.store.get('world_state', `${watch.roomId}:${condition.key}`), this.now());
        matched = Boolean(state && !state.stale && safeEqual(watch.lastValue, condition.from) && safeEqual(state.value, condition.to));
        if (matched) evidenceIds = [...new Set([...(watch.lastEvidenceIds || []), ...state.evidenceIds])];
        watch.lastValue = state?.value ?? null;
        watch.lastEvidenceIds = state?.evidenceIds || [];
      } else if (condition.kind === 'deadline_state' && this.now().getTime() >= Date.parse(condition.at) && watch.roomId) {
        const state = currentState(this.store.get('world_state', `${watch.roomId}:${condition.key}`), this.now());
        matched = Boolean(state && !state.stale && safeEqual(state.value, condition.value));
        if (matched) evidenceIds = state.evidenceIds;
      }
      if (matched) {
        watch.status = 'triggered'; watch.triggeredAt = this.now().toISOString(); watch.triggerEvidenceIds = evidenceIds;
        const trigger = occurrence('WatchTriggered', evidenceIds, this.now());
        trigger.payload = { watchId: watch.id, condition, simulated: evidenceIds.some(item => this.store.get('observations', item)?.source.origin === 'simulator') };
        this.store.put('events', trigger);
        triggers.push(trigger);
        const action = this.requestAction(watch.action, { watch, evidenceIds, triggerId: trigger.id });
        trigger.payload.actionId = action.id;
        this.store.put('events', trigger);
      }
      this.store.put('watches', watch);
    }
    return triggers;
  }

  tick() { const triggers = this.store.transaction(() => this.evaluateWatches()); for (const trigger of triggers) { this.emitStored('WatchTriggered', trigger); const action = this.store.get('actions', trigger.payload.actionId); if (action) this.emitStored('ActionRequested', action); } this.dispatchQueuedActions(); this.disconnectStaleDevices(); this.expireCommands(); return triggers; }

  requestAction(action, context = {}) {
    const evidence = (context.evidenceIds || []).map(item => this.store.get('observations', item)).filter(Boolean);
    const simulated = evidence.some(item => item.source.origin === 'simulator' || item.source.origin === 'replay');
    const decision = decideIntervention({ event: { confidence: Math.min(...evidence.map(item => item.confidence), 1), relevance: 1, actionable: true, interruptionCost: 'low', expiresAt: null }, now: this.now() });
    const preferences = this.store.get('preferences', context.watch?.createdBy || 'local');
    const quiet = withinQuietHours(preferences, this.now());
    const weak = preferences && evidence.some(item => item.confidence < preferences.minConfidence);
    const recent = preferences && this.store.all('actions').some(item => item.text === action.text && !['suppressed', 'failed'].includes(item.status) && this.now().getTime() - Date.parse(item.createdAt) < preferences.cooldownMs);
    const blockedReason = !decision.surface ? decision.reason : quiet ? 'quiet_hours' : weak ? 'low_confidence_preference' : recent ? 'cooldown' : action.type === 'speak' && preferences?.speechEnabled === false ? 'speech_disabled' : null;
    const status = blockedReason ? 'suppressed' : simulated ? 'simulated' : 'queued';
    const record = { id: id(), createdAt: this.now().toISOString(), type: action.type, text: action.text, status,
      reason: blockedReason || (simulated ? 'untrusted_evidence' : decision.reason), triggerId: context.triggerId || null,
      watchId: context.watch?.id || null, evidenceIds: context.evidenceIds || [], simulated };
    this.store.put('actions', record);
    return record;
  }

  dispatchQueuedActions() {
    for (const record of this.store.all('actions').filter(item => item.status === 'queued')) {
      const deliver = record.type === 'speak' ? this.speech : record.type === 'notify' ? this.notification : null;
      if (!deliver) continue;
      record.status = 'executing'; this.store.put('actions', record);
      Promise.resolve().then(() => deliver(record.text)).then(() => {
        record.status = 'executed'; this.store.put('actions', record); this.emitStored('ActionExecuted', record);
      }).catch(error => {
        record.status = 'failed'; record.error = error.message; this.store.put('actions', record); this.emitStored('ActionRejected', record);
      });
    }
  }

  replay(observationId) {
    if (this.environment === 'production') throw new Error('Replay disabled in production');
    const original = this.store.get('observations', observationId);
    if (!original) throw new Error('Unknown observation');
    return this.ingest({ type: original.type, value: original.value, roomId: original.roomId,
      timestamp: original.timestamp, confidence: original.confidence,
      source: { ...original.source, origin: 'replay', adapter: 'replay' },
      metadata: { originalObservationId: original.id, originalSource: original.source, replayedAt: this.now().toISOString() } }, { origin: 'replay' });
  }

  replaySequence(observationIds) {
    if (this.environment === 'production') throw new Error('Replay disabled in production');
    if (!Array.isArray(observationIds) || !observationIds.length || observationIds.length > 1000) throw new Error('Invalid replay sequence');
    const originals = observationIds.map(observationId => {
      const observation = this.store.get('observations', observationId);
      if (!observation) throw new Error(`Unknown observation ${observationId}`);
      return observation;
    }).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const sandboxStore = new PhysicalStore(':memory:');
    let clock = new Date(originals[0].timestamp);
    const sandbox = new PhysicalRuntime({ store: sandboxStore, environment: 'test', now: () => clock, allowReplayProjection: true });
    try {
      for (const room of this.store.all('rooms')) sandboxStore.put('rooms', room);
      for (const watch of this.store.all('watches').filter(item => item.status === 'active')) sandboxStore.put('watches', { ...watch, triggeredAt: null, triggerEvidenceIds: [], lastValue: null, lastEvidenceIds: [] });
      const replayed = [];
      for (const original of originals) {
        clock = new Date(original.timestamp);
        replayed.push(sandbox.ingest({
          type: original.type, value: original.value, roomId: original.roomId, timestamp: original.timestamp,
          confidence: original.confidence, source: { ...original.source, adapter: 'replay', origin: 'replay' },
          metadata: { originalObservationId: original.id, originalSource: original.source }
        }, { origin: 'replay' }).observation.id);
      }
      const result = { id: id(), createdAt: this.now().toISOString(), originalObservationIds: originals.map(item => item.id),
        replayObservationIds: replayed, observations: sandboxStore.all('observations'), state: sandboxStore.all('world_state'),
        inferences: sandboxStore.all('inferences'), triggers: sandboxStore.all('events').filter(item => item.type === 'WatchTriggered'),
        actions: sandboxStore.all('actions'), environment: 'test' };
      this.store.put('replay_runs', result);
      return result;
    } finally { sandboxStore.close(); }
  }

  async chat(message, { roomId = null, userId = 'local' } = {}) {
    text(message, 'message', 4000);
    if (!this.agent) throw new Error('No agent provider configured');
    const context = {
      room: roomId ? this.roomState(roomId) : null,
      watches: this.store.all('watches').filter(item => item.status === 'active' && (!roomId || item.roomId === roomId)).slice(0, 10),
      recentObservations: this.store.list('observations', 10).filter(item => !roomId || item.roomId === roomId),
      relevantMemories: this.searchMemory(message),
      recentConversation: this.store.list('conversations', 6).filter(item => item.userId === userId).reverse()
    };
    const plan = await this.agent({ message, context });
    if (!plan || !['answer', 'silence', 'create_watch', 'query_state', 'tool'].includes(plan.kind)) throw new Error('Agent returned invalid decision');
    let result = null;
    if (plan.kind === 'create_watch') result = this.createWatch({ ...plan.watch, roomId: plan.watch?.roomId || roomId, createdBy: userId, provenance: { origin: 'user_report', message } });
    if (plan.kind === 'query_state') result = roomId ? this.roomState(roomId) : null;
    if (plan.kind === 'tool') result = executeTool(this, plan.toolName, plan.input || {}, { allowWrite: false });
    const turn = { id: id(), userId, roomId, createdAt: this.now().toISOString(), message, decision: plan.kind, response: plan.response || null, result };
    this.store.put('conversations', turn);
    this.emitStored('AgentInvoked', turn);
    return turn;
  }

  async command(deviceId, type, payload = {}) {
    const device = this.store.get('devices', deviceId);
    if (!device) throw new Error('Unknown device');
    if (!SAFE_COMMANDS.has(type)) throw new Error('Command requires a separate reviewed action contract');
    if (!device.capabilities.includes(type)) throw new Error('Capability not announced');
    if (device.origin === 'simulator' && this.environment === 'production') throw new Error('Simulator disabled in production');
    const command = { id: id(), deviceId, type, payload, status: 'pending', createdAt: this.now().toISOString(), expiresAt: new Date(this.now().getTime() + 15_000).toISOString() };
    this.store.put('commands', command);
    return command;
  }

  acknowledgeCommand(deviceId, commandId, status) {
    const command = this.store.get('commands', commandId);
    if (!command || command.deviceId !== deviceId) throw new Error('Unknown command');
    if (command.status !== 'pending') return command;
    if (!['acknowledged', 'failed'].includes(status)) throw new Error('Invalid acknowledgement');
    command.status = status; command.completedAt = this.now().toISOString();
    this.store.put('commands', command);
    this.emitStored('CommandAcknowledged', command);
    return command;
  }

  pendingCommands(deviceId) {
    return this.store.all('commands').filter(item => item.deviceId === deviceId && item.status === 'pending' && Date.parse(item.expiresAt) > this.now().getTime());
  }

  expireCommands() {
    for (const command of this.store.all('commands')) {
      if (command.status !== 'pending' || Date.parse(command.expiresAt) > this.now().getTime()) continue;
      command.status = 'timed_out'; command.completedAt = this.now().toISOString();
      this.store.put('commands', command);
      this.emitStored('CommandTimedOut', command);
    }
  }

  async speakLocally(textToSpeak) {
    if (process.platform !== 'darwin') throw new Error('Local speech requires macOS');
    await execFileAsync('/usr/bin/say', [textToSpeak], { timeout: 30_000 });
  }

  async notifyLocally(message) {
    if (process.platform !== 'darwin') throw new Error('Local notification requires macOS');
    await execFileAsync('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Adam"', '-e', 'end run', message], { timeout: 15_000 });
  }
}

module.exports = { PhysicalRuntime, STATE_TTL_MS, STATE_KEYS };

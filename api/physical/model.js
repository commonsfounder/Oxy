'use strict';

const crypto = require('node:crypto');

const ORIGINS = new Set(['hardware', 'simulator', 'replay', 'software', 'external_service', 'user_report']);
const ENVIRONMENTS = new Set(['development', 'test', 'staging', 'production']);
const MAX_FUTURE_MS = 5 * 60 * 1000;

function id() { return crypto.randomUUID(); }
function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
  return date.toISOString();
}
function bounded(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${name} must be 0..1`);
  return number;
}
function text(value, name, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function canonicalObservation(input, { environment = 'development', now = new Date(), trustedOrigin } = {}) {
  const source = input?.source || {};
  const origin = trustedOrigin || source.origin;
  if (!ORIGINS.has(origin)) throw new Error('Invalid observation origin');
  if (!ENVIRONMENTS.has(environment)) throw new Error('Invalid environment');
  if (source.origin && source.origin !== origin) throw new Error('Origin mismatch');
  if (environment === 'production' && (origin === 'simulator' || origin === 'replay')) throw new Error('Simulated and replayed input is disabled in production');
  const timestamp = iso(input.timestamp || now);
  if (Date.parse(timestamp) > now.getTime() + MAX_FUTURE_MS) throw new Error('Observation timestamp is in the future');
  const value = input.value;
  let serializedValue;
  try { serializedValue = JSON.stringify(value); } catch { throw new Error('Invalid observation value'); }
  if (serializedValue === undefined || serializedValue.length > 8192) throw new Error('Invalid observation value');
  const observation = {
    id: id(), timestamp, receivedAt: now.toISOString(),
    type: text(input.type, 'observation type'), value,
    roomId: input.roomId ? text(input.roomId, 'room ID') : null,
    source: Object.freeze({
      deviceId: source.deviceId ? text(source.deviceId, 'device ID') : null,
      adapter: text(source.adapter || origin, 'adapter'), origin,
      environment, sensor: source.sensor ? text(source.sensor, 'sensor') : null
    }),
    confidence: bounded(input.confidence ?? 1, 'confidence'),
    trustLevel: origin === 'hardware' ? 'device_authenticated' : origin === 'user_report' ? 'user_reported' : 'untrusted',
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {}
  };
  if (JSON.stringify(observation).length > 16000) throw new Error('Observation too large');
  return Object.freeze(observation);
}

function currentState(state, now = new Date()) {
  if (!state) return null;
  const expired = state.expiresAt && Date.parse(state.expiresAt) <= now.getTime();
  return expired ? { ...state, value: 'unknown', stale: true, confidence: 0 } : { ...state, stale: false };
}

module.exports = { ORIGINS, ENVIRONMENTS, canonicalObservation, currentState, id, iso, text };

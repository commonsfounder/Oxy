'use strict';

// Pairing that starts on the device: the box asks for a short code and shows it on its screen,
// the person types that code into the app, and the box then collects its credentials with a secret
// only it holds. Nothing is typed on the box and no laptop is needed.
//
// Requests live in memory for ten minutes (production is one always-on machine); a restart just
// means asking for a new code. The pairing itself is created through the same challenge/redeem path
// as browser displays, so the device ends up as an ordinary paired display with its own token.

const crypto = require('node:crypto');

const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 500;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CLAIM_ATTEMPTS = 10;                                // per person per ten minutes
const STARTS_PER_SOURCE = 5;                              // per minute

const requests = new Map();  // requestId -> request
const byCode = new Map();    // code -> requestId
const claimAttempts = new Map();
const starts = new Map();

function pairingError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sameHash(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function makeCode(randomBytes) {
  const bytes = randomBytes(6);
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function sweep(now) {
  for (const [id, request] of requests) {
    if (request.expiresAt <= now) {
      requests.delete(id);
      if (byCode.get(request.code) === id) byCode.delete(request.code);
    }
  }
  for (const map of [claimAttempts, starts]) {
    for (const [key, entry] of map) if (entry.resetAt <= now) map.delete(key);
  }
}

function countAgainst(map, key, limit, windowMs, now, error) {
  const entry = map.get(key);
  if (!entry || entry.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (entry.count >= limit) throw error;
  entry.count += 1;
}

// Device: ask for a code. `source` is the caller's address, for rate limiting.
function startDevicePairing({ name, source = 'unknown', now = Date.now(), randomBytes = crypto.randomBytes } = {}) {
  sweep(now);
  countAgainst(starts, source, STARTS_PER_SOURCE, 60 * 1000, now, pairingError('too_fast', 'Too many pairing requests. Wait a minute.', 429));
  if (requests.size >= MAX_PENDING) throw pairingError('busy', 'Pairing is busy. Try again shortly.', 503);
  let code;
  do { code = makeCode(randomBytes); } while (byCode.has(code));
  const requestId = randomBytes(16).toString('hex');
  const pollSecret = randomBytes(24).toString('hex');
  const displayName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Adam device';
  requests.set(requestId, {
    requestId, code, displayName, pollSecretHash: hash(pollSecret), expiresAt: now + TTL_MS, claimed: null
  });
  byCode.set(code, requestId);
  return {
    requestId,
    code: `${code.slice(0, 3)} ${code.slice(3)}`,
    pollSecret,
    expiresAt: new Date(now + TTL_MS).toISOString(),
    pollSeconds: 3
  };
}

// App: the signed-in person typed the code shown on the device. createPairing(userId, displayName)
// makes the paired display and returns { display, token }.
async function claimDevicePairing({ userId, code, createPairing, now = Date.now() }) {
  if (!userId) throw pairingError('unauthorized', 'Sign in first.', 401);
  sweep(now);
  countAgainst(claimAttempts, userId, CLAIM_ATTEMPTS, TTL_MS, now, pairingError('too_fast', 'Too many tries. Wait a few minutes and ask the device for a new code.', 429));
  const requestId = byCode.get(normalizeCode(code));
  const request = requestId && requests.get(requestId);
  if (!request || request.expiresAt <= now) throw pairingError('invalid_code', 'That code is not valid. Check the device screen, or ask it for a new code.');
  if (request.claimed) throw pairingError('invalid_code', 'That code has already been used.');
  byCode.delete(request.code);
  request.claimed = { pending: true };
  try {
    const { display, token } = await createPairing(userId, request.displayName);
    request.claimed = { display, token, userId };
    return display;
  } catch (error) {
    request.claimed = null;
    byCode.set(request.code, request.requestId);
    throw error;
  }
}

// Device: has someone typed my code yet? The token is handed over once, then forgotten here.
function pollDevicePairing({ requestId, pollSecret, now = Date.now() }) {
  sweep(now);
  const request = requests.get(String(requestId || ''));
  if (!request || !pollSecret || !sameHash(request.pollSecretHash, hash(pollSecret))) {
    return { status: 'expired' };
  }
  if (!request.claimed || request.claimed.pending) return { status: 'pending' };
  requests.delete(request.requestId);
  return { status: 'paired', displayId: request.claimed.display.id, name: request.claimed.display.name, token: request.claimed.token };
}

function _reset() {
  requests.clear();
  byCode.clear();
  claimAttempts.clear();
  starts.clear();
}

module.exports = { TTL_MS, claimDevicePairing, pollDevicePairing, startDevicePairing, _reset };

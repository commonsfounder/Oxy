const crypto = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getSessionSecret() {
  return process.env.OXY_SESSION_SECRET || process.env.SESSION_SECRET || process.env.OXY_API_KEY || '';
}

function encodeBase64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signPayload(payload, expiresInMs = SESSION_TTL_MS) {
  const secret = getSessionSecret();
  if (!secret) throw new Error('Server auth is not configured.');

  const enrichedPayload = {
    ...payload,
    exp: Date.now() + expiresInMs
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(enrichedPayload));
  const sig = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${sig}`;
}

function verifySignedPayload(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [encodedPayload, sig] = token.split('.', 2);
  const secret = getSessionSecret();
  if (!secret) return null;

  const expectedSig = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function createSessionToken(userId) {
  return signPayload({ type: 'session', userId });
}

function getProvidedSessionToken(req) {
  const authHeader = req.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const headerToken = req.get('X-Session-Token');
  if (headerToken) return headerToken;

  if (typeof req.query?.authToken === 'string' && req.query.authToken) {
    return req.query.authToken;
  }

  return '';
}

function requireSessionAuth(req, res, next) {
  if (!getSessionSecret()) {
    return res.status(500).json({ error: 'Server auth is not configured.' });
  }

  const payload = verifySignedPayload(getProvidedSessionToken(req));
  if (!payload || payload.type !== 'session' || !payload.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.auth = { userId: payload.userId, exp: payload.exp };
  next();
}

function getAuthenticatedUserId(req) {
  return req.auth?.userId || null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) return false;
  const [salt, expectedHash] = storedHash.split(':', 2);
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  const actualBuf = Buffer.from(actualHash, 'hex');
  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

module.exports = {
  createSessionToken,
  getAuthenticatedUserId,
  getProvidedSessionToken,
  getSessionSecret,
  hashPassword,
  requireSessionAuth,
  signPayload,
  verifyPassword,
  verifySignedPayload
};

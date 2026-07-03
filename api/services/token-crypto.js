const crypto = require('crypto');

const KEY_ENV = 'OXY_TOKEN_ENCRYPTION_KEY';
const ALGORITHM = 'aes-256-gcm';
let warned = false;

function encryptionKey({ strict = false } = {}) {
  const raw = process.env[KEY_ENV];
  const isProd = process.env.NODE_ENV === 'production' || process.env.OXY_REQUIRE_TOKEN_KEY === 'true';
  if (!raw) {
    if (strict || isProd) {
      throw new Error(`FATAL: ${KEY_ENV} is required (32-byte hex) in production. Connector tokens cannot be handled in plaintext.`);
    }
    warnOnce(`${KEY_ENV} is not set; connector tokens will remain plaintext until configured.`);
    return null;
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    if (strict || isProd) {
      throw new Error(`FATAL: ${KEY_ENV} must be a 32-byte hex string.`);
    }
    warnOnce(`${KEY_ENV} must be a 32-byte hex string; connector tokens will remain plaintext.`);
    return null;
  }
  return key;
}

function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`[token-crypto] ${message}`);
}

function isEncryptedTokenEnvelope(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && value.encrypted === true
      && value.alg === ALGORITHM
      && value.iv
      && value.ciphertext
      && value.tag
  );
}

function encryptTokens(tokensObj = {}) {
  const key = encryptionKey();
  if (!key || isEncryptedTokenEnvelope(tokensObj)) return tokensObj;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(tokensObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: true,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decryptTokens(value = {}) {
  if (!isEncryptedTokenEnvelope(value)) return value || {};
  const key = encryptionKey({ strict: true });
  if (!key) throw new Error('Connector tokens are encrypted but OXY_TOKEN_ENCRYPTION_KEY is unavailable.');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

module.exports = {
  decryptTokens,
  encryptTokens,
  isEncryptedTokenEnvelope
};

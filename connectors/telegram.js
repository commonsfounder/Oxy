const crypto = require('crypto');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const { computeCheck } = require('telegram/Password');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('telegram connector bootstrap');

// SECURITY NOTE: The Telegram session string is sensitive — it grants full account access.
// It should be encrypted at rest. We use AES-256-GCM keyed from SESSION_ENCRYPTION_KEY.
// If the key is not set, the session is stored as-is and a warning is logged once.
let _sessionEncryptionWarnedOnce = false;

function encryptSession(plaintext) {
  const key = process.env.SESSION_ENCRYPTION_KEY;
  if (!key) {
    if (!_sessionEncryptionWarnedOnce) {
      console.warn('[telegram] WARNING: SESSION_ENCRYPTION_KEY is not set. Telegram session stored as plaintext. Set this env var to encrypt sessions at rest.');
      _sessionEncryptionWarnedOnce = true;
    }
    return plaintext;
  }
  const keyBuf = Buffer.from(key, 'hex').slice(0, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSession(stored) {
  if (!stored || !stored.startsWith('enc:')) return stored;
  const key = process.env.SESSION_ENCRYPTION_KEY;
  if (!key) {
    console.warn('[telegram] WARNING: SESSION_ENCRYPTION_KEY is not set but an encrypted session was found. Cannot decrypt.');
    return '';
  }
  try {
    const parts = stored.slice(4).split(':');
    if (parts.length !== 3) return stored;
    const [ivHex, authTagHex, encryptedHex] = parts;
    const keyBuf = Buffer.from(key, 'hex').slice(0, 32);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encryptedBuf = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encryptedBuf).toString('utf8') + decipher.final('utf8');
  } catch (err) {
    console.error('[telegram] Failed to decrypt session:', err.message);
    return '';
  }
}

const SUPPORTED_ACTIONS = ['send_telegram', 'get_telegram_contacts'];

function credentials() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH env vars are not set');
  return { apiId, apiHash };
}

async function getStoredTokens(userId) {
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'telegram')
      .limit(1);
    if (!error && data?.length > 0) return data[0].tokens || {};
  } catch (err) {
    console.error('[telegram] getStoredTokens error:', err.message);
  }
  return {};
}

async function saveStoredTokens(userId, tokens) {
  await supabase
    .from('connectors')
    .upsert(
      { user_id: userId, connector_id: 'telegram', enabled: true, tokens, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,connector_id' }
    );
}

async function buildClient(sessionString) {
  const { apiId, apiHash } = credentials();
  const client = new TelegramClient(
    new StringSession(sessionString || ''),
    apiId,
    apiHash,
    { connectionRetries: 3, requestRetries: 3 }
  );
  await client.connect();
  return client;
}

// ── Auth flow ─────────────────────────────────────────────────────────────────

async function startAuth(userId, phone) {
  const { apiId, apiHash } = credentials();
  const client = await buildClient('');
  try {
    const result = await client.sendCode({ apiId, apiHash }, phone);
    const partialSession = encryptSession(client.session.save());
    await saveStoredTokens(userId, {
      pendingAuth: { phone, phoneCodeHash: result.phoneCodeHash, partialSession }
    });
    return { success: true, message: 'Code sent to your Telegram' };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function verifyCode(userId, code) {
  const tokens = await getStoredTokens(userId);
  const { phone, phoneCodeHash, partialSession } = tokens.pendingAuth || {};
  if (!phone || !phoneCodeHash) throw new Error('No pending auth — call startAuth first');

  const { apiId, apiHash } = credentials();
  const client = await buildClient(decryptSession(partialSession));
  try {
    await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
    const session = encryptSession(client.session.save());
    await saveStoredTokens(userId, { session });
    return { success: true, requires2FA: false };
  } catch (err) {
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      // Save session mid-flow so 2FA step can resume it
      const partialSession2FA = encryptSession(client.session.save());
      await saveStoredTokens(userId, { pendingAuth: { ...tokens.pendingAuth, partialSession: partialSession2FA, needs2FA: true } });
      return { success: true, requires2FA: true };
    }
    throw err;
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function verify2FA(userId, password) {
  const tokens = await getStoredTokens(userId);
  const { partialSession } = tokens.pendingAuth || {};
  if (!partialSession) throw new Error('No pending 2FA session — restart auth');

  const client = await buildClient(decryptSession(partialSession));
  try {
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    const passwordCheck = await computeCheck(passwordInfo, password);
    await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
    const session = encryptSession(client.session.save());
    await saveStoredTokens(userId, { session });
    return { success: true };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function execute(userId, action, params) {
  const tokens = await getStoredTokens(userId);
  if (!tokens.session) {
    return { success: false, error: 'Telegram not connected. Authenticate via /auth/telegram/start' };
  }

  let client;
  try {
    client = await buildClient(decryptSession(tokens.session));

    switch (action) {
      case 'send_telegram': {
        const { contact, message } = params;
        if (!contact || !message) return { success: false, error: 'send_telegram requires contact and message' };

        const result = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) }));
        const match = result.users.find(u => {
          const fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim().toLowerCase();
          const username = (u.username || '').toLowerCase();
          const search = contact.toLowerCase();
          return fullName.includes(search) || username === search || username.includes(search);
        });

        if (!match) return { success: false, error: `Contact "${contact}" not found in your Telegram` };

        await client.sendMessage(match, { message });
        const name = `${match.firstName || ''} ${match.lastName || ''}`.trim();
        return { success: true, text: `Telegram message sent to ${name}` };
      }

      case 'get_telegram_contacts': {
        const result = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) }));
        const contacts = result.users.map(u => ({
          id: u.id.toString(),
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          username: u.username || null
        }));
        return { success: true, contacts, text: `Found ${contacts.length} Telegram contacts` };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: `Telegram error: ${err.message}` };
  } finally {
    if (client) await client.disconnect().catch(() => {});
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, startAuth, verifyCode, verify2FA };

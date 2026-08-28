#!/usr/bin/env node

// Hand Oxy the login you already have in Chrome, for ONE site, so the agent arrives signed in
// instead of as the brand-new visitor bot detection is built to catch — without ever learning
// the password, since it never signs in.
//
//   node scripts/import-chrome-session.js <site> [--api <url>] [--dry-run]
//
// Runs entirely on your machine: reads Chrome's cookie store, keeps only the named site's
// cookies, posts them to your own server. Never prints a cookie value; --dry-run posts nothing.
// Requires OXY_API_TOKEN and, on macOS, Keychain access to the "Chrome Safe Storage" key.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { prepareImportedSession, isSensitiveSite, normalizeSite } = require('../api/services/session-import');

const CHROME_EPOCH_OFFSET_SECONDS = 11644473600; // Chrome counts from 1601, Unix from 1970

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { site: null, api: process.env.OXY_API_URL || 'https://milgrain-live-2026.fly.dev', dryRun: false, profile: 'Default' };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--api') args.api = argv[++i];
    else if (value === '--profile') args.profile = argv[++i];
    else if (!args.site) args.site = value;
  }
  return args;
}

function chromeCookieDbPath(profile) {
  if (process.platform !== 'darwin') {
    fail('This helper currently supports macOS Chrome only.');
  }
  const base = path.join(os.homedir(), 'Library/Application Support/Google/Chrome', profile);
  for (const candidate of [path.join(base, 'Cookies'), path.join(base, 'Network/Cookies')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  fail(`Could not find Chrome's cookie store for profile "${profile}".`);
}

/** Chrome encrypts cookie values with a key derived from a Keychain secret. */
function chromeDecryptionKey() {
  let secret;
  try {
    secret = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], { encoding: 'utf8' }).trim();
  } catch {
    fail('Could not read the "Chrome Safe Storage" key from your Keychain. Approve the prompt and try again.');
  }
  return crypto.pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
}

function decryptCookieValue(encrypted, key) {
  if (!encrypted || encrypted.length === 0) return '';
  const prefix = encrypted.slice(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return encrypted.toString('utf8');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  decipher.setAutoPadding(false);
  let out = Buffer.concat([decipher.update(encrypted.slice(3)), decipher.final()]);
  // Strip PKCS#7 padding manually, since auto-padding is off.
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.slice(0, out.length - pad);
  // Chrome 127+ prepends a 32-byte SHA256 of the domain to the plaintext.
  const text = out.toString('utf8');
  return text.length > 32 && !/^[\x20-\x7e]*$/.test(text.slice(0, 32)) ? out.slice(32).toString('utf8') : text;
}

async function readCookies(dbPath, site, key) {
  let sqlite;
  try {
    ({ DatabaseSync: sqlite } = require('node:sqlite'));
  } catch {
    fail('This helper needs Node 22+ for its built-in SQLite support.');
  }

  // Chrome holds a lock on the live file, so work on a copy.
  const copy = path.join(os.tmpdir(), `oxy-cookies-${Date.now()}.sqlite`);
  fs.copyFileSync(dbPath, copy);
  try {
    const db = new sqlite(copy, { readOnly: true });
    const rows = db.prepare(
      `select host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
         from cookies
        where host_key = ? or host_key = ? or host_key like ?`
    ).all(site, `.${site}`, `%.${site}`);
    db.close();

    const sameSiteName = value => (value === 0 ? 'None' : value === 1 ? 'Lax' : value === 2 ? 'Strict' : 'Lax');
    return rows.map(row => ({
      name: row.name,
      value: decryptCookieValue(Buffer.from(row.encrypted_value), key),
      domain: row.host_key,
      path: row.path || '/',
      expires: row.expires_utc ? Math.floor(Number(row.expires_utc) / 1e6) - CHROME_EPOCH_OFFSET_SECONDS : -1,
      httpOnly: Boolean(row.is_httponly),
      secure: Boolean(row.is_secure),
      sameSite: sameSiteName(row.samesite)
    }));
  } finally {
    fs.rmSync(copy, { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.site) fail('Usage: node scripts/import-chrome-session.js <site> [--dry-run]');

  const site = normalizeSite(args.site);
  // Refused here as well as on the server, so a mistake never even reads those cookies.
  if (isSensitiveSite(site)) fail(`Sessions for ${site} cannot be imported. Sign in there yourself.`);

  const key = chromeDecryptionKey();
  const raw = await readCookies(chromeCookieDbPath(args.profile), site, key);
  if (!raw.length) fail(`Chrome has no cookies for ${site}. Sign in there in Chrome first, then re-run this.`);

  const prepared = prepareImportedSession({ site, cookies: raw });
  if (!prepared.ok) fail(prepared.error);

  // Names only. A cookie value printed to a terminal is a credential in your scrollback.
  console.log(`\n${site}: ${prepared.state.cookies.length} cookies ready (${prepared.dropped} not for this site, dropped)`);
  console.log(`  ${prepared.state.cookies.map(c => c.name).join(', ')}`);
  console.log(`  expires ${new Date(prepared.expiresAt).toISOString()}`);

  if (args.dryRun) {
    console.log('\n--dry-run: nothing was sent.\n');
    return;
  }

  const token = process.env.OXY_API_TOKEN;
  if (!token) fail('Set OXY_API_TOKEN to your session token to send this.');

  const response = await fetch(`${args.api.replace(/\/+$/, '')}/vault/browser-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ site, cookies: prepared.state.cookies, origins: prepared.state.origins })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(`Import failed (HTTP ${response.status}): ${body.error || 'unknown error'}`);
  console.log(`\nImported. Oxy now has your ${body.site} session (${body.cookiesStored} cookies), until ${body.expiresAt}.\n`);
}

main().catch(error => fail(error.message));

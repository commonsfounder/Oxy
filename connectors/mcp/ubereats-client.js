// Per-user MCP stdio client for the @striderlabs/mcp-ubereats server.
//
// Each Oxy user gets their OWN Uber Eats session. The server stores its login
// cookies at `homedir()/.strider/ubereats/cookies.json`, and Node's
// os.homedir() honors $HOME on POSIX — so we launch a separate server process
// per user with its own HOME directory. That isolates logins, carts, and
// orders between users. The server mkdir's its own config dir, so we only need
// to point HOME at a writable per-user folder.
//
// Each process runs a headless browser, so they are spawned lazily on first use
// and torn down after an idle period to bound resource usage.
//
// The @modelcontextprotocol/sdk package is ESM-only; this file is CommonJS, so
// the SDK is pulled in with dynamic import() inside openClient().

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// Prefer the locally-installed server (pinned version → matching Playwright
// browser revision). Fall back to npx if it isn't installed.
const LOCAL_SERVER_ENTRY = (() => {
  try {
    const pkgJson = require.resolve('@striderlabs/mcp-ubereats/package.json');
    return path.join(path.dirname(pkgJson), 'dist', 'index.js');
  } catch {
    return null;
  }
})();

const SERVER_COMMAND = process.env.UBEREATS_MCP_COMMAND
  || (LOCAL_SERVER_ENTRY ? process.execPath : 'npx');
const SERVER_ARGS = process.env.UBEREATS_MCP_ARGS
  ? process.env.UBEREATS_MCP_ARGS.split(' ').filter(Boolean)
  : (LOCAL_SERVER_ENTRY ? [LOCAL_SERVER_ENTRY] : ['-y', '@striderlabs/mcp-ubereats']);

// Where each user's isolated session HOME lives. Persisted across restarts so
// logins survive — do NOT default to a temp dir.
const SESSIONS_ROOT = process.env.UBEREATS_SESSIONS_DIR
  || path.join(os.homedir(), '.oxy', 'ubereats-sessions');

// Playwright browser download — SHARED across all users (one ~400MB install,
// not one per user). Computed from the real host home, before any HOME override.
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
  || path.join(os.homedir(), '.oxy', 'ms-playwright');

// Tear down a user's server process after this much idle time.
const IDLE_MS = Number(process.env.UBEREATS_MCP_IDLE_MS) || 15 * 60 * 1000;

// userKey -> { clientPromise, transport, timer }
const sessions = new Map();

// Hash the userId into a filesystem-safe directory name (avoids path traversal
// and odd characters in user identifiers).
function userKey(userId) {
  return crypto.createHash('sha256').update(String(userId || 'default')).digest('hex').slice(0, 32);
}

function sessionHome(key) {
  const dir = path.join(SESSIONS_ROOT, key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function closeSession(key) {
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  try {
    if (entry.transport) await entry.transport.close();
  } catch {
    /* already gone */
  }
}

function touch(key) {
  const entry = sessions.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => closeSession(key), IDLE_MS);
  if (entry.timer.unref) entry.timer.unref();
}

async function openClient(key) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const home = sessionHome(key);
  const transport = new StdioClientTransport({
    command: SERVER_COMMAND,
    args: SERVER_ARGS,
    env: {
      ...process.env,
      // Isolate this user's Uber Eats session (cookies) via HOME / USERPROFILE.
      HOME: home,
      USERPROFILE: home,
      // ...but share one Playwright browser install across all users.
      PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH
    }
  });

  const client = new Client({ name: 'oxy-ubereats', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const entry = sessions.get(key);
  if (entry) entry.transport = transport;

  // If the process dies, drop the session so the next call respawns it.
  const drop = () => closeSession(key);
  transport.onclose = drop;
  transport.onerror = drop;

  return client;
}

function getClient(key) {
  let entry = sessions.get(key);
  if (!entry) {
    entry = { clientPromise: null, transport: null, timer: null };
    sessions.set(key, entry);
    entry.clientPromise = openClient(key).catch(err => {
      sessions.delete(key);
      throw err;
    });
  }
  return entry.clientPromise;
}

function extractText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();
}

// The exact cookies.json path the per-user headless server reads/writes. Used
// by scripts/ubereats-login.js to seed a session into the right place.
function cookiesPathForUser(userId) {
  return path.join(SESSIONS_ROOT, userKey(userId), '.strider', 'ubereats', 'cookies.json');
}

// Call a tool on the given user's server. Returns { text, isError, raw }.
// Throws only on a transport/connection failure — tool-level errors come back
// as isError.
async function callTool(userId, name, args = {}) {
  const key = userKey(userId);
  const client = await getClient(key);
  touch(key);
  const result = await client.callTool({ name, arguments: args });
  return {
    text: extractText(result),
    isError: Boolean(result?.isError),
    raw: result
  };
}

module.exports = { callTool, cookiesPathForUser, BROWSERS_PATH };

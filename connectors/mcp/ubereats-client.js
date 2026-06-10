// Per-user MCP stdio client for the @striderlabs/mcp-ubereats server, with
// Supabase-backed sessions so it works on serverless hosts (Cloud Run).
//
// The server stores its Uber Eats login as cookies on disk at
// `homedir()/.strider/ubereats/cookies.json`. On Cloud Run that disk is
// ephemeral, so the DB is the source of truth:
//   • before a user's server starts, we HYDRATE their cookies from Supabase
//     onto disk, so the server loads them;
//   • after every call, we PERSIST the on-disk cookies back to Supabase.
// If Supabase isn't configured (e.g. local CLI testing) it degrades to
// disk-only — same behaviour as before.
//
// Each user gets an isolated HOME so concurrent sessions don't collide, and the
// Playwright browser binary is shared across users via PLAYWRIGHT_BROWSERS_PATH.
//
// The @modelcontextprotocol/sdk package is ESM-only; this file is CommonJS, so
// the SDK is loaded via dynamic import() inside openClient().

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

// Per-user session HOME (scratch on serverless; the DB is the durable copy).
const SESSIONS_ROOT = process.env.UBEREATS_SESSIONS_DIR
  || path.join(os.homedir(), '.oxy', 'ubereats-sessions');

// Playwright browser download — SHARED across users (one install, not per user).
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
  || path.join(os.homedir(), '.oxy', 'ms-playwright');

// Tear down a user's server process after this much idle time.
const IDLE_MS = Number(process.env.UBEREATS_MCP_IDLE_MS) || 15 * 60 * 1000;

const SESSION_TABLE = 'ubereats_sessions';

// ── Supabase (lazy; null if unavailable) ─────────────────────────────────────
let supabaseClient; // undefined = not tried, null = unavailable
function getSupabase() {
  if (supabaseClient !== undefined) return supabaseClient;
  try {
    const { createSupabaseServiceClient } = require('../../runtime');
    supabaseClient = createSupabaseServiceClient();
  } catch {
    supabaseClient = null;
  }
  return supabaseClient;
}

// ── Disk helpers ─────────────────────────────────────────────────────────────
function userKey(userId) {
  return crypto.createHash('sha256').update(String(userId || 'default')).digest('hex').slice(0, 32);
}

function sessionHome(key) {
  const dir = path.join(SESSIONS_ROOT, key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The exact cookies.json path the per-user server reads/writes.
function cookiesPathForUser(userId) {
  return path.join(SESSIONS_ROOT, userKey(userId), '.strider', 'ubereats', 'cookies.json');
}

function readDiskCookies(userId) {
  try {
    const arr = JSON.parse(fs.readFileSync(cookiesPathForUser(userId), 'utf-8'));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function writeDiskCookies(userId, cookies) {
  const file = cookiesPathForUser(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cookies, null, 2));
}

// ── DB <-> disk session sync ─────────────────────────────────────────────────
async function hydrateFromDB(userId) {
  const db = getSupabase();
  if (!db) return;
  try {
    const { data } = await db
      .from(SESSION_TABLE)
      .select('cookies')
      .eq('user_id', String(userId))
      .maybeSingle();
    if (Array.isArray(data?.cookies) && data.cookies.length) {
      writeDiskCookies(userId, data.cookies);
    }
  } catch (e) {
    console.warn('[ubereats] hydrateFromDB failed:', e.message);
  }
}

// Save the on-disk cookies back to the DB. Returns true if persisted.
async function persistToDB(userId) {
  const db = getSupabase();
  if (!db) return false;
  const cookies = readDiskCookies(userId);
  if (!cookies || !cookies.length) return false;
  try {
    const { error } = await db.from(SESSION_TABLE).upsert(
      { user_id: String(userId), cookies, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    return !error;
  } catch (e) {
    console.warn('[ubereats] persistToDB failed:', e.message);
    return false;
  }
}

// Used by scripts/ubereats-login.js: write a freshly-captured session to disk
// AND the DB. Returns true if it reached the DB.
async function seedSessionToDB(userId, cookies) {
  writeDiskCookies(userId, cookies);
  return persistToDB(userId);
}

// ── Per-user MCP process management ───────────────────────────────────────────
const sessions = new Map(); // key -> { clientPromise, transport, timer }

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
      // Isolate this user's session (cookies) via HOME / USERPROFILE...
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

  const drop = () => closeSession(key);
  transport.onclose = drop;
  transport.onerror = drop;

  return client;
}

// Hydrate the user's session from the DB, THEN start their server so it loads
// those cookies on first use.
function getClient(userId) {
  const key = userKey(userId);
  let entry = sessions.get(key);
  if (!entry) {
    entry = { clientPromise: null, transport: null, timer: null };
    sessions.set(key, entry);
    entry.clientPromise = hydrateFromDB(userId)
      .then(() => openClient(key))
      .catch(err => { sessions.delete(key); throw err; });
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

// Call a tool on the given user's server. Returns { text, isError, raw }.
async function callTool(userId, name, args = {}) {
  const client = await getClient(userId);
  touch(userKey(userId));
  const result = await client.callTool({ name, arguments: args });
  // Capture any session change (login refresh, etc.) durably.
  await persistToDB(userId);
  return {
    text: extractText(result),
    isError: Boolean(result?.isError),
    raw: result
  };
}

module.exports = { callTool, cookiesPathForUser, BROWSERS_PATH, seedSessionToDB };

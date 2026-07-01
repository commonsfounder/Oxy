'use strict';
/*
 * Latency baseline harness.
 *
 * Spawns the real server, fires a fixed set of /chat messages through it with a
 * self-minted session token, and records two things per request:
 *   - client TTFT  : wall time until the first `text` SSE chunk arrives
 *   - server marks : parsed from the existing [trace:...] stdout —
 *       preamble_ms  = time from request start to BEGIN buildChatContext
 *                      (the serial pending-state DB reads we want to cut)
 *       context_ms   = buildChatContext duration (parallel context load)
 *       ttft_ms      = gemini.first_token timestamp (server-side TTFT)
 *       model_ttft   = ttft_ms - (preamble_ms + context_ms)  ≈ the part we DON'T control
 *
 * Run:  node test/bench/latency.js
 * Needs a .env at repo root with SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY,
 * OXY_SESSION_SECRET (the same vars server.js requires).
 *
 * Writes test/bench/baseline-<timestamp>.json and prints a table. Run it before
 * and after a change; compare the medians. Fixed inputs => the delta is real.
 */

const path = require('path');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createSessionToken } = require(path.join(__dirname, '..', '..', 'auth.js'));

const PORT = Number(process.env.BENCH_PORT) || 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const RUNS = Number(process.env.BENCH_RUNS) || 3; // runs per message; run 1 warms caches
// Which brain to benchmark. `BENCH_PROVIDER=groq npm run latency` routes the
// spawned server's main generate to Groq (needs GROQ_API_KEY + OXY_GROQ_MODEL).
const PROVIDER = (process.env.BENCH_PROVIDER || 'gemini').toLowerCase();

// A deliberately mixed set: a quick-turn (fast path), a factual/search turn,
// a personal/memory turn, and a calendar-ish turn. Fixed forever so numbers compare.
const MESSAGES = [
  { tag: 'quickturn', text: 'thanks' },
  { tag: 'factual', text: "what's the weather in London this weekend" },
  { tag: 'personal', text: 'what did I say about my exams' },
  { tag: 'calendar', text: "what's on my calendar today" },
];

const required = ['SUPABASE_URL', 'SUPABASE_KEY', 'GEMINI_API_KEY', 'OXY_SESSION_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\nMissing env vars: ${missing.join(', ')}`);
  console.error('Add them to a .env at the repo root, then re-run.\n');
  process.exit(1);
}

let stdoutBuf = '';

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', OXY_BRAIN_PROVIDER: PROVIDER },
    });
    const onData = (d) => {
      const s = d.toString();
      stdoutBuf += s;
      if (s.includes('Oxy listening')) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { stdoutBuf += d.toString(); });
    child.on('exit', (code) => reject(new Error(`server exited early (code ${code})`)));
    setTimeout(() => reject(new Error('server did not start within 30s')), 30000);
  });
}

async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('health check never passed');
}

// Fire one /chat streaming request; return client-side timings.
async function oneRequest(userId, message) {
  const token = createSessionToken(userId);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat?stream=true&tts=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, userId }),
  });
  if (!res.ok) throw new Error(`/chat ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let firstText = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        const obj = JSON.parse(line.slice(6));
        if (obj.type === 'text' && firstText === null) firstText = Date.now() - t0;
      } catch { /* ignore non-JSON frames */ }
    }
  }
  return { client_ttft_ms: firstText, client_total_ms: Date.now() - t0 };
}

// Pull the server-side trace marks for a given userId out of captured stdout.
function serverMarks(userId) {
  const lines = stdoutBuf.split('\n').filter((l) => l.includes(`:${userId}:`));
  const find = (re) => {
    for (const l of lines) { const m = l.match(re); if (m) return Number(m[1]); }
    return null;
  };
  const preamble = find(/\+(\d+)ms BEGIN buildChatContext/);
  const ctxDur = find(/END buildChatContext \((\d+)ms\)/);
  const ttft = find(/\+(\d+)ms gemini\.first_token/);
  const model_ttft = ttft != null && preamble != null && ctxDur != null
    ? ttft - preamble - ctxDur : null;
  return { preamble_ms: preamble, context_ms: ctxDur, server_ttft_ms: ttft, model_ttft_ms: model_ttft };
}

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};

async function main() {
  console.log(`Starting server on :${PORT} (brain=${PROVIDER}) ...`);
  const child = await startServer();
  try {
    await waitHealthy();
    console.log(`Server up. Firing ${MESSAGES.length} messages x ${RUNS} runs.\n`);
    const rows = [];
    for (const msg of MESSAGES) {
      for (let run = 0; run < RUNS; run++) {
        const userId = `bench-${msg.tag}-${run}`;
        let client;
        try {
          client = await oneRequest(userId, msg.text);
        } catch (e) {
          console.warn(`  ${msg.tag} run${run}: ERROR ${e.message}`);
          continue;
        }
        await new Promise((r) => setTimeout(r, 150)); // let trace lines flush
        const marks = serverMarks(userId);
        rows.push({ tag: msg.tag, run, ...client, ...marks });
        console.log(
          `  ${msg.tag.padEnd(9)} run${run}  ` +
          `client_ttft=${String(client.client_ttft_ms).padStart(5)}ms  ` +
          `preamble=${String(marks.preamble_ms).padStart(4)}ms  ` +
          `context=${String(marks.context_ms).padStart(4)}ms  ` +
          `model_ttft=${String(marks.model_ttft_ms).padStart(5)}ms`,
        );
      }
    }

    console.log('\n=== MEDIANS (excluding warm-up run 0) ===');
    const warm = rows.filter((r) => r.run > 0);
    const summary = {};
    for (const msg of MESSAGES) {
      const g = warm.filter((r) => r.tag === msg.tag);
      summary[msg.tag] = {
        preamble_ms: median(g.map((r) => r.preamble_ms)),
        context_ms: median(g.map((r) => r.context_ms)),
        model_ttft_ms: median(g.map((r) => r.model_ttft_ms)),
        client_ttft_ms: median(g.map((r) => r.client_ttft_ms)),
      };
      const s = summary[msg.tag];
      console.log(
        `  ${msg.tag.padEnd(9)}  preamble=${String(s.preamble_ms).padStart(4)}ms  ` +
        `context=${String(s.context_ms).padStart(4)}ms  ` +
        `model_ttft=${String(s.model_ttft_ms).padStart(5)}ms  ` +
        `client_ttft=${String(s.client_ttft_ms).padStart(5)}ms`,
      );
    }
    const overallPreamble = median(warm.map((r) => r.preamble_ms));
    console.log(`\n  >> controllable overhead (preamble) median across all turns: ${overallPreamble}ms`);

    const out = path.join(__dirname, `baseline-${PROVIDER}-${Date.now()}.json`);
    require('fs').writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), provider: PROVIDER, rows, summary }, null, 2));
    console.log(`\nWrote ${path.relative(process.cwd(), out)}`);
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

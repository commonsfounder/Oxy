'use strict';

// Capability stress run: throw the real-user corpus at a live deployment, concurrently, and
// score three things separately — how FAST it answers, whether it REACHED the right capability,
// and what the capability actually returned. The task matrix scores the last one only, one turn
// at a time, so it cannot show latency or what happens under parallel load.
//
// Usage:
//   node test/dev/capability-stress.js                          # 42 read-only tasks, 4 in flight
//   node test/dev/capability-stress.js --concurrency=8
//   node test/dev/capability-stress.js --group=public-read --limit=10
//   BASE_URL=http://localhost:3000 node test/dev/capability-stress.js
//
// Read-only by default. Modes that write to the account or reach a send boundary need an
// explicit --allow-writes, because this points at a real deployment and a real user row.

require('dotenv').config();
const path = require('path');
const { createSessionToken } = require(path.join(__dirname, '..', '..', 'auth'));
const { TASKS, selectTasks, classify } = require('./real-user-task-matrix');

const BASE = (process.env.BASE_URL || process.env.OXY_STRESS_API_URL || 'https://milgrain-live-2026.fly.dev').replace(/\/+$/, '');
const USER = process.env.OXY_STRESS_USER || process.env.SMOKE_USER || 'user123';
const TURN_TIMEOUT_MS = Number(process.env.OXY_STRESS_TURN_TIMEOUT_MS || 120000);
// /chat allows 30 turns per minute per user. Exceeding it measures the limiter, not the agent,
// so the runner paces itself under the cap and retries a 429 rather than scoring it.
const DEFAULT_RATE_PER_MIN = Number(process.env.OXY_STRESS_RATE_PER_MIN || 25);

// A status that means the runtime did its job. `setup_blocked` is a truthful "this account has
// no such connector", which is a correct answer, not a capability failure.
const HEALTHY = new Set(['completed', 'setup_blocked', 'handoff_required', 'approval_boundary', 'browser_boundary', 'setup_or_handoff']);

function parseArgs(argv = process.argv.slice(2)) {
  const options = { groups: [], modes: [], ids: [], limit: 0, concurrency: 4, allowWrites: false, ratePerMin: DEFAULT_RATE_PER_MIN };
  for (const arg of argv) {
    const [key, value = ''] = arg.split('=', 2);
    if (key === '--group') options.groups.push(...value.split(',').filter(Boolean));
    if (key === '--mode') options.modes.push(...value.split(',').filter(Boolean));
    if (key === '--id') options.ids.push(...value.split(',').filter(Boolean));
    if (key === '--limit') options.limit = Number(value) || 0;
    if (key === '--concurrency') options.concurrency = Math.max(1, Number(value) || 1);
    if (key === '--rate') options.ratePerMin = Math.max(1, Number(value) || DEFAULT_RATE_PER_MIN);
    if (arg === '--allow-writes') options.allowWrites = true;
  }
  if (!options.modes.length && !options.ids.length) options.modes = ['safe'];
  return options;
}

// Spaces request STARTS so throughput stays under the server's per-minute cap.
function createPacer(ratePerMin) {
  const gapMs = Math.ceil(60000 / ratePerMin);
  let nextAt = 0;
  return async function pace() {
    const now = Date.now();
    const startAt = Math.max(now, nextAt);
    nextAt = startAt + gapMs;
    if (startAt > now) await new Promise((resolve) => setTimeout(resolve, startAt - now));
  };
}

async function runTask(token, task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: USER, message: task.message }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    const ms = Date.now() - startedAt;
    if (response.status === 429) {
      return { id: task.id, group: task.group, expectedAction: task.expectedAction, ms, status: 'rate_limited', routed: false, error: body.error || 'HTTP 429' };
    }
    if (!response.ok) {
      return { id: task.id, group: task.group, expectedAction: task.expectedAction, ms, status: 'http_error', routed: false, error: body.error || `HTTP ${response.status}` };
    }
    const { status, receipts } = classify(task, body);
    const routed = (receipts || []).some((receipt) => receipt.action === task.expectedAction);
    const detail = (receipts || []).map((r) => r.action).join(',') || '(no actions)';
    return { id: task.id, group: task.group, expectedAction: task.expectedAction, ms, status, routed, actions: detail };
  } catch (error) {
    return {
      id: task.id, group: task.group, expectedAction: task.expectedAction,
      ms: Date.now() - startedAt, routed: false,
      status: error.name === 'AbortError' ? 'timeout' : 'transport_error',
      error: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Fixed-size worker pool: every worker pulls the next task, so a slow turn does not idle the rest.
async function runPool(token, tasks, concurrency, ratePerMin = DEFAULT_RATE_PER_MIN) {
  const queue = [...tasks];
  const results = [];
  const pace = createPacer(ratePerMin);
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      await pace();
      let result = await runTask(token, task);
      // A 429 is the limiter, not an answer. Wait out the window once and ask again.
      if (result.status === 'rate_limited') {
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.OXY_STRESS_RETRY_MS || 62000)));
        await pace();
        result = await runTask(token, task);
      }
      results.push(result);
      const flag = result.routed ? ' ' : '?';
      console.log(`${flag} ${String(result.ms).padStart(6)}ms  ${result.status.padEnd(16)} ${result.id}  → ${result.actions || result.error || ''}`);
    }
  });
  await Promise.all(workers);
  return results;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(results, wallMs, concurrency) {
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const routed = results.filter((r) => r.routed).length;
  const healthy = results.filter((r) => HEALTHY.has(r.status)).length;
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  const pct = (n) => `${((n / results.length) * 100).toFixed(1)}%`;
  console.log(`\n${'='.repeat(72)}`);
  console.log(`CAPABILITY STRESS — ${BASE}`);
  console.log(`${results.length} tasks, ${concurrency} in flight, ${(wallMs / 1000).toFixed(1)}s wall\n`);
  console.log(`SMART    routed to the expected capability   ${routed}/${results.length}  ${pct(routed)}`);
  console.log(`CAPABLE  capability answered truthfully      ${healthy}/${results.length}  ${pct(healthy)}`);
  console.log(`FAST     p50 ${percentile(latencies, 50)}ms   p90 ${percentile(latencies, 90)}ms   p95 ${percentile(latencies, 95)}ms   max ${latencies[latencies.length - 1]}ms`);
  console.log(`\nstatus breakdown: ${JSON.stringify(byStatus)}`);

  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log(`\nslowest 5:`);
  for (const r of slowest) console.log(`  ${String(r.ms).padStart(6)}ms  ${r.id} (${r.status})`);

  const misrouted = results.filter((r) => !r.routed);
  if (misrouted.length) {
    console.log(`\nnot routed to the expected capability (${misrouted.length}):`);
    for (const r of misrouted) console.log(`  ${r.id.padEnd(20)} wanted ${r.expectedAction.padEnd(26)} got ${r.actions || r.error || '(nothing)'}`);
  }
  return { routed, healthy, total: results.length };
}

async function main() {
  const options = parseArgs();
  const tasks = selectTasks(options);
  const unsafe = tasks.filter((task) => task.mode !== 'safe');
  if (unsafe.length && !options.allowWrites) {
    console.error(`Refusing to run ${unsafe.length} task(s) that write to the account or reach a send boundary.`);
    console.error(`Modes present: ${[...new Set(unsafe.map((t) => t.mode))].join(', ')}. Re-run with --allow-writes if that is intended.`);
    process.exit(2);
  }
  if (!tasks.length) {
    console.error(`No tasks selected. Corpus has ${TASKS.length}.`);
    process.exit(2);
  }

  const token = createSessionToken(USER);
  console.log(`${tasks.length} tasks against ${BASE} as ${USER}, concurrency ${options.concurrency}, paced to ${options.ratePerMin}/min\n`);
  const startedAt = Date.now();
  const results = await runPool(token, tasks, options.concurrency, options.ratePerMin);
  const summary = report(results, Date.now() - startedAt, options.concurrency);
  process.exit(summary.healthy === summary.total ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runTask, runPool, HEALTHY };

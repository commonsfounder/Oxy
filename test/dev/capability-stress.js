'use strict';

require('dotenv').config();
const path = require('path');
const { createSessionToken } = require(path.join(__dirname, '..', '..', 'auth'));
const { TASKS, selectTasks, classify } = require('./real-user-task-matrix');

const BASE = (process.env.BASE_URL || process.env.OXY_STRESS_API_URL || 'https://milgrain-live-2026.fly.dev').replace(/\/+$/, '');
const USER = process.env.OXY_STRESS_USER || process.env.SMOKE_USER || 'user123';
const TURN_TIMEOUT_MS = Number(process.env.OXY_STRESS_TURN_TIMEOUT_MS || 120000);
// /chat caps a user at 30/min; staying under it measures the agent rather than the limiter.
const DEFAULT_RATE_PER_MIN = Number(process.env.OXY_STRESS_RATE_PER_MIN || 25);

// Statuses where the runtime answered truthfully; a missing connector is an answer, not a failure.
const HEALTHY = new Set(['completed', 'setup_blocked', 'handoff_required', 'approval_boundary', 'browser_boundary', 'setup_or_handoff']);
const LAYER_ONE_GAUNTLET_PASSING = new Set(['completed', 'approval_boundary', 'browser_boundary']);

function passesLayerOneGauntlet(result) {
  return LAYER_ONE_GAUNTLET_PASSING.has(result?.status);
}

const USAGE = `capability-stress — run the read-only task corpus against a live deployment

  node test/dev/capability-stress.js [--group=g] [--mode=m] [--id=a,b] [--layer=1,2,3] [--gauntlet=layer1] [--limit=n]
                                     [--concurrency=n] [--rate=perMinute] [--allow-writes]

  BASE_URL   deployment to hit (default ${BASE})
  --rate     requests/min, kept under the server cap (default ${DEFAULT_RATE_PER_MIN})
  Read-only unless --allow-writes.`;

function parseArgs(argv = process.argv.slice(2)) {
  const options = { groups: [], modes: [], ids: [], layers: [], gauntlet: null, limit: 0, concurrency: 4, allowWrites: false, ratePerMin: DEFAULT_RATE_PER_MIN };
  for (const arg of argv) {
    const [key, value = ''] = arg.split('=', 2);
    if (key === '--group') options.groups.push(...value.split(',').filter(Boolean));
    if (key === '--mode') options.modes.push(...value.split(',').filter(Boolean));
    if (key === '--id') options.ids.push(...value.split(',').filter(Boolean));
    if (key === '--layer') options.layers.push(...value.split(',').map(Number).filter(Number.isInteger));
    if (key === '--gauntlet' && value === 'layer1') options.gauntlet = value;
    if (key === '--limit') options.limit = Number(value) || 0;
    if (key === '--concurrency') options.concurrency = Math.max(1, Number(value) || 1);
    if (key === '--rate') options.ratePerMin = Math.max(1, Number(value) || DEFAULT_RATE_PER_MIN);
    if (arg === '--allow-writes') options.allowWrites = true;
    if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
  }
  if (!options.modes.length && !options.ids.length) options.modes = ['safe'];
  return options;
}

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
      return { id: task.id, group: task.group, layer: task.layer, expectedAction: task.expectedAction, ms, status: 'rate_limited', routed: false, error: body.error || 'HTTP 429' };
    }
    if (!response.ok) {
      return { id: task.id, group: task.group, layer: task.layer, expectedAction: task.expectedAction, ms, status: 'http_error', routed: false, error: body.error || `HTTP ${response.status}` };
    }
    const { status, receipts } = classify(task, body);
    const routed = (receipts || []).some((receipt) => receipt.action === task.expectedAction);
    const detail = (receipts || []).map((r) => r.action).join(',') || '(no actions)';
    return { id: task.id, group: task.group, layer: task.layer, expectedAction: task.expectedAction, ms, status, routed, actions: detail };
  } catch (error) {
    return {
      id: task.id, group: task.group, layer: task.layer, expectedAction: task.expectedAction,
      ms: Date.now() - startedAt, routed: false,
      status: error.name === 'AbortError' ? 'timeout' : 'transport_error',
      error: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(token, tasks, concurrency, ratePerMin = DEFAULT_RATE_PER_MIN) {
  const queue = [...tasks];
  const results = [];
  const pace = createPacer(ratePerMin);
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      await pace();
      let result = await runTask(token, task);
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

function report(results, wallMs, concurrency, { passes = result => HEALTHY.has(result.status), label = 'CAPABLE  capability answered truthfully' } = {}) {
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const routed = results.filter((r) => r.routed).length;
  const passed = results.filter(passes).length;
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  const pct = (n) => `${((n / results.length) * 100).toFixed(1)}%`;
  console.log(`\n${'='.repeat(72)}`);
  console.log(`CAPABILITY STRESS — ${BASE}`);
  console.log(`${results.length} tasks, ${concurrency} in flight, ${(wallMs / 1000).toFixed(1)}s wall\n`);
  console.log(`SMART    routed to the expected capability   ${routed}/${results.length}  ${pct(routed)}`);
  console.log(`${label}      ${passed}/${results.length}  ${pct(passed)}`);
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
  return { routed, passed, total: results.length };
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
  const gauntlet = options.gauntlet === 'layer1';
  const summary = report(results, Date.now() - startedAt, options.concurrency, gauntlet
    ? { passes: passesLayerOneGauntlet, label: 'GAUNTLET completed or safely parked' }
    : undefined);
  process.exit(summary.passed === summary.total ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runTask, runPool, HEALTHY, passesLayerOneGauntlet };

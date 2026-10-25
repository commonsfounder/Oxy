'use strict';

// Public-web task benchmark: the same read-only tasks can be given to Adam and done by hand,
// then compared. Runs against a live deployment as a test account (it leaves chat history behind).
//
//   node test/dev/web-task-benchmark.js [--id=a,b] [--out=path]
//   BASE_URL (default the Fly app)   OXY_BENCH_USER (default demo-test-user)
//
// Each task has an optional automatic check; tasks without one are graded by reading the answer
// against the reference answers in test/dev/benchmark-results/reference-*.json.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createSessionToken } = require(path.join(__dirname, '..', '..', 'auth'));
const { summarizeTurn } = require(path.join(__dirname, '..', '..', 'api', 'services', 'failure-report'));

const BASE = (process.env.BASE_URL || 'https://milgrain-live-2026.fly.dev').replace(/\/+$/, '');
const USER = process.env.OXY_BENCH_USER || 'demo-test-user';
const TURN_TIMEOUT_MS = Number(process.env.OXY_BENCH_TURN_TIMEOUT_MS || 180000);

const TASKS = [
  { id: 'wiki-population', kind: 'lookup', message: 'What is the current population of Reykjavik according to Wikipedia?' },
  { id: 'wiki-director', kind: 'lookup', message: 'Who directed the film Paddington 2, and what year did it come out?', expectText: [/paul king/i, /2017/] },
  { id: 'museum-hours', kind: 'lookup', message: 'What time does the British Museum open on a Saturday?' },
  { id: 'wiki-tallest', kind: 'browse', message: 'On Wikipedia, find the tallest building in Birmingham, UK and tell me how tall it is.' },
  { id: 'jl-kettle', kind: 'shop', message: 'How much is the Bosch Sky kettle on John Lewis?' },
  { id: 'tesco-milk', kind: 'shop', message: "On Tesco's website, how much is 2 pints of semi-skimmed milk?" },
  { id: 'currys-cheapest-kettle', kind: 'shop', message: "What's the cheapest kettle on Currys right now?" },
  { id: 'argos-kettle', kind: 'botwall', message: "What's the price of the cheapest kettle on Argos?", note: 'Argos blocks automated browsers; the right answer is honest about it or finds the price another way.' },
  { id: 'kettle-cards', kind: 'cards', message: 'Find me three good kettles under £60 and show me the options.', expectAction: 'show_results' },
  { id: 'london-weather', kind: 'live', message: "What's the weather in London tomorrow?" },
  { id: 'bbc-headline', kind: 'live', message: "What's the top headline on BBC News right now?" },
  { id: 'prague-hotel', kind: 'travel', message: 'Find me a hotel in Prague for two nights next weekend under £150 a night.', expectAction: 'search_hotels' },
  { id: 'lisbon-flight', kind: 'travel', message: "What's the cheapest flight from London to Lisbon next Friday?", expectAction: 'search_flights' },
  { id: 'walk-bullring', kind: 'live', message: 'How long does it take to walk from Birmingham New Street station to the Bullring?' },
];

function grade(task, text, actions) {
  const checks = [];
  if (task.expectAction) checks.push(actions.some((a) => a.action === task.expectAction));
  for (const pattern of task.expectText || []) checks.push(pattern.test(text));
  if (!checks.length) return 'unchecked';
  return checks.every(Boolean) ? 'pass' : 'fail';
}

async function runTask(token, task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  const startedAt = Date.now();
  const base = { id: task.id, kind: task.kind, message: task.message };
  try {
    const response = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: USER, message: task.message }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    const ms = Date.now() - startedAt;
    if (!response.ok) return { ...base, ms, grade: 'error', error: body.error || `HTTP ${response.status}`, steps: [] };
    const actions = body.actions || [];
    const turn = summarizeTurn(actions);
    return {
      ...base, ms,
      grade: grade(task, body.text || '', actions),
      answer: String(body.text || '').slice(0, 1200),
      steps: turn.steps,
      failures: turn.failures,
      firstFailure: turn.firstFailure,
    };
  } catch (error) {
    return { ...base, ms: Date.now() - startedAt, grade: error.name === 'AbortError' ? 'timeout' : 'error', error: error.message, steps: [] };
  } finally {
    clearTimeout(timer);
  }
}

function report(results) {
  const byCause = {};
  for (const r of results) for (const s of r.steps || []) if (!s.ok) byCause[s.cause] = (byCause[s.cause] || 0) + 1;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n${results.length} tasks, median ${times[Math.floor(times.length / 2)]}ms, slowest ${times[times.length - 1]}ms`);
  console.log('failed steps by cause:', JSON.stringify(byCause));
  for (const r of results) {
    const where = r.firstFailure ? ` first failure: ${r.firstFailure.action} (${r.firstFailure.cause})` : '';
    console.log(`${String(r.ms).padStart(7)}ms  ${r.grade.padEnd(9)} ${r.id.padEnd(24)} ${(r.steps || []).map((s) => s.action).join(',') || '(no actions)'}${where}`);
  }
}

async function main() {
  const ids = (process.argv.find((a) => a.startsWith('--id=')) || '').slice(5).split(',').filter(Boolean);
  const tasks = ids.length ? TASKS.filter((t) => ids.includes(t.id)) : TASKS;
  const token = createSessionToken(USER);
  console.log(`${tasks.length} tasks against ${BASE} as ${USER}\n`);
  const results = [];
  for (const task of tasks) {
    const result = await runTask(token, task);
    results.push(result);
    console.log(`${String(result.ms).padStart(7)}ms  ${result.grade.padEnd(9)} ${result.id}`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  report(results);
  const outDir = path.join(__dirname, 'benchmark-results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || path.join(outDir, `adam-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ base: BASE, user: USER, at: new Date().toISOString(), results }, null, 2));
  console.log(`\nsaved ${out}`);
}

if (require.main === module) main();

module.exports = { TASKS, runTask, grade };

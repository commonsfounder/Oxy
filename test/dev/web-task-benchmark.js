'use strict';

// Public-web task benchmark: the same read-only tasks can be given to Adam and done by hand,
// then compared. Runs against a live deployment as a test account (it leaves chat history behind).
//
//   node test/dev/web-task-benchmark.js [--suite=web|multistep|hard] [--id=a,b] [--out=path]
//                                       [--model=openai:gpt-6.1-sol] [--max-usd=0.30]
//   --model sets the test account's model for the run and puts it back afterwards (the account's own
//   model setting, so nothing else is touched). --max-usd stops the run once the estimated spend passes it.
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

const WEB_TASKS = [
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

const SUITES = { web: WEB_TASKS, multistep: require('./benchmark-multistep-tasks'), hard: require('./benchmark-hard-tasks') };

function matches(pattern, text) {
  const [regex, count] = Array.isArray(pattern) ? pattern : [pattern, 1];
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  return (text.match(new RegExp(regex.source, flags)) || []).length >= count;
}

// Returns the grade and the reasons a check failed, so a fail says which part broke.
function grade(task, text, actions) {
  const names = actions.map((a) => a.action);
  const checks = [];
  const miss = (label, ok) => checks.push({ label, ok });
  if (task.expectAction) miss(`used ${task.expectAction}`, names.includes(task.expectAction));
  for (const name of task.expectActions || []) miss(`used ${name}`, names.includes(name));
  for (const name of task.forbidActions || []) miss(`did not use ${name}`, !names.includes(name));
  if (task.expectAny) miss(`used one of ${task.expectAny.join('/')}`, task.expectAny.some((n) => names.includes(n)));
  if (task.minSteps) miss(`took at least ${task.minSteps} steps`, actions.length >= task.minSteps);
  for (const pattern of task.expectText || []) miss(`answer matches ${Array.isArray(pattern) ? `${pattern[0]} x${pattern[1]}` : pattern}`, matches(pattern, text));
  for (const pattern of task.forbidText || []) miss(`answer avoids ${pattern}`, !pattern.test(text));
  if (!checks.length) return { grade: 'unchecked', failedChecks: [] };
  const failedChecks = checks.filter((c) => !c.ok).map((c) => c.label);
  return { grade: failedChecks.length ? 'fail' : 'pass', failedChecks };
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
      ...grade(task, body.text || '', actions),
      answer: String(body.text || '').slice(0, 1200),
      usage: body.usage || null,
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
  const cost = results.reduce((sum, r) => sum + (r.usage?.estimatedUsd || 0), 0);
  const inputTokens = results.reduce((sum, r) => sum + (r.usage?.inputTokens || 0), 0);
  const cachedTokens = results.reduce((sum, r) => sum + (r.usage?.cachedTokens || 0), 0);
  console.log(`input tokens: ${inputTokens}, of which cached: ${cachedTokens} (${inputTokens ? Math.round((cachedTokens / inputTokens) * 100) : 0}%)`);
  const reasoning = results.reduce((sum, r) => sum + (r.usage?.reasoningTokens || 0), 0);
  const output = results.reduce((sum, r) => sum + (r.usage?.outputTokens || 0), 0);
  console.log(`estimated model cost: $${cost.toFixed(4)} (about $${(cost / Math.max(1, results.length)).toFixed(4)} a task); ${reasoning} of ${output} output tokens were reasoning`);
  for (const r of results) {
    const where = r.firstFailure ? ` first failure: ${r.firstFailure.action} (${r.firstFailure.cause})` : '';
    console.log(`${String(r.ms).padStart(7)}ms  ${r.grade.padEnd(9)} ${r.id.padEnd(28)} ${(r.steps || []).map((s) => s.action).join(',') || '(no actions)'}${where}`);
    if (r.failedChecks?.length) console.log(`${' '.repeat(20)}failed: ${r.failedChecks.join('; ')}`);
  }
}

const DEFAULT_MODEL = 'openai:gpt-6-luna';

async function setModel(token, spec) {
  const [provider, ...rest] = String(spec).split(':');
  const response = await fetch(`${BASE}/model-routing`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ provider, model: rest.join(':') }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Could not set model ${spec}: ${body.error || response.status}`);
  if (body.selected && body.selected.configured === false) throw new Error(`${spec}: that provider has no key on the server yet.`);
  return body;
}

async function main() {
  const ids = (process.argv.find((a) => a.startsWith('--id=')) || '').slice(5).split(',').filter(Boolean);
  const suiteName = (process.argv.find((a) => a.startsWith('--suite=')) || '--suite=web').slice(8);
  const suite = SUITES[suiteName];
  if (!suite) { console.error(`Unknown suite "${suiteName}". Use: ${Object.keys(SUITES).join(', ')}`); process.exit(2); }
  const tasks = ids.length ? suite.filter((t) => ids.includes(t.id)) : suite;
  const token = createSessionToken(USER);
  const modelSpec = (process.argv.find((a) => a.startsWith('--model=')) || '').slice(8);
  const maxUsd = Number((process.argv.find((a) => a.startsWith('--max-usd=')) || '').slice(10)) || Infinity;
  if (modelSpec) await setModel(token, modelSpec);
  console.log(`${tasks.length} tasks against ${BASE} as ${USER}${modelSpec ? ` on ${modelSpec}` : ''}${Number.isFinite(maxUsd) ? `, stopping at $${maxUsd}` : ''}\n`);
  const results = [];
  let spent = 0;
  for (const task of tasks) {
    if (spent >= maxUsd) { console.log(`stopped: estimated spend $${spent.toFixed(4)} reached the cap`); break; }
    const result = await runTask(token, task);
    spent += result.usage?.estimatedUsd || 0;
    results.push(result);
    console.log(`${String(result.ms).padStart(7)}ms  ${result.grade.padEnd(9)} ${result.id}`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  if (modelSpec) await setModel(token, DEFAULT_MODEL).catch((e) => console.error(`WARNING: could not restore the default model: ${e.message}`));
  report(results);
  const outDir = path.join(__dirname, 'benchmark-results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || path.join(outDir, `adam-${suiteName}-${(modelSpec || 'default').replace(/[^a-z0-9.]+/gi, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ base: BASE, user: USER, model: modelSpec || 'server default', at: new Date().toISOString(), results }, null, 2));
  console.log(`\nsaved ${out}`);
}

if (require.main === module) main();

module.exports = { SUITES, runTask, grade };

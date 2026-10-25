'use strict';

// Side-by-side comparison of Adam, Claude and Codex on one suite.
//
//   node test/dev/benchmark-compare.js [--suite=hard] [--adam=path] [--claude=path] [--codex=path]
//
// Adam's file is the runner's output (newest adam-<suite>-*.json by default). Claude's and Codex's
// files are written by hand: { "who": "...", "answers": { "<task id>": { "answer": "...", "seconds": 90,
// "how": "browser|search|...", "confidence": "high|medium|low" } } }. People get the text checks only;
// the action checks (which tools were used) apply to Adam alone.

const fs = require('fs');
const path = require('path');
const { SUITES } = require('./web-task-benchmark');

const DIR = path.join(__dirname, 'benchmark-results');
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const suiteName = arg('suite') || 'hard';
const tasks = SUITES[suiteName];
if (!tasks) { console.error(`Unknown suite ${suiteName}`); process.exit(2); }

function newest(prefix) {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort() : [];
  return files.length ? path.join(DIR, files[files.length - 1]) : null;
}
function load(file) { return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }

function matches(pattern, text) {
  const [regex, count] = Array.isArray(pattern) ? pattern : [pattern, 1];
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  return (text.match(new RegExp(regex.source, flags)) || []).length >= count;
}
// Text checks only: used for people, whose tool use is not recorded.
function gradeText(task, text) {
  const checks = [...(task.expectText || []).map((p) => matches(p, text)), ...(task.forbidText || []).map((p) => !p.test(text))];
  if (!checks.length) return 'unchecked';
  return checks.every(Boolean) ? 'pass' : 'fail';
}

const adam = load(arg('adam') || newest(`adam-${suiteName}-`));
const claude = load(arg('claude') || path.join(DIR, `claude-${suiteName}.json`));
const codex = load(arg('codex') || path.join(DIR, `codex-${suiteName}.json`));
const adamById = new Map((adam?.results || []).map((r) => [r.id, r]));

const clip = (text, n = 260) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n) || '(no answer)';
const tally = { adam: { pass: 0, fail: 0, unchecked: 0 }, claude: { pass: 0, fail: 0, unchecked: 0 }, codex: { pass: 0, fail: 0, unchecked: 0 } };
const lines = [`# ${suiteName} suite: Adam vs Claude vs Codex`, '', `Adam run: ${adam?.at || 'missing'} on ${adam?.base || '-'}`, `Claude: ${claude?.who || 'missing'}`, `Codex: ${codex?.who || 'missing'}`, ''];
const rows = [];

for (const task of tasks) {
  const a = adamById.get(task.id);
  const c = claude?.answers?.[task.id];
  const x = codex?.answers?.[task.id];
  const grades = {
    adam: a ? a.grade : 'missing',
    claude: c ? gradeText(task, c.answer || '') : 'missing',
    codex: x ? gradeText(task, x.answer || '') : 'missing',
  };
  for (const who of Object.keys(tally)) if (tally[who][grades[who]] !== undefined) tally[who][grades[who]] += 1;
  rows.push(`| ${task.id} | ${grades.adam}${a ? ` (${Math.round(a.ms / 1000)}s)` : ''} | ${grades.claude}${c?.seconds ? ` (${c.seconds}s)` : ''} | ${grades.codex}${x?.seconds ? ` (${x.seconds}s)` : ''} |`);
  lines.push(`## ${task.id}  _(${task.kind})_`, `**Task:** ${task.message}`, `**Reference:** ${task.ref || '-'}`, '',
    `- **Adam** [${grades.adam}]: ${clip(a?.answer || a?.error)}${a?.steps?.length ? `  \n  steps: ${a.steps.map((s) => s.action + (s.ok ? '' : `(${s.cause})`)).join(' > ')}` : ''}${a?.failedChecks?.length ? `  \n  failed: ${a.failedChecks.join('; ')}` : ''}`,
    `- **Claude** [${grades.claude}]: ${clip(c?.answer)}${c?.how ? `  \n  how: ${c.how}${c.confidence ? `, confidence ${c.confidence}` : ''}` : ''}`,
    `- **Codex** [${grades.codex}]: ${clip(x?.answer)}${x?.how ? `  \n  how: ${x.how}${x.confidence ? `, confidence ${x.confidence}` : ''}` : ''}`, '');
}

const summary = ['## Scoreboard', '', '| task | Adam | Claude | Codex |', '|---|---|---|---|', ...rows, '',
  `Adam ${tally.adam.pass} pass / ${tally.adam.fail} fail / ${tally.adam.unchecked} unchecked`,
  `Claude ${tally.claude.pass} pass / ${tally.claude.fail} fail / ${tally.claude.unchecked} unchecked`,
  `Codex ${tally.codex.pass} pass / ${tally.codex.fail} fail / ${tally.codex.unchecked} unchecked`, ''];
const out = path.join(DIR, `comparison-${suiteName}.md`);
fs.writeFileSync(out, [...lines.slice(0, 6), ...summary, ...lines.slice(6)].join('\n'));
console.log(summary.join('\n'));
console.log(`saved ${out}`);

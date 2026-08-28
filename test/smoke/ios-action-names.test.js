const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ACTION_CONTRACTS } = require('../../api/action-contracts');

// iOS picks its UI off action names, so deleting a capability breaks the client silently.

const APP_ROOT = path.join(__dirname, '..', '..', 'OxyApp', 'OxyApp');

// Must stay empty: restore the capability or delete the branch instead of adding to this.
const KNOWN_DEAD = new Set([]);

const SNAKE_LITERAL = /"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"/g;

function swiftFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) swiftFiles(full, out);
    else if (full.endsWith('.swift')) out.push(full);
  }
  return out;
}

// Returns names the Swift compares against, and names it builds on-device (which need no contract).
function scanSwift() {
  const compared = new Map();
  const clientLocal = new Set();

  for (const file of swiftFiles(APP_ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let switchIndent = null;
    let setIndent = null;

    lines.forEach((line, index) => {
      const where = `${path.relative(APP_ROOT, file)}:${index + 1}`;
      const indent = line.search(/\S|$/);

      if (switchIndent !== null && line.trim() === '}' && indent === switchIndent) switchIndent = null;
      if (setIndent !== null && line.trim().startsWith(']')) setIndent = null;

      if (/(NativeLocalActionResult|ActionResult)\s*\(/.test(line)) {
        for (let ahead = index; ahead < Math.min(index + 6, lines.length); ahead += 1) {
          const built = lines[ahead].match(/action:\s*"([a-z_]+)"/);
          if (built) { clientLocal.add(built[1]); break; }
        }
      }

      const inContext = /\.action\b|watchedAction/.test(line) || switchIndent !== null || setIndent !== null;
      if (inContext) {
        for (const match of line.matchAll(SNAKE_LITERAL)) {
          if (!compared.has(match[1])) compared.set(match[1], []);
          compared.get(match[1]).push(where);
        }
      }

      if (/switch\s+[\w.]*\.action\s*\{/.test(line)) switchIndent = indent;
      if (/(let|var)\s+\w*[Aa]ction\w*\s*:\s*Set<String>\s*=\s*\[/.test(line)) setIndent = indent;
    });
  }
  return { compared, clientLocal };
}

test('every action name the iOS client watches still exists somewhere', () => {
  const { compared, clientLocal } = scanSwift();
  assert.ok(compared.size > 5, 'extractor found almost nothing — it has probably stopped matching');

  const broken = [];
  for (const [name, sites] of compared) {
    if (ACTION_CONTRACTS[name] || clientLocal.has(name) || KNOWN_DEAD.has(name)) continue;
    broken.push(`${name} (watched at ${sites.join(', ')})`);
  }
  assert.deepEqual(broken, [], `iOS watches action names nothing produces:\n  ${broken.join('\n  ')}`);
});

test('the extractor still sees the switch and Set forms, not just == comparisons', () => {
  const { compared } = scanSwift();
  assert.ok(compared.has('search_flights'), 'lost sight of names inside `switch action.action`');
  assert.ok(compared.has('make_call'), 'lost sight of names inside an action Set literal');
});

test('the known-dead list does not outlive the capabilities it describes', () => {
  const { compared } = scanSwift();
  for (const name of KNOWN_DEAD) {
    assert.ok(!ACTION_CONTRACTS[name], `${name} is a declared capability again — remove it from KNOWN_DEAD`);
    assert.ok(compared.has(name), `${name} is no longer referenced by iOS — remove it from KNOWN_DEAD`);
  }
});

test('the action AgentTaskSession watches is the gated money step', () => {
  const source = fs.readFileSync(path.join(APP_ROOT, 'Models', 'AgentTaskSession.swift'), 'utf8');
  const match = source.match(/watchedAction = kind == \.ride \? "([a-z_]+)" : "([a-z_]+)"/);
  assert.ok(match, 'AgentTaskSession no longer has a recognisable watchedAction line');

  const [, rideAction, taskAction] = match;
  assert.ok(ACTION_CONTRACTS[rideAction], `${rideAction} must be a declared capability`);

  const contract = ACTION_CONTRACTS[taskAction];
  assert.ok(contract, `${taskAction} must be a declared capability`);
  assert.equal(contract.executionMode, 'review', `${taskAction} must stay review-gated`);
  assert.equal(contract.confirmation, 'review_required', `${taskAction} must emit the review card iOS renders`);
});

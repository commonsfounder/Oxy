'use strict';

// Guards the api/actions extraction.
//
// Handler bodies were moved down a directory out of api/index.js, and several of them call
// require() lazily *inside* the function rather than at the top of the file. A lazy require
// with a now-wrong relative path resolves fine at import time and only throws when that one
// action runs, so loading the module proves nothing. Three modules shipped exactly that way
// during the extraction and the suite stayed green, because no test happened to invoke those
// particular branches. This resolves every require path statically instead.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ACTIONS_DIR = path.join(__dirname, '../../api/actions');

function actionFiles() {
  return fs.readdirSync(ACTIONS_DIR).filter(name => name.endsWith('.js'));
}

test('every require in an action module resolves, including lazy ones inside functions', () => {
  const failures = [];
  for (const file of actionFiles()) {
    const full = path.join(ACTIONS_DIR, file);
    const source = fs.readFileSync(full, 'utf8');
    for (const match of source.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
      const request = match[1];
      if (!request.startsWith('.')) continue; // package imports are npm's problem, not ours
      try {
        require.resolve(path.resolve(path.dirname(full), request));
      } catch {
        failures.push(`${file}: require('${request}')`);
      }
    }
  }
  assert.deepEqual(failures, [], `unresolvable requires:\n${failures.join('\n')}`);
});

test('the registry exposes every handler each module declares, with no duplicate owners', () => {
  const registry = require('../../api/actions');
  const seen = new Map();

  for (const file of actionFiles()) {
    if (file === 'index.js') continue;
    const mod = require(path.join(ACTIONS_DIR, file));
    assert.ok(mod.handlers, `${file} exports no handlers`);
    for (const [action, handler] of Object.entries(mod.handlers)) {
      assert.equal(typeof handler, 'function', `${file}: ${action} is not a function`);
      // Two modules claiming the same action is how a silently-dead handler happens.
      assert.equal(seen.has(action), false, `${action} is claimed by both ${seen.get(action)} and ${file}`);
      seen.set(action, file);
      // A module that is written but never registered is dead code that still looks live.
      assert.equal(registry.handlerFor(action), handler, `${action} is not reachable through the registry`);
    }
  }

  assert.ok(seen.size > 0, 'no action handlers were found at all');
  assert.equal(registry.handlerFor('definitely_not_an_action'), null);
});

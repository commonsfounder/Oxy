// Every standalone entrypoint must be able to reach the function it claims to run.
//
// This exists because retention-job.js destructured `runRetentionSweep` from api/index.js,
// which never exported it. `npm run retention:job` threw a TypeError on every invocation and
// nothing noticed: data-retention.js was fully implemented and unit-tested, and the suite
// stayed green, while the bounded-retention promise on /privacy was enforced by nothing.
//
// A unit test on the service could never have caught that. This checks the wiring instead.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const repoRoot = path.join(__dirname, '..', '..');

/** Every `node <file>` script declared in package.json, and the module it pulls from. */
function scriptEntrypoints() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return Object.entries(pkg.scripts || {})
    .map(([name, command]) => {
      const match = /^node\s+([\w./-]+\.js)$/.exec(command.trim());
      return match ? { name, file: match[1] } : null;
    })
    .filter(Boolean);
}

test('every `node <file>` npm script points at a file that exists', () => {
  const entrypoints = scriptEntrypoints();
  assert.ok(entrypoints.length >= 2, 'expected at least the proactive and retention jobs');
  for (const { name, file } of entrypoints) {
    assert.ok(fs.existsSync(path.join(repoRoot, file)), `npm run ${name} points at missing ${file}`);
  }
});

test('every function a job entrypoint destructures from api/index.js is actually exported', () => {
  const api = require('../../api/index.js');
  const missing = [];

  for (const { name, file } of scriptEntrypoints()) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    // `const { a, b } = require('./api/index.js')`
    const pattern = /const\s*\{([^}]+)\}\s*=\s*require\(['"]([^'"]*api\/index(?:\.js)?)['"]\)/g;
    let match;
    while ((match = pattern.exec(source))) {
      const names = match[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean);
      for (const exported of names) {
        if (typeof api[exported] !== 'function') {
          missing.push(`${file} destructures ${exported} from api/index.js, which exports ${typeof api[exported]}`);
        }
      }
    }
  }

  assert.deepEqual(missing, [], missing.join('\n'));
});

test('the retention sweep is reachable from its job and really runs the policy', async () => {
  const api = require('../../api/index.js');
  assert.equal(typeof api.runRetentionSweep, 'function');

  // And it delegates to the real implementation rather than being a stub that returns {}.
  const dataRetention = require('../../api/services/data-retention');
  assert.equal(typeof dataRetention.runRetentionSweep, 'function');
  assert.ok(Object.keys(dataRetention.RETENTION_POLICY).length > 0, 'a policy with no tables purges nothing');

  const src = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');
  assert.match(src, /dataRetention\.runRetentionSweep\(supabase, \{ logger \}\)/,
    'the entrypoint must pass the server supabase client into the real sweep');
});

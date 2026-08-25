'use strict';

// supabase-js does not reject. It RESOLVES with `{ data, error }`.
//
// That is true for an RLS refusal, a constraint violation, a missing column, and even a
// dead host — "TypeError: fetch failed" arrives in the `error` field, not as an exception.
// So `try { await supabase.from(...)... } catch { ... }` catches nothing that actually
// happens, and the code inside reads as a safety net while being unreachable.
//
// This has now bitten this repo three separate times: notification-delivery.js documents
// the `.catch()`-on-a-query-builder version, credential-grants.js handed out an uncounted
// credential when the use-count write failed, and /health reported `db: ok` for every
// database failure it exists to detect. These are source-level tripwires rather than
// behavioural tests on purpose — asserting the real behaviour would mean requiring the
// database to be DOWN, which is not a state a test suite should depend on.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');

function routeBody(marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `route not found: ${marker}`);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf('\n});'));
}

test('/health inspects the returned error, so a dead database is not reported as ok', () => {
  const body = routeBody("app.get('/health'");
  assert.match(body, /const \{ error \} = await supabase\.from\('users'\)/,
    'the probe must destructure the returned error');
  assert.match(body, /if \(error\) dbStatus = 'error'/,
    "a returned error must set dbStatus, not just a thrown one");
});

test('deleting preferences reports a failed delete instead of success', () => {
  const body = routeBody("app.delete('/preferences/:userId'");
  assert.match(body, /const \{ error \} = await supabase\.from\('preferences'\)\.delete\(\)/,
    'the delete must destructure the returned error');
  assert.match(body, /if \(error\) return res\.status\(500\)/,
    'a returned error must become a 500, not `{ success: true }`');
});

test('the credential use-count guard checks both failure shapes', () => {
  const grants = fs.readFileSync(require.resolve('../../api/services/credential-grants.js'), 'utf8');
  const start = grants.indexOf('async function claimGrantUse');
  assert.notEqual(start, -1);
  const body = grants.slice(start, grants.indexOf('\n}', start));

  // The returned-error path is the one that actually fires in production; the try/catch is
  // kept for a mocked client that throws. Losing either one reopens the cap.
  assert.match(body, /if \(error\) return \{ ok: false, error \}/,
    'a returned error must be captured');
  assert.match(body, /catch \(err\) \{\s*return \{ ok: false, error: err \}/,
    'a thrown error must be captured too');

  // And the caller must turn either one into a refusal rather than a sign-in.
  const caller = grants.slice(grants.indexOf('async function authorizeCredentialUse'));
  assert.match(caller, /if \(!claim\.raced\)[\s\S]{0,400}reason: 'use_count_failed', grant: null/,
    'either failure must refuse the sign-in');
});

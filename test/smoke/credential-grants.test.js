'use strict';

// The authorisation decision for using a stored password.
//
// The rule that matters: the GRANT is the authority, and it comes from the user. The model
// picks which sites to request (run_browser_task's credentialSites param), and this agent
// reads web pages written by strangers, so a model-chosen site must never be able to widen
// what the user allowed -- it can only narrow it. Every other check here exists so an
// unattended grant cannot quietly become a permanent one.

const assert = require('node:assert/strict');
const test = require('node:test');

const { authorizeCredentialUse, decideCredentialUse } = require('../../api/services/credential-grants');

const NOW = new Date('2026-08-25T12:00:00Z');

function grant(overrides = {}) {
  return {
    id: 'g1',
    site: 'johnlewis.com',
    scope: 'standing',
    task_id: null,
    expires_at: '2026-08-26T12:00:00Z',
    revoked_at: null,
    max_uses: null,
    use_count: 0,
    ...overrides
  };
}

test('a live user grant for the site allows the sign-in', () => {
  const decision = decideCredentialUse({ grant: grant(), site: 'johnlewis.com', now: NOW });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'granted');
});

test('no grant means no sign-in, which is what makes this fail closed', () => {
  const decision = decideCredentialUse({ grant: null, site: 'johnlewis.com', now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no_grant');
});

test('a model-requested site can narrow the grant but can never widen it', () => {
  // The user granted johnlewis.com. A page the agent read tries to steer it at a bank.
  // The grant is looked up per site, so the bank simply has no grant -- but assert the
  // explicit case too, because this is the property the whole design rests on.
  const widened = decideCredentialUse({
    grant: grant({ site: 'johnlewis.com' }),
    site: 'evil-bank-login.com',
    now: NOW
  });
  assert.equal(widened.allowed, false);
  assert.equal(widened.reason, 'site_not_granted');

  // Narrowing is fine: the user granted the site, and the model asked for exactly it.
  const narrowed = decideCredentialUse({
    grant: grant(),
    site: 'johnlewis.com',
    requestedSites: ['johnlewis.com'],
    now: NOW
  });
  assert.equal(narrowed.allowed, true);

  // A grant the model did not ask to use in this task stays unused rather than being
  // spent opportunistically.
  const notRequested = decideCredentialUse({
    grant: grant(),
    site: 'johnlewis.com',
    requestedSites: ['argos.co.uk'],
    now: NOW
  });
  assert.equal(notRequested.allowed, false);
  assert.equal(notRequested.reason, 'site_not_requested');
});

test('grants stop working when they expire or are revoked', () => {
  const expired = decideCredentialUse({
    grant: grant({ expires_at: '2026-08-25T11:59:59Z' }),
    site: 'johnlewis.com',
    now: NOW
  });
  assert.equal(expired.allowed, false);
  assert.equal(expired.reason, 'expired');

  const revoked = decideCredentialUse({
    grant: grant({ revoked_at: '2026-08-25T10:00:00Z' }),
    site: 'johnlewis.com',
    now: NOW
  });
  assert.equal(revoked.allowed, false);
  assert.equal(revoked.reason, 'revoked');

  // Revocation wins even if the window is still open -- revoking is the emergency stop.
  const revokedButUnexpired = decideCredentialUse({
    grant: grant({ revoked_at: '2026-08-25T10:00:00Z', expires_at: '2027-01-01T00:00:00Z' }),
    site: 'johnlewis.com',
    now: NOW
  });
  assert.equal(revokedButUnexpired.allowed, false);
  assert.equal(revokedButUnexpired.reason, 'revoked');
});

test('a use limit is enforced, so an unattended grant cannot be spent indefinitely', () => {
  const remaining = decideCredentialUse({
    grant: grant({ max_uses: 3, use_count: 2 }),
    site: 'johnlewis.com',
    now: NOW
  });
  assert.equal(remaining.allowed, true);

  const exhausted = decideCredentialUse({
    grant: grant({ max_uses: 3, use_count: 3 }),
    site: 'johnlewis.com',
    now: NOW
  });
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.reason, 'use_limit_reached');

  // A null limit means "no cap", not "zero".
  const uncapped = decideCredentialUse({
    grant: grant({ max_uses: null, use_count: 99 }),
    site: 'johnlewis.com',
    now: NOW
  });
  assert.equal(uncapped.allowed, true);
});

test('a task-scoped grant is confined to the task it was created for', () => {
  const sameTask = decideCredentialUse({
    grant: grant({ scope: 'task', task_id: 't-1' }),
    site: 'johnlewis.com',
    taskId: 't-1',
    now: NOW
  });
  assert.equal(sameTask.allowed, true);

  const otherTask = decideCredentialUse({
    grant: grant({ scope: 'task', task_id: 't-1' }),
    site: 'johnlewis.com',
    taskId: 't-2',
    now: NOW
  });
  assert.equal(otherTask.allowed, false);
  assert.equal(otherTask.reason, 'wrong_task');

  // A task grant with no task in hand is not a free pass.
  const noTask = decideCredentialUse({
    grant: grant({ scope: 'task', task_id: 't-1' }),
    site: 'johnlewis.com',
    now: NOW
  });
  assert.equal(noTask.allowed, false);
  assert.equal(noTask.reason, 'wrong_task');

  // A standing grant is deliberately not confined to a task -- that is what makes
  // unattended overnight work possible.
  const standing = decideCredentialUse({
    grant: grant({ scope: 'standing' }),
    site: 'johnlewis.com',
    taskId: 't-9',
    now: NOW
  });
  assert.equal(standing.allowed, true);
});

test('site matching ignores www and case, so a grant is not defeated by a host prefix', () => {
  const decision = decideCredentialUse({
    grant: grant({ site: 'johnlewis.com' }),
    site: 'WWW.JohnLewis.com',
    requestedSites: ['www.johnlewis.com'],
    now: NOW
  });
  assert.equal(decision.allowed, true);
});

test('a grant that did not come from the user is never honoured', () => {
  // Provenance is recorded so a grant created by anything other than a deliberate user
  // action cannot authorise a sign-in, even if a row somehow exists.
  const decision = decideCredentialUse({
    grant: grant({ granted_via: 'model' }),
    site: 'johnlewis.com',
    now: NOW
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'not_user_granted');
});

// Regression guard for a silent no-op.
//
// The use counter was originally advanced with `await query.catch?.(fn)`. The PostgREST
// query builder has no .catch method, so that expression short-circuited to
// `await undefined` -- and because these builders only execute when awaited, the update
// never ran. The cap silently did nothing, and only a live run against the real database
// exposed it. This asserts the write is actually issued.
test('using a grant actually advances the counter, so a use cap cannot silently do nothing', async () => {
  const { authorizeCredentialUse } = require('../../api/services/credential-grants');
  const updates = [];
  const inserted = [];

  const stored = {
    id: 'g1', site: 'johnlewis.com', scope: 'standing', task_id: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    max_uses: 2, use_count: 0, revoked_at: null, granted_via: 'user'
  };

  const db = {
    from(table) {
      const chain = {
        _table: table,
        select() { return chain; },
        eq() { return chain; },
        order() { return chain; },
        limit() { return Promise.resolve({ data: [stored] }); },
        insert(row) { inserted.push({ table, row }); return Promise.resolve({ error: null }); },
        update(patch) {
          updates.push({ table, patch });
          // Mirrors the real builder: no .catch, resolves only when awaited, and honours
          // the compare-and-set by returning the row it matched (or no row at all).
          const filters = {};
          const p = {
            eq(column, value) { filters[column] = value; return p; },
            select() { return p; },
            maybeSingle() { return p; },
            then(res) {
              const matched = !('use_count' in filters) || filters.use_count === stored.use_count;
              if (matched && 'use_count' in patch) stored.use_count = patch.use_count;
              return Promise.resolve({ data: matched ? { id: stored.id } : null, error: null }).then(res);
            }
          };
          return p;
        }
      };
      return chain;
    }
  };

  const result = await authorizeCredentialUse(db, 'u1', { site: 'johnlewis.com' });
  assert.equal(result.allowed, true);

  const counterWrite = updates.find(u => u.table === 'credential_grants' && 'use_count' in u.patch);
  assert.ok(counterWrite, 'the use counter was never written -- the cap would not hold');
  assert.equal(counterWrite.patch.use_count, 1);
  assert.equal(stored.use_count, 1, 'the stored row must actually carry the new count');

  // And the use is recorded, so the log is a complete history rather than only refusals.
  const logged = inserted.find(i => i.table === 'credential_use_log');
  assert.ok(logged, 'the use was not written to the audit log');
  assert.equal(logged.row.outcome, 'used');
  assert.equal(logged.row.site, 'johnlewis.com');
});

// Source-level tripwire, same style as the commitments one.
//
// The credential log is only honest if it covers BOTH ways the agent gets into an account.
// It shipped covering password sign-ins only, while browser-task.js quietly reused stored
// session cookies -- which that file itself notes are "often stronger than a password, since
// a live session cookie skips login and 2FA entirely". Reusing a session is the common case,
// so omitting it made the log misleading rather than merely incomplete.
test('reusing a stored browser session is recorded as a credential use', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../../api/services/browser-task.js'), 'utf8');

  assert.match(source, /require\('\.\/credential-grants'\)/,
    'browser-task must import the credential log');

  // The load and the log must sit together: a stored session that is loaded but never
  // recorded is exactly the gap this closes.
  assert.match(
    source,
    /const storageState = await loadStorageState\([^)]*\);[\s\S]{0,900}if \(storageState\)[\s\S]{0,400}recordUse\(/,
    'loading a stored session must be followed by a recordUse call'
  );
  assert.match(source, /reason: 'stored_session'/,
    "session reuse must be distinguishable in the log from a password sign-in");
});


// The use cap is only a cap if a failed counter stops the sign-in.
//
// authorizeCredentialUse increments use_count BEFORE handing the credential over, and
// guarded that write with a try/catch. supabase-js does not reject -- it RESOLVES with
// `{ error }`, for an RLS refusal, a constraint, and even a dead host ("TypeError: fetch
// failed" arrives in that field, not as an exception). So the catch never ran, and a grant
// capped at one use was handed out uncounted precisely when the database was least able to
// enforce the cap. Both failure shapes are asserted, because a returned error is the one
// that actually happens in production.
// A chainable stand-in for the PostgREST builder: every filter returns the builder and the
// builder itself is the thenable, which is what makes `.update().eq().eq()` await correctly.
// A stub that returned a bare Promise from update() would blow up on the first `.eq` and
// make these tests pass for entirely the wrong reason.
function query(settle) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => builder,
    maybeSingle: () => builder,
    then: (resolve, reject) => settle().then(resolve, reject)
  };
  return builder;
}

function supabaseStub({ grants, onUpdate }) {
  return {
    from(table) {
      return {
        select: () => query(() => Promise.resolve({ data: grants, error: null })),
        insert: () => query(() => Promise.resolve({ data: null, error: null })),
        update: () => query(table === 'credential_grants'
          ? onUpdate
          : () => Promise.resolve({ data: null, error: null })),
        _table: table
      };
    }
  };
}

const liveGrant = {
  id: 'g1',
  site: 'johnlewis.com',
  scope: 'standing',
  task_id: null,
  expires_at: '2099-01-01T00:00:00Z',
  revoked_at: null,
  max_uses: 1,
  use_count: 0,
  granted_via: 'user'
};

test('a use-count write that RETURNS an error refuses the sign-in', async () => {
  const supabase = supabaseStub({
    grants: [liveGrant],
    onUpdate: () => Promise.resolve({ data: null, error: { message: 'TypeError: fetch failed' } })
  });
  const result = await authorizeCredentialUse(supabase, 'u1', { site: 'johnlewis.com' });
  assert.equal(result.allowed, false, 'an uncounted use must not be authorised');
  assert.equal(result.reason, 'use_count_failed');
  assert.equal(result.grant, null);
});

test('a use-count write that THROWS refuses the sign-in too', async () => {
  const supabase = supabaseStub({
    grants: [liveGrant],
    onUpdate: () => Promise.reject(new Error('connection reset'))
  });
  const result = await authorizeCredentialUse(supabase, 'u1', { site: 'johnlewis.com' });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'use_count_failed');
});

test('a counted use is still authorised, so the guard has not simply broken sign-in', async () => {
  const supabase = supabaseStub({
    grants: [liveGrant],
    // A matched row is what a successful compare-and-set returns.
    onUpdate: () => Promise.resolve({ data: { id: 'g1' }, error: null })
  });
  const result = await authorizeCredentialUse(supabase, 'u1', { site: 'johnlewis.com' });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'granted');
  assert.equal(result.grant.id, 'g1');
});


// A task-scoped grant is the BOUNDED permission -- "sign in for this one job" -- and it is
// the DEFAULT scope in validateGrantInput. It authorised nothing at all.
//
// authorizeCredentialUse was called with `session.pendingCredentialTaskId`, which is only
// assigned AFTER an offer has already been made, so at the moment of the decision it was
// always null and decideCredentialUse always answered 'wrong_task'. Worse, the only id
// available to bind a grant to was runOrderingTurnImpl's taskId -- a fresh randomUUID() on
// every turn -- so even a correctly-created task grant could never match a later turn. The
// net effect was that the only grant that worked was `standing`, the broader one: the
// bounded option silently failed and pushed the user to the permanent permission.
test('a task-scoped grant authorises the run it was bound to', () => {
  const runId = 'run-abc';
  const decision = decideCredentialUse({
    grant: grant({ scope: 'task', task_id: runId }),
    site: 'johnlewis.com',
    taskId: runId,
    now: NOW
  });
  assert.equal(decision.allowed, true, 'the bounded grant must actually work');
  assert.equal(decision.reason, 'granted');
});

test('a task-scoped grant is still refused for a different run, and for no run at all', () => {
  const bound = grant({ scope: 'task', task_id: 'run-abc' });
  assert.equal(decideCredentialUse({ grant: bound, site: 'johnlewis.com', taskId: 'run-xyz', now: NOW }).reason, 'wrong_task');
  assert.equal(decideCredentialUse({ grant: bound, site: 'johnlewis.com', taskId: null, now: NOW }).reason, 'wrong_task');
});

// Source-level tripwire, because the bug was not in the decision function -- that was always
// correct -- but in which id the caller handed it.
test('the browser loop authorises against the run id, not the per-turn one', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../../api/services/browser-task.js'), 'utf8');

  // The session-lifetime id must exist and be created once per run.
  assert.match(source, /credentialTaskId: randomUUID\(\)/,
    'a session needs a run-lifetime credential identity');

  const call = source.slice(source.indexOf('const authorized = await authorizeCredentialUse'));
  const body = call.slice(0, call.indexOf('.catch('));
  assert.match(body, /taskId: session\.credentialTaskId/,
    'the grant decision must use the run id');
  assert.doesNotMatch(body, /pendingCredentialTaskId/,
    'pendingCredentialTaskId is only set after an offer, so it is always null here');

  // The audit log has to agree with the decision: one run's 'used' and 'failed' rows must
  // sit under the same task, not under a run id and a null.
  assert.doesNotMatch(source, /outcome: 'failed',[\s\S]{0,120}pendingCredentialTaskId/,
    'the failure log must use the same run id the authorisation used');

  // And the ask has to tell the caller which id a task grant would bind to, or there is no
  // way to create a working one.
  assert.match(source, /type: 'ready_for_credential_use',[\s\S]{0,200}credentialTaskId: session\.credentialTaskId/,
    'the ask must surface the run id');
});


// The use cap is a cap only if two concurrent runs cannot both spend the same use.
//
// The increment was a read-modify-write: both runs read use_count 0, both wrote 1, and a
// grant capped at one sign-in paid for two. It is now a compare-and-set on the count that
// was read, so the second writer matches no row and is told, instead of silently
// overwriting the first.

/** A stub whose credential_grants row behaves like a real one under concurrency. */
function racyStub(stored, { stealBefore = 0 } = {}) {
  let claims = 0;
  return {
    from(table) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: [{ ...stored }], error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update(patch) {
          const filters = {};
          const p = {
            eq(column, value) { filters[column] = value; return p; },
            select: () => p,
            maybeSingle: () => p,
            then(resolve) {
              if (table !== 'credential_grants') return Promise.resolve({ data: null, error: null }).then(resolve);
              claims += 1;
              // Simulate another run winning the race for the first N attempts by moving
              // the count out from under this one.
              if (claims <= stealBefore) stored.use_count += 1;
              const matched = filters.use_count === stored.use_count;
              if (matched) stored.use_count = patch.use_count;
              return Promise.resolve({ data: matched ? { id: stored.id } : null, error: null }).then(resolve);
            }
          };
          return p;
        }
      };
      return chain;
    }
  };
}

function uncapped() {
  return {
    id: 'g1', site: 'johnlewis.com', scope: 'standing', task_id: null,
    expires_at: '2099-01-01T00:00:00Z', revoked_at: null,
    max_uses: null, use_count: 0, granted_via: 'user'
  };
}

test('a sign-in that loses the race retries against the fresh count and still succeeds', async () => {
  // An uncapped permission has no reason to refuse just because another run went first.
  const stored = uncapped();
  const result = await authorizeCredentialUse(racyStub(stored, { stealBefore: 1 }), 'u1', { site: 'johnlewis.com' });
  assert.equal(result.allowed, true);
  // One use stolen by the other run, one claimed by this one.
  assert.equal(stored.use_count, 2);
});

test('the retry re-checks the cap, so a race cannot push a capped grant past its limit', async () => {
  // The whole point of re-reading: the competing run consumed the last permitted use, so
  // retrying must refuse rather than claim a use that is no longer available.
  const stored = { ...uncapped(), max_uses: 1 };
  const result = await authorizeCredentialUse(racyStub(stored, { stealBefore: 1 }), 'u1', { site: 'johnlewis.com' });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'use_limit_reached');
  assert.equal(stored.use_count, 1, 'the cap must not be exceeded');
});

test('a counter that never settles gives up rather than spinning', async () => {
  const { MAX_CLAIM_ATTEMPTS } = require('../../api/services/credential-grants');
  const stored = uncapped();
  const result = await authorizeCredentialUse(racyStub(stored, { stealBefore: 99 }), 'u1', { site: 'johnlewis.com' });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'use_count_raced');
  assert.equal(stored.use_count, MAX_CLAIM_ATTEMPTS, 'it must stop after a bounded number of attempts');
});

test('the increment is a compare-and-set, not a blind write of the value just read', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../../api/services/credential-grants.js'), 'utf8');
  const claim = source.slice(source.indexOf('async function claimGrantUse'));
  const body = claim.slice(0, claim.indexOf('\n}'));

  assert.match(body, /\.eq\('use_count', current\)/,
    'without the compare-and-set both writers overwrite the same count');
  assert.match(body, /if \(!data\) return \{ ok: false, raced: true \}/,
    'a write that matched no row must be reported, not treated as success');
});

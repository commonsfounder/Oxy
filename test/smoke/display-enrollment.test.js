const assert = require('node:assert/strict');
const test = require('node:test');

const pairedDisplays = require('../../api/services/paired-displays');

function fakeSupabase() {
  const tables = { display_enrollments: [], paired_displays: [] };
  let seq = 0;
  function from(table) {
    const state = { filters: [], op: null, row: null };
    const chain = {
      select() { return chain; },
      delete() { state.op = 'delete'; return chain; },
      insert(row) { state.op = 'insert'; state.row = row; return chain; },
      eq(k, v) { state.filters.push(r => r[k] === v); return chain; },
      is(k, v) { state.filters.push(r => (v === null ? r[k] == null : r[k] === v)); return chain; },
      lt(k, v) { state.filters.push(r => new Date(r[k]) < new Date(v)); return chain; },
      single() {
        if (table === 'display_enrollments' && tables[table].some(r => r.code === state.row.code && !r.claimed_at)) {
          return Promise.resolve({ data: null, error: { code: '23505' } });
        }
        const row = { id: table + '-' + (seq += 1), claimed_at: null, display_id: null, ...state.row };
        tables[table].push(row);
        return Promise.resolve({ data: row, error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: tables[table].find(r => state.filters.every(f => f(r))) || null, error: null });
      },
      then(resolve, reject) {
        if (state.op === 'delete') tables[table] = tables[table].filter(r => !state.filters.every(f => f(r)));
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
    };
    return chain;
  }
  function rpc(name, args) {
    assert.equal(name, 'claim_display_enrollment');
    const enrollment = tables.display_enrollments.find(r => r.code === args.p_code && !r.claimed_at && new Date(r.expires_at) > new Date(args.p_now));
    if (!enrollment) return Promise.resolve({ data: null, error: { code: 'P0001' } });
    const display = { id: 'pd-' + (seq += 1), user_id: args.p_user_id, display_name: args.p_display_name || 'Screen', display_type: 'browser_display', capabilities: { text: true }, token_hash: enrollment.token_hash, paired_at: args.p_now, last_seen_at: null };
    tables.paired_displays.push(display);
    enrollment.claimed_at = args.p_now;
    enrollment.display_id = display.id;
    return Promise.resolve({ data: { display }, error: null });
  }
  return { tables, from, rpc };
}

test('a screen shows a 4-digit code, the person types it, and the screen finds out', async () => {
  const supabase = fakeSupabase();
  const enrollment = await pairedDisplays.createEnrollment(supabase);
  assert.match(enrollment.code, /^\d{4}$/);
  assert.equal(supabase.tables.display_enrollments[0].token_hash === enrollment.token, false, 'only a hash of the key is stored');

  assert.deepEqual(
    await pairedDisplays.enrollmentStatus(supabase, enrollment.id, enrollment.token),
    { status: 'waiting', expiresAt: enrollment.expiresAt }
  );
  assert.equal(await pairedDisplays.enrollmentStatus(supabase, enrollment.id, 'someone-elses-key'), null);

  const claimed = await pairedDisplays.claimEnrollment(supabase, 'u1', { code: enrollment.code.split('').join(' '), displayName: 'Kitchen' });
  assert.equal(claimed.display.name, 'Kitchen');

  const status = await pairedDisplays.enrollmentStatus(supabase, enrollment.id, enrollment.token);
  assert.equal(status.status, 'paired');
  assert.equal(status.display.id, claimed.display.id);
  assert.equal(pairedDisplays.hashSecret(enrollment.token), supabase.tables.paired_displays[0].token_hash, 'the screen already holds the key');
});

test('a code works once, a wrong code is turned away kindly, and tries are limited', async () => {
  const supabase = fakeSupabase();
  const enrollment = await pairedDisplays.createEnrollment(supabase);
  await pairedDisplays.claimEnrollment(supabase, 'u1', { code: enrollment.code });
  await assert.rejects(pairedDisplays.claimEnrollment(supabase, 'u2', { code: enrollment.code }), { code: 'invalid_code' });
  await assert.rejects(pairedDisplays.claimEnrollment(supabase, 'u3', { code: '12' }), { message: 'Enter the 4 digits shown on the screen.' });

  for (let i = 0; i < 8; i += 1) {
    await assert.rejects(pairedDisplays.claimEnrollment(supabase, 'u4', { code: '0000' }), { code: 'invalid_code' });
  }
  await assert.rejects(pairedDisplays.claimEnrollment(supabase, 'u4', { code: '0000' }), { code: 'too_many_tries' });
});

test('an expired code is gone, and a busy code is replaced with another', async () => {
  const supabase = fakeSupabase();
  const past = new Date('2026-01-01T00:00:00Z');
  const old = await pairedDisplays.createEnrollment(supabase, { now: past, randomInt: () => 7 });
  assert.equal(old.code, '0007');
  assert.equal((await pairedDisplays.enrollmentStatus(supabase, old.id, old.token, new Date('2026-01-01T00:10:00Z'))).status, 'expired');
  await assert.rejects(pairedDisplays.claimEnrollment(supabase, 'u1', { code: '0007', now: new Date('2026-01-01T00:10:00Z') }), { code: 'invalid_code' });

  const a = await pairedDisplays.createEnrollment(supabase, { randomInt: () => 42 });
  let n = 0;
  const b = await pairedDisplays.createEnrollment(supabase, { randomInt: () => (n++ < 2 ? 42 : 43) });
  assert.equal(a.code, '0042');
  assert.equal(b.code, '0043');
});

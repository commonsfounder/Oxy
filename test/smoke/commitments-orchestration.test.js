// The commitment actions against the REAL commitments table and demo-test-user: capture,
// person linking through the real people layer, resolution, and appearance in the real digest.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');
const { createSupabaseServiceClient } = require('../../runtime');

const supabase = createSupabaseServiceClient();
const USER_ID = 'demo-test-user';
const MARK = 'CmtTest';

async function cleanup() {
  await supabase.from('commitments').delete().eq('user_id', USER_ID).ilike('what', `%${MARK}%`);
  const { data } = await supabase.from('participants').select('id').eq('user_id', USER_ID).ilike('display_name', `${MARK}%`);
  if (data?.length) await supabase.from('participants').delete().in('id', data.map(p => p.id));
}

test.beforeEach(cleanup);
test.after(cleanup);

test('an explicit commitment is captured with its real due date', async () => {
  const result = await app.executeAction(USER_ID, 'track_commitment', {
    what: `send the ${MARK} documents`, person_name: `${MARK} Mia`, due: 'tomorrow'
  });
  assert.equal(result.success, true);
  assert.ok(result.commitment.due_at, 'a stated "tomorrow" must become a real date');
  assert.equal(result.commitment.due_is_date_only, true);
  assert.match(result.text, /Noted: send the CmtTest documents \(CmtTest Mia\) — due tomorrow/);
});

test('a commitment with no stated timing gets no invented deadline', async () => {
  const result = await app.executeAction(USER_ID, 'track_commitment', { what: `tidy the ${MARK} garage` });
  assert.equal(result.commitment.due_at, null);
  assert.match(result.text, /no date set/);
});

test('a commitment links to the canonical person when one is known', async () => {
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${MARK} Ben`, relationship: 'manager' });
  const result = await app.executeAction(USER_ID, 'track_commitment', {
    what: `send the ${MARK} report`, person_name: `${MARK} Ben`, due: 'Friday'
  });
  assert.ok(result.commitment.participant_id, 'it should resolve through the people layer, not just store a string');

  const owed = await app.executeAction(USER_ID, 'find_commitments', { person_name: `${MARK} Ben` });
  assert.equal(owed.commitments.length, 1);
  assert.match(owed.text, /send the CmtTest report/);
});

test('re-stating the same promise updates it instead of creating a second obligation', async () => {
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} slides`, due: 'tomorrow' });
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} slides`, due: 'Friday' });

  const { data } = await supabase.from('commitments').select('id, due_at')
    .eq('user_id', USER_ID).ilike('what', `%${MARK} slides%`);
  assert.equal(data.length, 1, 'moving a deadline must not leave two commitments');
});

test('"what have I promised?" and "what is overdue?" answer from real rows', async () => {
  await supabase.from('commitments').insert([
    { user_id: USER_ID, what: `pay the ${MARK} invoice`, due_at: '2026-08-01T00:00:00Z', due_is_date_only: true, status: 'open' },
    { user_id: USER_ID, what: `book the ${MARK} MOT`, due_at: '2099-01-01T00:00:00Z', due_is_date_only: true, status: 'open' }
  ]);

  const all = await app.executeAction(USER_ID, 'find_commitments', {});
  const mine = all.commitments.filter(c => c.what.includes(MARK));
  assert.equal(mine.length, 2);
  assert.equal(mine[0].overdue, true, 'overdue sorts first');

  const overdue = await app.executeAction(USER_ID, 'find_commitments', { overdue_only: true });
  const overdueMine = overdue.commitments.filter(c => c.what.includes(MARK));
  assert.deepEqual(overdueMine.map(c => c.what), [`pay the ${MARK} invoice`]);
});

test('"I already did that" closes it, and it stops being outstanding', async () => {
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} invoice`, due: 'tomorrow' });
  const resolved = await app.executeAction(USER_ID, 'resolve_commitment', { what: `${MARK} invoice` });
  assert.equal(resolved.success, true);
  assert.match(resolved.text, /Marked done/);

  const after = await app.executeAction(USER_ID, 'find_commitments', {});
  assert.equal(after.commitments.some(c => c.what.includes(`${MARK} invoice`)), false);

  const { data } = await supabase.from('commitments').select('status, resolved_at, resolved_by')
    .eq('user_id', USER_ID).ilike('what', `%${MARK} invoice%`).single();
  assert.equal(data.status, 'done');
  assert.ok(data.resolved_at);
  assert.equal(data.resolved_by, 'user', 'who closed it is recorded, so an auto-resolution is distinguishable');
});

test('an ambiguous resolution asks rather than guessing which promise to close', async () => {
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} report` });
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} receipt` });
  const result = await app.executeAction(USER_ID, 'resolve_commitment', { what: `send the ${MARK}` });
  assert.equal(result.success, false);
  assert.match(result.error, /More than one matches/);
});

test('resolving something that was never promised says so', async () => {
  const result = await app.executeAction(USER_ID, 'resolve_commitment', { what: `${MARK} nothing like this` });
  assert.equal(result.success, false);
  assert.match(result.error, /don't have an open commitment/);
});

test('"forget that one" cancels rather than marking it done', async () => {
  await app.executeAction(USER_ID, 'track_commitment', { what: `call the ${MARK} plumber` });
  await app.executeAction(USER_ID, 'resolve_commitment', { what: `${MARK} plumber`, outcome: 'cancelled' });
  const { data } = await supabase.from('commitments').select('status')
    .eq('user_id', USER_ID).ilike('what', `%${MARK} plumber%`).single();
  assert.equal(data.status, 'cancelled');
});

test('an overdue commitment genuinely appears in the real morning digest', async () => {
  await supabase.from('commitments').insert({
    user_id: USER_ID, what: `send the ${MARK} case study`, person_name: `${MARK} Mia`,
    due_at: '2026-08-01T00:00:00Z', due_is_date_only: true, status: 'open'
  });

  const digest = await app.executeAction(USER_ID, 'daily_digest', {});
  const item = digest.items.find(i => i.kind === 'commitment' && i.title.includes(MARK));
  assert.ok(item, 'an overdue promise is exactly what a morning digest is for');
  assert.match(item.detail, /You told CmtTest Mia you'd send the CmtTest case study — overdue/);
  assert.equal(item.urgency, 'now');
});

test('a resolved commitment leaves the digest', async () => {
  await supabase.from('commitments').insert({
    user_id: USER_ID, what: `send the ${MARK} deck`, due_at: '2026-08-01T00:00:00Z',
    due_is_date_only: true, status: 'open'
  });
  const before = await app.executeAction(USER_ID, 'daily_digest', {});
  assert.ok(before.items.some(i => i.title.includes(`${MARK} deck`)));

  await app.executeAction(USER_ID, 'resolve_commitment', { what: `${MARK} deck` });
  const after = await app.executeAction(USER_ID, 'daily_digest', {});
  assert.equal(after.items.some(i => i.title.includes(`${MARK} deck`)), false);
});

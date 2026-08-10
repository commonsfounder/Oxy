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
  assert.equal(result.ambiguous, true);
  assert.equal(result.candidates.length, 2, 'the full candidate list is returned, not just a formatted string, so the caller can present real choices');
  assert.match(result.error, /More than one matches/);
});

// ── Explicit completion path: adversarial ────────────────────────────────────────────────
// "I already did it" is strong evidence when it is clear which promise is meant, and must
// stay conservative when it is not — the same standard as the sent-mail evidence path.
test('the same task promised to two different people: naming the person resolves cleanly', async () => {
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} report`, person_name: `${MARK} Mia` });
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} report`, person_name: `${MARK} Ben` });

  // Without a person, genuinely ambiguous — same task, two people.
  const noPerson = await app.executeAction(USER_ID, 'resolve_commitment', { what: `${MARK} report` });
  assert.equal(noPerson.success, false);
  assert.equal(noPerson.ambiguous, true);
  assert.equal(noPerson.candidates.length, 2);

  // "I already sent Ben the report" — naming the person narrows it to exactly one.
  const withPerson = await app.executeAction(USER_ID, 'resolve_commitment', { what: `${MARK} report`, person_name: `${MARK} Ben` });
  assert.equal(withPerson.success, true);

  const { data } = await supabase.from('commitments').select('status, person_name')
    .eq('user_id', USER_ID).ilike('what', `%${MARK} report%`).order('person_name');
  const ben = data.find(c => c.person_name === `${MARK} Ben`);
  const mia = data.find(c => c.person_name === `${MARK} Mia`);
  assert.equal(ben.status, 'done', 'the one actually named is closed');
  assert.equal(mia.status, 'open', 'the other person\'s identical task is untouched');
});

test('one person, two different obligations: a specific query resolves the right one', async () => {
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} invoice`, person_name: `${MARK} Mia` });
  await app.executeAction(USER_ID, 'track_commitment', { what: `call the ${MARK} landlord`, person_name: `${MARK} Mia` });

  // A vague query naming only the person is still ambiguous — two different things are owed.
  const vague = await app.executeAction(USER_ID, 'resolve_commitment', { what: '', person_name: `${MARK} Mia` });
  assert.equal(vague.success, false, 'an empty what with only a person is not specific enough to resolve anything');

  const specific = await app.executeAction(USER_ID, 'resolve_commitment', { what: `${MARK} landlord`, person_name: `${MARK} Mia` });
  assert.equal(specific.success, true);
  const { data } = await supabase.from('commitments').select('what, status').eq('user_id', USER_ID).ilike('what', `%${MARK}%`);
  const landlord = data.find(c => c.what.includes('landlord'));
  const invoice = data.find(c => c.what.includes('invoice'));
  assert.equal(landlord.status, 'done');
  assert.equal(invoice.status, 'open', 'the other obligation to the same person is untouched');
});

test('a vague "done" with several unrelated commitments open does not arbitrarily pick one', async () => {
  await app.executeAction(USER_ID, 'track_commitment', { what: `pay the ${MARK} rent` });
  await app.executeAction(USER_ID, 'track_commitment', { what: `book the ${MARK} dentist` });
  await app.executeAction(USER_ID, 'track_commitment', { what: `call the ${MARK} bank` });
  // A query too generic to match any single "what" resolves nothing — the calling agent is
  // responsible for supplying which one the user actually meant from conversation context;
  // the code-level backstop here is simply: never guess when the query does not single one out.
  const result = await app.executeAction(USER_ID, 'resolve_commitment', { what: MARK });
  assert.equal(result.success, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.candidates.length, 3);
});

test('a commitment resolved by id is exact, ignoring any wording collision with other rows', async () => {
  const a = await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} draft` });
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} draft again` });
  const result = await app.executeAction(USER_ID, 'resolve_commitment', { id: a.commitment.id });
  assert.equal(result.success, true);
  const { data } = await supabase.from('commitments').select('id, status').eq('id', a.commitment.id).single();
  assert.equal(data.status, 'done');
  const { data: other } = await supabase.from('commitments').select('status')
    .eq('user_id', USER_ID).ilike('what', `%${MARK} draft again%`).single();
  assert.equal(other.status, 'open', 'the similarly-worded sibling is untouched — id bypasses text matching entirely');
});

test('rescheduling then completing resolves the CURRENT commitment, not a stale duplicate', async () => {
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} agenda`, due: 'tomorrow' });
  // Re-stating with a new date updates in place — this is the documented reschedule path.
  await app.executeAction(USER_ID, 'track_commitment', { what: `send the ${MARK} agenda`, due: 'Friday' });
  const { data: beforeResolve } = await supabase.from('commitments').select('id')
    .eq('user_id', USER_ID).ilike('what', `%${MARK} agenda%`);
  assert.equal(beforeResolve.length, 1, 'rescheduling must not have produced a second row');

  const resolved = await app.executeAction(USER_ID, 'resolve_commitment', { what: `${MARK} agenda` });
  assert.equal(resolved.success, true);
  const { data: afterResolve } = await supabase.from('commitments').select('status')
    .eq('user_id', USER_ID).ilike('what', `%${MARK} agenda%`).single();
  assert.equal(afterResolve.status, 'done');
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

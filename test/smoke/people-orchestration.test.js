// The people actions against REAL Supabase (participants, participant_addresses,
// person_facts, occasions) and demo-test-user. Identity resolution is the whole point of
// this feature, and "did it merge two records or create two" cannot be proved with a mock.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');
const { createSupabaseServiceClient } = require('../../runtime');

const supabase = createSupabaseServiceClient();
const USER_ID = 'demo-test-user';
const PREFIX = 'PplTest';

async function cleanup() {
  const { data } = await supabase.from('participants').select('id').eq('user_id', USER_ID).ilike('display_name', `${PREFIX}%`);
  const ids = (data || []).map(p => p.id);
  if (ids.length) {
    await supabase.from('occasions').update({ participant_id: null }).in('participant_id', ids);
    await supabase.from('participants').delete().in('id', ids);
  }
  await supabase.from('occasions').delete().eq('user_id', USER_ID).ilike('person_name', `${PREFIX}%`);
}

test.beforeEach(cleanup);
test.after(cleanup);

async function factsFor(participantId) {
  const { data } = await supabase.from('person_facts').select('fact, kind').eq('participant_id', participantId);
  return (data || []).map(f => f.fact);
}

// ── Explicit relationship capture ──────────────────────────────────────────────────────
test('an explicitly stated relationship is captured and durably retrievable', async () => {
  const saved = await app.executeAction(USER_ID, 'remember_person', {
    person_name: `${PREFIX} Alisa`, relationship: 'girlfriend'
  });
  assert.equal(saved.success, true);
  assert.equal(saved.created, true);

  // Genuinely re-read, not returned from the write.
  const found = await app.executeAction(USER_ID, 'find_people', { query: `${PREFIX} Alisa` });
  assert.equal(found.people.length, 1);
  assert.equal(found.people[0].relationship, 'girlfriend');
  assert.equal(found.ambiguous, false);
});

// ── Identity by email + name ───────────────────────────────────────────────────────────
test('a name and an email address converge on one person, not two records', async () => {
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} Mia`, relationship: 'colleague' });
  // A later turn learns her address — same person, so it must attach, not fork.
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} Mia`, email: 'ppltest.mia@example.com' });

  const { data: rows } = await supabase.from('participants').select('id').eq('user_id', USER_ID).eq('display_name', `${PREFIX} Mia`);
  assert.equal(rows.length, 1, 'learning an address must not create a second Mia');

  // And the address alone now resolves her, with the relationship intact.
  const byEmail = await app.executeAction(USER_ID, 'find_people', { email: 'ppltest.mia@example.com' });
  assert.equal(byEmail.people.length, 1);
  assert.equal(byEmail.people[0].relationship, 'colleague');
  assert.deepEqual(byEmail.people[0].emails, ['ppltest.mia@example.com']);
});

test('an address seen first, then a name, still resolves to a single person', async () => {
  await app.executeAction(USER_ID, 'remember_person', { email: 'ppltest.james@example.com' });
  const named = await app.executeAction(USER_ID, 'remember_person', {
    person_name: `${PREFIX} James Whitfield`, email: 'ppltest.james@example.com', relationship: 'tutor'
  });
  assert.equal(named.created, false, 'the address should have matched the existing record');
  assert.equal(named.person.name, `${PREFIX} James Whitfield`, 'the real name should replace the address placeholder');

  const { data: rows } = await supabase.from('participant_addresses')
    .select('participant_id').eq('address_value', 'ppltest.james@example.com');
  assert.equal(rows.length, 1);
});

// ── Same name, different people ────────────────────────────────────────────────────────
test('two people with the same name are never auto-merged; the second needs an explicit signal', async () => {
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} James`, relationship: 'tutor' });

  // A bare re-statement updates the one that exists.
  const second = await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} James`, relationship: 'manager' });
  assert.equal(second.created, false);

  // "That's a different James" forces a genuinely separate record.
  const forked = await app.executeAction(USER_ID, 'remember_person', {
    person_name: `${PREFIX} James`, relationship: 'plumber', different_person: true
  });
  assert.equal(forked.created, true);

  const { data: rows } = await supabase.from('participants').select('id, relationship').eq('user_id', USER_ID).eq('display_name', `${PREFIX} James`);
  assert.equal(rows.length, 2);

  // And now the ambiguous name refuses to write rather than picking one.
  const ambiguous = await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} James`, facts: 'likes cycling' });
  assert.equal(ambiguous.success, false);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.candidates.length, 2);

  const lookup = await app.executeAction(USER_ID, 'find_people', { query: `${PREFIX} James` });
  assert.equal(lookup.ambiguous, true);
  assert.match(lookup.text, /Which one\?/);
});

test('an ambiguous name still resolves cleanly when an address disambiguates it', async () => {
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} James`, email: 'ppltest.j1@example.com' });
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} James`, email: 'ppltest.j2@example.com', different_person: true });

  const targeted = await app.executeAction(USER_ID, 'remember_person', {
    person_name: `${PREFIX} James`, email: 'ppltest.j2@example.com', facts: 'prefers evening calls'
  });
  assert.equal(targeted.success, true, 'the address is definitive evidence, so this must not be ambiguous');
  assert.equal(targeted.person.emails[0], 'ppltest.j2@example.com');
  assert.deepEqual(targeted.person.facts.map(f => f.fact), ['prefers evening calls']);
});

// ── Contact + occasion merge ───────────────────────────────────────────────────────────
test('a saved birthday links to the same person record, so gift context connects', async () => {
  await app.executeAction(USER_ID, 'remember_person', {
    person_name: `${PREFIX} Alisa`, relationship: 'girlfriend', facts: 'prefers gold jewellery', fact_kind: 'preference'
  });
  const saved = await app.executeAction(USER_ID, 'save_occasion', {
    person_name: `${PREFIX} Alisa`, occasion_type: 'birthday', month: 7, day: 12
  });
  assert.equal(saved.success, true);

  const { data: occasion } = await supabase.from('occasions').select('participant_id')
    .eq('user_id', USER_ID).eq('person_name', `${PREFIX} Alisa`).single();
  assert.ok(occasion.participant_id, 'the occasion should be linked to the person');

  // One lookup now answers recipient + preference + date together.
  const profile = await app.executeAction(USER_ID, 'find_people', { query: `${PREFIX} Alisa` });
  const her = profile.people[0];
  assert.equal(her.id, occasion.participant_id);
  assert.equal(her.relationship, 'girlfriend');
  assert.deepEqual(her.facts.map(f => f.fact), ['prefers gold jewellery']);
  assert.deepEqual(her.occasions, [{ occasionType: 'birthday', month: 7, day: 12 }]);
});

test('a birthday stated for an unknown person creates that person rather than a dangling name', async () => {
  await app.executeAction(USER_ID, 'save_occasion', {
    person_name: `${PREFIX} Mum`, occasion_type: 'birthday', month: 10, day: 8, relationship: 'mum'
  });
  const found = await app.executeAction(USER_ID, 'find_people', { query: `${PREFIX} Mum` });
  assert.equal(found.people.length, 1);
  assert.equal(found.people[0].relationship, 'mum');
  assert.deepEqual(found.people[0].occasions, [{ occasionType: 'birthday', month: 10, day: 8 }]);
});

// ── Correction ─────────────────────────────────────────────────────────────────────────
test('a correction replaces the outdated fact instead of stacking a contradiction', async () => {
  const created = await app.executeAction(USER_ID, 'remember_person', {
    person_name: `${PREFIX} Alisa`, facts: 'prefers silver jewellery', fact_kind: 'preference'
  });
  await app.executeAction(USER_ID, 'remember_person', {
    person_name: `${PREFIX} Alisa`, facts: 'prefers gold jewellery', replaces: 'silver', fact_kind: 'preference'
  });

  const facts = await factsFor(created.person.id);
  assert.deepEqual(facts, ['prefers gold jewellery'], 'the silver preference must be gone, not merely outnumbered');
});

test('re-stating the same fact updates it rather than duplicating it', async () => {
  const created = await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} Mum`, facts: 'likes gardening' });
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} Mum`, facts: 'likes gardening' });
  assert.deepEqual(await factsFor(created.person.id), ['likes gardening']);
});

// ── Deletion / forgetting ──────────────────────────────────────────────────────────────
test('"Ben isn\'t my manager anymore" clears the relationship without deleting the person', async () => {
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} Ben`, relationship: 'manager', facts: 'based in Leeds' });
  const forgotten = await app.executeAction(USER_ID, 'forget_person_detail', { person_name: `${PREFIX} Ben`, clear_relationship: true });
  assert.equal(forgotten.success, true);

  const found = await app.executeAction(USER_ID, 'find_people', { query: `${PREFIX} Ben` });
  assert.equal(found.people.length, 1, 'the person must still exist');
  assert.equal(found.people[0].relationship, null);
  assert.deepEqual(found.people[0].facts.map(f => f.fact), ['based in Leeds'], 'unrelated facts must survive');
});

test('"forget that preference" removes one fact, never the whole person', async () => {
  const created = await app.executeAction(USER_ID, 'remember_person', {
    person_name: `${PREFIX} Alisa`, relationship: 'girlfriend', facts: 'prefers gold jewellery; allergic to lilies'
  });
  await app.executeAction(USER_ID, 'forget_person_detail', { person_name: `${PREFIX} Alisa`, facts: 'lilies' });

  assert.deepEqual(await factsFor(created.person.id), ['prefers gold jewellery']);
  const found = await app.executeAction(USER_ID, 'find_people', { query: `${PREFIX} Alisa` });
  assert.equal(found.people[0].relationship, 'girlfriend');
});

test('forgetting a person entirely is possible but has to be asked for explicitly', async () => {
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} Temp`, relationship: 'plumber' });
  const gone = await app.executeAction(USER_ID, 'forget_person_detail', { person_name: `${PREFIX} Temp`, delete_person: true });
  assert.equal(gone.deleted, true);

  const found = await app.executeAction(USER_ID, 'find_people', { query: `${PREFIX} Temp` });
  assert.equal(found.people.length, 0);
});

// ── Recipient resolution ───────────────────────────────────────────────────────────────
test('"my manager" resolves to the right person and their real address', async () => {
  await app.executeAction(USER_ID, 'remember_person', {
    person_name: `${PREFIX} Ben`, relationship: 'manager', email: 'ppltest.ben@example.com'
  });
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} Alisa`, relationship: 'girlfriend' });

  const found = await app.executeAction(USER_ID, 'find_people', { relationship: 'manager' });
  assert.equal(found.people.length, 1);
  assert.equal(found.people[0].name, `${PREFIX} Ben`);
  assert.deepEqual(found.people[0].emails, ['ppltest.ben@example.com']);
});

test('an unknown person is admitted, never invented', async () => {
  const found = await app.executeAction(USER_ID, 'find_people', { query: `${PREFIX} Nobody` });
  assert.equal(found.people.length, 0);
  assert.match(found.text, /don't have anyone saved as/);
});

test('the live prompt roster reflects real saved people', async () => {
  await app.executeAction(USER_ID, 'remember_person', { person_name: `${PREFIX} Ben`, relationship: 'manager' });
  const { data } = await supabase.from('participants').select('display_name, relationship')
    .eq('user_id', USER_ID).ilike('display_name', `${PREFIX}%`);
  const line = require('../../api/services/people').peopleContextLine(data);
  assert.match(line, new RegExp(`${PREFIX} Ben \\(manager\\)`));
});

// Guards the RLS posture of the six tables that once shipped without row-level security, where
// the public anon key could read across users and insert. Two layers: a static check that the
// migration keeps covering all six, and a live client-context check that runs only when a
// SUPABASE_ANON_KEY is present — opt-in, since the key isn't in this repo.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const PROTECTED_TABLES = [
  'millie_identities',
  'millie_identity_handles',
  'participants',
  'participant_addresses',
  'external_conversations',
  'external_conversation_events'
];

const MIGRATION = path.join(__dirname, '../../supabase/migrations/supabase-migration-rls-identity-participants.sql');

test('the RLS migration still enables row level security on every affected table', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  for (const table of PROTECTED_TABLES) {
    assert.match(
      sql,
      new RegExp(`alter table ${table} enable row level security`, 'i'),
      `${table} must stay in the RLS migration — it was readable and writable by the public anon key without it`
    );
  }
});

test('the migration adds no policies, matching the posture every other table in this schema uses', () => {
  // This project has no Supabase Auth: auth.uid() is always null, the Node backend enforces
  // per-user access with the service-role key (which bypasses RLS), and a policy written
  // against auth.uid() would match nothing. RLS-on with zero policies is what actually
  // denies anon/authenticated here — inventing a permissive policy would undo the fix.
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /using \(true\)/i);
});

test('every table this pass created also enables RLS in its own migration', () => {
  const dir = path.join(__dirname, '../../supabase/migrations');
  const expectations = [
    ['supabase-migration-people.sql', 'person_facts'],
    ['supabase-migration-purchases.sql', 'purchases']
  ];
  for (const [file, table] of expectations) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.match(sql, new RegExp(`alter table ${table} enable row level security`, 'i'),
      `${table} must ship with RLS enabled, not be added to the backlog of tables that did not`);
  }
});

// The live half. Set SUPABASE_ANON_KEY to run it; the key is public by design but is not
// committed here.
const anonKey = process.env.SUPABASE_ANON_KEY;
const supabaseUrl = process.env.SUPABASE_URL;

test('a client context can read nothing from the protected tables', { skip: !anonKey || !supabaseUrl ? 'set SUPABASE_ANON_KEY to run the live RLS check' : false }, async () => {
  for (const table of PROTECTED_TABLES) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*&limit=5`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` }
    });
    const rows = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(rows, [], `${table} must return no rows to a client context`);
  }
});

test('a client context cannot insert into the protected tables', { skip: !anonKey || !supabaseUrl ? 'set SUPABASE_ANON_KEY to run the live RLS check' : false }, async () => {
  const res = await fetch(`${supabaseUrl}/rest/v1/participants`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: 'demo-test-user', display_name: 'RLS regression probe', source: 'manual' })
  });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /row-level security policy/);
});

'use strict';

// The iOS Vault screen decodes these with non-optional properties, so a missing key is not a
// blank row — Codable throws and the whole list fails to load, and neither toolchain notices
// when one side drops a column. Two directions checked: every key the decoder requires is
// selected by the query, and the not-null columns really are not-null in the migration.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const VAULT_VIEW = path.join(__dirname, '../../OxyApp/OxyApp/Views/Vault/VaultView.swift');
const GRANTS_SERVICE = path.join(__dirname, '../../api/services/credential-grants.js');
const MIGRATION = path.join(__dirname, '../../supabase/migrations/supabase-migration-credential-grants.sql');

const swift = fs.readFileSync(VAULT_VIEW, 'utf8');
const service = fs.readFileSync(GRANTS_SERVICE, 'utf8');
const migration = fs.readFileSync(MIGRATION, 'utf8');

/** The server-side column names a Swift struct's CodingKeys block maps onto. */
function serverKeysFor(structName) {
  const start = swift.indexOf(`struct ${structName}`);
  assert.notEqual(start, -1, `${structName} not found in VaultView.swift`);
  const block = swift.slice(start, swift.indexOf('\n}', swift.indexOf('enum CodingKeys', start)));

  const keys = new Set();
  // `case id, site, scope` — name and column are the same.
  for (const line of block.split('\n')) {
    const plain = line.match(/^\s*case ([a-zA-Z, ]+)$/);
    if (plain) plain[1].split(',').map(k => k.trim()).filter(Boolean).forEach(k => keys.add(k));
    // `case expiresAt = "expires_at"` — the string is the column.
    const mapped = line.match(/^\s*case \w+ = "([^"]+)"/);
    if (mapped) keys.add(mapped[1]);
  }
  assert.ok(keys.size > 0, `${structName} declared no coding keys`);
  return keys;
}

/** The columns a named function's .select('...') asks Supabase for. */
function selectedColumns(functionName) {
  const start = service.indexOf(`async function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} not found`);
  const body = service.slice(start, service.indexOf('\n}', start));
  const select = body.match(/\.select\('([^']+)'\)/);
  assert.ok(select, `${functionName} has no .select()`);
  return new Set(select[1].split(',').map(c => c.trim()));
}

test('every column the iOS grant list decodes is actually selected', () => {
  const required = serverKeysFor('VaultGrantSummary');
  const selected = selectedColumns('listGrants');
  const missing = [...required].filter(key => !selected.has(key));
  assert.deepEqual(missing, [], `GET /vault/grants does not select: ${missing.join(', ')}`);
});

test('every column the iOS activity list decodes is actually selected', () => {
  const required = serverKeysFor('VaultCredentialUse');
  const selected = selectedColumns('listUses');
  const missing = [...required].filter(key => !selected.has(key));
  assert.deepEqual(missing, [], `GET /vault/credential-uses does not select: ${missing.join(', ')}`);
});

test('the columns iOS decodes as non-optional are not-null in the schema', () => {
  // These are the Swift properties declared without `?`. A null here throws on decode and
  // takes the entire list down with it, so the guarantee has to come from the table.
  const nonOptional = {
    credential_grants: ['site', 'scope'],
    credential_use_log: ['site', 'outcome']
  };

  for (const [table, columns] of Object.entries(nonOptional)) {
    const start = migration.indexOf(`create table if not exists ${table}`);
    assert.notEqual(start, -1, `${table} not found in the migration`);
    const body = migration.slice(start, migration.indexOf(');', start));
    for (const column of columns) {
      const line = body.split('\n').find(l => l.trim().startsWith(`${column} `));
      assert.ok(line, `${table}.${column} not declared`);
      assert.match(line, /not null/, `${table}.${column} must be not null — iOS decodes it as non-optional`);
    }
  }
});

test('the permission sheet cannot ask for a longer life than the server allows', () => {
  const { MAX_TTL_MINUTES } = require('../../api/services/credential-grants');
  const cases = swift.match(/case \.(day|week|month): return (\d+)/g) || [];
  assert.equal(cases.length, 3, 'expected three lifetime options');
  for (const entry of cases) {
    const minutes = Number(entry.match(/return (\d+)/)[1]);
    assert.ok(minutes > 0 && minutes <= MAX_TTL_MINUTES,
      `${entry} exceeds the server cap of ${MAX_TTL_MINUTES} minutes and would be rejected`);
  }
});

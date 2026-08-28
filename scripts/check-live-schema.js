#!/usr/bin/env node

// Proves the live database matches the user-data manifest. `npm test` only compares the manifest
// to the SQL files on disk, so it cannot tell whether those files were ever applied — a green
// suite is compatible with production missing declared tables entirely.
//
//   node scripts/check-live-schema.js

require('dotenv').config();

const { auditLiveSchema, USER_DATA_RESOURCES } = require('../api/services/user-data-lifecycle');

// Tables that legitimately exist in the database but are deliberately not part of the
// account manifest.  Add to this ONLY with a stated reason; an empty list is the goal.
const IGNORED_TABLES = Object.freeze([]);

async function fetchLiveTables() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY must be set to check the live schema.');

  const response = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!response.ok) throw new Error(`Could not read the live schema (HTTP ${response.status}).`);

  const body = await response.json();
  const definitions = body.definitions || body.components?.schemas || {};
  const tables = Object.keys(definitions);
  if (!tables.length) throw new Error('The live schema came back empty; refusing to report a false pass.');
  return tables;
}

async function main() {
  const liveTables = await fetchLiveTables();
  const result = auditLiveSchema({
    liveTables,
    resources: USER_DATA_RESOURCES,
    ignore: IGNORED_TABLES
  });
  console.log(`Live schema OK — ${USER_DATA_RESOURCES.length} declared tables all present, ${result.checked} tables seen, nothing undeclared.`);
}

main().catch(error => {
  console.error('\nLIVE SCHEMA CHECK FAILED\n');
  console.error(error.message);

  const details = error.message.match(/\{.*\}/);
  if (details) {
    try {
      const { absent = [], unregistered = [] } = JSON.parse(details[0]);
      if (absent.length) {
        console.error(`\n  Missing from the database (${absent.length}): ${absent.join(', ')}`);
        console.error('  Account export and deletion will fail for every user until these exist.');
        console.error('  Fix: apply the matching file in supabase/migrations/.');
      }
      if (unregistered.length) {
        console.error(`\n  In the database but undeclared (${unregistered.length}): ${unregistered.join(', ')}`);
        console.error('  Nothing exports or deletes these, so any user data inside is stranded.');
        console.error('  Fix: add each to USER_DATA_RESOURCES, or drop the table if it is retired.');
      }
    } catch { /* the raw message above is enough */ }
  }
  process.exitCode = 1;
});

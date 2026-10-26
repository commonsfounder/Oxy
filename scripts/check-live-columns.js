#!/usr/bin/env node

// Finds queries that ask the live database for a column it does not have. check-live-schema.js
// only proves the tables exist; a missing column fails every query that names it, and the app
// reads that as "no rows". Read-only.
//
//   node scripts/check-live-columns.js

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.js') && !full.endsWith(' 2.js')) out.push(full);
  }
  return out;
}

// Every literal `.from('table').select('a, b, c')` in the app, with where it was written.
function selectShapes() {
  const shapes = new Map();
  for (const file of [...sourceFiles(path.join(root, 'api')), ...sourceFiles(path.join(root, 'connectors'))]) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\.from\('([a-z_]+)'\)\s*\n?\s*\.select\('([^']*)'/g)) {
      const columns = match[2].replace(/\s+/g, '');
      if (columns === '*' || /[()!:]/.test(columns)) continue;
      const key = `${match[1]}|${columns}`;
      shapes.set(key, [...(shapes.get(key) || []), path.relative(root, file)]);
    }
  }
  return shapes;
}

async function liveColumns() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY must be set.');
  const response = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`Could not read the live schema (HTTP ${response.status}).`);
  const body = await response.json();
  const definitions = body.definitions || body.components?.schemas || {};
  if (!Object.keys(definitions).length) throw new Error('The live schema came back empty; refusing to report a false pass.');
  return Object.fromEntries(Object.entries(definitions).map(([table, def]) => [table, new Set(Object.keys(def.properties || {}))]));
}

async function main() {
  const live = await liveColumns();
  const problems = [];
  const shapes = selectShapes();
  for (const [key, files] of shapes) {
    const [table, columns] = key.split('|');
    if (!live[table]) { problems.push(`${table}: table is missing (${[...new Set(files)].join(', ')})`); continue; }
    const missing = columns.split(',').filter(column => !live[table].has(column));
    if (missing.length) problems.push(`${table}: no column ${missing.join(', ')} (${[...new Set(files)].join(', ')})`);
  }
  if (problems.length) {
    console.error(`\nLIVE COLUMN CHECK FAILED — ${problems.length} query shape(s) name columns the database lacks:\n`);
    problems.forEach(problem => console.error(`  ${problem}`));
    console.error('\nFix: apply the matching file in supabase/migrations/, or stop selecting the column.');
    process.exit(1);
  }
  console.log(`Live columns OK — ${shapes.size} query shapes checked.`);
}

main().catch(error => {
  console.error(`\nLIVE COLUMN CHECK FAILED\n\n${error.message}`);
  process.exit(1);
});

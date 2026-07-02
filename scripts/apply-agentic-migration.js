#!/usr/bin/env node
/**
 * Agentic Migration Runner for Oxy
 * Loads the SQL from supabase-migration-agentic.sql and provides instructions + attempts basic verification.
 * 
 * Because Supabase client doesn't support arbitrary DDL, this script:
 * 1. Prints the full SQL for you to paste into the Supabase SQL Editor (recommended).
 * 2. Tries to connect with your keys and checks if the new tables exist.
 * 3. If not, reminds you to run the SQL.
 *
 * Usage: node scripts/apply-agentic-migration.js
 * Make sure your .env or Documents/Oxy/.env has SUPABASE_URL and SUPABASE_KEY (service key recommended for schema)
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

// Try loading from common locations
const envPaths = [
  path.join(__dirname, '..', '.env'),
  '/Users/chizigamonyewuchi/Documents/Oxy/.env',
  path.join(process.cwd(), '.env')
];

let loaded = false;
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    console.log(`Loaded env from ${p}`);
    loaded = true;
    break;
  }
}

if (!loaded) {
  console.log('No .env found in expected locations. Set SUPABASE_URL and SUPABASE_KEY in shell.');
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY. Cannot connect.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const migrationPath = path.join(__dirname, '..', 'supabase-migration-agentic.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

console.log('\n=== OXY AGENTIC MIGRATION ===\n');
console.log('Full SQL to run in Supabase Dashboard > SQL Editor (copy and paste):');
console.log('---------------------------------------------');
console.log(sql);
console.log('---------------------------------------------\n');

console.log('Attempting to verify current state with Supabase client...');

async function checkTables() {
  const tablesToCheck = ['agent_tasks', 'agent_traces', 'simulation_runs'];
  for (const table of tablesToCheck) {
    try {
      const { data, error } = await supabase.from(table).select('*').limit(1);
      if (error) {
        if (error.message.includes('relation') || error.message.includes('does not exist')) {
          console.log(`❌ Table "${table}" does NOT exist yet. Migration needed.`);
        } else {
          console.log(`⚠️ Table "${table}" check error: ${error.message}`);
        }
      } else {
        console.log(`✅ Table "${table}" exists (or accessible). Rows sample: ${data ? data.length : 0}`);
      }
    } catch (e) {
      console.log(`Error checking ${table}: ${e.message}`);
    }
  }

  // Check for new columns on existing tables
  try {
    const { data, error } = await supabase.from('conversations').select('agentic, trace_id').limit(1);
    if (!error) {
      console.log('✅ conversations table has (or allows) agentic, trace_id columns');
    } else {
      console.log(`⚠️ conversations columns check: ${error.message}`);
    }
  } catch (e) {
    console.log('Note: column check limited by client.');
  }

  console.log('\nNext: Paste the SQL above into your Supabase project SQL editor and run it.');
  console.log('Then re-run this script or restart server to verify.');
  console.log('After migration, you can test with: node -e "console.log(require(\'./api/services/task-manager\'))" or use the /agent/tasks endpoints.');
}

checkTables().catch(console.error);
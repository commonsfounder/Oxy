#!/usr/bin/env node
// Adam's shared phone numbers.
//
//   node scripts/phone-pool.js list         show the pool
//   node scripts/phone-pool.js add [count]  buy numbers into the pool (default 1)
//
// Buying needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, APP_URL and, for UK numbers,
// TWILIO_BUNDLE_SID. Each number costs money every month: this asks for nothing more than
// the count you give it.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { addPoolNumber } = require('../api/services/phone-pool');
const { provisionPhoneNumber } = require('../connectors/phone-provider');

async function main() {
  const [command = 'list', countArg = '1'] = process.argv.slice(2);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY must be set.');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  if (command === 'add') {
    const count = Number(countArg);
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('count must be a whole number from 1 to 20.');
    for (let i = 0; i < count; i++) {
      const row = await addPoolNumber(supabase, provisionPhoneNumber);
      console.log(`Added ${row.phone_number} (${row.provider} ${row.provider_ref || ''})`);
    }
    return;
  }
  if (command !== 'list') throw new Error(`Unknown command "${command}". Use list or add.`);

  const { data, error } = await supabase.from('phone_number_pool').select('*').order('created_at', { ascending: true });
  if (error) throw new Error(`Could not read the pool: ${error.message}`);
  if (!data.length) console.log('The pool is empty. Add a number with: node scripts/phone-pool.js add');
  for (const row of data) console.log(`${row.phone_number}  ${row.status}  ${row.provider}  added ${row.created_at}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

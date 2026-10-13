#!/usr/bin/env node

// Weekly usage from the live database: active people, retention, actions the execution boundary
// actually ran, completed tasks. Test accounts are always excluded; exclude yourself too, because
// "people other than the founder" is the number that matters.
//
//   OXY_TRACTION_EXCLUDE_USERS=<your user_id>,<cofounder user_id> node scripts/traction-report.js [weeks] [--json]

require('dotenv').config();

const { createSupabaseServiceClient } = require('../runtime');
const { formatTractionReport, summarizeTraction, weeksEnding } = require('../api/services/traction-metrics');

const PAGE = 1000;

async function fetchAll(supabase, table, columns, since) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const weeks = Math.max(2, Math.min(52, Number(args.find(a => /^\d+$/.test(a))) || 8));
  const now = new Date();
  const since = `${weeksEnding(now, weeks)[0]}T00:00:00Z`;
  const excludeIds = (process.env.OXY_TRACTION_EXCLUDE_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

  const supabase = createSupabaseServiceClient();
  const [messages, actions, tasks, users] = await Promise.all([
    fetchAll(supabase, 'conversations', 'user_id, role, created_at', since),
    fetchAll(supabase, 'action_log', 'user_id, status, created_at', since),
    fetchAll(supabase, 'agent_tasks', 'user_id, status, created_at, updated_at, completed_at', since),
    fetchAll(supabase, 'users', 'user_id, created_at', since)
  ]);

  const summary = summarizeTraction({ messages, actions, tasks, users, excludeIds, now, weeks });
  console.log(args.includes('--json') ? JSON.stringify(summary, null, 2) : formatTractionReport(summary));
  if (!excludeIds.length) {
    console.error('\nNote: OXY_TRACTION_EXCLUDE_USERS is empty, so your own account is counted.');
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

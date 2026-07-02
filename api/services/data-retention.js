'use strict';
/*
 * Data retention sweep.
 *
 * The privacy policy promises bounded retention (conversations kept ~180 days,
 * etc.). Nothing enforced that promise until this module. It is split into:
 *   - pure planners (selectExpiredConversationIds) — fully unit-testable, no I/O
 *   - a thin runner (runRetentionSweep) that turns plans into Supabase deletes
 *
 * Conversation rule mirrors the long-standing comment in
 * supabase-migration-indexes.sql: keep the newest `keepPerUser` messages per
 * user AND additionally delete anything older than `maxAgeDays`. A row is purged
 * only when it is BOTH beyond the per-user keep window AND past the age cutoff,
 * so an active user never loses recent context regardless of age.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// RETENTION_POLICY is the single source of truth: the runner reads it and the
// privacy page renders from it, so the promise and the enforcement cannot drift.
// `label` is the human sentence shown on the privacy page.
const RETENTION_POLICY = {
  conversations: { maxAgeDays: 180, keepPerUser: 500, label: 'Chat & voice transcripts: deleted after 180 days (your 500 most recent messages are always kept for context).' },
  action_log: { maxAgeDays: 180, column: 'created_at', label: 'Action history (what the assistant did on your behalf): deleted after 180 days.' },
  briefings: { maxAgeDays: 90, column: 'created_at', label: 'Proactive briefings: deleted after 90 days.' },
  native_context: { maxAgeDays: 90, column: 'updated_at', label: 'Device context (location, health snapshots): the single latest snapshot is overwritten on each sync and purged after 90 days of inactivity.' },
  browser_sessions: { maxAgeDays: 90, column: 'updated_at', label: 'Saved website logins for browser tasks: deleted after 90 days unused.' },
  password_reset_tokens: { column: 'expires_at', expireWhenPast: true, label: 'Password-reset tokens: deleted as soon as they expire.' },
};

// Pure: returns the ids of conversation rows that should be deleted.
function selectExpiredConversationIds(rows, { now = Date.now(), maxAgeDays, keepPerUser = 0 } = {}) {
  const cutoff = now - maxAgeDays * DAY_MS;

  // Rank each user's rows newest-first so we can protect the newest keepPerUser.
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }

  const expired = [];
  for (const userRows of byUser.values()) {
    userRows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    userRows.forEach((r, rank) => {
      const beyondKeepWindow = rank >= keepPerUser;
      const olderThanCutoff = new Date(r.created_at).getTime() < cutoff;
      if (beyondKeepWindow && olderThanCutoff) expired.push(r.id);
    });
  }
  return expired;
}

// Page through a table's rows so the conversation planner sees every user's
// full history (supabase-js caps a single select at ~1000 rows).
async function fetchAllRows(supabase, table, columns, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

// Executes the retention policy. Returns a per-table count of rows purged.
// `opts.policy` defaults to RETENTION_POLICY; `opts.now` is injectable for tests.
async function runRetentionSweep(supabase, opts = {}) {
  const { now = Date.now(), logger = console, policy = RETENTION_POLICY } = opts;
  const summary = {};
  const isoCutoff = (days) => new Date(now - days * DAY_MS).toISOString();

  // 1. Conversations: keep-newest-N + age gate, deleted by explicit id list.
  if (policy.conversations) {
    const { maxAgeDays, keepPerUser } = policy.conversations;
    const rows = await fetchAllRows(supabase, 'conversations', 'id,user_id,created_at');
    const ids = selectExpiredConversationIds(rows, { now, maxAgeDays, keepPerUser });
    if (ids.length) {
      const { error } = await supabase.from('conversations').delete().in('id', ids);
      if (error) throw error;
    }
    summary.conversations = ids.length;
    logger.log?.(`[retention] conversations purged=${ids.length}`);
  }

  // 2. Simple time-based tables: delete where <column> is older than the cutoff
  //    (or, for tokens, already expired).
  for (const [table, rule] of Object.entries(policy)) {
    if (table === 'conversations') continue;
    const column = rule.column || 'created_at';
    const boundary = rule.expireWhenPast ? new Date(now).toISOString() : isoCutoff(rule.maxAgeDays);
    const { error, count } = await supabase.from(table).delete({ count: 'exact' }).lt(column, boundary);
    if (error) throw error;
    summary[table] = typeof count === 'number' ? count : 0;
    logger.log?.(`[retention] ${table} purged where ${column} < ${boundary}`);
  }

  return summary;
}

module.exports = {
  DAY_MS,
  RETENTION_POLICY,
  selectExpiredConversationIds,
  fetchAllRows,
  runRetentionSweep,
};

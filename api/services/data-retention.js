'use strict';
/*
 * Enforces the bounded retention the privacy policy promises. Split into pure planners, which
 * are unit-testable with no I/O, and a thin runner that turns a plan into deletes.
 *
 * A conversation row is purged only when it is BOTH beyond the newest-`keepPerUser` window and
 * past `maxAgeDays`, so an active user never loses recent context however old it is.
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
  display_pairing_challenges: { column: 'expires_at', expireWhenPast: true, label: 'Nearby-display pairing codes: deleted as soon as they expire.' },
  display_render_events: { column: 'expires_at', expireWhenPast: true, label: 'Nearby-display updates: deleted after delivery expires.' },
  // Identity, handle, participant, and conversation *records* are relationship
  // metadata, not message content, and are intentionally left out of this policy —
  // only the event bodies (the actual correspondence) get a retention clock, mirroring
  // how conversations (chat) has one but connectors (the relationship, not its
  // content) does not.
  external_conversation_events: { maxAgeDays: 180, column: 'created_at', label: 'Messages Millie has sent or received on your behalf: deleted after 180 days.' },
  // Keyed on last_used_at, not created_at, and deliberately so: a passport scan uploaded
  // once and reused every few months would be deleted by an age-since-upload clock while
  // still being in active use. `storageBucket` tells the sweep the row has a blob behind it
  // that must go first — see the storage branch in runRetentionSweep.
  documents: { maxAgeDays: 365, column: 'last_used_at', storageBucket: 'documents', label: 'Files you have given Millie, or that she has saved for you: deleted after 365 days without being used.' },
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

    // 2a. Storage-backed tables: the row is only an index over a blob, so read the expired
    //     rows first, remove their objects, and only then delete the rows. Deleting rows
    //     directly would leave orphaned objects — user data we are still holding and can no
    //     longer see or account for, which is a privacy failure rather than wasted space.
    if (rule.storageBucket) {
      const { data: expiredRows, error: selectError } = await supabase
        .from(table).select('id,storage_path').lt(column, boundary);
      if (selectError) throw selectError;
      const rows = expiredRows || [];
      if (rows.length) {
        const paths = rows.map(r => r.storage_path).filter(Boolean);
        if (paths.length) {
          const { error: storageError } = await supabase.storage.from(rule.storageBucket).remove(paths);
          if (storageError) throw storageError;
        }
        const { error: deleteError } = await supabase.from(table).delete().in('id', rows.map(r => r.id));
        if (deleteError) throw deleteError;
      }
      summary[table] = rows.length;
      logger.log?.(`[retention] ${table} purged ${rows.length} rows + blobs where ${column} < ${boundary}`);
      continue;
    }

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

-- Indexes supporting the automated data-retention sweep (api/services/data-retention.js).
-- The sweep deletes by a timestamp column on each table; these keep those deletes
-- from doing full scans as the tables grow. Safe to run repeatedly.

-- conversations(created_at) cleanup index already exists in supabase-migration-indexes.sql
CREATE INDEX IF NOT EXISTS idx_action_log_cleanup ON action_log(created_at);
CREATE INDEX IF NOT EXISTS idx_briefings_cleanup ON briefings(created_at);
CREATE INDEX IF NOT EXISTS idx_native_context_cleanup ON native_context(updated_at);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_cleanup ON browser_sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_cleanup ON password_reset_tokens(expires_at);

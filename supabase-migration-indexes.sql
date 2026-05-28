-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_conversations_user_time ON conversations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_log_user_time ON action_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_briefings_user_read_time ON briefings(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_cleanup ON conversations(created_at);

-- Retention function: keep last 500 messages per user, delete older than 180 days
-- Run this periodically via Cloud Scheduler or cron
-- DELETE FROM conversations
-- WHERE id NOT IN (
--   SELECT id FROM (
--     SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) as rn
--     FROM conversations
--   ) ranked WHERE rn <= 500
-- )
-- AND created_at < NOW() - INTERVAL '180 days';

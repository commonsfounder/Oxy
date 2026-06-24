-- Resumable ordering context: persist the last page url, active goal, and step
-- history alongside the existing storageState, so an idle-evicted or accidentally
-- closed session re-opens where it left off instead of dead-ending on "session expired".

ALTER TABLE browser_sessions ADD COLUMN IF NOT EXISTS last_url TEXT;
ALTER TABLE browser_sessions ADD COLUMN IF NOT EXISTS goal     TEXT;
ALTER TABLE browser_sessions ADD COLUMN IF NOT EXISTS history  JSONB;

-- Browser task session persistence — one row per (user, site), holds Playwright
-- storageState (cookies + localStorage) so logins survive across runs.

CREATE TABLE IF NOT EXISTS browser_sessions (
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  site          TEXT NOT NULL,
  storage_state JSONB,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, site)
);

ALTER TABLE browser_sessions ENABLE ROW LEVEL SECURITY;

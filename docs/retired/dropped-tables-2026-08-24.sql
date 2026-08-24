-- Retired tables, dropped from production 2026-08-24.
--
-- Both had ZERO references anywhere in the repo (api/, OxyApp/, test/, docs/,
-- supabase/migrations/). Kept here only so the shape is recoverable if a future
-- feature ever wants it. Row data was NOT preserved -- see notes below.
--
-- ubereats_sessions: created by efe07ee5 ("Make Uber Eats connector Cloud-Run-ready
--   (DB-backed sessions)") and orphaned by 6f4e8769 ("Revert Uber Eats MCP scraper
--   connector"), which removed the code but left the table. At drop time it held a
--   single stale row: user_id 'user123', 41 stored Uber Eats login cookies, last
--   written 2026-06-10. Those cookies were leftover login credentials for a retired
--   connector; they were deliberately NOT backed up, because preserving them would
--   defeat the point of removing them.
--
-- oxy_accounts: never appeared in tracked git history at all -- an early
--   connector-token table superseded by `connectors`. Empty (0 rows) at drop time.

CREATE TABLE oxy_accounts (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  provider      text NOT NULL,
  access_token  text,
  refresh_token text,
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE ubereats_sessions (
  user_id    text NOT NULL,
  cookies    jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

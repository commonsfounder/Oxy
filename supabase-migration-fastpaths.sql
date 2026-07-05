-- Global, self-learning browser search-URL fast-paths (api/services/browser-fastpaths.js).
-- One row per host; contains only generic URL templates (never user search terms). Shared
-- across all users. Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS browser_fastpaths (
  host         text PRIMARY KEY,
  url_template text NOT NULL,
  param        text,
  fail_count   int  NOT NULL DEFAULT 0,
  last_ok_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

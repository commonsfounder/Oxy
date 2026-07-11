-- Append-only trace of ordering-loop steps and terminal outcomes (api/services/session-events.js).
-- Two purposes: a recipe hit-rate report (event_type IN ('recipe_hit','vision_step'), grouped by
-- site+step_name) and a session trace (event_type IN ('session_done','session_error','session_ask'),
-- one row per completed runOrderingTurn call). Best-effort — the ordering loop works without this
-- table applied; logging failures are swallowed at the call site.
CREATE TABLE IF NOT EXISTS browser_session_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    text NOT NULL,
  site       text NOT NULL,
  event_type text NOT NULL,
  step_name  text,
  phase      text,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS browser_session_events_site_type_idx
  ON browser_session_events (site, event_type, created_at);

CREATE INDEX IF NOT EXISTS browser_session_events_user_idx
  ON browser_session_events (user_id, created_at);

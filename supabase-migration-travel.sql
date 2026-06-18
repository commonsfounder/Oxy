-- Travel agent schema additions — Phase 1
-- Run after supabase-migration.sql

-- Persistent trip storage (replaces ephemeral preferences entry for completed plans)
CREATE TABLE IF NOT EXISTS travel_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title        TEXT,                        -- e.g. "Tokyo April 2027"
  status       TEXT DEFAULT 'planning',     -- planning | confirmed | in_progress | completed
  requirements JSONB DEFAULT '{}',          -- extracted intent (destination, dates, budget, etc.)
  itinerary    JSONB DEFAULT '{}',          -- day-by-day plan once generated
  budget       JSONB DEFAULT '{}',          -- { estimated, actual, currency }
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_travel_sessions_user_id ON travel_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_travel_sessions_status  ON travel_sessions(user_id, status);

-- Trigger to keep updated_at current
CREATE OR REPLACE FUNCTION update_travel_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_travel_sessions_updated_at
  BEFORE UPDATE ON travel_sessions
  FOR EACH ROW EXECUTE FUNCTION update_travel_sessions_updated_at();

-- Long-term travel preference profile — one row per user, upserted on learning
CREATE TABLE IF NOT EXISTS travel_preferences (
  user_id               TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  preferred_airlines    TEXT[]   DEFAULT '{}',
  disliked_destinations TEXT[]   DEFAULT '{}',
  hotel_style           TEXT,                  -- boutique | chain | hostel | luxury
  activity_types        TEXT[]   DEFAULT '{}', -- culture | adventure | food | nightlife | beach
  travel_style          TEXT,                  -- slow | balanced | fast-paced
  dietary_requirements  TEXT[]   DEFAULT '{}',
  accessibility_needs   TEXT[]   DEFAULT '{}',
  budget_tier           TEXT,                  -- budget | mid | luxury
  past_destinations     TEXT[]   DEFAULT '{}',
  updated_at            TIMESTAMPTZ DEFAULT now()
);

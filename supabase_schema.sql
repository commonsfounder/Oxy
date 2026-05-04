-- Run this in your Supabase SQL editor

-- Stores rolling conversation history per user
CREATE TABLE conversations (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT        NOT NULL,
  role        TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX conversations_user_time ON conversations (user_id, created_at DESC);

-- Stores persistent facts Oxcy learns about the user
CREATE TABLE memories (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memories_user_time ON memories (user_id, created_at DESC);

-- Optional: auto-prune conversations older than 7 days
-- (Run manually or set up a pg_cron job)
-- DELETE FROM conversations WHERE created_at < now() - interval '7 days';

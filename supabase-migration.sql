CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- User accounts
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);

-- Chat history
CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, created_at DESC);

-- Memory facts
CREATE TABLE IF NOT EXISTS memories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT DEFAULT 'fact',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, created_at DESC);

-- Action log table
CREATE TABLE IF NOT EXISTS action_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  action JSONB NOT NULL,
  status TEXT DEFAULT 'executed',
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_action_log_user ON action_log(user_id, created_at DESC);

-- Connectors table
CREATE TABLE IF NOT EXISTS connectors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  enabled BOOLEAN DEFAULT false,
  tokens JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, connector_id)
);

CREATE INDEX IF NOT EXISTS idx_connectors_user ON connectors(user_id);

-- Preferences table (personality evolution)
CREATE TABLE IF NOT EXISTS preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_preferences_user ON preferences(user_id);

-- Backfill columns for older deployments
ALTER TABLE action_log ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS tokens JSONB;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'fact';

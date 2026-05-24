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

-- Native device registrations for push notifications
CREATE TABLE IF NOT EXISTS devices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  push_token TEXT NOT NULL,
  timezone TEXT DEFAULT 'Europe/London',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, push_token)
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- Latest permission-backed native context sent by the iOS app
CREATE TABLE IF NOT EXISTS native_context (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  location JSONB,
  health JSONB,
  capabilities JSONB,
  settings JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_native_context_user ON native_context(user_id);

-- Proactive briefing feed
CREATE TABLE IF NOT EXISTS briefings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT DEFAULT 'proactive',
  metadata JSONB DEFAULT '{}'::jsonb,
  read BOOLEAN DEFAULT false,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_briefings_user ON briefings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_briefings_unread ON briefings(user_id, read, created_at DESC);

-- Backfill columns for older deployments
ALTER TABLE action_log ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS tokens JSONB;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'fact';

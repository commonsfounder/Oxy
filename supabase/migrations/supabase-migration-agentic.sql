-- Agentic features migration: persistent tasks/goals, plans, traces, simulation support
-- Run this in Supabase SQL editor or as part of deploy.

CREATE TABLE IF NOT EXISTS agent_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- pending, running, paused, completed, failed, cancelled
  plan JSONB,
  current_step INTEGER DEFAULT 0,
  results JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  autonomy TEXT DEFAULT 'Active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_user ON agent_tasks(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);

CREATE TABLE IF NOT EXISTS agent_traces (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id UUID REFERENCES agent_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  step INTEGER,
  type TEXT,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_traces_task ON agent_traces(task_id, created_at);

-- Optional: store full decision/execution trace for replay
ALTER TABLE action_log ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agentic BOOLEAN DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS trace_id TEXT;

-- For simulation / dry run support
CREATE TABLE IF NOT EXISTS simulation_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal TEXT,
  simulated_actions JSONB,
  outcomes JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on new agentic tables (consistent with existing)
DO $$ BEGIN
  ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE agent_traces ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE simulation_runs ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- Note: No permissive policies = deny for non-service roles. Service role (used by backend) bypasses RLS.
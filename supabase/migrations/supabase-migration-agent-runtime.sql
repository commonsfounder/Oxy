-- The durable work session behind an ambient delegated goal.
-- This is deliberately separate from agent_workspace_sessions: the workspace session is a
-- storage/browser view, while this row is the execution identity that can be resumed,
-- associated with a device, and produce bounded artifacts.

CREATE TABLE IF NOT EXISTS agent_runtime_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  task_id UUID NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  device_id TEXT,
  device_type TEXT NOT NULL DEFAULT 'ambient_home'
    CHECK (device_type IN ('ambient_home', 'ios_companion', 'browser', 'unknown')),
  kind TEXT NOT NULL DEFAULT 'task'
    CHECK (kind IN ('task', 'project', 'browser')),
  project_ref TEXT,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready'
    CHECK (state IN ('ready', 'running', 'paused', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, task_id)
);

CREATE INDEX IF NOT EXISTS agent_runtime_sessions_user_idx
  ON agent_runtime_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_runtime_artifacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id UUID NOT NULL REFERENCES agent_runtime_sessions(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note'
    CHECK (kind IN ('file', 'diff', 'receipt', 'browser_evidence', 'test_result', 'note')),
  path TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'failed')),
  workspace_file_id UUID REFERENCES agent_workspace_files(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_runtime_artifacts_session_idx
  ON agent_runtime_artifacts(user_id, session_id, created_at);

ALTER TABLE agent_runtime_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runtime_artifacts ENABLE ROW LEVEL SECURITY;

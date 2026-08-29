-- Controlled, user-scoped workspace for Adam's persistent agent sessions.
-- Content is text-only in the first slice; binary assets belong in object storage.

CREATE TABLE IF NOT EXISTS agent_workspaces (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Adam workspace',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_workspaces_user_idx ON agent_workspaces(user_id);

CREATE TABLE IF NOT EXISTS agent_workspace_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'folder')),
  content TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, path)
);

CREATE INDEX IF NOT EXISTS agent_workspace_files_user_idx
  ON agent_workspace_files(user_id, workspace_id, path);

CREATE TABLE IF NOT EXISTS agent_workspace_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('chat', 'task', 'browser', 'project')),
  title TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_workspace_sessions_user_idx
  ON agent_workspace_sessions(user_id, workspace_id, updated_at DESC);

ALTER TABLE agent_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workspace_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workspace_sessions ENABLE ROW LEVEL SECURITY;

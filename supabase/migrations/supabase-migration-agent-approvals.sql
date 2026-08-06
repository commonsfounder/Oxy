-- Approval records belong to the delegated goal that created them.
-- The legacy preferences.pending.action value remains a compatibility fallback for
-- installations that have not applied this migration yet; new durable runs use this table.

CREATE TABLE IF NOT EXISTS agent_runtime_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  task_id UUID REFERENCES agent_tasks(id) ON DELETE CASCADE,
  session_id UUID REFERENCES agent_runtime_sessions(id) ON DELETE CASCADE,
  task_goal TEXT,
  action_type TEXT NOT NULL,
  action_payload JSONB NOT NULL,
  user_message TEXT,
  location JSONB,
  native_hints JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'approved', 'cancelled', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_runtime_approvals_pending_idx
  ON agent_runtime_approvals(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_runtime_approvals_task_idx
  ON agent_runtime_approvals(user_id, task_id, created_at DESC);

ALTER TABLE agent_runtime_approvals ENABLE ROW LEVEL SECURITY;


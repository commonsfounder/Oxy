-- Resumable agent runs.
--
-- A run lived entirely in the memory of one Cloud Run instance: `runAgenticLoop(...)` was
-- fire-and-forget, so an instance recycle mid-run left the task at status 'running' with no
-- progress recorded, nothing to resume from, and no error to explain it. It sat there
-- forever, and re-running started the goal from scratch.
--
-- `checkpoint` holds enough of the loop to continue: the iteration reached, the conversation
-- so far, and what has already been executed. `heartbeat_at` is what makes "still working"
-- distinguishable from "the instance died" — without it, a stalled run and a busy one look
-- identical from the outside.

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS checkpoint JSONB;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Drives the stale-run sweep: find running tasks whose heartbeat has gone quiet.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_heartbeat
  ON agent_tasks (heartbeat_at)
  WHERE status = 'running';

-- Agentic / autonomous scheduled tasks: condition triggers, polling, budget cap.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS condition TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS interval_minutes INT;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS budget_cap NUMERIC;
-- 'completed' flips when a one-shot/condition task has fulfilled its goal, so a retried
-- sweep can't double-run it. Distinct from 'active' (which the user can toggle).
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT false;

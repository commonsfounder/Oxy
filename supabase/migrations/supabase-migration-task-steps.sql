-- Step-by-step progress events for browser-automation tasks (api/services/task-steps.js).
-- Lets a later API expose live "what is the agent doing right now" visibility for a task,
-- scoped per-user. Best-effort — recordTaskStep never throws, so a logging failure here must
-- never break a running browser task.
create table if not exists task_steps (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_name text not null,
  phase text not null default 'progress',
  status text not null default 'ok' check (status in ('ok', 'error')),
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists task_steps_task_id_idx on task_steps (task_id, created_at);

alter table task_steps enable row level security;

create policy "task_steps_select_own" on task_steps
  for select using (auth.uid() = user_id);

create policy "task_steps_insert_own" on task_steps
  for insert with check (auth.uid() = user_id);

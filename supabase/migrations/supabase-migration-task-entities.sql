create table if not exists task_entities (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  site text not null,
  entity_name text not null,
  entity_type text,
  created_at timestamptz not null default now()
);

create index if not exists task_entities_user_created_idx on task_entities (user_id, created_at desc);

alter table task_entities enable row level security;

create policy "task_entities_select_own" on task_entities
  for select using (auth.uid() = user_id);

create policy "task_entities_insert_own" on task_entities
  for insert with check (auth.uid() = user_id);

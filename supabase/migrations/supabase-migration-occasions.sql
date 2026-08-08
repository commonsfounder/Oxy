-- Durable, structured occasion data (birthdays, anniversaries) — the memories table is
-- free-text only (content, source, created_at, no date field), which cannot reliably answer
-- "whose birthday is coming up?" without re-parsing prose at query time. This is the same
-- FK/RLS pattern already proven correct elsewhere in this schema: `user_id text references
-- users(user_id)` (this app's real auth is a text handle, not Supabase Auth — see
-- supabase-migration-fix-user-id-fk.sql), RLS enabled with zero policies (service_role
-- bypasses it entirely; anon/authenticated are blocked since nothing grants them access —
-- matches every other table in this project, confirmed live against vault_credentials/
-- scheduled_tasks/memories/users before writing this).
create table if not exists occasions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  person_name text not null,
  occasion_type text not null default 'birthday',
  month integer not null check (month between 1 and 12),
  day integer not null check (day between 1 and 31),
  year integer,
  relationship text,
  notes text,
  source text not null default 'chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists occasions_user_id_idx on occasions (user_id);

-- Re-stating "Mum's birthday is October 8" again should update the existing row, not
-- duplicate it — this is the upsert key.
create unique index if not exists occasions_user_person_type_idx
  on occasions (user_id, lower(person_name), occasion_type);

alter table occasions enable row level security;

-- User-saved routines: a named prompt a user can re-run later (api/services/routines.js).
create table if not exists routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  prompt text not null,
  created_at timestamptz not null default now()
);

create index if not exists routines_user_id_idx on routines (user_id, created_at);

alter table routines enable row level security;

create policy "routines_select_own" on routines for select using (auth.uid() = user_id);
create policy "routines_insert_own" on routines for insert with check (auth.uid() = user_id);
create policy "routines_delete_own" on routines for delete using (auth.uid() = user_id);

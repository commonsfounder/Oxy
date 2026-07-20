create table if not exists chat_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  effort text not null default 'medium' check (effort in ('low', 'medium', 'high')),
  guard_mode boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table chat_settings enable row level security;
create policy "chat_settings_select_own" on chat_settings for select using (auth.uid() = user_id);
create policy "chat_settings_upsert_own" on chat_settings for insert with check (auth.uid() = user_id);
create policy "chat_settings_update_own" on chat_settings for update using (auth.uid() = user_id);

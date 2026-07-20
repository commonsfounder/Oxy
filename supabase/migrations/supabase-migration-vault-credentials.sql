create table if not exists vault_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  site text not null,
  label text not null,
  username text,
  tokens jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One credential per (user, site) — keeps scoped-grant matching in browser-task.js a plain
-- domain equality check, and saveVaultCredential upserts on this key so re-saving a site
-- updates the existing row instead of creating a duplicate.
create unique index if not exists vault_credentials_user_site_idx on vault_credentials (user_id, site);

alter table vault_credentials enable row level security;

create policy "vault_credentials_select_own" on vault_credentials
  for select using (auth.uid() = user_id);

create policy "vault_credentials_insert_own" on vault_credentials
  for insert with check (auth.uid() = user_id);

create policy "vault_credentials_update_own" on vault_credentials
  for update using (auth.uid() = user_id);

create policy "vault_credentials_delete_own" on vault_credentials
  for delete using (auth.uid() = user_id);

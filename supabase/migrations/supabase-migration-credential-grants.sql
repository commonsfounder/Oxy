-- Bounded permission to use a stored site password, and the record of every use.
--
-- vault_credentials already keeps passwords encrypted and decrypts them only at the point
-- of use. What was missing is when the agent may sign in WITHOUT asking first. A tap per
-- sign-in makes unattended work impossible; no gate at all makes the model's own choice of
-- site the only lock on a password, and this agent reads pages written by strangers.
--
-- So: the user creates a grant, it expires on its own, it can be revoked instantly, and it
-- can carry a use cap. granted_via is recorded and only 'user' is ever honoured, so a row
-- created by anything else cannot authorise a sign-in.
--
-- user_id is `text references users(user_id)`, matching browser_sessions. Do NOT use
-- `uuid references auth.users(id)`: this app's auth is homegrown, userId is a client-chosen
-- text handle, and Supabase's auth.users is never populated. Every table that got that
-- wrong silently rejected all real writes until supabase-migration-fix-user-id-fk.sql.

create table if not exists credential_grants (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  site text not null,
  scope text not null default 'task' check (scope in ('task', 'standing')),
  task_id text,
  expires_at timestamptz not null,
  max_uses integer check (max_uses is null or max_uses > 0),
  use_count integer not null default 0,
  granted_via text not null default 'user',
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- The hot lookup is "is there a live grant for this site right now".
create index if not exists credential_grants_live_idx
  on credential_grants (user_id, site, created_at desc)
  where revoked_at is null;

create table if not exists credential_use_log (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  site text not null,
  grant_id uuid references credential_grants(id) on delete set null,
  task_id text,
  outcome text not null check (outcome in ('used', 'denied', 'failed')),
  reason text,
  created_at timestamptz not null default now()
);

-- Refusals are kept, not just successes: a denied row is what shows a page trying to steer
-- the agent at a site the user never granted.
create index if not exists credential_use_log_user_idx
  on credential_use_log (user_id, created_at desc);

alter table credential_grants enable row level security;
alter table credential_use_log enable row level security;

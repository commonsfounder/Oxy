-- Fixes a schema bug introduced across the entire Aside-parity roadmap (Phases 1-4):
-- task_steps, routines, vault_credentials, task_entities, and chat_settings were all
-- created with `user_id uuid references auth.users(id)`, but this app's real auth is
-- homegrown (see auth.js) — userId is a client-chosen text handle from /auth/register,
-- never a UUID, and Supabase's own auth.users table is never populated (this app doesn't
-- use Supabase Auth sessions at all). Every insert from a real logged-in user has been
-- throwing "invalid input syntax for type uuid", silently swallowed by each service's
-- never-throw contract — all 5 tables had zero rows in production despite being live
-- since Phase 1. The correct, already-proven-working pattern in this codebase is
-- `browser_sessions.user_id text references users(user_id)` — matched here exactly.
-- All 5 tables are empty (verified before writing this migration), so drop+recreate is
-- safe — no data loss, no need for a column-type ALTER + cast dance.
--
-- RLS/auth.uid()-based policies are also dropped, not just retyped: this app never
-- authenticates via Supabase Auth, so auth.uid() is always null and those policies were
-- inert from day one (real access control is enforced entirely in the Node backend via
-- requireSessionAuth before the service-role Supabase client is ever touched, which
-- bypasses RLS regardless). browser_sessions — the one table that actually works — has
-- no RLS at all. Matching that, not inventing a new convention.

drop table if exists task_steps;
drop table if exists routines;
drop table if exists vault_credentials;
drop table if exists task_entities;
drop table if exists chat_settings;

create table task_steps (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  user_id text not null references users(user_id) on delete cascade,
  step_name text not null,
  phase text not null default 'progress',
  status text not null default 'ok',
  detail jsonb,
  created_at timestamptz not null default now()
);
create index task_steps_task_id_idx on task_steps (task_id, created_at);

create table routines (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  name text not null,
  prompt text not null,
  created_at timestamptz not null default now(),
  interval_minutes integer,
  next_run_at timestamptz,
  last_run_at timestamptz
);
create index routines_user_id_idx on routines (user_id, created_at);
create index routines_next_run_idx on routines (next_run_at) where interval_minutes is not null;

create table vault_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  site text not null,
  label text not null,
  username text,
  tokens jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index vault_credentials_user_site_idx on vault_credentials (user_id, site);

create table task_entities (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  user_id text not null references users(user_id) on delete cascade,
  site text not null,
  entity_name text not null,
  entity_type text,
  created_at timestamptz not null default now()
);
create index task_entities_user_created_idx on task_entities (user_id, created_at desc);

create table chat_settings (
  user_id text primary key references users(user_id) on delete cascade,
  effort text not null default 'medium' check (effort in ('low', 'medium', 'high')),
  guard_mode boolean not null default false,
  updated_at timestamptz not null default now()
);

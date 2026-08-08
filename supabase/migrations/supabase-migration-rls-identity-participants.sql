-- SECURITY FIX: the six tables added by the Millie-identity milestone shipped with RLS never
-- enabled, while every other table in this schema has it on. Because Supabase grants anon and
-- authenticated full DML on public tables by default, RLS-off means the PUBLIC anon key could
-- read and write them across users.
--
-- Verified before writing this, with the real anon key against the real PostgREST endpoint:
--   SELECT millie_identities        -> 200, returned a real row
--   SELECT millie_identity_handles  -> 200, returned a real row
--   SELECT participants             -> 200, returned 3 real rows
--   INSERT participants             -> 201, the row was actually created
-- and, for contrast, on tables that already had RLS enabled with zero policies:
--   SELECT occasions / vault_credentials / purchases -> 200 with ZERO rows
--   INSERT occasions                -> 401, "new row violates row-level security policy"
--
-- So the fix is to match the posture the rest of this schema already proves correct, not to
-- invent a new one. This project does not use Supabase Auth — auth.uid() is always null here,
-- and the Node backend enforces per-user access itself using the service-role key, which
-- bypasses RLS entirely. A policy written against auth.uid() would therefore match nothing
-- and add nothing; enabling RLS with NO policies is what actually denies anon/authenticated,
-- and is exactly what occasions, vault_credentials, purchases, memories, users and the rest
-- already do.
--
-- No schema change is needed: every one of these tables is already user-scoped, directly via
-- user_id or transitively through a parent that has one (handles -> identity, addresses ->
-- participant, events -> conversation), so nothing here is unscoped data that could not be
-- protected.
alter table millie_identities enable row level security;
alter table millie_identity_handles enable row level security;
alter table participants enable row level security;
alter table participant_addresses enable row level security;
alter table external_conversations enable row level security;
alter table external_conversation_events enable row level security;

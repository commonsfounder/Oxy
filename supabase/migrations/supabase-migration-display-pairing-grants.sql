-- Re-apply the execute grant that supabase-migration-paired-displays.sql already declares.
--
-- That file ends with `revoke all ... from public` and `grant execute ... to service_role`,
-- but production does not match it: on 2026-08-29 the live ACL on redeem_display_pairing read
--
--   {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- so a SECURITY DEFINER function that pairs a display to a challenge's user_id was reachable
-- by an unauthenticated caller at /rest/v1/rpc/redeem_display_pairing. Supabase grants EXECUTE
-- on public functions to anon and authenticated by default, and `create or replace function`
-- keeps the ACL a function already has — so a revoke that runs once, before a later replace,
-- or never at all, leaves no trace in the file to say it is not in force.
--
-- Abuse still needs an unexpired challenge id (a uuid) and its code hash, so this is the
-- intended boundary being absent rather than a known break. The API calls this RPC with the
-- service client (api/index.js passes the module-level service-key client), so revoking anon
-- and authenticated does not touch the real pairing path.
--
-- npm run check:schema compares declared tables to live tables. It does not read function
-- ACLs, which is why this drifted silently.

revoke all on function redeem_display_pairing(uuid, text, text, text, timestamptz) from public;
revoke all on function redeem_display_pairing(uuid, text, text, text, timestamptz) from anon;
revoke all on function redeem_display_pairing(uuid, text, text, text, timestamptz) from authenticated;
grant execute on function redeem_display_pairing(uuid, text, text, text, timestamptz) to service_role;

-- Verify after applying — expect no anon= or authenticated= entry:
--   select proacl::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'redeem_display_pairing';

-- A recurring routine that starts failing every firing (bad prompt, revoked connector,
-- browser bot-wall) previously advanced next_run_at exactly the same way a real success
-- did — markRoutineRun was called unconditionally after runAgenticLoop returned, and
-- runAgenticLoop resolves normally even when its own internal status is 'error'. There was
-- no way to tell a silently-broken routine from a working one short of reading server logs.

alter table routines add column if not exists last_run_status text
  check (last_run_status in ('success', 'failed'));
alter table routines add column if not exists last_run_error text;
alter table routines add column if not exists consecutive_failures integer not null default 0;

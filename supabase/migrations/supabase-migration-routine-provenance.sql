-- Imported workflows land in `routines`, so a routine needs to say where it came from and
-- whether it is actually live.
--
-- `enabled` exists because an imported Zap is still running at its source. Turning it on
-- here immediately would double-fire it — two identical emails, two calendar entries — so
-- imports arrive inert and the user switches them on after retiring the original.
--
-- listDueRoutines() already filters on `interval_minutes is not null`, so a NULL interval is
-- inert today; `enabled` makes that state explicit and survivable when a scheduled routine
-- needs pausing without losing its cadence.

alter table routines add column if not exists source text;
alter table routines add column if not exists external_id text;
alter table routines add column if not exists enabled boolean not null default true;
alter table routines add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Re-importing the same export must update the existing routine rather than stack copies.
create unique index if not exists routines_user_source_external_idx
  on routines (user_id, source, external_id)
  where source is not null and external_id is not null;

create index if not exists routines_due_idx
  on routines (next_run_at)
  where interval_minutes is not null and enabled;

alter table routines add column if not exists interval_minutes integer;
alter table routines add column if not exists next_run_at timestamptz;
alter table routines add column if not exists last_run_at timestamptz;

create index if not exists routines_next_run_idx on routines (next_run_at) where interval_minutes is not null;

-- Only the service-role client (used by the proactive sweep) ever writes next_run_at/
-- last_run_at, but an update policy keeps this table's RLS surface complete/consistent
-- with the rest of the schema rather than relying solely on service-role bypass.
create policy "routines_update_own" on routines for update using (auth.uid() = user_id);

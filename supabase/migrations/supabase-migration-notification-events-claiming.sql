-- Adds a 'sending' status so two concurrent delivery sweeps (two Cloud Run instances, an
-- overlapping manual /proactive/sweep call and a scheduled one, or simply two loop iterations
-- racing on the same row) cannot both send the same real message externally.
--
-- The claim is the conditional UPDATE itself: `set status='sending' where status in
-- ('pending','deferred')`. Postgres's row-level locking makes that atomic — only one
-- concurrent writer can flip a given row out of ('pending','deferred'), so only one worker
-- ever proceeds to actually call a provider for it. A worker that crashes after claiming and
-- before recording an outcome leaves the row stuck in 'sending'; the sweep's own SELECT treats
-- a 'sending' row older than a short staleness window as claimable again, the same recovery
-- shape this codebase already uses for stale agent runs (taskManager.recoverStaleRuns).
alter table notification_events drop constraint if exists notification_events_status_check;
alter table notification_events add constraint notification_events_status_check
  check (status in ('pending', 'sending', 'delivered', 'failed', 'suppressed', 'deferred'));

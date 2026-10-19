-- An urgent household alert that nobody has seen is re-sent on every connected channel once.
alter table notification_events add column if not exists acknowledged_at timestamptz;
alter table notification_events add column if not exists escalated_at timestamptz;
create index if not exists notification_events_escalation_idx
  on notification_events (urgency, status, delivered_at) where escalated_at is null and acknowledged_at is null;

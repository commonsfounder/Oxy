-- Durable outbound notification events. Until now, everything Adam noticed proactively
-- (a watch firing, a parcel moving, the morning digest) only became a briefing row and a
-- best-effort APNs push whose failure was swallowed — so if the user did not open the app,
-- they simply never found out.
--
-- One row per THING WORTH TELLING, not per delivery attempt: the row records what happened,
-- which channel finally accepted it, and why it was suppressed or deferred if it never went.
-- Nothing is marked delivered because it entered a queue; only a provider actually accepting
-- it sets 'delivered'.
--
-- Ownership: user_id text references users(user_id), RLS enabled with zero policies — the
-- same posture as every other table here (service_role bypasses; anon/authenticated blocked).
create table if not exists notification_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  category text not null check (category in ('watch', 'digest', 'delivery', 'reply_needed', 'occasion', 'commitment', 'action_required', 'other')),
  urgency text not null default 'normal' check (urgency in ('urgent', 'normal', 'low')),
  title text not null,
  body text not null,
  -- The identity of the underlying event, not of this row. Re-raising the same real-world
  -- change (a watch that fires twice for one transition, a digest recomputed twice in a
  -- morning) updates this row instead of sending the user a second alert.
  dedupe_key text not null,
  source_ref jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'failed', 'suppressed', 'deferred')),
  attempts integer not null default 0,
  channel text,
  provider_ref text,
  last_error text,
  -- Quiet hours do not drop a notification, they move it. Urgent items ignore this.
  deliver_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists notification_events_pending_idx
  on notification_events (user_id, status, deliver_after);
create index if not exists notification_events_created_idx
  on notification_events (user_id, created_at desc);
-- One row per real-world event per user. This is the whole deduplication mechanism.
create unique index if not exists notification_events_dedupe_idx
  on notification_events (user_id, dedupe_key);

alter table notification_events enable row level security;

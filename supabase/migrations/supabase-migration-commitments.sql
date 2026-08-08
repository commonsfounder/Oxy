-- Things the user has said they will do. Reminders answer "tell me at 4pm"; a commitment
-- answers "you told Mia you'd send the documents today, and you still haven't".
--
-- Linked rather than duplicated: participant_id points at the canonical person (so "what do I
-- owe Ben?" resolves through the same people layer as everything else), thread_id at the mail
-- it came from, scheduled_task_id at the reminder created for it. Nothing here re-implements
-- people, mail or scheduling.
--
-- Same posture as the rest of this schema: user_id text references users(user_id), RLS
-- enabled with zero policies (service_role bypasses; anon/authenticated blocked).
create table if not exists commitments (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  -- The obligation in the user's own terms ("send the case study"), never a paraphrase.
  what text not null,
  participant_id uuid references participants(id) on delete set null,
  person_name text,
  due_at timestamptz,
  -- "Tuesday" is a day, not 00:00 on Tuesday. Without this every date-only commitment would
  -- read as overdue from the moment the day began.
  due_is_date_only boolean not null default false,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  -- How it was captured, which is also how much to trust it: 'stated' (the user said it),
  -- 'sent_email' (it was in a message they approved and sent), 'email_context' (created
  -- deliberately from a thread). Nothing is captured by passive inference.
  source text not null default 'stated' check (source in ('stated', 'sent_email', 'email_context')),
  source_ref jsonb,
  thread_id text,
  scheduled_task_id uuid references scheduled_tasks(id) on delete set null,
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists commitments_user_status_idx on commitments (user_id, status, due_at);
create index if not exists commitments_participant_idx on commitments (participant_id);
-- Saying the same thing twice updates the open commitment instead of stacking a second one.
-- Scoped to open rows so a genuinely new promise about the same thing later is still new.
create unique index if not exists commitments_dedupe_idx
  on commitments (user_id, lower(what), coalesce(lower(person_name), '')) where status = 'open';

alter table commitments enable row level security;

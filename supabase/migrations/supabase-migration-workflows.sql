-- Workflows: the durable responsibility.
--
-- The distinction this table exists to hold: a TASK is an action ("upload the CV"); a
-- WORKFLOW is the responsibility ("get this application submitted"). agent_tasks already
-- does tasks well and is not being rebuilt — workflows sit ABOVE it, and agent_tasks gains
-- a workflow_id so the actions taken toward a responsibility hang off it.
--
-- This is case management, not a task manager. The thing that must survive is the
-- responsibility: a browser session ending, a day passing, waiting on the user, waiting on
-- a company, or switching tools entirely must none of them lose it.
--
-- `type` is TEXT, not an enum, and there is deliberately no job_application table, no
-- insurance_claim table, no travel table. A job application and an insurance claim are the
-- same shape — goal, documents, correspondence, checkpoints, a deadline, evidence — and if
-- they needed different schemas the abstraction would be wrong. Type is a label for
-- presentation and grouping, never a branch in the data model.
--
-- user_id is `text references users(user_id)`, matching every other table here. The uuid/
-- auth.users mistake silently dropped writes across five tables in this codebase before.

create table workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,

  -- Free-form label: 'job_application', 'insurance_renewal', 'claim', 'trip', 'purchase'.
  -- Data, not schema.
  type text not null,
  -- The outcome in the user's terms: "Apply for the Software Engineer role at X".
  goal text not null,

  status text not null default 'gathering' check (status in (
    'gathering',        -- working out what this needs
    'working',          -- actively doing it
    'waiting_for_user', -- blocked on a person who is not a stranger
    'waiting_external', -- blocked on a company that owes us a reply
    'completed',
    'failed',
    'cancelled'
  )),

  -- Where we are and what happens next, in plain language, because these two strings are
  -- what the user actually reads on the home screen.
  current_step text,
  next_action text,
  blocked_reason text,

  deadline timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set when status becomes terminal, so "what did Adam finish this month" is answerable
  -- without scanning the timeline.
  closed_at timestamptz,

  -- Resumable browser state. Deliberately a column on the workflow rather than a live
  -- session handle anywhere: the durable thing is the objective and where we got to, NOT a
  -- browser tab. A dead session must be reconstructable by reopening the site and reading
  -- this — { objective, currentUrl, lastObservation, completedActions, nextIntendedAction }.
  browser_state jsonb
);

create index workflows_user_active_idx on workflows (user_id, updated_at desc)
  where status not in ('completed', 'failed', 'cancelled');
create index workflows_user_all_idx on workflows (user_id, created_at desc);
create index workflows_deadline_idx on workflows (deadline) where deadline is not null;

-- The timeline. Append-only, and load-bearing for four separate things: debugging, the
-- user's trust that Adam did what they say, resuming after a gap, and explaining the
-- current state without the user having to ask.
create table workflow_events (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,

  -- 'created', 'note', 'status_changed', 'document_added', 'message_sent',
  -- 'message_received', 'checkpoint_opened', 'checkpoint_resolved', 'action_taken',
  -- 'evidence_captured', 'error'. Text for the same reason `type` above is.
  kind text not null,
  -- One line, written for a person: "Generated tailored CV", not "PUT /documents 201".
  summary text not null,

  -- Who caused it. 'millie' | 'user' | 'external' — the timeline is much less useful if you
  -- cannot tell what Adam did from what was done to it. The stored value stays 'millie':
  -- it is a live CHECK constraint on existing rows, not a label anyone reads.
  actor text not null default 'millie' check (actor in ('millie', 'user', 'external', 'system')),

  -- Optional pointer to whatever this event is about, without a foreign key per entity type.
  ref_type text,
  ref_id uuid,

  -- Structured extras for debugging; never required to render the line.
  detail jsonb,

  created_at timestamptz not null default now()
);
create index workflow_events_workflow_idx on workflow_events (workflow_id, created_at);

-- Checkpoints: the single primitive that replaces ready_for_payment.
--
-- "Confirm before submitting the application", "choose which quote", "enter the code that
-- just arrived", "approve £250" are the same thing wearing different clothes: work has
-- stopped, a human decision is required, and nothing consequential proceeds until it comes.
-- Hardcoding one shopping-shaped version of that (ready_for_payment) is what made every
-- non-shopping goal unable to pause safely.
create table workflow_checkpoints (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,

  type text not null check (type in (
    'approval',                -- "confirm before I submit this"
    'missing_information',     -- only Adam's user can supply it
    'authentication_required', -- a login or a verification code
    'legal_confirmation',      -- a declaration the user must actually make
    'payment_confirmation',    -- what ready_for_payment used to be
    'choice_required'          -- several valid options, the consequential pick is the user's
  )),

  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),

  -- What the user is being asked, in their language.
  prompt text not null,
  -- For choice_required: [{ id, label, detail }]. Null otherwise.
  options jsonb,

  -- What came back. resolution_choice is the option id for a choice; resolution_note is
  -- free text ("use the cheaper one but add breakdown cover").
  resolution_choice text,
  resolution_note text,
  resolved_at timestamptz,

  -- Checkpoints go stale: an MFA code is worthless in ten minutes, an approval to submit is
  -- questionable a week later. Null means it does not expire on its own.
  expires_at timestamptz,

  created_at timestamptz not null default now()
);
create index workflow_checkpoints_workflow_idx on workflow_checkpoints (workflow_id, created_at desc);
-- The hot query: "is anything waiting on me right now".
create index workflow_checkpoints_pending_idx on workflow_checkpoints (workflow_id) where status = 'pending';

-- Everything else a workflow touches, without one FK column per entity type. Documents get a
-- direct column (below) because that relationship is the densest and is queried on its own;
-- conversations, calendar events, commitments and people go through here, and a new kind of
-- related thing costs a row rather than a migration.
create table workflow_links (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'conversation', 'calendar_event', 'commitment', 'participant', 'agent_task', 'document'
  )),
  entity_id text not null,
  -- Why it is attached: 'evidence', 'requirement', 'correspondence', 'deadline', 'subject'.
  -- Evidence is a role, not a table — a submission confirmation is just a document linked
  -- with role 'evidence'.
  role text not null default 'related',
  created_at timestamptz not null default now(),
  unique (workflow_id, entity_type, entity_id, role)
);
create index workflow_links_workflow_idx on workflow_links (workflow_id);
create index workflow_links_entity_idx on workflow_links (entity_type, entity_id);

-- Documents get the direct column. Nullable only for genuinely personal files that exist
-- outside any piece of work (a passport uploaded once, reused forever); anything created,
-- downloaded or uploaded DURING work must carry it.
alter table documents add column workflow_id uuid references workflows(id) on delete set null;
create index documents_workflow_idx on documents (workflow_id) where workflow_id is not null;

-- Tasks hang off the responsibility that caused them. agent_tasks keeps doing tasks; this is
-- the edge that says which responsibility a given action was in service of.
alter table agent_tasks add column workflow_id uuid references workflows(id) on delete set null;

alter table workflows enable row level security;
alter table workflow_events enable row level security;
alter table workflow_checkpoints enable row level security;
alter table workflow_links enable row level security;

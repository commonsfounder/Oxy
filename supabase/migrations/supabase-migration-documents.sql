-- Documents: the first representation of a *file* anywhere in this system.
--
-- Before this table, nothing here could hold a PDF. The agent could read the email that
-- mentioned a policy schedule and could not touch the schedule; it could reach a job
-- application and could not upload a CV. That gap blocks 11 of the 14 end-to-end outcomes
-- audited in docs/superpowers/specs/2026-08-10-capability-classes-and-communication-identity-audit.md,
-- which is why this is the first primitive of the foundational pass rather than another
-- connector.
--
-- Bytes live in the private `documents` Storage bucket, addressed by storage_path. This
-- table is the index over them: provenance, ownership, and what work each file belongs to.
--
-- Split on encryption, deliberately:
--   * Blobs rely on the private bucket (service-role access only, no public URLs) plus
--     Supabase's own at-rest encryption. Enveloping them ourselves would buy little and
--     would sit in the way of the whole point — handing a file to a website.
--   * extracted_encrypted DOES get token-crypto's envelope, because that is the column
--     whose contents get read into prompts and query results. A payslip's text is the
--     sensitive part, and it is the part that travels.
--
-- user_id is `text references users(user_id)`, NOT uuid references auth.users. This exact
-- FK mistake silently dropped every real write across five tables in this codebase before
-- (see supabase-migration-fix-user-id-fk.sql). Do not "fix" it to uuid.

create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,

  -- What work this file belongs to. Nullable on purpose: a file routinely arrives before
  -- the work that needs it exists (a CV is uploaded, then an application is started), and
  -- forcing a task at write time would mean either refusing the upload or inventing a task.
  agent_task_id uuid references agent_tasks(id) on delete set null,
  -- Who it came from or concerns, when known — the insurer that emailed the policy.
  participant_id uuid references participants(id) on delete set null,
  conversation_id uuid references external_conversations(id) on delete set null,

  filename text not null,
  mime_type text not null,
  byte_size bigint not null,
  -- sha256 of the bytes. Powers per-user dedupe, and answers "is this the same file I
  -- already sent them" without re-downloading it.
  checksum text not null,
  storage_path text not null unique,

  source text not null check (source in ('upload', 'email_attachment', 'browser_download', 'generated')),
  -- Where it actually came from: the URL it was downloaded from, the provider message id
  -- it was attached to. Provenance is what lets Adam answer "why do I have this file",
  -- which matters more for a file than for a chat message.
  source_ref text,

  -- A short human label the agent matches on ("CV", "passport", "2026 policy schedule").
  -- Metadata stays plaintext so finding a document never requires decrypting every row;
  -- only the contents are enveloped.
  label text,

  -- Filled in by the extraction pass. Best-effort by design: extraction must never be able
  -- to block storing the file, so a document is valid and usable at 'pending' or 'failed'.
  extracted_encrypted jsonb,
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'done', 'failed', 'unsupported')),

  created_at timestamptz not null default now(),
  -- Touched whenever the file is actually read or re-uploaded somewhere. Retention keys off
  -- this rather than created_at: a passport scan uploaded once and used every few months is
  -- exactly the file you must not silently delete.
  last_used_at timestamptz not null default now()
);

create index documents_user_idx on documents (user_id, created_at desc);
create index documents_task_idx on documents (agent_task_id) where agent_task_id is not null;
-- Dedupe lookup: "do I already have these exact bytes for this user".
create index documents_checksum_idx on documents (user_id, checksum);
create index documents_last_used_idx on documents (last_used_at);

-- RLS on, zero policies — the posture every other table in this schema already proves
-- correct. This project does not use Supabase Auth, so auth.uid() is always null and any
-- policy referencing it would match nothing; the Node backend enforces per-user access
-- with the service-role key, which bypasses RLS. Enabling RLS with no policies is what
-- actually denies the public anon key. See supabase-migration-rls-identity-participants.sql
-- for the incident that established this.
alter table documents enable row level security;

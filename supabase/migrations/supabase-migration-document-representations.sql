-- A document is the original file. Everything we later work out ABOUT it is a separate,
-- attributed representation — never an overwrite.
--
-- The first documents migration put extraction in a single `extracted_encrypted` column on
-- documents itself. That shape is wrong for three reasons this migration fixes:
--
--   1. It implies one true parse. A scanned PDF has a (useless) empty text layer AND a
--      (useful) OCR reading; a policy schedule has raw text AND structured fields. Those are
--      different representations of the same bytes, with different producers and different
--      trustworthiness, and collapsing them loses exactly the information needed to judge
--      which to believe.
--   2. It has nowhere to record WHO produced the reading or how confident it was. An OCR
--      guess and a text-layer extraction must not be indistinguishable once stored — low
--      confidence must stay visibly low rather than quietly becoming a fact.
--   3. Re-running a better extractor later would destroy the earlier reading rather than
--      sitting alongside it.
--
-- Safe to restructure rather than migrate data: documents shipped earlier today and the
-- table has zero rows in production (verified before writing this).

alter table documents drop column if exists extracted_encrypted;

create table document_representations (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,

  -- 'text'      — a linear reading of the document
  -- 'fields'    — structured values pulled out of it, each with its own confidence
  -- 'summary'   — a short description, for matching and for showing the user
  kind text not null check (kind in ('text', 'fields', 'summary')),

  -- Who produced this reading, and with what. Both are needed to decide whether a newer
  -- extractor supersedes an older one, and to find every reading produced by a version we
  -- later discover was wrong.
  producer text not null,
  producer_version text not null,

  -- 0..1 overall confidence, null where the notion doesn't apply (a DOCX text layer is not
  -- a guess). Per-field confidences live inside the 'fields' content.
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),

  -- Encrypted with token-crypto, same as the column it replaces: this is the part that gets
  -- read into prompts and query results.
  content_encrypted jsonb not null,

  -- Extractor warnings kept where an engineer can see them: "no text layer, fell back to
  -- OCR", "3 pages unreadable". Internal only, never user-facing copy.
  notes text,

  created_at timestamptz not null default now(),

  -- Re-running the SAME producer replaces its own previous output rather than accumulating
  -- duplicates; a DIFFERENT producer coexists, which is the point.
  unique (document_id, kind, producer)
);

create index document_representations_document_idx on document_representations (document_id, kind);

-- Versioning. A tailored CV is a NEW document derived from the original, never an edit of
-- it — "do not overwrite the original document after extraction" applies just as much to
-- modification. root_document_id lets every version of a thing be found together, while
-- derived_from_document_id records the single step that produced this one.
alter table documents add column version integer not null default 1;
alter table documents add column root_document_id uuid references documents(id) on delete set null;
alter table documents add column derived_from_document_id uuid references documents(id) on delete set null;

create index documents_root_idx on documents (root_document_id) where root_document_id is not null;

alter table document_representations enable row level security;

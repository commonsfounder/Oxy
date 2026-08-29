-- The people layer. Deliberately an EXTENSION of `participants`, not a new `people` table:
-- participants already is the channel-agnostic "who Adam deals with" record, and
-- participant_addresses already is the stable-handle identity index (unique lookup on
-- channel_type + address_value) that makes "Alisa", her email address, and an occasion
-- record resolve to one person. A second table would have been the exact fragmented
-- identity this feature exists to prevent.
--
-- Same FK/RLS pattern as the rest of this schema: user_id text references users(user_id)
-- (this app's auth is a text handle, not Supabase Auth), RLS enabled with zero policies —
-- service_role bypasses it, anon/authenticated are blocked because nothing grants them
-- access. `participants` itself is still RLS-disabled at the time of writing; that is a
-- known, separately-tracked gap, fixed in its own security migration rather than smuggled
-- in here.

-- Relationship to the user ("mum", "manager", "girlfriend", "tutor"). Nullable: plenty of
-- participants are businesses with no relationship at all.
alter table participants add column if not exists relationship text;
alter table participants add column if not exists updated_at timestamptz not null default now();

-- Name lookup for "who is Mia again?". Deliberately NOT unique: two different people
-- genuinely can both be called James, and silently merging them on a name collision is the
-- specific failure this index must not cause. Ambiguity is resolved by asking, in
-- api/services/people.js.
create index if not exists participants_user_name_idx on participants (user_id, lower(display_name));
create index if not exists participants_relationship_idx on participants (user_id, lower(relationship));

-- One row per remembered fact, rather than a single notes blob, because corrections need
-- to be surgical: "Alisa prefers gold, not silver" must replace one fact, and "forget that
-- preference" must delete one fact — a blob would accumulate contradictory lines.
create table if not exists person_facts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  kind text not null default 'note' check (kind in ('note', 'preference')),
  fact text not null,
  -- Provenance, and the honest confidence signal: 'stated' means the user said it,
  -- 'inferred' means Adam derived it. Nothing else may be stored.
  source text not null default 'stated' check (source in ('stated', 'inferred')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists person_facts_participant_idx on person_facts (participant_id);
-- Re-stating the same fact updates it instead of duplicating it.
create unique index if not exists person_facts_dedupe_idx on person_facts (participant_id, lower(fact));
alter table person_facts enable row level security;

-- Links a saved birthday/anniversary to the canonical person, so "get Alisa something for
-- her birthday" connects recipient + occasion + preferences without a fragile name join.
-- Nullable: occasions saved before this migration (and any where the person could not be
-- resolved unambiguously) keep working off person_name alone.
alter table occasions add column if not exists participant_id uuid references participants(id) on delete set null;
create index if not exists occasions_participant_idx on occasions (participant_id);

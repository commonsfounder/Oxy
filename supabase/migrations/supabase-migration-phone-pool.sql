-- Shared pool of Adam phone numbers. Most users never need a number of their own: Adam texts
-- a business from a pool number, and the reply is routed back by (pool number, sender). A
-- dedicated millie_identity_handles number is still used first when a user has one.
--
-- The pool is Oxy's, not any account's, so it carries no user_id and references nothing
-- user-owned. Which user a pool number is talking to lives on external_conversations.
--
-- RLS on with no policies, like every other table here: the backend uses the service-role key.

create table phone_number_pool (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  provider text not null,
  provider_ref text,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now()
);
alter table phone_number_pool enable row level security;

-- The line a conversation is on. Kept per conversation so the same business keeps seeing the
-- same Adam number, and so an inbound text can be matched to exactly one user.
alter table external_conversations
  add column pool_number_id uuid references phone_number_pool(id) on delete set null;
create index external_conversations_pool_idx
  on external_conversations (pool_number_id, participant_id) where pool_number_id is not null;

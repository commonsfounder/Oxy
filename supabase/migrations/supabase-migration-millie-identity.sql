-- Millie's own persistent communication identity — one identity per user, with one
-- handle per channel type. Channel is scoped to email + phone_sms in this milestone;
-- adding 'whatsapp'/'telegram_bot' later is a one-line ALTER on the two check
-- constraints below, not a redesign.
--
-- No RLS: this app never uses Supabase Auth, auth.uid() is always null, and access
-- control is enforced entirely in the Node backend via the service-role client. See
-- supabase-migration-fix-user-id-fk.sql for the established, proven pattern this
-- migration follows exactly (user_id text references users(user_id), no policies).

create table millie_identities (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique references users(user_id) on delete cascade,
  display_name text not null default 'Millie',
  created_at timestamptz not null default now()
);

create table millie_identity_handles (
  id uuid primary key default gen_random_uuid(),
  millie_identity_id uuid not null references millie_identities(id) on delete cascade,
  channel_type text not null check (channel_type in ('email', 'phone_sms')),
  handle_value text not null,
  provider text not null,
  provider_ref text,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (millie_identity_id, channel_type),
  unique (handle_value)
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  display_name text not null,
  business_name text,
  source text not null default 'learned' check (source in ('learned', 'manual')),
  created_at timestamptz not null default now()
);
create index participants_user_idx on participants (user_id, created_at desc);

create table participant_addresses (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references participants(id) on delete cascade,
  channel_type text not null check (channel_type in ('email', 'phone_sms')),
  address_value text not null,
  created_at timestamptz not null default now(),
  unique (participant_id, channel_type, address_value)
);
-- The hot path for inbound matching: "who is this address talking to already".
create index participant_addresses_lookup_idx on participant_addresses (channel_type, address_value);

create table external_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  millie_identity_id uuid not null references millie_identities(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  request_task_id uuid references agent_tasks(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'awaiting_reply', 'resolved', 'closed')),
  last_activity_at timestamptz not null default now(),
  -- Split from last_activity_at on purpose: a future follow-up scheduler needs to know
  -- "how long has it been since WE last heard from THEM" specifically, not just "when
  -- did anything last happen" (an outbound send updates last_activity_at too, but isn't
  -- a signal that a follow-up is due). Not read by any code in this milestone — reserved
  -- so scheduled follow-up (deferred, see the plan's Global Constraints) is an additive
  -- service later, not a schema change.
  last_outbound_at timestamptz,
  last_inbound_at timestamptz,
  -- When a future follow-up scheduler should next consider this conversation. Left null
  -- and unused in this milestone — no code sets or reads it yet.
  next_follow_up_at timestamptz,
  created_at timestamptz not null default now()
);
create index external_conversations_participant_idx on external_conversations (participant_id, status);
create index external_conversations_user_idx on external_conversations (user_id, last_activity_at desc);
-- Reserved for the future follow-up scheduler ("find conversations due for a check"),
-- unused until that service exists — partial index costs nothing while next_follow_up_at
-- is always null.
create index external_conversations_follow_up_idx on external_conversations (next_follow_up_at) where next_follow_up_at is not null;

create table external_conversation_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references external_conversations(id) on delete cascade,
  channel_type text not null check (channel_type in ('email', 'phone_sms')),
  direction text not null check (direction in ('outbound', 'inbound')),
  participant_address_id uuid references participant_addresses(id) on delete set null,
  millie_identity_handle_id uuid references millie_identity_handles(id) on delete set null,
  provider_event_id text,
  -- Encrypted envelope from token-crypto.js's encryptTokens({subject, body}) — never
  -- plaintext subject/body columns. See api/services/external-conversations.js.
  body_encrypted jsonb not null,
  needs_decision boolean not null default false,
  raw_provider_payload jsonb,
  created_at timestamptz not null default now()
);
create index external_conversation_events_conversation_idx on external_conversation_events (conversation_id, created_at);
create index external_conversation_events_needs_decision_idx on external_conversation_events (needs_decision) where needs_decision = true;

alter table agent_tasks add column conversation_id uuid references external_conversations(id) on delete set null;

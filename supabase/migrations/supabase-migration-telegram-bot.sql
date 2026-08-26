-- Links an Oxy account to a Telegram Bot API chat. Kept separate from the `connectors` table
-- because that table's `tokens` column is encrypted opaque JSON — fine for the existing
-- MTProto telegram connector (which only ever needs to look itself up by user_id), but this
-- table exists specifically so an inbound Telegram webhook (which only knows a chat_id) can
-- find the Oxy user it belongs to, which an encrypted blob can't be queried by.
create table if not exists telegram_bot_links (
  user_id text primary key references users(user_id) on delete cascade,
  chat_id text not null unique,
  telegram_user_id text,
  username text,
  linked_at timestamptz not null default now()
);

create index if not exists telegram_bot_links_chat_id_idx on telegram_bot_links (chat_id);

alter table telegram_bot_links enable row level security;

-- One-time account-linking tokens for the "Connect Telegram" deep link. Opaque + random
-- rather than a signed JWT: Telegram's /start deep-link parameter is capped at 64 characters
-- from a restricted [A-Za-z0-9_-] alphabet, which a signed payload (JSON + separator + HMAC)
-- cannot fit into. A row per token also works correctly across multiple Fly machines, unlike
-- an in-memory map. Each token is deleted the moment it's redeemed.
create table if not exists telegram_bot_link_tokens (
  token text primary key,
  user_id text not null references users(user_id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table telegram_bot_link_tokens enable row level security;

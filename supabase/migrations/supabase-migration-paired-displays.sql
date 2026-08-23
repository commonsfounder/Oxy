-- Authorised nearby displays are separate from push destinations.
-- A push token can notify an iPhone; it cannot authorise a screen to receive agent content.

create table if not exists paired_displays (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  display_name text not null,
  display_type text not null default 'browser_display',
  capabilities jsonb not null default '{"text":true}'::jsonb,
  token_hash text not null unique,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create index if not exists paired_displays_user_idx on paired_displays (user_id, paired_at desc);

create table if not exists display_pairing_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  code_hash text not null,
  display_name text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  display_id uuid references paired_displays(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists display_pairing_challenges_user_idx
  on display_pairing_challenges (user_id, created_at desc);
create index if not exists display_pairing_challenges_expiry_idx
  on display_pairing_challenges (expires_at)
  where consumed_at is null;

create table if not exists display_render_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  display_id uuid not null references paired_displays(id) on delete cascade,
  kind text not null default 'agent_update',
  title text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  delivered_at timestamptz,
  acked_at timestamptz
);

create index if not exists display_render_events_pending_idx
  on display_render_events (display_id, created_at)
  where acked_at is null;

alter table paired_displays enable row level security;
alter table display_pairing_challenges enable row level security;
alter table display_render_events enable row level security;

-- Pairing is a single transaction. The API passes only a hash of the one-time code and
-- the hash of the newly minted display token; the raw values never cross this boundary.
create or replace function redeem_display_pairing(
  p_challenge_id uuid,
  p_code_hash text,
  p_display_name text,
  p_token_hash text,
  p_paired_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  challenge display_pairing_challenges%rowtype;
  display paired_displays%rowtype;
begin
  select * into challenge
    from display_pairing_challenges
   where id = p_challenge_id
     and code_hash = p_code_hash
     and consumed_at is null
     and expires_at > p_paired_at
   for update;

  if not found then
    raise exception 'That pairing request is invalid or expired.' using errcode = 'P0001';
  end if;

  insert into paired_displays (
    user_id, display_name, display_type, capabilities, token_hash, paired_at
  ) values (
    challenge.user_id,
    left(coalesce(nullif(trim(p_display_name), ''), nullif(trim(challenge.display_name), ''), 'Nearby display'), 80),
    'browser_display',
    '{"text":true}'::jsonb,
    p_token_hash,
    p_paired_at
  ) returning * into display;

  update display_pairing_challenges
     set consumed_at = p_paired_at, display_id = display.id
   where id = challenge.id;

  return jsonb_build_object(
    'display', jsonb_build_object(
      'id', display.id,
      'display_name', display.display_name,
      'display_type', display.display_type,
      'capabilities', display.capabilities,
      'paired_at', display.paired_at,
      'last_seen_at', display.last_seen_at
    )
  );
end;
$$;

revoke all on function redeem_display_pairing(uuid, text, text, text, timestamptz) from public;
grant execute on function redeem_display_pairing(uuid, text, text, text, timestamptz) to service_role;

-- A screen introduces itself and shows a short code; the signed-in person types the code in the app.
-- No link, no account on the screen. The screen's own key is made when it asks, so only a hash is stored.

create table if not exists display_enrollments (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  display_id uuid references paired_displays(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists display_enrollments_open_code_idx
  on display_enrollments (code) where claimed_at is null;
create index if not exists display_enrollments_expiry_idx
  on display_enrollments (expires_at) where claimed_at is null;

alter table display_enrollments enable row level security;

-- Claiming is one transaction: find the open code, make the paired display from the screen's own
-- key hash, mark the code used. A wrong, used or expired code raises P0001.
create or replace function claim_display_enrollment(
  p_code text,
  p_user_id text,
  p_display_name text,
  p_now timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  enrollment display_enrollments%rowtype;
  display paired_displays%rowtype;
begin
  select * into enrollment
    from display_enrollments
   where code = p_code
     and claimed_at is null
     and expires_at > p_now
   for update;

  if not found then
    raise exception 'That code is not on a screen right now.' using errcode = 'P0001';
  end if;

  insert into paired_displays (
    user_id, display_name, display_type, capabilities, token_hash, paired_at
  ) values (
    p_user_id,
    left(coalesce(nullif(trim(p_display_name), ''), 'Screen'), 80),
    'browser_display',
    '{"text":true}'::jsonb,
    enrollment.token_hash,
    p_now
  ) returning * into display;

  update display_enrollments
     set claimed_at = p_now, display_id = display.id
   where id = enrollment.id;

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

revoke all on function claim_display_enrollment(text, text, text, timestamptz) from public;
grant execute on function claim_display_enrollment(text, text, text, timestamptz) to service_role;

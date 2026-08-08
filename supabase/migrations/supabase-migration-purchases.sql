-- Normalized purchase/receipt records. Two genuinely different real sources, marked as such
-- on every row so the answer to "how much have I spent" can always say where the number came
-- from: 'millie_browser' (an order this system actually placed and saw confirmed) and
-- 'email_receipt' (a receipt extracted from the user's connected mailbox). There is no bank
-- feed in this product, and nothing here may ever pretend otherwise.
--
-- Same FK/RLS pattern as the rest of this schema: user_id text references users(user_id),
-- RLS enabled with zero policies (service_role bypasses; anon/authenticated blocked).
create table if not exists purchases (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id) on delete cascade,
  source text not null check (source in ('millie_browser', 'email_receipt')),
  merchant text not null,
  merchant_domain text,
  purchased_at timestamptz not null,
  -- Nullable on purpose: a confirmation with no reliably-labelled total is still a real
  -- purchase worth recording, and recording it with a guessed number would be worse than
  -- recording it with none. Queries count these separately.
  total_amount numeric,
  currency text,
  order_id text,
  description text,
  items jsonb,
  status text not null default 'confirmed' check (status in ('confirmed', 'refunded', 'pending')),
  refund_amount numeric,
  tracking_url text,
  -- Provenance back to the exact thing observed: a Gmail message id, or the browser session's
  -- confirmation URL. `raw_total_text` keeps the literal string the amount was parsed from so
  -- a wrong total can always be traced to what was actually on the page/in the email.
  source_ref text,
  source_thread_id text,
  raw_total_text text,
  extraction_confidence text check (extraction_confidence in ('high', 'medium')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists purchases_user_date_idx on purchases (user_id, purchased_at desc);
create index if not exists purchases_user_merchant_idx on purchases (user_id, lower(merchant));

-- Re-scanning the same mailbox must not double-count: one row per source document.
create unique index if not exists purchases_source_ref_idx
  on purchases (user_id, source_ref) where source_ref is not null;
-- And the order confirmation, the shipping note and the refund for ONE order are one
-- purchase, not three — they share an order id at the same merchant.
create unique index if not exists purchases_order_idx
  on purchases (user_id, lower(merchant), order_id) where order_id is not null;

alter table purchases enable row level security;

-- Credit subscriptions. Existing numeric money columns stay in dollars internally; customer UI
-- converts at 100 credits/$1. Purchased and welcome credit has no expiry. Each paid monthly grant
-- expires after three months, giving a bounded but generous rollover.
alter table studio.credits add column if not exists expires_at timestamptz;
create index if not exists credits_expiry on studio.credits(account_id, expires_at) where expires_at is not null;

create table if not exists studio.subscriptions (
  account_id uuid primary key references studio.accounts(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  plan_id text not null,
  status text not null default 'active',
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_customer on studio.subscriptions(stripe_customer_id);

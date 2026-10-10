-- Credits: what an account has paid for or been given, in dollars at Studio's prices. Spending is
-- read from the ledger (generation) and agent_usage (the agent's model), counted from billing_from.
-- billing_exempt accounts (the team) are never charged.
alter table studio.accounts add column if not exists billing_from timestamptz not null default now();
alter table studio.accounts add column if not exists billing_exempt boolean not null default false;

create table if not exists studio.credits (
  id bigserial primary key,
  account_id uuid not null references studio.accounts(id) on delete cascade,
  kind text not null,               -- trial | purchase | refund | grant
  amount_usd numeric not null,      -- negative for refunds
  ref text unique,                  -- the Stripe session/charge, so a webhook never credits twice
  note text,
  created_at timestamptz not null default now()
);
create index if not exists credits_account on studio.credits(account_id, created_at);

-- Accounts that exist today start billing now, with the same trial a new sign-up gets.
update studio.accounts set billing_from = now();
insert into studio.credits(account_id, kind, amount_usd, ref, note)
  select id, 'trial', 5, 'trial:' || id, 'Welcome credit' from studio.accounts on conflict (ref) do nothing;

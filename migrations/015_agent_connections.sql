-- Browser-approved credentials for external agents. The pending secret is stored only as a hash;
-- after approval that same hash becomes an API key, so the server never stores a usable token.
create table if not exists studio.agent_connections (
  request_code text primary key,
  secret_hash text unique not null,
  secret_prefix text not null,
  client_name text not null,
  status text not null default 'pending' check (status in ('pending', 'connected', 'denied')),
  account_id uuid references studio.accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  token_expires_at timestamptz
);
create index if not exists agent_connections_expiry on studio.agent_connections(expires_at) where status='pending';
create index if not exists agent_connections_account on studio.agent_connections(account_id, created_at desc) where account_id is not null;

-- The built-in agent (agent/): its conversations and turns, model use and allowances, and the
-- short-lived keys its sandboxes act with.
alter table studio.api_keys add column if not exists kind text not null default 'personal';
alter table studio.api_keys add column if not exists expires_at timestamptz;

create table if not exists studio.agent_threads (
  id text primary key,                 -- the Codex thread id
  account_id uuid not null references studio.accounts(id) on delete cascade,
  project_id text references studio.projects(id) on delete set null,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived boolean not null default false
);
create index if not exists agent_threads_account on studio.agent_threads(account_id, updated_at desc);

-- One row per turn: the project revision it started from and ended at ("Undo this turn").
create table if not exists studio.agent_turns (
  id text primary key,                 -- the Codex turn id
  thread_id text not null references studio.agent_threads(id) on delete cascade,
  account_id uuid not null references studio.accounts(id) on delete cascade,
  project_id text,
  from_revision integer,
  to_revision integer,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists agent_turns_thread on studio.agent_turns(thread_id, started_at);

-- Every model request, priced from the usage the model reported.
create table if not exists studio.agent_usage (
  id bigserial primary key,
  account_id uuid not null references studio.accounts(id) on delete cascade,
  at timestamptz not null default now(),
  model text not null,
  status integer not null,
  input_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cost_micros bigint not null default 0,
  seconds real not null default 0
);
create index if not exists agent_usage_account on studio.agent_usage(account_id, at);
create index if not exists agent_usage_at on studio.agent_usage(at);

-- Per-account overrides: a different monthly allowance, or a paused agent.
create table if not exists studio.agent_accounts (
  account_id uuid primary key references studio.accounts(id) on delete cascade,
  allowance_micros bigint,             -- null: STUDIO_AGENT_ALLOWANCE_USD
  suspended text,                      -- set: the agent is paused, with this reason
  updated_at timestamptz not null default now()
);

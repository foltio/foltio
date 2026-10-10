-- Studio: agentic video editor + generation platform. Everything lives in its own schema.
create schema if not exists studio;

create table if not exists studio.accounts (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  monthly_cap_usd numeric not null default 150,
  per_op_auto_usd numeric not null default 10,
  created_at timestamptz not null default now()
);

create table if not exists studio.api_keys (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references studio.accounts(id) on delete cascade,
  name text not null,
  prefix text not null,
  hash text unique not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table if not exists studio.projects (
  id text primary key,
  account_id uuid not null references studio.accounts(id) on delete cascade,
  name text not null,
  revision integer not null default 0,
  doc jsonb not null,
  poster_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists projects_account on studio.projects(account_id, updated_at desc);

-- One row per applied batch: the full document after the batch (simple, exact undo/restore).
create table if not exists studio.commits (
  project_id text not null references studio.projects(id) on delete cascade,
  revision integer not null,
  actor text not null,
  label text,
  ops jsonb not null,
  summary jsonb,
  doc jsonb not null,
  created_at timestamptz not null default now(),
  primary key (project_id, revision)
);

create table if not exists studio.assets (
  id text primary key,
  project_id text not null references studio.projects(id) on delete cascade,
  account_id uuid not null references studio.accounts(id) on delete cascade,
  kind text not null,               -- video | audio | image | other
  roles text[] not null default '{}',
  name text not null,
  mime text,
  bytes bigint,
  sha256 text,
  status text not null default 'uploading', -- uploading | processing | ready | failed
  origin jsonb not null default '{}',
  probe jsonb,
  derived jsonb not null default '{}',
  storage_key text not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists assets_project on studio.assets(project_id, created_at);

create table if not exists studio.jobs (
  id text primary key,
  project_id text references studio.projects(id) on delete cascade,
  account_id uuid not null references studio.accounts(id) on delete cascade,
  kind text not null,               -- ingest | transcribe | render | generate | frames
  status text not null default 'queued', -- queued | running | succeeded | failed | cancelled
  input jsonb not null default '{}',
  output jsonb,
  error jsonb,
  progress real not null default 0,
  attempts integer not null default 0,
  worker text,
  lease_until timestamptz,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists jobs_idem on studio.jobs(account_id, idempotency_key) where idempotency_key is not null;
create index if not exists jobs_queue on studio.jobs(status, created_at) where status in ('queued','running');
create index if not exists jobs_project on studio.jobs(project_id, created_at desc);

create table if not exists studio.quotes (
  id text primary key,
  account_id uuid not null references studio.accounts(id) on delete cascade,
  project_id text references studio.projects(id) on delete cascade,
  model text not null,
  request jsonb not null,
  cost_usd numeric not null,
  status text not null default 'open', -- open | needs_approval | approved | used | expired | denied
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists studio.ledger (
  id bigserial primary key,
  account_id uuid not null references studio.accounts(id) on delete cascade,
  kind text not null,               -- hold | capture | release | adjust
  amount_usd numeric not null,
  quote_id text,
  job_id text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists ledger_account on studio.ledger(account_id, created_at);

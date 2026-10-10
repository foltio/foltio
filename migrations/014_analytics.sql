-- First-party product analytics. Core business facts (credits, jobs, projects and agent turns) stay
-- in their authoritative tables; this event stream fills in visits, sessions, funnels, UI use and
-- browser quality. It deliberately has no prompt, message, filename, media URL or IP columns.
create table if not exists studio.analytics_events (
  event_id text primary key,
  account_id uuid references studio.accounts(id) on delete set null,
  anonymous_id text,
  session_id text,
  name text not null,
  source text not null default 'web' check (source in ('web', 'server', 'agent', 'worker', 'billing')),
  path text,
  project_id text,
  properties jsonb not null default '{}',
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);

create index if not exists analytics_events_time on studio.analytics_events(occurred_at desc);
create index if not exists analytics_events_name_time on studio.analytics_events(name, occurred_at desc);
create index if not exists analytics_events_account_time on studio.analytics_events(account_id, occurred_at desc) where account_id is not null;
create index if not exists analytics_events_session_time on studio.analytics_events(session_id, occurred_at) where session_id is not null;
create index if not exists analytics_events_project_time on studio.analytics_events(project_id, occurred_at desc) where project_id is not null;

comment on table studio.analytics_events is 'Privacy-safe behavioral telemetry; raw events retained for 180 days by the ingestion path.';

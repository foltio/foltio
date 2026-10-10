-- The project board: the director's (and the person's) shared creative state — the brief, the cast
-- and places with their reference images, the look, the shot list with takes, and the plan.
-- Separate from the timeline document, so board edits never become timeline revisions.
create table if not exists studio.boards (
  project_id text primary key references studio.projects(id) on delete cascade,
  data jsonb not null default '{}',
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Per-turn numbers for the agent panel's footer ("Worked 4m 12s · $0.38").
alter table studio.agent_turns add column if not exists seconds real;
alter table studio.agent_turns add column if not exists model_usd numeric;
alter table studio.agent_turns add column if not exists gen_usd numeric;

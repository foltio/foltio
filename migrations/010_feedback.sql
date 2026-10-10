-- A direct line between filmmakers and the team: private requests, visible replies, and a shared
-- product update feed. Only the server's configured admins can read across accounts or publish.
create table if not exists studio.feedback (
  id text primary key,
  account_id uuid not null references studio.accounts(id) on delete cascade,
  kind text not null check (kind in ('feature', 'feedback', 'bug')),
  title text not null,
  details text not null,
  context text,
  status text not null default 'new' check (status in ('new', 'reviewing', 'planned', 'building', 'shipped', 'closed')),
  priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  admin_response text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feedback_account on studio.feedback(account_id, created_at desc);
create index if not exists feedback_triage on studio.feedback(status, priority, created_at desc);

create table if not exists studio.product_updates (
  id text primary key,
  title text not null,
  body text not null,
  tag text not null default 'Update',
  published boolean not null default true,
  created_by uuid references studio.accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists product_updates_feed on studio.product_updates(published, created_at desc);

insert into studio.product_updates(id, title, body, tag, created_at) values
  ('upd_feedback_home', 'A direct line to the team', 'Request a feature, report something rough, or tell us what would make your filmmaking flow better. You can now follow every request from first review to shipped.', 'New', now()),
  ('upd_original_films', 'An original FOLTIO film collection', 'The public FOLTIO experience now features seven original short films, generated and art-directed specifically for the studio.', 'Creative', now() - interval '1 day')
on conflict (id) do nothing;

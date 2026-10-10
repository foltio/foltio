create table if not exists studio.feedback_messages (
  id text primary key,
  feedback_id text not null references studio.feedback(id) on delete cascade,
  account_id uuid references studio.accounts(id) on delete set null,
  author_role text not null check (author_role in ('user', 'support')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists feedback_messages_thread
  on studio.feedback_messages(feedback_id, created_at asc);

-- Preserve any replies written before conversations were introduced.
insert into studio.feedback_messages(id, feedback_id, account_id, author_role, body, created_at)
select 'fbm_' || substr(md5(f.id || ':initial-support-reply'), 1, 24), f.id, null, 'support', f.admin_response, f.updated_at
from studio.feedback f
where f.admin_response is not null and length(trim(f.admin_response)) > 0
on conflict (id) do nothing;

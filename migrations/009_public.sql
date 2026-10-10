-- Public projects: a project is public while its owner has never paid (no purchase in studio.credits).
-- Cloning records where a project came from; the clone count is the number of live projects cloned from it.
alter table studio.projects add column if not exists cloned_from text;
create index if not exists projects_cloned_from on studio.projects(cloned_from) where deleted_at is null;
create index if not exists credits_purchase on studio.credits(account_id) where kind = 'purchase';

create or replace view studio.public_projects as
  select p.*,
    (select count(*) from studio.projects c where c.cloned_from = p.id and c.deleted_at is null)::int as clones
  from studio.projects p
  where p.deleted_at is null
    and not exists (select 1 from studio.credits cr where cr.account_id = p.account_id and cr.kind = 'purchase');

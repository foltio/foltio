-- Projects are explicitly public by default, with a per-project private switch. Preserve the old
-- paid-account privacy state for existing projects; new projects take the public default.
alter table studio.projects add column if not exists is_public boolean;
update studio.projects p set is_public = not exists (
  select 1 from studio.credits cr where cr.account_id = p.account_id and cr.kind = 'purchase'
) where is_public is null;
alter table studio.projects alter column is_public set default true;
alter table studio.projects alter column is_public set not null;
create index if not exists projects_public on studio.projects(updated_at desc) where is_public=true and deleted_at is null;

-- p.* gains is_public above, which changes the view's column order; PostgreSQL requires a rebuild
-- rather than create-or-replace in that case.
drop view if exists studio.public_projects;
create view studio.public_projects as
  select p.*,
    (select count(*) from studio.projects c where c.cloned_from = p.id and c.deleted_at is null)::int as clones
  from studio.projects p
  where p.deleted_at is null and p.is_public=true;

insert into studio.product_updates(id, title, body, tag, created_at) values
  ('upd_project_privacy', 'Public by default, private when you choose', 'Every new project is easy to share and clone by default. Use the visibility control in the editor to make any project private instantly.', 'Control', now())
on conflict (id) do nothing;

-- Drafts: a quote the person reviews (and may edit) before it runs. In "Work with me" the director's
-- generations wait here with status 'review' until the person presses Generate in the panel.
alter table studio.quotes add column if not exists updated_at timestamptz;
alter table studio.quotes add column if not exists edited_by text;
create index if not exists quotes_project_status on studio.quotes(project_id, status, created_at desc);

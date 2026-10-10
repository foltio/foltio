-- One person, several sign-in emails (e.g. gmail + work Google accounts) → one studio account.
alter table studio.accounts add column if not exists aliases text[] not null default '{}';
create index if not exists accounts_aliases on studio.accounts using gin (aliases);

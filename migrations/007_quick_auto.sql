-- Whether the built-in agent may run quick generations (look frames, sheets, voice samples — under
-- $0.15 each, $3 a project) without asking. Off by default: every generation waits for the person.
alter table studio.accounts add column if not exists quick_auto boolean not null default false;

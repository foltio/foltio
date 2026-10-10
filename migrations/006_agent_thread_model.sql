-- The model a conversation runs on, picked when it starts (null = the service default).
alter table studio.agent_threads add column if not exists model text;

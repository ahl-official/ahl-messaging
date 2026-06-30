-- Reusable Magic Message presets, scoped per team.
--
-- The /quick-replies table is workspace-wide and meant for short
-- slash-shortcut snippets. Magic Message bodies are longer
-- (greeting + 3-4 line pitch) and operators wanted these saved per
-- TEAM (e.g. "Sales" team has Sales-specific outreach copy; "HT Done"
-- has follow-up scripts). A NULL team_id row is workspace-wide,
-- available to everyone — useful for org-level boilerplate.

create table if not exists magic_message_templates (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid references teams(id) on delete cascade,
  title       text not null,
  body        text not null,
  created_by  uuid references team_members(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists magic_message_templates_team_idx
  on magic_message_templates (team_id, created_at desc);

alter table magic_message_templates enable row level security;
-- Service role only. The API does its own scope filtering by joining
-- to the caller's team_members.team_id.

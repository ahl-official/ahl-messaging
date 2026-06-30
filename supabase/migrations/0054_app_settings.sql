-- Workspace-wide key/value settings.
--
-- A tiny catch-all for single-instance config that doesn't deserve its
-- own table — currently the editable AI chat-summary prompt. Reads and
-- writes always go through the service role (API routes mediate access
-- + role checks), so RLS is left enabled with no policies = deny-all to
-- anon/authenticated clients.

create table if not exists public.app_settings (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

-- Tata Tele (Smartflo) click-to-call wiring. Mirrors the Ozonetel
-- shape from 0074.
--
--   tatatele_settings — one workspace-wide account: the Smartflo API
--     token (used raw as the Authorization header), the caller_id /
--     pilot DID shown to the customer, and the API base host.
--   per-agent binding — team_members.tatatele_agent_number is the
--     Smartflo agent the call rings first before bridging the customer.

create table if not exists public.tatatele_settings (
  id          uuid primary key default gen_random_uuid(),
  base_url    text not null default 'https://api-smartflo.tatateleservices.com',
  -- Smartflo portal API token. Sent verbatim as `Authorization: <token>`.
  api_token   text not null,
  -- DID / pilot number shown to the customer as the caller ID.
  caller_id   text not null,
  is_active   boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists tatatele_settings_one_active
  on public.tatatele_settings(is_active)
  where is_active = true;

alter table public.team_members
  add column if not exists tatatele_agent_number text;

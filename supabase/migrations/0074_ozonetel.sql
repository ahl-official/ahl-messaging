-- Ozonetel CloudAgent click-to-call wiring.
--
-- Two pieces of config:
--   1. ozonetel_settings — one workspace-wide account (CloudAgent
--      userName + apiKey + the campaign every dial runs through + the
--      API data-centre base URL). Exactly ONE row may be is_active so
--      the dial route can resolve it without an id. Mirrors the
--      payment_accounts "one active" pattern.
--   2. per-agent binding on team_members — each operator has their own
--      CloudAgent agentID and the phone (or WebRTC SIP id) calls land
--      on. AgentManualDial needs the agentID of whoever clicked.

create table if not exists public.ozonetel_settings (
  id            uuid primary key default gen_random_uuid(),
  -- API data-centre base, e.g. https://in1-ccaas-api.ozonetel.com
  base_url      text not null default 'https://in1-ccaas-api.ozonetel.com',
  user_name     text not null,
  api_key       text not null,
  -- The CloudAgent campaign every manual dial is placed through.
  campaign_name text not null,
  is_active     boolean not null default true,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- At most one active account workspace-wide.
create unique index if not exists ozonetel_settings_one_active
  on public.ozonetel_settings(is_active)
  where is_active = true;

-- Per-operator CloudAgent identity. NULL = operator hasn't been wired
-- for Ozonetel yet; the dial route blocks with a clear message.
alter table public.team_members
  add column if not exists ozonetel_agent_id text,
  add column if not exists ozonetel_phone text;

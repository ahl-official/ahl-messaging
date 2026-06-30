-- Application-level session ledger.
--
-- Supabase ships a refresh-token table internally but it's not query-
-- friendly: no geo, no friendly user-agent labelling, no way to revoke
-- a single session from our own UI without forcing a full sign-out via
-- the admin API.
--
-- This table records one row per successful sign-in (server-side, from
-- signInAction + the OAuth callback). We refresh `last_seen_at` on the
-- HeartbeatTracker tick so "active" can be computed as "last_seen
-- within the last 5 min". Logout-all flow ALSO writes here so the
-- "revoke this session" button has something to act against.
--
-- Geo (city / country) is populated best-effort from a free IP→geo
-- lookup at insert time; failures don't block the sign-in.

create table if not exists user_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  member_id       uuid references team_members(id) on delete cascade,
  ip              text,
  user_agent      text,
  city            text,
  region          text,
  country         text,   -- ISO-2
  started_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_reason  text
);

create index if not exists user_sessions_user_recent_idx
  on user_sessions (user_id, last_seen_at desc);
create index if not exists user_sessions_active_idx
  on user_sessions (user_id) where revoked_at is null;

alter table user_sessions enable row level security;
-- No anon/authenticated policies — the API uses the service-role
-- client throughout. Admins read other users' sessions via that
-- same path so RLS would have to be permissive to be useful, and the
-- API already does its own role gating.

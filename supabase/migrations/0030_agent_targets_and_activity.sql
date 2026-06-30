-- KRA / KPA targets + per-day activity tracking.
--
-- Three tables:
--   • agent_targets_role     — per-role defaults (owner sets a baseline
--     for every Admin / Teammate).
--   • agent_targets_member   — per-member overrides. NULL columns mean
--     "inherit role default". Mirrors the role_permissions /
--     team_member_permissions pattern already used elsewhere.
--   • user_activity_days     — one row per (user, day). Updated by the
--     /api/heartbeat ping every 30s while a tab is focused. We track
--     BOTH a "working window" (first_seen → last_seen, includes breaks)
--     AND the active-focus seconds inside that window (calibrated by
--     heartbeat hits) so reports can show login time + idle time.

create table if not exists public.agent_targets_role (
  role                       text primary key
    check (role in ('owner','superadmin','admin','teammate')),
  magic_messages_per_day     int     not null default 0,
  calls_per_day              int     not null default 0,
  text_replies_per_day       int     not null default 0,
  template_sends_per_day     int     not null default 0,
  /** Max acceptable idle hours per working day. Score penalises
      anything above this. */
  max_idle_hours_per_day     numeric not null default 4,
  /** Minimum expected login hours per day. */
  min_login_hours_per_day    numeric not null default 6,
  updated_at                 timestamptz not null default now()
);

-- Seed sensible role defaults — operators can edit these from the UI.
insert into public.agent_targets_role (role, magic_messages_per_day, calls_per_day, text_replies_per_day, template_sends_per_day, max_idle_hours_per_day, min_login_hours_per_day)
  values
    ('owner',      0, 0, 0, 0, 24, 0),
    ('superadmin', 0, 0, 0, 0, 24, 0),
    ('admin',      5, 5, 30, 5, 4, 6),
    ('teammate',  10, 10, 50, 10, 3, 7)
  on conflict (role) do nothing;

create table if not exists public.agent_targets_member (
  member_id                  uuid primary key
    references public.team_members(id) on delete cascade,
  magic_messages_per_day     int,
  calls_per_day              int,
  text_replies_per_day       int,
  template_sends_per_day     int,
  max_idle_hours_per_day     numeric,
  min_login_hours_per_day    numeric,
  /** When true, this member can view EVERYONE'S scores + Reports
      (otherwise sees only their own). Owner always can. */
  can_view_team_scores       boolean not null default false,
  updated_at                 timestamptz not null default now()
);

create table if not exists public.user_activity_days (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  email             text,
  day               date not null,
  first_seen_at     timestamptz not null,
  last_seen_at      timestamptz not null,
  /** Heartbeat-derived focus seconds. Cumulative throughout the day. */
  active_seconds    int not null default 0,
  /** last_seen - first_seen — total span including breaks. */
  window_seconds    int not null default 0,
  unique (user_id, day)
);

create index if not exists idx_user_activity_days_email_day
  on public.user_activity_days (email, day desc);

create index if not exists idx_user_activity_days_day
  on public.user_activity_days (day desc);

-- RLS: only service-role reads/writes; client always talks via the
-- /api/heartbeat + /api/reports endpoints so we never expose raw rows
-- to non-admin users.
alter table public.agent_targets_role    enable row level security;
alter table public.agent_targets_member  enable row level security;
alter table public.user_activity_days    enable row level security;

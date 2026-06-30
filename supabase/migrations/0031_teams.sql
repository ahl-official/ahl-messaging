-- Teams — operator-defined groupings (e.g. HT Done, Welcome, Sales,
-- Date Align). Every team_member can belong to AT MOST one team. Teams
-- are workspace-wide; there is no per-team RLS (rows are visible to
-- anyone with read access to team_members).

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  /** Optional Tailwind colour key (e.g. "emerald") used to tint the
      chip rendered in member lists. NULL falls back to a hashed colour. */
  color       text,
  /** Optional one-line description visible in the Teams tab. */
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists teams_name_lower_idx
  on public.teams (lower(name));

-- Seed the four QHT teams.
insert into public.teams (name, color)
  values
    ('HT Done',     'emerald'),
    ('Welcome',     'sky'),
    ('Sales',       'violet'),
    ('Date Align',  'amber')
  on conflict (lower(name)) do nothing;

alter table public.team_members
  add column if not exists team_id uuid
    references public.teams(id) on delete set null;

create index if not exists team_members_team_id_idx
  on public.team_members (team_id);

alter table public.teams enable row level security;

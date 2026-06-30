-- System settings — single-row config for app-wide toggles. Used for
-- the global notice banner that shows in the TopBar in place of the
-- old search input. Single row enforced via PK = 1 + ON CONFLICT.
--
-- Run in Supabase SQL Editor. Idempotent.

create table if not exists public.system_settings (
  id int primary key default 1,
  /** Free-text notice shown in the TopBar. Empty / null = banner hidden. */
  notice_banner_text text,
  /** Master switch — operator can toggle off without losing the text. */
  notice_banner_enabled boolean not null default false,
  /** Tone preset for the banner — picks the colour of the pill. */
  notice_banner_tone text not null default 'info'
    check (notice_banner_tone in ('info', 'success', 'warning', 'danger')),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- Enforce singleton.
alter table public.system_settings
  drop constraint if exists system_settings_singleton;
alter table public.system_settings
  add constraint system_settings_singleton check (id = 1);

-- Seed the row so reads never miss.
insert into public.system_settings (id)
values (1)
on conflict (id) do nothing;

-- RLS — anon / authed users can read; only service role writes (UI
-- goes through the /api/system-settings route which uses the service
-- client after a role check).
alter table public.system_settings enable row level security;

drop policy if exists "system_settings_read" on public.system_settings;
create policy "system_settings_read"
  on public.system_settings for select
  using (true);

-- Reload PostgREST schema cache so the new table is queryable.
notify pgrst, 'reload schema';

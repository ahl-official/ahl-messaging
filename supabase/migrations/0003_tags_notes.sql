-- =====================================================================
-- 0003 — Contact tags + notes
-- =====================================================================

-- Simple text array on contact for tags (e.g. ['vip', 'follow-up', 'consult'])
alter table public.contacts
  add column if not exists tags text[] default array[]::text[];

-- Internal notes about a contact (visible to all agents, never to customer)
create table if not exists public.contact_notes (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid references public.contacts(id) on delete cascade,
  body            text not null,
  created_by      uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at      timestamptz default now()
);

create index if not exists idx_contact_notes_contact
  on public.contact_notes(contact_id, created_at desc);

-- Realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contact_notes'
  ) then
    alter publication supabase_realtime add table public.contact_notes;
  end if;
end $$;

-- RLS
alter table public.contact_notes enable row level security;

drop policy if exists "auth read notes"        on public.contact_notes;
drop policy if exists "auth insert own notes"  on public.contact_notes;
drop policy if exists "auth update own notes"  on public.contact_notes;
drop policy if exists "auth delete own notes"  on public.contact_notes;

create policy "auth read notes"
  on public.contact_notes for select to authenticated using (true);

create policy "auth insert own notes"
  on public.contact_notes for insert to authenticated
  with check (auth.uid() = created_by);

create policy "auth update own notes"
  on public.contact_notes for update to authenticated
  using (auth.uid() = created_by);

create policy "auth delete own notes"
  on public.contact_notes for delete to authenticated
  using (auth.uid() = created_by);

-- Broaden contacts UPDATE policy to cover tags + name edits
-- (existing "auth update contacts unread" already exists from 0001 — replace)
drop policy if exists "auth update contacts unread" on public.contacts;
drop policy if exists "auth update contacts"       on public.contacts;
create policy "auth update contacts"
  on public.contacts for update to authenticated
  using (true) with check (true);

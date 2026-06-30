-- =====================================================================
-- 0002 — Multi-number support
-- One webhook can serve multiple WhatsApp business numbers (same WABA
-- or multiple WABAs on the same Meta app). Each contact + message tracks
-- which business number it belongs to.
-- =====================================================================

create table if not exists public.business_numbers (
  phone_number_id      text primary key,
  display_phone_number text,
  verified_name        text,
  created_at           timestamptz default now()
);

alter table public.contacts
  add column if not exists business_phone_number_id text
    references public.business_numbers(phone_number_id);

alter table public.messages
  add column if not exists business_phone_number_id text
    references public.business_numbers(phone_number_id);

create index if not exists idx_contacts_business_number
  on public.contacts(business_phone_number_id);

create index if not exists idx_messages_business_number
  on public.messages(business_phone_number_id);

-- Realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'business_numbers'
  ) then
    alter publication supabase_realtime add table public.business_numbers;
  end if;
end $$;

-- RLS
alter table public.business_numbers enable row level security;

drop policy if exists "auth read business_numbers" on public.business_numbers;
create policy "auth read business_numbers"
  on public.business_numbers for select
  to authenticated
  using (true);

-- Backfill: register the existing default business number
insert into public.business_numbers (phone_number_id, display_phone_number, verified_name)
values ('1150287611490963', '+91 90847 23091', 'URoots')
on conflict (phone_number_id) do nothing;

-- Backfill existing contacts + messages to point at it
update public.contacts
   set business_phone_number_id = '1150287611490963'
 where business_phone_number_id is null;

update public.messages
   set business_phone_number_id = '1150287611490963'
 where business_phone_number_id is null;

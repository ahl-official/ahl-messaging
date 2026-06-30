-- =====================================================================
-- QHT WhatsApp Dashboard — initial schema
-- Run inside Supabase SQL editor (or `supabase db push` with CLI).
-- Idempotent so it's safe to re-run.
-- =====================================================================

-- Required for gen_random_uuid()
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- contacts: one row per WhatsApp number we've interacted with
-- ---------------------------------------------------------------------
create table if not exists public.contacts (
  id                    uuid primary key default gen_random_uuid(),
  wa_id                 text unique not null,           -- e.g. "919876543210"
  name                  text,
  profile_name          text,
  last_message_at       timestamptz default now(),
  last_message_preview  text,
  unread_count          int default 0,
  created_at            timestamptz default now()
);

-- ---------------------------------------------------------------------
-- messages: every inbound + outbound WhatsApp message
-- ---------------------------------------------------------------------
create table if not exists public.messages (
  id                uuid primary key default gen_random_uuid(),
  contact_id        uuid references public.contacts(id) on delete cascade,
  wa_message_id     text unique,                        -- WA's message id (wamid.xxx)
  direction         text not null check (direction in ('inbound','outbound')),
  type              text not null,                      -- text | image | document | audio | video | template
  content           text,                               -- text body or media caption
  media_url         text,
  media_mime_type   text,
  status            text default 'sent',                -- sent | delivered | read | failed
  error_message     text,
  timestamp         timestamptz default now(),
  raw_payload       jsonb
);

create index if not exists idx_messages_contact     on public.messages(contact_id, timestamp desc);
create index if not exists idx_contacts_last_msg    on public.contacts(last_message_at desc);

-- ---------------------------------------------------------------------
-- Realtime: broadcast row changes to subscribed clients
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contacts'
  ) then
    alter publication supabase_realtime add table public.contacts;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Row level security
-- Authenticated users can read everything; writes go through the
-- service-role webhook / send-message API on the server.
-- ---------------------------------------------------------------------
alter table public.contacts enable row level security;
alter table public.messages enable row level security;

drop policy if exists "auth read contacts" on public.contacts;
create policy "auth read contacts"
  on public.contacts for select
  to authenticated
  using (true);

drop policy if exists "auth read messages" on public.messages;
create policy "auth read messages"
  on public.messages for select
  to authenticated
  using (true);

-- (Optional) allow authenticated UI to clear unread_count via update
drop policy if exists "auth update contacts unread" on public.contacts;
create policy "auth update contacts unread"
  on public.contacts for update
  to authenticated
  using (true)
  with check (true);

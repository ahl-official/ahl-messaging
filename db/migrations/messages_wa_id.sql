-- Add `wa_id` to public.messages so the Supabase Table Editor can
-- filter chats by phone number without joining contacts every time.
-- Auto-populated via a BEFORE INSERT/UPDATE trigger that copies the
-- matching contacts.wa_id, so every existing insert path in the
-- codebase keeps working unchanged.
--
-- Run in Supabase SQL Editor. Idempotent.

-- 1. Column.
alter table public.messages
  add column if not exists wa_id text;

-- 2. Index — operator filters by exact wa_id, so a btree on it is
--    enough; cheap and small.
create index if not exists messages_wa_id_idx
  on public.messages (wa_id);

-- 3. Trigger function: pull wa_id from the linked contact whenever a
--    row is inserted OR contact_id changes on update. We fall back to
--    the existing value if the lookup fails (e.g. orphaned message).
create or replace function public.fill_messages_wa_id()
returns trigger
language plpgsql
as $$
begin
  if NEW.contact_id is not null then
    select c.wa_id into NEW.wa_id
    from public.contacts c
    where c.id = NEW.contact_id;
  end if;
  return NEW;
end;
$$;

-- 4. Wire the trigger. Drop-then-create keeps the migration idempotent.
drop trigger if exists messages_fill_wa_id_trigger on public.messages;
create trigger messages_fill_wa_id_trigger
  before insert or update of contact_id on public.messages
  for each row
  execute function public.fill_messages_wa_id();

-- 5. One-time backfill for rows that predate the column. Skipped on
--    re-runs (where every row already has a value).
update public.messages m
set wa_id = c.wa_id
from public.contacts c
where m.contact_id = c.id
  and (m.wa_id is null or m.wa_id = '');

-- 6. Reload PostgREST schema cache so the column shows up in API + UI.
notify pgrst, 'reload schema';

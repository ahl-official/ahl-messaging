-- WhatsApp group support (read-only viewing).
--
-- Until now the app ingested only 1:1 customer chats. Group chats
-- (@g.us JIDs from Evolution) are now stored too — as a `contacts`
-- row flagged `is_group`, with each message carrying the participant's
-- name in `sender_name`. The inbox keeps groups out of the normal
-- filters and surfaces them under a dedicated "Groups" filter.

alter table public.contacts
  add column if not exists is_group boolean not null default false;

-- Per-message sender — for group messages this is the participant who
-- sent it (1:1 messages leave it null; the contact IS the sender).
alter table public.messages
  add column if not exists sender_name text;

-- The inbox lists groups and 1:1 chats separately — index the flag so
-- the filtered query stays fast.
create index if not exists idx_contacts_is_group
  on public.contacts(is_group);

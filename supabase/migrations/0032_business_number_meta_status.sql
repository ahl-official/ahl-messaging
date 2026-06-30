-- Track whether a business number still exists on Meta's WhatsApp
-- Business API. When an operator removes a number from Meta, the local
-- row should visibly flag "Removed from Meta" so it's obvious why
-- inbound stopped — and prompt a purge.
--
--   meta_status     — 'connected' | 'removed' | 'unknown'
--                     ('unknown' = never checked yet)
--   meta_checked_at — last time we probed Meta's Graph API for it.

alter table public.business_numbers
  add column if not exists meta_status text not null default 'unknown'
    check (meta_status in ('connected', 'removed', 'unknown'));

alter table public.business_numbers
  add column if not exists meta_checked_at timestamptz;

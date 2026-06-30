-- Call routing + atomic claim columns.
--
-- WhatsApp inbound calls were broadcasting to every operator who
-- happened to be on the dashboard, and the row stayed visible even
-- after someone picked up — so the entire team kept seeing a banner
-- for an already-answered call. This migration adds:
--
--   lsq_owner_email — cached at ring-time so we can route the banner
--                     to the LSQ lead-owner first. Falls back to "any
--                     operator with access to this business number"
--                     when the owner isn't on the platform.
--
--   claim_token     — guaranteed-unique value the accept handler
--                     conditional-UPDATEs against, so two simultaneous
--                     clicks can't both win. The losing operator gets
--                     an empty-update response and the UI tells them
--                     "Already picked up".
--
-- handled_by_user_id / handled_by_email already exist (see
-- db/migrations/whatsapp_calls_recording.sql) — those columns stay
-- the canonical "who answered" record.

alter table public.whatsapp_calls
  add column if not exists lsq_owner_email text;

create index if not exists whatsapp_calls_owner_email_idx
  on public.whatsapp_calls (lsq_owner_email)
  where status in ('ringing', 'accepted');

-- Index supporting the active-call lookup filter — we read by
-- business_phone_number_id and current status, so a partial index on
-- live calls only is the right shape.
create index if not exists whatsapp_calls_active_bpid_idx
  on public.whatsapp_calls (business_phone_number_id, start_at desc)
  where status in ('ringing', 'accepted');

notify pgrst, 'reload schema';

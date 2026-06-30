-- 0126 — LSQ webhook event log (full payloads).
--
-- The global lsq_webhook_last_payload only keeps the LATEST payload and is
-- overwritten on every hit, so a form-submission payload is gone the moment the
-- next event lands. This table keeps the FULL payload of recent events per
-- webhook (ring-buffered to the last 50) so they can actually be inspected.

create table if not exists public.lsq_webhook_events (
  id                uuid primary key default gen_random_uuid(),
  webhook_id        text,
  webhook_name      text,
  received_at       timestamptz not null default now(),
  notable_event     text,                 -- After.NotableEvent (the trigger)
  activity          text,                 -- ProspectActivityName_Max
  prospect_id       text,
  prospect_auto_id  text,                 -- LSQ lead number
  phone             text,
  stage             text,                 -- After.ProspectStage
  source            text,
  payload           jsonb not null,       -- FULL payload (untruncated)
  created_at        timestamptz not null default now()
);

create index if not exists idx_lsq_webhook_events_recent
  on public.lsq_webhook_events (received_at desc);
create index if not exists idx_lsq_webhook_events_hook
  on public.lsq_webhook_events (webhook_id, received_at desc);

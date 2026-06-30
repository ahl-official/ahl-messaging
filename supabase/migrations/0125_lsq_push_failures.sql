-- 0125 — LSQ push failures + retry queue.
--
-- When a Source/Sub-source backfill push fails (almost always an LSQ rate
-- limit), we record it here instead of silently dropping it. A 2-minute
-- heartbeat (/api/cron/lsq-push-retry) re-attempts every `pending` row whose
-- next_retry_at has passed, and the LSQ settings panel shows the queue so an
-- operator can see what failed and whether the retry eventually pushed.

create table if not exists public.lsq_push_failures (
  id                uuid primary key default gen_random_uuid(),
  lead_number       text not null,
  prospect_id       text,
  phone             text,
  first_chat_number text,
  fields            jsonb not null default '[]'::jsonb,   -- [{Attribute, Value}]
  status            text  not null default 'pending',     -- pending | pushed | failed
  attempts          int   not null default 0,
  last_error        text,
  source            text,                                  -- bulk_firstchat | bulk_source
  next_retry_at     timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  pushed_at         timestamptz,
  unique (lead_number)
);

create index if not exists idx_lsq_push_failures_due
  on public.lsq_push_failures (status, next_retry_at);

-- Chat import sessions. Tracks a single bulk-load of historical
-- contacts + messages from another platform (Interakt, old Supabase,
-- etc.) into a target WhatsApp business number on this workspace.
--
-- Why a job row instead of just streaming POSTs:
--   • 50k+ messages can't fit in one request — caller batches in chunks
--     of ~500 and we credit each chunk against the same job_id.
--   • Resume support — if the upload script dies mid-stream, the operator
--     can pick up from `processed_messages` and retry without dupes
--     (wa_message_id unique constraint protects us).
--   • UI progress bar reads the counters directly.

create table if not exists public.chat_import_jobs (
  id                       uuid primary key default gen_random_uuid(),
  target_bpid              text not null,           -- business_phone_number_id rows land under
  label                    text,                    -- operator-supplied note ("Interakt URoots Sep'25")
  status                   text not null default 'pending'
    check (status in ('pending','running','completed','failed','cancelled')),
  source_format            text,                    -- 'json' | 'csv' | 'script' | other
  total_messages           int not null default 0,  -- expected count (caller declares up-front; informational)
  total_contacts           int not null default 0,
  processed_messages       int not null default 0,  -- creditted across batches
  processed_contacts       int not null default 0,
  inserted_messages        int not null default 0,  -- actually inserted (excludes idempotent skips)
  inserted_contacts        int not null default 0,
  errors                   jsonb default '[]'::jsonb,  -- [{batch, msg}, ...] capped at ~50 entries
  created_by               text,                    -- email of operator who started it
  created_at               timestamptz not null default now(),
  finished_at              timestamptz,
  cancelled_at             timestamptz
);

create index if not exists idx_chat_import_jobs_target_bpid
  on public.chat_import_jobs(target_bpid, created_at desc);

create index if not exists idx_chat_import_jobs_status
  on public.chat_import_jobs(status, created_at desc);

-- Service-role only — there is no end-user-facing RLS read path. The
-- UI talks to a /api/import/chats endpoint that authenticates the
-- operator and uses the service-role client to read/write this table.
alter table public.chat_import_jobs enable row level security;

-- Splits ring time from talk time. `start_at` was already the moment
-- the call started ringing; `accepted_at` is when the operator picked
-- up. duration_seconds now measures TALK time (accepted_at → end_at);
-- ring_seconds covers the ring phase (start_at → accepted_at).
--
-- Backfill: existing rows lose the breakdown but that's fine — we
-- never measured talk separately before.

alter table public.whatsapp_calls
  add column if not exists accepted_at timestamptz,
  add column if not exists ring_seconds int;

notify pgrst, 'reload schema';

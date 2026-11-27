-- 0130 — Per-step drip send retries after Meta failures.
-- On send failure keep the run active, retry the SAME step after 24h.
-- After 2 attempts, mark the run failed and stop.

ALTER TABLE public.drip_runs
  ADD COLUMN IF NOT EXISTS step_send_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_send_error text,
  ADD COLUMN IF NOT EXISTS last_sent_step_order int,
  ADD COLUMN IF NOT EXISTS last_sent_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failed_wa_message_id text;

COMMENT ON COLUMN public.drip_runs.step_send_attempts IS
  'Send attempts for the current next_step_order. Reset to 0 when the step advances. Max 2 then status=failed.';
COMMENT ON COLUMN public.drip_runs.last_send_error IS
  'Last Meta/send error for the current step (cleared on successful send).';
COMMENT ON COLUMN public.drip_runs.last_sent_step_order IS
  'Step order of the last accepted Meta send (for delivery-fail rollback).';
COMMENT ON COLUMN public.drip_runs.last_sent_attempts IS
  'step_send_attempts at the moment Meta accepted the last send (delivery-fail continues this counter).';
COMMENT ON COLUMN public.drip_runs.last_failed_wa_message_id IS
  'Last wa_message_id whose delivery-fail was already handled (dedupe webhooks).';

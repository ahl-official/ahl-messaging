-- =====================================================================
-- 0061 — Atomic claim for runAutomation
-- ---------------------------------------------------------------------
-- Two cron-driven invokers can fire runAutomation for the same inbound
-- trigger_message_id at the same time:
--   1. /api/automation/process-pending  (debounced worker)
--   2. /api/automation/sweep            (safety-net for missed inbounds)
-- The pre-send "any AI reply yet?" guard wasn't atomic — both runs
-- could pass the check before either had INSERTed, producing two AI
-- replies for one patient message.
--
-- This partial unique index turns the FIRST automation_logs insert
-- with status IN ('processing','success') into the atomic claim. A
-- parallel runAutomation hits 23505 and bails before the LLM call.
-- ---------------------------------------------------------------------
-- 1) Allow 'processing' as a status — the claim sentinel runAutomation
--    inserts at start. Drop + recreate the CHECK constraint (Postgres
--    has no "ADD VALUE" for CHECK; only for ENUM types).
ALTER TABLE public.automation_logs
  DROP CONSTRAINT IF EXISTS automation_logs_status_check;
ALTER TABLE public.automation_logs
  ADD CONSTRAINT automation_logs_status_check
  CHECK (status IN ('processing', 'success', 'failed', 'skipped'));

-- 2) Only one in-flight or successful AI reply per trigger message.
--    The partial WHERE leaves room for 'skipped' / 'failed' rows since
--    those don't represent a send and shouldn't block a future claim.
CREATE UNIQUE INDEX IF NOT EXISTS automation_logs_trigger_claim_idx
  ON public.automation_logs (trigger_message_id)
  WHERE status IN ('processing', 'success');

-- =====================================================================
-- 0058 — Automation inbound debounce
-- ---------------------------------------------------------------------
-- Today the AI fires immediately on every inbound message. Patients
-- often send 3-4 messages back-to-back; that produced 3-4 separate
-- replies and visible races against the next inbound.
--
-- New flow: the webhook sets `contacts.automation_pending_at` to
-- `now() + debounce` instead of running the LLM. Every subsequent
-- inbound within the window resets the timestamp. A worker route
-- (/api/automation/process-pending) hit by cron every few seconds
-- atomically picks contacts whose timestamp has elapsed and fires the
-- run ONCE — the LLM sees the whole batch in its context window and
-- produces a single consolidated reply.
-- =====================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS automation_pending_at timestamptz;

-- Partial index — the worker only scans rows whose timer is armed, so
-- a sparse partial index keeps the planner fast even on 100k contacts.
CREATE INDEX IF NOT EXISTS contacts_automation_pending_at_idx
  ON public.contacts (automation_pending_at)
  WHERE automation_pending_at IS NOT NULL;

ALTER TABLE public.automation_configs
  ADD COLUMN IF NOT EXISTS inbound_debounce_seconds int NOT NULL DEFAULT 10;

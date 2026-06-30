-- =====================================================================
-- 0078 — Trigger flows: add 'template_reply' trigger type
-- ---------------------------------------------------------------------
-- Fires when a patient replies right after a template was sent to them.
-- trigger_config: { template_name?: '<name>' }  (blank = any template)
-- =====================================================================

ALTER TABLE public.trigger_flows DROP CONSTRAINT IF EXISTS trigger_flows_trigger_type_check;
ALTER TABLE public.trigger_flows
  ADD CONSTRAINT trigger_flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'schedule', 'webhook', 'template_reply'));

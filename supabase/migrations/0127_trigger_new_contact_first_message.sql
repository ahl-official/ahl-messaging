-- 0127 — allow the new flow triggers: 'new_contact' (first message from a
-- never-engaged number) and 'first_message' (new conversation after a gap).
-- The 0078 check constraint only listed keyword/schedule/webhook/template_reply,
-- so saving a flow with either new trigger failed with
-- trigger_flows_trigger_type_check.

ALTER TABLE public.trigger_flows DROP CONSTRAINT IF EXISTS trigger_flows_trigger_type_check;

ALTER TABLE public.trigger_flows
  ADD CONSTRAINT trigger_flows_trigger_type_check
  CHECK (trigger_type IN (
    'keyword', 'schedule', 'webhook', 'template_reply', 'new_contact', 'first_message'
  ));

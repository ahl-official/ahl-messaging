-- campaign_recipients.error_code was written by the campaign worker
-- (lib/campaigns.ts) and read by the Failure Breakdown UI, but the column
-- was never created — so EVERY failed send's "mark failed" update errored
-- out, leaving recipients stuck in 'sending' forever (the worker only
-- re-picks 'pending'). Add the column so failures record their Meta error
-- code (132012, 131026, …) and the breakdown can group by it.

alter table public.campaign_recipients
  add column if not exists error_code text;

-- Add the recipient's phone to the automation-run ledger so the Lead
-- Automations report can show how many people got the message and which
-- numbers. Existing rows stay NULL (no backfill); new sends record it.

alter table lead_automation_runs
  add column if not exists mobile text;

-- Automation config: photo-stage + image-response columns.
--
-- The /api/automation/config PUT route (and the Automation panel UI)
-- have been writing these three columns, but no migration ever created
-- them. Every save from the panel hit "column does not exist" and 500'd
-- — so persona / model / any field edit silently failed to persist.
--
-- `if not exists` keeps this safe to run even where the columns were
-- already added by hand.

alter table public.automation_configs
  add column if not exists photo_lead_stage_target text,
  add column if not exists photo_lead_stage_allowed_from text[],
  add column if not exists image_response_triggers jsonb not null default '[]'::jsonb;

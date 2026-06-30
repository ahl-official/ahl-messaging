-- Image-flow + photo-receive automation config.
-- Adds:
--   • image_system_prompt          — overrides the default persona when
--                                    the inbound message is an image so
--                                    the LLM can react to "I sent photos".
--   • image_reply_delay_seconds    — debounce window before the bot
--                                    replies to an image; second image
--                                    arriving in that window restarts
--                                    the timer and only one reply fires.
--   • photo_lead_stage_target      — LSQ ProspectStage to set after the
--                                    first image arrives ("Photos Received").
--   • photo_lead_stage_allowed_from — list of stages the lead must
--                                    currently be in for the transition
--                                    to fire. Outside the list = no-op.
--
-- Run in Supabase SQL Editor. Idempotent.

alter table public.automation_configs
  add column if not exists image_system_prompt text,
  add column if not exists image_reply_delay_seconds int not null default 30,
  add column if not exists photo_lead_stage_target text not null default 'Photos Received',
  add column if not exists photo_lead_stage_allowed_from jsonb not null
    default '["Prospect","Engaged","Pending First Contact","Photo Awaited"]'::jsonb;

notify pgrst, 'reload schema';

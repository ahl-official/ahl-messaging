-- Image-response triggers for automation_configs.
--
-- Each row in the array describes ONE rule:
--   {
--     "patterns": ["front/top/side", "2-3 clear photos"],
--     "image_url": "https://…/photo-instructions.jpg",
--     "caption":  "Aap apni front, top aur side ki 2-3 clear scalp photos bhej do.",
--     "gate_by_stage": true
--   }
--
-- When the bot's generated reply contains ANY pattern (case-insensitive
-- substring or regex match) AND the gate passes (lead's current stage
-- is in `photo_lead_stage_allowed_from`), the pipeline replaces the
-- text dispatch with an image dispatch. Caption rides along with the
-- image; empty caption = image only.

alter table public.automation_configs
  add column if not exists image_response_triggers jsonb not null
    default '[]'::jsonb;

notify pgrst, 'reload schema';

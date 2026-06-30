-- =====================================================================
-- 0101 — Stage-based AI personas
-- ---------------------------------------------------------------------
-- A per-number map of { "<LSQ stage>": "<persona text>" }. At reply time
-- the engine appends the persona matching the contact's CURRENT lsq_stage
-- to the base system_prompt — so a Prospect lead gets the Prospect
-- scenario, an HT Done lead gets the HT Done scenario, etc. Empty / no
-- match → just the base persona (back-compat).
-- =====================================================================
ALTER TABLE public.automation_configs
  ADD COLUMN IF NOT EXISTS stage_personas jsonb NOT NULL DEFAULT '{}'::jsonb;

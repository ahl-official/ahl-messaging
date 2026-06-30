-- =====================================================================
-- 0096 — Drip trigger: match on any LSQ field (Brand / NDR / utm / Source)
-- ---------------------------------------------------------------------
-- A drip can now enroll on stage PLUS an exact value of any LSQ lead
-- field — e.g. trigger_field='mx_Brand', trigger_value='QHT' targets
-- hair-transplant leads (whose Source is "URoots" but Brand is "QHT").
-- trigger_field NULL = stage-only (old behaviour). trigger_source stays
-- for back-compat but new drips use trigger_field/value.
-- =====================================================================
ALTER TABLE public.drip_campaigns
  ADD COLUMN IF NOT EXISTS trigger_field text,   -- LSQ schema name, e.g. mx_Brand
  ADD COLUMN IF NOT EXISTS trigger_value text;   -- exact value (case-insensitive)

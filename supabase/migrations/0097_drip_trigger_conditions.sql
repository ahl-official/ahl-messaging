-- =====================================================================
-- 0097 — Drip multi-field trigger conditions
-- ---------------------------------------------------------------------
-- A drip can enroll on stage PLUS several LSQ field conditions, all of
-- which must match (AND). Stored as a JSON array:
--   [{"field":"mx_Brand","value":"QHT"},
--    {"field":"mx_NDR_Reason","value":"URoots"}]
-- An empty value matches "any non-empty". Supersedes the single
-- trigger_field/trigger_value (kept for back-compat).
-- =====================================================================
ALTER TABLE public.drip_campaigns
  ADD COLUMN IF NOT EXISTS trigger_conditions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- =====================================================================
-- 0105 — Lead Distribution: lead-source filter
-- ---------------------------------------------------------------------
-- Only distribute leads whose Source is in this list. Empty = all
-- sources (no source filter). Mirrors the brand filter (0104).
-- =====================================================================
ALTER TABLE public.lead_distribution_config
  ADD COLUMN IF NOT EXISTS sources jsonb NOT NULL DEFAULT '[]'::jsonb;

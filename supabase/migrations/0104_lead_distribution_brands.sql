-- =====================================================================
-- 0104 — Lead Distribution: brand filter
-- ---------------------------------------------------------------------
-- Only distribute leads whose mx_Brand is in this list. Empty = all
-- brands (no brand filter). Lets e.g. only "American Hairline" leads be auto-assigned
-- while other brands' leads are left untouched.
-- =====================================================================
ALTER TABLE public.lead_distribution_config
  ADD COLUMN IF NOT EXISTS brands jsonb NOT NULL DEFAULT '[]'::jsonb;

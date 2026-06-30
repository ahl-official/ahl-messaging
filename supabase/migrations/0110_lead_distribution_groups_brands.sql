-- =====================================================================
-- 0110 — Stage groups: optional brand filter
-- ---------------------------------------------------------------------
-- A stage group can now also be scoped to specific brand(s) (mx_Brand).
-- Empty = any brand. So e.g. "Photos Received + American Hairline" routes only American Hairline
-- Photos-Received leads to the group's agents.
-- =====================================================================
ALTER TABLE public.lead_distribution_groups
  ADD COLUMN IF NOT EXISTS brands jsonb NOT NULL DEFAULT '[]'::jsonb;

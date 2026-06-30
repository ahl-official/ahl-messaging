-- =====================================================================
-- 0106 — Lead Distribution: distinct lead-sources helper
-- ---------------------------------------------------------------------
-- Returns every distinct lead Source we've stored on contacts, so the
-- Lead-source filter dropdown can list them all (LSQ's metadata API does
-- not expose Source options).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.lead_distribution_sources()
RETURNS TABLE(source text)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT trim(lsq_source) AS source
  FROM public.contacts
  WHERE lsq_source IS NOT NULL AND trim(lsq_source) <> ''
  ORDER BY 1
$$;

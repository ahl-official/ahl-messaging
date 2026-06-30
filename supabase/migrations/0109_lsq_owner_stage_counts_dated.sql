-- =====================================================================
-- 0109 — LSQ owner × stage counts: optional date range
-- ---------------------------------------------------------------------
-- Adds a [p_from, p_to) filter on contacts.created_at so the LSQ assignment
-- view can be filtered by day / month / year. NULL bounds = all time.
-- =====================================================================
DROP FUNCTION IF EXISTS public.lsq_owner_stage_counts();

CREATE OR REPLACE FUNCTION public.lsq_owner_stage_counts(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(owner_email text, owner_name text, stage text, n bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT
    lower(trim(lsq_owner_email))                       AS owner_email,
    max(lsq_owner_name)                                AS owner_name,
    coalesce(nullif(trim(lsq_stage), ''), 'Unknown')   AS stage,
    count(*)::bigint                                   AS n
  FROM public.contacts
  WHERE lsq_owner_email IS NOT NULL AND trim(lsq_owner_email) <> ''
    AND (p_from IS NULL OR created_at >= p_from)
    AND (p_to   IS NULL OR created_at <  p_to)
  GROUP BY 1, 3
$$;

-- =====================================================================
-- 0108 — LSQ owner × stage counts (for the Lead Distribution view)
-- ---------------------------------------------------------------------
-- The "LSQ live assignment" tab was built off the webhook event log, which
-- only carries the stages LSQ happens to push there (e.g. Photo Awaited but
-- not Photos Received). This aggregates the REAL current state straight from
-- contacts (lsq_owner_email × lsq_stage), so every stage shows.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.lsq_owner_stage_counts()
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
  GROUP BY 1, 3
$$;

-- =====================================================================
-- 0114 — Lead Distribution: denormalised summary columns (perf)
-- ---------------------------------------------------------------------
-- The Executions / LSQ-assignment lists were selecting the full `lead`
-- jsonb for every row (~900ms for 200 rows). We pull the few fields the
-- lists actually need onto plain columns so the queries don't touch the
-- heavy payload.
-- =====================================================================
ALTER TABLE public.lead_distribution_pending
  ADD COLUMN IF NOT EXISTS stage       text,
  ADD COLUMN IF NOT EXISTS lead_name   text,
  ADD COLUMN IF NOT EXISTS owner_email text,
  ADD COLUMN IF NOT EXISTS lead_number text;

CREATE INDEX IF NOT EXISTS idx_ld_pending_owner_email ON public.lead_distribution_pending (lower(owner_email));
CREATE INDEX IF NOT EXISTS idx_ld_pending_stage ON public.lead_distribution_pending (stage);

-- Backfill the new columns from the existing `lead` payload (handles the
-- raw top-level shape and the After/body-wrapped shape).
UPDATE public.lead_distribution_pending p
SET
  stage       = NULLIF(TRIM(COALESCE(l->>'ProspectStage', l->>'Stage', '')), ''),
  lead_name   = NULLIF(TRIM(COALESCE(l->>'FirstName', l->>'Name', '')), ''),
  owner_email = NULLIF(LOWER(TRIM(COALESCE(l->>'OwnerIdEmailAddress', l->>'OwnerEmailAddress', ''))), ''),
  lead_number = NULLIF(TRIM(COALESCE(l->>'ProspectAutoId', l->>'leadnumber', '')), '')
FROM (
  SELECT id, COALESCE(lead->'After', lead->'body', lead) AS l
  FROM public.lead_distribution_pending
) src
WHERE p.id = src.id;

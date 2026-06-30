-- =====================================================================
-- 0107 — Lead Distribution: prospect_id for dedup
-- ---------------------------------------------------------------------
-- The webhook can now fire on BOTH Lead Creation and Lead Stage Change,
-- so the same lead arrives twice. Storing the LSQ ProspectID lets the
-- engine assign each lead only once (skip if already assigned).
-- =====================================================================
ALTER TABLE public.lead_distribution_pending
  ADD COLUMN IF NOT EXISTS prospect_id text;

CREATE INDEX IF NOT EXISTS idx_ld_pending_prospect
  ON public.lead_distribution_pending (prospect_id);

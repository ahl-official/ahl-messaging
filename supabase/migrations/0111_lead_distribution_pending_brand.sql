-- =====================================================================
-- 0111 — Lead Distribution: store brand on each webhook lead
-- ---------------------------------------------------------------------
-- The webhook payload rarely carries mx_Brand, so the Executions brand
-- filter had nothing to match on. We now resolve + store the brand per
-- lead at ingest (from the payload, else a one-time LSQ lookup) so the
-- filter works for every event.
-- =====================================================================
ALTER TABLE public.lead_distribution_pending
  ADD COLUMN IF NOT EXISTS brand text;

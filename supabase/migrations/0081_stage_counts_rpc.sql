-- =====================================================================
-- 0081 — get_stage_counts RPC (replaces the 136-round-trip JS paginator)
-- ---------------------------------------------------------------------
-- /api/lsq/stage-counts was looping `range(from, from+999)` over the whole
-- contacts table (135k+ rows = ~136 sequential round-trips, every 30s, from
-- two pollers) and tallying lsq_stage in JS — the "data calculation" stall.
--
-- This does it in ONE indexed GROUP BY. allowed_bpids NULL = owner (no
-- number filter); hidden_bpids excludes numbers toggled off in the UI.
-- Pairs with the contacts(business_phone_number_id, lsq_stage) index (0080)
-- for an index scan on the scoped case. Runs SECURITY INVOKER so contacts
-- RLS still applies.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_stage_counts(
  allowed_bpids text[] DEFAULT NULL,
  hidden_bpids  text[] DEFAULT '{}'
)
RETURNS TABLE(lsq_stage text, cnt bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT c.lsq_stage, count(*)::bigint AS cnt
  FROM public.contacts c
  WHERE (allowed_bpids IS NULL OR c.business_phone_number_id = ANY(allowed_bpids))
    AND NOT (c.business_phone_number_id = ANY(hidden_bpids))
  GROUP BY c.lsq_stage;
$$;

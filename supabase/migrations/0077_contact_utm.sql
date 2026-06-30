-- =====================================================================
-- 0077 — Campaign UTM attribution on contacts
-- ---------------------------------------------------------------------
-- When a campaign's wa.me?text=... link carries utm_* / source_id in the
-- pre-filled message, the lead's FIRST inbound arrives with that marker.
-- The webhook parses it (lib/utm.ts) and stamps it here, once — the
-- first-touch source is preserved (we never overwrite a set utm_source).
--
--   • utm_source — best-effort single label for display/filtering
--   • utm_params — the full parsed bag (utm_medium, utm_campaign,
--                  source_id, ref, etc.) for LSQ push / reporting
-- =====================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS utm_params jsonb;

-- =====================================================================
-- 0099 — Conversion values on contacts (for campaign LSQ conversions)
-- ---------------------------------------------------------------------
-- The campaign "LSQ conversions" card buckets recipients by their CURRENT
-- lsq_stage (kept fresh by the LSQ webhook) and shows a value. Storing the
-- value locally lets the card read ALL recipients cheaply (no per-lead LSQ
-- call) so it can auto-refresh. Filled from the webhook payload, or
-- backfilled by a bounded LSQ fetch when missing.
-- =====================================================================
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lsq_total_package numeric,   -- HT Done / Order Placed package value
  ADD COLUMN IF NOT EXISTS lsq_order_value   numeric,   -- Order Confirmed order value (Revenue)
  ADD COLUMN IF NOT EXISTS lsq_sales_notes   text;      -- package notes / review

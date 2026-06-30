-- =====================================================================
-- 0112 — Lead Distribution: daily cap reset marker
-- ---------------------------------------------------------------------
-- haridwar_sales_agents.leads_today is the per-DAY counter the cap checks
-- against. It must reset at IST midnight, else every agent stays "full"
-- after their first 20. We store the last reset date (IST YYYY-MM-DD) on
-- the config; the scheduler tick resets all counters when the date rolls.
-- =====================================================================
ALTER TABLE public.lead_distribution_config
  ADD COLUMN IF NOT EXISTS leads_reset_date text;

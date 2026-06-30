-- ============================================================================
-- 0014_business_number_active.sql — per-number visibility toggle
-- ----------------------------------------------------------------------------
-- Adds is_active to business_numbers so the user-menu can flip a number
-- on/off and the inbox can hide its conversations without removing it from
-- the portfolio. Webhooks keep ingesting (we don't want to silently drop
-- inbound messages); the flag only controls UI visibility.
-- ============================================================================

ALTER TABLE business_numbers
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS business_numbers_is_active_idx
  ON business_numbers (is_active)
  WHERE is_active = false;

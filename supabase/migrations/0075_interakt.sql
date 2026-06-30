-- =====================================================================
-- 0074 — Interakt (WhatsApp BSP) provider
-- ---------------------------------------------------------------------
-- A second, parallel inbound/outbound routing alongside Meta + Evolution.
-- Interakt POSTs every event to our /api/interakt/webhook/<secret> route;
-- we ingest into the SAME contacts / messages tables so the existing
-- inbox renders Interakt chats with zero UI changes.
--
-- Nothing here touches the Meta or Evolution code paths — additive only:
--   • widen business_numbers.provider to allow 'interakt'
--   • per-number Interakt API key (nullable; falls back to the
--     workspace-level key in app_settings)
-- The webhook secret + default API key live in app_settings
-- ('interakt_webhook_secret', 'interakt_api_key').
-- =====================================================================

-- Widen the provider CHECK (originally meta|evolution from 0039).
ALTER TABLE public.business_numbers
  DROP CONSTRAINT IF EXISTS business_numbers_provider_check;
ALTER TABLE public.business_numbers
  ADD CONSTRAINT business_numbers_provider_check
  CHECK (provider IN ('meta', 'evolution', 'interakt'));

-- Optional per-number Interakt API key. NULL ⇒ use the workspace-level
-- key stored in app_settings('interakt_api_key').
ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS interakt_api_key text;

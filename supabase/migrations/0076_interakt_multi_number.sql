-- =====================================================================
-- 0076 — Interakt: multiple numbers (per-number webhook secret)
-- ---------------------------------------------------------------------
-- Each Interakt account = one business_numbers row (provider='interakt')
-- carrying its OWN api key (0074) + webhook secret. Interakt's webhook
-- payload only contains the customer number, so the secret in the
-- /api/interakt/webhook/<secret> URL is what identifies which number an
-- event belongs to.
-- =====================================================================

ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS interakt_webhook_secret text;

CREATE UNIQUE INDEX IF NOT EXISTS business_numbers_interakt_secret_uidx
  ON public.business_numbers(interakt_webhook_secret)
  WHERE interakt_webhook_secret IS NOT NULL;

-- NOTE: the single-number remap/guard triggers (added live during the
-- old-code transition) must be dropped once this multi-number code is
-- deployed — they force every Interakt event onto one number:
--   DROP TRIGGER IF EXISTS remap_interakt_bpid_contacts ON public.contacts;
--   DROP TRIGGER IF EXISTS remap_interakt_bpid_messages ON public.messages;
--   DROP TRIGGER IF EXISTS guard_interakt_business_number ON public.business_numbers;

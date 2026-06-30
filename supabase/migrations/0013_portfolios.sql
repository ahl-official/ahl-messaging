-- ============================================================================
-- 0013_portfolios.sql — multi-Meta-app architecture
-- ----------------------------------------------------------------------------
-- The dashboard now hosts multiple WhatsApp business portfolios (one per
-- company / brand), each with its own Meta App credentials and a fleet of
-- phone numbers. Inbound + outbound on a given number must use that
-- portfolio's access token, app id, etc.
--
-- Architecture:
--   whatsapp_portfolios     — one row per Meta App / portfolio
--     ↳ access_token, app_id, business_account_id, verify_token
--   business_numbers        — gets a portfolio_id FK (every number belongs
--                             to exactly one portfolio).
--   business_numbers.portfolio_id is nullable during the transition window
--     so existing single-app installs keep functioning. The fallback path
--     in lib/portfolios.ts uses app_credentials.* when portfolio_id is null.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_portfolios (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Display name shown in the UI ("URoots", "QHT Clinic"). Doesn't need to
  -- match anything Meta-side; just for the admin's convenience.
  name                     text NOT NULL UNIQUE,
  -- Permanent System User access token for the Meta App that owns this
  -- portfolio. Stored in plaintext, locked down via RLS.
  access_token             text NOT NULL,
  -- Meta App ID — required for media-header template uploads (Resumable
  -- Upload uses /{app_id}/uploads).
  app_id                   text,
  -- Business Account ID (WABA) — used by Templates pages.
  business_account_id      text,
  -- Webhook verify handshake token. Each Meta App has its own; the
  -- webhook GET handler matches the incoming `hub.verify_token` against
  -- the verify_token of every portfolio, so a single /api/webhook URL
  -- works for all apps.
  verify_token             text NOT NULL,
  -- Optional: where the agents see this portfolio in chat headers.
  display_name             text,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_portfolios ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS whatsapp_portfolios_set_updated_at ON public.whatsapp_portfolios;
CREATE TRIGGER whatsapp_portfolios_set_updated_at
  BEFORE UPDATE ON public.whatsapp_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Wire each phone number to its parent portfolio. Nullable during the
-- transition; the helper falls back to the legacy single-app credentials.
ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS portfolio_id uuid REFERENCES public.whatsapp_portfolios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS business_numbers_portfolio_idx
  ON public.business_numbers (portfolio_id);

-- ============================================================================
-- 0012_app_credentials.sql — DB-backed secret storage
-- ----------------------------------------------------------------------------
-- Centralizes API keys / tokens / endpoints that today live in .env.local so
-- admins can rotate them from the dashboard without redeploying. The shape
-- is intentionally a flat key/value bag — UI only surfaces the keys we've
-- explicitly added (start: openai_api_key + whatsapp_access_token), but the
-- schema is ready for future additions (LSQ, Interakt, etc.).
--
-- Security model:
--   * Strict RLS — no policies are added, so non-service-role users get
--     ZERO access. Every read goes through createServiceRoleClient() in
--     server code, gated by an explicit "owner role" check at the API layer.
--   * Plaintext at rest. Acceptable for a small clinic team; if scale or
--     compliance ever demands it, swap to Supabase Vault / pgsodium and
--     point the helper at decrypted_secrets.
--   * UI masks values by default (eye-toggle to reveal).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.app_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Logical name. Use lower_snake_case (e.g. 'openai_api_key',
  -- 'whatsapp_access_token'). The credentials helper looks rows up by
  -- this column, so it has to be unique + stable.
  key          text NOT NULL UNIQUE,
  value        text NOT NULL,
  -- Optional human-readable note for the UI ("API key used by the
  -- AI auto-reply on the Automation page").
  description  text,
  -- Coarse grouping for the UI ("openai", "whatsapp", "lsq", "image_generator").
  category     text,
  updated_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- RLS lockdown — without explicit policies this denies everyone except the
-- service-role bypass. Reads/writes all flow through server-side API routes
-- that gate on owner role.
ALTER TABLE public.app_credentials ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS app_credentials_set_updated_at ON public.app_credentials;
CREATE TRIGGER app_credentials_set_updated_at
  BEFORE UPDATE ON public.app_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

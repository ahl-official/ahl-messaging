-- Adds the "provider" axis to business_numbers so the same table can
-- hold both Meta Cloud API numbers (the existing flow, default
-- `provider='meta'`) and Evolution API numbers (unofficial / Baileys-
-- based, `provider='evolution'`). All existing rows are backfilled to
-- 'meta' via the column DEFAULT — no migration of historical data.
--
-- Evolution-specific columns are NULLABLE and only filled when
-- provider='evolution'. They mirror the shape Evolution returns from
-- /instance/create + the connection-state response:
--   • instance_name   — caller-chosen identifier (used in URL path)
--   • instance_api_key — per-instance key Evolution issues at create
--   • jid             — WhatsApp JID once the QR is scanned
--                       (e.g. "919876543210@s.whatsapp.net")
--   • connection_state — last known state ('open' / 'connecting' /
--                        'close') so the dashboard can show a live
--                        status pill without polling Evolution on each
--                        page load.
--
-- A partial unique index on instance_name (where not null) prevents
-- two rows pointing at the same Evolution instance. Meta rows keep
-- their existing uniqueness on phone_number_id (PK).

ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'evolution')),
  ADD COLUMN IF NOT EXISTS evolution_instance_name text,
  ADD COLUMN IF NOT EXISTS evolution_api_key text,
  ADD COLUMN IF NOT EXISTS evolution_jid text,
  ADD COLUMN IF NOT EXISTS evolution_connection_state text
    CHECK (evolution_connection_state IN ('open', 'connecting', 'close') OR evolution_connection_state IS NULL),
  ADD COLUMN IF NOT EXISTS evolution_last_state_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS business_numbers_evolution_instance_name_idx
  ON public.business_numbers (evolution_instance_name)
  WHERE evolution_instance_name IS NOT NULL;

-- Provider lookup is on every webhook + send dispatch — index it.
CREATE INDEX IF NOT EXISTS business_numbers_provider_idx
  ON public.business_numbers (provider);

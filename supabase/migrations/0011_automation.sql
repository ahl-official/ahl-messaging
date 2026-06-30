-- ============================================================================
-- 0011_automation.sql — AI auto-reply foundation
-- ----------------------------------------------------------------------------
-- Mirrors the fundamentals from the existing n8n WhatsApp bot:
--   - Per-number config (system prompt, model, on/off)
--   - Per-contact chat memory (last N messages context window)
--   - Run logs for audit + debugging
-- Knowledge base + intent routing live in later migrations (Phase 2/3).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- automation_configs — one row per WhatsApp business number
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.automation_configs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_phone_number_id text NOT NULL UNIQUE,
  -- Master switch. When FALSE, no auto-replies; agents handle everything.
  enabled                  boolean NOT NULL DEFAULT false,
  -- The agent's persona / instructions (editable per number from Settings).
  system_prompt            text NOT NULL DEFAULT
    E'You are a friendly support assistant at QHT Clinic, a hair restoration center based in Dehradun. Reply to customer queries in clear Hinglish.\n\n- Always be polite and helpful.\n- For cost questions, mention that exact pricing requires hair photos for graft estimation.\n- Keep replies concise (under 200 words).\n- Never mention you are an AI; speak naturally as a clinic representative.',
  model                    text NOT NULL DEFAULT 'gpt-4o-mini',
  temperature              numeric NOT NULL DEFAULT 0.4,
  -- Past messages to feed as context (more = smarter, more = costlier).
  context_window           int NOT NULL DEFAULT 50,
  -- Skip auto-reply when a human agent sent something within this many
  -- minutes — prevents the AI from talking over a live agent.
  human_takeover_minutes   int NOT NULL DEFAULT 2,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_configs_temp_range CHECK (temperature BETWEEN 0 AND 2),
  CONSTRAINT automation_configs_window_range CHECK (context_window BETWEEN 1 AND 200)
);

-- Auto-touch updated_at on any UPDATE.
DROP TRIGGER IF EXISTS automation_configs_set_updated_at ON public.automation_configs;
CREATE TRIGGER automation_configs_set_updated_at
  BEFORE UPDATE ON public.automation_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- automation_logs — one row per automation invocation (success or failure)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.automation_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  -- Which WhatsApp business number was this run on. Denormalized off the
  -- contact so the activity feed can filter by number without a JOIN, even
  -- if the contact's number assignment changes later.
  business_phone_number_id text,
  -- The inbound message that triggered the run.
  trigger_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  -- The outbound reply we sent (NULL when send failed or skipped).
  reply_message_id  uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  status            text NOT NULL
                      CHECK (status IN ('success', 'failed', 'skipped')),
  -- Why we skipped: human-takeover, automation-disabled, no-config, etc.
  skip_reason       text,
  model             text,
  prompt_tokens     int,
  completion_tokens int,
  duration_ms       int,
  raw_output        text,
  cleaned_output    text,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_logs_contact_idx
  ON public.automation_logs (contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS automation_logs_status_idx
  ON public.automation_logs (status, created_at DESC);

-- Per-number activity-feed lookup — most-recent runs for a given number.
-- Wrapped in ADD COLUMN IF NOT EXISTS so re-running this migration on a
-- DB that already has automation_logs (from an earlier version of this
-- file) safely upgrades it to the per-number-filterable shape.
ALTER TABLE public.automation_logs
  ADD COLUMN IF NOT EXISTS business_phone_number_id text;

CREATE INDEX IF NOT EXISTS automation_logs_number_idx
  ON public.automation_logs (business_phone_number_id, created_at DESC);

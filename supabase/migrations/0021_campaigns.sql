-- =====================================================================
-- 0021 — Outbound campaigns (templates + magic-message variants)
-- ---------------------------------------------------------------------
-- Two campaign types share one schema:
--   • template       — pre-approved WhatsApp template + per-recipient vars
--   • magic_message  — AI-generated personalized message via the persona
--
-- Lifecycle: draft → scheduled → sending → completed (or failed/canceled).
-- An in-process tick (instrumentation hook) wakes every 30s, picks
-- campaigns whose schedule_at is due, and sends N pending recipients
-- per tick (rate_limit_per_minute / 2 for the 30s window). Webhook
-- updates push delivery / read / reply state back onto each recipient.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) campaigns — one row per send
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campaigns (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                         text NOT NULL,
  type                         text NOT NULL CHECK (type IN ('template', 'magic_message')),
  status                       text NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft','scheduled','sending','completed','canceled','failed')),

  -- Source number
  business_phone_number_id     text NOT NULL
                                  REFERENCES public.business_numbers(phone_number_id) ON DELETE CASCADE,

  -- Template-mode fields (NULL when type='magic_message')
  template_name                text,
  template_language            text,
  template_components          jsonb,                       -- prebuilt header / button params
  template_body_preview        text,                        -- rendered preview text
  template_media_url           text,                        -- header media URL if any
  template_footer              text,
  template_buttons             jsonb,

  -- Magic-message-mode fields (NULL when type='template')
  magic_prompt                 text,                        -- operator's brief to AI
  magic_persona_override       text,                        -- optional persona override
  magic_tone                   text,                        -- e.g. "warm", "concise"

  -- Scheduling
  schedule_at                  timestamptz,                 -- NULL = send now on start
  -- Quiet hours kept as half-open [start, end) in IST. NULL = send 24/7.
  quiet_hours_start            text,                        -- e.g. "21:00"
  quiet_hours_end              text,                        -- e.g. "09:00"
  rate_limit_per_minute        int  NOT NULL DEFAULT 30,    -- safety throttle

  -- Counters (live-updated by the worker / webhook)
  total_recipients             int  NOT NULL DEFAULT 0,
  sent_count                   int  NOT NULL DEFAULT 0,
  delivered_count              int  NOT NULL DEFAULT 0,
  read_count                   int  NOT NULL DEFAULT 0,
  replied_count                int  NOT NULL DEFAULT 0,
  failed_count                 int  NOT NULL DEFAULT 0,
  unsubscribed_count           int  NOT NULL DEFAULT 0,

  -- Bookkeeping
  created_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at                   timestamptz,
  completed_at                 timestamptz,
  last_error                   text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaigns_status_schedule_idx
  ON public.campaigns(status, schedule_at);
CREATE INDEX IF NOT EXISTS campaigns_business_idx
  ON public.campaigns(business_phone_number_id, created_at DESC);

DROP TRIGGER IF EXISTS campaigns_set_updated_at ON public.campaigns;
CREATE TRIGGER campaigns_set_updated_at
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------
-- 2) campaign_recipients — one row per (campaign, contact)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campaign_recipients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  wa_id               text NOT NULL,
  display_name        text,
  -- Per-recipient template variables (e.g. {"name":"Rahul","date":"5 May"})
  -- AND magic-message context attributes the AI uses for personalization.
  variables           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Lifecycle for THIS recipient
  status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','sending','sent','delivered','read','replied','failed','skipped','unsubscribed')),
  wa_message_id       text,                                 -- Meta wamid once sent
  message_id          uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  -- Generated body for magic_message campaigns; cached so retries
  -- don't burn fresh AI tokens.
  generated_text      text,
  prompt_tokens       int,
  completion_tokens   int,

  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  replied_at          timestamptz,
  failed_reason       text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_campaign_wa_uidx
  ON public.campaign_recipients(campaign_id, wa_id);
CREATE INDEX IF NOT EXISTS campaign_recipients_status_idx
  ON public.campaign_recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS campaign_recipients_wa_message_idx
  ON public.campaign_recipients(wa_message_id) WHERE wa_message_id IS NOT NULL;

DROP TRIGGER IF EXISTS campaign_recipients_set_updated_at ON public.campaign_recipients;
CREATE TRIGGER campaign_recipients_set_updated_at
  BEFORE UPDATE ON public.campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------
-- 3) campaign_unsubscribes — STOP keyword opts-outs persist forever
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campaign_unsubscribes (
  wa_id                    text NOT NULL,
  business_phone_number_id text NOT NULL,
  source                   text NOT NULL DEFAULT 'stop_reply',  -- 'stop_reply' | 'manual'
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wa_id, business_phone_number_id)
);

-- ---------------------------------------------------------------------
-- 4) RLS — active members read; writes via service role only
-- ---------------------------------------------------------------------
ALTER TABLE public.campaigns               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_recipients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_unsubscribes   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaigns_select ON public.campaigns;
CREATE POLICY campaigns_select ON public.campaigns
  FOR SELECT TO authenticated
  USING (public.current_member_is_active());

DROP POLICY IF EXISTS campaign_recipients_select ON public.campaign_recipients;
CREATE POLICY campaign_recipients_select ON public.campaign_recipients
  FOR SELECT TO authenticated
  USING (public.current_member_is_active());

DROP POLICY IF EXISTS campaign_unsubscribes_select ON public.campaign_unsubscribes;
CREATE POLICY campaign_unsubscribes_select ON public.campaign_unsubscribes
  FOR SELECT TO authenticated
  USING (public.current_member_is_active());

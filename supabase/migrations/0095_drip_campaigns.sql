-- =====================================================================
-- 0095 — Drip campaigns (LSQ lead-event triggered message sequences)
-- ---------------------------------------------------------------------
-- A drip fires when an LSQ lead lands at a configured stage (optionally
-- filtered by lead Source). The matching WhatsApp contact is enrolled
-- and walked through an ordered list of steps — step 1 immediately, each
-- later step after its delay. If the contact's LSQ stage changes away
-- from the enrolled stage, the run stops.
--
-- Live event source: POST /api/lsq/webhook/<secret> (LSQ Automation rule
-- on lead create / stage change). Enrollment happens in that handler; an
-- in-process tick (instrumentation hook) drains due runs every 30s.
-- =====================================================================

-- 1) drip_campaigns — one row per drip definition
CREATE TABLE IF NOT EXISTS public.drip_campaigns (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  business_phone_number_id  text NOT NULL
                              REFERENCES public.business_numbers(phone_number_id) ON DELETE CASCADE,
  trigger_stage             text NOT NULL,            -- LSQ stage that enrolls
  trigger_source            text,                     -- NULL = any source; else exact (case-insensitive) match
  enabled                   boolean NOT NULL DEFAULT true,
  rate_limit_per_minute     int NOT NULL DEFAULT 30,
  quiet_hours_start         text,                     -- "HH:MM" IST, optional
  quiet_hours_end           text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by_email          text
);

-- 2) drip_steps — ordered steps for a drip
CREATE TABLE IF NOT EXISTS public.drip_steps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drip_id           uuid NOT NULL REFERENCES public.drip_campaigns(id) ON DELETE CASCADE,
  step_order        int NOT NULL,                      -- 1-based
  step_type         text NOT NULL DEFAULT 'template'
                      CHECK (step_type IN ('template','magic','text')),
  delay_minutes     int NOT NULL DEFAULT 0,            -- gap from the PREVIOUS step (0 for step 1)
  template_name     text,
  template_language text,
  magic_prompt      text,
  magic_tone        text,
  text_body         text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drip_steps_drip ON public.drip_steps (drip_id, step_order);

-- 3) drip_runs — one enrollment of a contact into a drip
CREATE TABLE IF NOT EXISTS public.drip_runs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drip_id                   uuid NOT NULL REFERENCES public.drip_campaigns(id) ON DELETE CASCADE,
  contact_id                uuid,
  wa_id                     text NOT NULL,
  business_phone_number_id  text NOT NULL,
  display_name              text,
  enrolled_stage            text,                      -- stage at enrollment; run stops if contact moves off it
  status                    text NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','completed','stopped','failed')),
  next_step_order           int NOT NULL DEFAULT 1,
  next_run_at               timestamptz NOT NULL DEFAULT now(),
  last_sent_at              timestamptz,
  stop_reason               text,
  enrolled_at               timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drip_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_drip_runs_due ON public.drip_runs (status, next_run_at);

-- 4) contacts — store LSQ Source / Sub source so drips can filter on them
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lsq_source     text,
  ADD COLUMN IF NOT EXISTS lsq_sub_source text;

-- =====================================================================
-- 0098 — Recurring (dynamic) campaigns
-- ---------------------------------------------------------------------
-- A recurring campaign re-runs DAILY against a rolling LSQ filter
-- (e.g. last 90 days, stage=Prospect, Brand=QHT). Each daily run:
--   1. pulls matching leads from LSQ,
--   2. upserts them into contacts (stage/source/brand/owner — modified
--      leads get updated),
--   3. sends the template to leads NOT already sent by THIS campaign
--      (recurring_campaign_sends dedup — each lead gets it ONCE),
--   4. the template-reply workflow fires on tap as usual.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.recurring_campaigns (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  business_phone_number_id  text NOT NULL
                              REFERENCES public.business_numbers(phone_number_id) ON DELETE CASCADE,
  template_name             text NOT NULL,
  template_language         text,
  template_body_preview     text,
  template_components       jsonb,
  -- Rolling LSQ filter. window_days drives created_after = now - window_days.
  filter                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  window_days               int NOT NULL DEFAULT 90,
  enabled                   boolean NOT NULL DEFAULT true,
  rate_limit_per_minute     int NOT NULL DEFAULT 30,
  -- Per-run bookkeeping.
  last_run_at               timestamptz,
  last_run_matched          int,
  last_run_sent             int,
  last_run_error            text,
  total_sent                int NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by_email          text
);

-- One row per (campaign, lead) we've already sent to — the dedup ledger.
CREATE TABLE IF NOT EXISTS public.recurring_campaign_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_id    uuid NOT NULL REFERENCES public.recurring_campaigns(id) ON DELETE CASCADE,
  wa_id           text NOT NULL,
  contact_id      uuid,
  wa_message_id   text,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recurring_id, wa_id)
);
CREATE INDEX IF NOT EXISTS idx_recurring_sends_campaign
  ON public.recurring_campaign_sends (recurring_id);

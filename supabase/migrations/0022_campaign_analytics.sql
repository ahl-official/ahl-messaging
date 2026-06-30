-- =====================================================================
-- 0022 — Per-recipient analytics: button clicks + structured error codes
-- ---------------------------------------------------------------------
-- The campaign detail page now shows a "what actually happened" breakdown:
--   • For templates with Quick Reply / URL / Phone buttons we record
--     which one each recipient tapped (button_clicked) and when
--     (button_clicked_at). The webhook sets these when a button-reply
--     inbound arrives from a known recipient.
--   • Failures get a separate error_code column so we can group +
--     classify (e.g. "131026 — outside 24h", "131056 — rate limited").
-- =====================================================================

ALTER TABLE public.campaign_recipients
  ADD COLUMN IF NOT EXISTS button_clicked     text,
  ADD COLUMN IF NOT EXISTS button_clicked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS reply_text         text,
  ADD COLUMN IF NOT EXISTS error_code         text;

CREATE INDEX IF NOT EXISTS campaign_recipients_button_idx
  ON public.campaign_recipients(campaign_id, button_clicked)
  WHERE button_clicked IS NOT NULL;

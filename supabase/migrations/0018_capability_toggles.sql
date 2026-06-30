-- 0018 — Per-number capability toggles
--
-- Each business number now has explicit on/off switches for every
-- automation/LSQ/call feature so the operator can enable a number for
-- chats only (no AI, no LSQ push) or any other combination without
-- editing prompts/mappings to "fake" off.
--
-- Default = true everywhere → existing rows keep their current behaviour.
-- The runtime gates (webhook, ensure-lead, activity-log, transcribe, etc.)
-- read these flags and bail early when false.

ALTER TABLE public.automation_configs
  -- LSQ
  ADD COLUMN IF NOT EXISTS lsq_lead_create_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS lsq_field_extraction_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS lsq_activity_log_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS lsq_photo_stage_enabled boolean NOT NULL DEFAULT true,
  -- Image auto-reply (text→image swap on outbound)
  ADD COLUMN IF NOT EXISTS image_auto_reply_enabled boolean NOT NULL DEFAULT true,
  -- WhatsApp calls
  ADD COLUMN IF NOT EXISTS call_recording_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS call_transcribe_enabled boolean NOT NULL DEFAULT true;

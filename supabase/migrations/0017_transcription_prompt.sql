-- 0017 — Per-number Whisper transcription prompt
--
-- Operators want to seed Whisper with a context blurb (e.g. "hair-transplant
-- consultation, Hindi+English code-switching, common terms: graft, FUE,
-- DHT, telogen") so transcripts of WhatsApp call recordings come out
-- accurate without a manual edit pass. Stored alongside the AI persona
-- since both are number-level configuration.

ALTER TABLE public.automation_configs
  ADD COLUMN IF NOT EXISTS transcription_prompt text;

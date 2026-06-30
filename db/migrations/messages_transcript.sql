-- Cached audio transcripts for inbound voice / audio messages.
-- Populated by /api/messages/[id]/transcribe (calls OpenAI Whisper).
-- The bot's `buildHistory` reads `content` first, but for audio the
-- content is empty until transcription lands — once it does, we mirror
-- it onto `content` so the LLM sees the speech as text without any
-- special handling. The transcript column itself is the canonical
-- copy; content can be regenerated from it.

alter table public.messages
  add column if not exists transcript text;

notify pgrst, 'reload schema';

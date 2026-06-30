-- WhatsApp Cloud Calling — recording + transcription + handler
-- columns. Run after whatsapp_calls.sql.
--
-- recording_url       Public URL of the mixed-audio recording uploaded
--                     after the call ends. Mixed = local mic + remote
--                     stream merged via Web Audio's
--                     MediaStreamAudioDestinationNode.
-- recording_mime      Container/codec, usually "audio/webm".
-- transcript          Whisper output (full text). Lazy — populated by
--                     /api/whatsapp-call/[id]/transcribe.
-- transcript_status   "none" | "pending" | "done" | "failed".
-- handled_by_user_id  team_members.user_id of whoever clicked Accept.
-- handled_by_email    Cached so the history list doesn't need a join.

alter table public.whatsapp_calls
  add column if not exists recording_url text,
  add column if not exists recording_mime text,
  add column if not exists transcript text,
  add column if not exists transcript_status text not null default 'none',
  add column if not exists handled_by_user_id uuid,
  add column if not exists handled_by_email text;

create index if not exists whatsapp_calls_recent_idx
  on public.whatsapp_calls (start_at desc);

notify pgrst, 'reload schema';

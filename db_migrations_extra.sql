-- Image-flow + photo-receive automation config.
-- Adds:
--   • image_system_prompt          — overrides the default persona when
--                                    the inbound message is an image so
--                                    the LLM can react to "I sent photos".
--   • image_reply_delay_seconds    — debounce window before the bot
--                                    replies to an image; second image
--                                    arriving in that window restarts
--                                    the timer and only one reply fires.
--   • photo_lead_stage_target      — LSQ ProspectStage to set after the
--                                    first image arrives ("Photos Received").
--   • photo_lead_stage_allowed_from — list of stages the lead must
--                                    currently be in for the transition
--                                    to fire. Outside the list = no-op.
--
-- Run in Supabase SQL Editor. Idempotent.

alter table public.automation_configs
  add column if not exists image_system_prompt text,
  add column if not exists image_reply_delay_seconds int not null default 30,
  add column if not exists photo_lead_stage_target text not null default 'Photos Received',
  add column if not exists photo_lead_stage_allowed_from jsonb not null
    default '["Prospect","Engaged","Pending First Contact","Photo Awaited"]'::jsonb;

notify pgrst, 'reload schema';
-- Image-response triggers for automation_configs.
--
-- Each row in the array describes ONE rule:
--   {
--     "patterns": ["front/top/side", "2-3 clear photos"],
--     "image_url": "https://…/photo-instructions.jpg",
--     "caption":  "Aap apni front, top aur side ki 2-3 clear scalp photos bhej do.",
--     "gate_by_stage": true
--   }
--
-- When the bot's generated reply contains ANY pattern (case-insensitive
-- substring or regex match) AND the gate passes (lead's current stage
-- is in `photo_lead_stage_allowed_from`), the pipeline replaces the
-- text dispatch with an image dispatch. Caption rides along with the
-- image; empty caption = image only.

alter table public.automation_configs
  add column if not exists image_response_triggers jsonb not null
    default '[]'::jsonb;

notify pgrst, 'reload schema';
-- Public storage bucket for trigger-image uploads (used by the
-- Automation page's "Trigger phrases → send image" editor). Public
-- so the URL stored in image_response_triggers.image_url can be
-- fetched directly by Meta when the bot dispatches the image.

insert into storage.buckets (id, name, public)
values ('automation-trigger-images', 'automation-trigger-images', true)
on conflict (id) do update set public = true;

drop policy if exists "trigger-images-read" on storage.objects;
create policy "trigger-images-read"
  on storage.objects for select
  using (bucket_id = 'automation-trigger-images');

drop policy if exists "trigger-images-write" on storage.objects;
create policy "trigger-images-write"
  on storage.objects for insert
  with check (bucket_id = 'automation-trigger-images' and auth.role() = 'authenticated');

drop policy if exists "trigger-images-update" on storage.objects;
create policy "trigger-images-update"
  on storage.objects for update
  using (bucket_id = 'automation-trigger-images' and auth.role() = 'authenticated');

drop policy if exists "trigger-images-delete" on storage.objects;
create policy "trigger-images-delete"
  on storage.objects for delete
  using (bucket_id = 'automation-trigger-images' and auth.role() = 'authenticated');
-- Contact avatar_url — operator-uploaded profile photo for the contact.
-- Stored as a public URL pointing at the `contact-avatars` Supabase
-- Storage bucket (created below). Public bucket = no signed URLs needed
-- so the contact list renders avatars without per-row API calls.

alter table public.contacts
  add column if not exists avatar_url text;

-- Storage bucket for the uploaded photos. `public = true` so the URL
-- can be used directly in <img>. Operator uploads go through the
-- /api/contacts/[id]/avatar route which uses the service role.
insert into storage.buckets (id, name, public)
values ('contact-avatars', 'contact-avatars', true)
on conflict (id) do update set public = true;

-- Bucket policies — anyone can read (public bucket); writes are
-- restricted to authenticated users (we additionally check membership
-- + admin role at the API layer).
drop policy if exists "contact-avatars-read" on storage.objects;
create policy "contact-avatars-read"
  on storage.objects for select
  using (bucket_id = 'contact-avatars');

drop policy if exists "contact-avatars-write" on storage.objects;
create policy "contact-avatars-write"
  on storage.objects for insert
  with check (bucket_id = 'contact-avatars' and auth.role() = 'authenticated');

drop policy if exists "contact-avatars-update" on storage.objects;
create policy "contact-avatars-update"
  on storage.objects for update
  using (bucket_id = 'contact-avatars' and auth.role() = 'authenticated');

drop policy if exists "contact-avatars-delete" on storage.objects;
create policy "contact-avatars-delete"
  on storage.objects for delete
  using (bucket_id = 'contact-avatars' and auth.role() = 'authenticated');

notify pgrst, 'reload schema';
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
-- Add `wa_id` to public.messages so the Supabase Table Editor can
-- filter chats by phone number without joining contacts every time.
-- Auto-populated via a BEFORE INSERT/UPDATE trigger that copies the
-- matching contacts.wa_id, so every existing insert path in the
-- codebase keeps working unchanged.
--
-- Run in Supabase SQL Editor. Idempotent.

-- 1. Column.
alter table public.messages
  add column if not exists wa_id text;

-- 2. Index — operator filters by exact wa_id, so a btree on it is
--    enough; cheap and small.
create index if not exists messages_wa_id_idx
  on public.messages (wa_id);

-- 3. Trigger function: pull wa_id from the linked contact whenever a
--    row is inserted OR contact_id changes on update. We fall back to
--    the existing value if the lookup fails (e.g. orphaned message).
create or replace function public.fill_messages_wa_id()
returns trigger
language plpgsql
as $$
begin
  if NEW.contact_id is not null then
    select c.wa_id into NEW.wa_id
    from public.contacts c
    where c.id = NEW.contact_id;
  end if;
  return NEW;
end;
$$;

-- 4. Wire the trigger. Drop-then-create keeps the migration idempotent.
drop trigger if exists messages_fill_wa_id_trigger on public.messages;
create trigger messages_fill_wa_id_trigger
  before insert or update of contact_id on public.messages
  for each row
  execute function public.fill_messages_wa_id();

-- 5. One-time backfill for rows that predate the column. Skipped on
--    re-runs (where every row already has a value).
update public.messages m
set wa_id = c.wa_id
from public.contacts c
where m.contact_id = c.id
  and (m.wa_id is null or m.wa_id = '');

-- 6. Reload PostgREST schema cache so the column shows up in API + UI.
notify pgrst, 'reload schema';
-- System settings — single-row config for app-wide toggles. Used for
-- the global notice banner that shows in the TopBar in place of the
-- old search input. Single row enforced via PK = 1 + ON CONFLICT.
--
-- Run in Supabase SQL Editor. Idempotent.

create table if not exists public.system_settings (
  id int primary key default 1,
  /** Free-text notice shown in the TopBar. Empty / null = banner hidden. */
  notice_banner_text text,
  /** Master switch — operator can toggle off without losing the text. */
  notice_banner_enabled boolean not null default false,
  /** Tone preset for the banner — picks the colour of the pill. */
  notice_banner_tone text not null default 'info'
    check (notice_banner_tone in ('info', 'success', 'warning', 'danger')),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- Enforce singleton.
alter table public.system_settings
  drop constraint if exists system_settings_singleton;
alter table public.system_settings
  add constraint system_settings_singleton check (id = 1);

-- Seed the row so reads never miss.
insert into public.system_settings (id)
values (1)
on conflict (id) do nothing;

-- RLS — anon / authed users can read; only service role writes (UI
-- goes through the /api/system-settings route which uses the service
-- client after a role check).
alter table public.system_settings enable row level security;

drop policy if exists "system_settings_read" on public.system_settings;
create policy "system_settings_read"
  on public.system_settings for select
  using (true);

-- Reload PostgREST schema cache so the new table is queryable.
notify pgrst, 'reload schema';
-- WhatsApp Cloud Calling — call records table.
--
-- One row per call leg (inbound or outbound). The webhook handler
-- creates the row on `ringing` and updates it through the lifecycle
-- (accepted / rejected / terminated). Operators see calls in the
-- chat thread via this table; the UI joins on contact_id to surface
-- "Call started", "Missed call", etc. in-line with messages.

create table if not exists public.whatsapp_calls (
  id uuid primary key default gen_random_uuid(),
  /** Meta's call_id from the calls[] webhook entry. */
  wa_call_id text unique,
  contact_id uuid references public.contacts(id) on delete cascade,
  business_phone_number_id text,
  /** "inbound" = user called us; "outbound" = we called the user. */
  direction text not null check (direction in ('inbound', 'outbound')),
  /** Latest event seen for this call: ringing → accepted / rejected
   *  / terminated / missed. */
  status text not null default 'ringing'
    check (status in ('ringing', 'accepted', 'rejected', 'terminated', 'missed', 'failed')),
  /** SDP offer from Meta (WebRTC route) — null when SIP is used. */
  sdp_offer text,
  /** SDP answer we sent back. */
  sdp_answer text,
  /** Permission state for outbound: pending → granted / denied / expired. */
  permission_state text,
  start_at timestamptz not null default now(),
  end_at timestamptz,
  duration_seconds int,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_calls_contact_idx
  on public.whatsapp_calls (contact_id, start_at desc);
create index if not exists whatsapp_calls_status_idx
  on public.whatsapp_calls (status)
  where status in ('ringing', 'accepted');

-- Track call-permission grants per user — Meta requires explicit
-- consent before a business can place outbound calls.
create table if not exists public.whatsapp_call_permissions (
  contact_id uuid primary key references public.contacts(id) on delete cascade,
  /** "granted" | "denied" | "pending" */
  state text not null default 'pending',
  granted_at timestamptz,
  /** Meta's CPR is single-use OR limited-time — we cache the expiry
   *  so the UI knows when to re-request consent. */
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
-- Splits ring time from talk time. `start_at` was already the moment
-- the call started ringing; `accepted_at` is when the operator picked
-- up. duration_seconds now measures TALK time (accepted_at → end_at);
-- ring_seconds covers the ring phase (start_at → accepted_at).
--
-- Backfill: existing rows lose the breakdown but that's fine — we
-- never measured talk separately before.

alter table public.whatsapp_calls
  add column if not exists accepted_at timestamptz,
  add column if not exists ring_seconds int;

notify pgrst, 'reload schema';
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

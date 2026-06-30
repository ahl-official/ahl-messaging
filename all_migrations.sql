-- =====================================================================
-- QHT WhatsApp Dashboard — initial schema
-- Run inside Supabase SQL editor (or `supabase db push` with CLI).
-- Idempotent so it's safe to re-run.
-- =====================================================================

-- Required for gen_random_uuid()
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- contacts: one row per WhatsApp number we've interacted with
-- ---------------------------------------------------------------------
create table if not exists public.contacts (
  id                    uuid primary key default gen_random_uuid(),
  wa_id                 text unique not null,           -- e.g. "919876543210"
  name                  text,
  profile_name          text,
  last_message_at       timestamptz default now(),
  last_message_preview  text,
  unread_count          int default 0,
  created_at            timestamptz default now()
);

-- ---------------------------------------------------------------------
-- messages: every inbound + outbound WhatsApp message
-- ---------------------------------------------------------------------
create table if not exists public.messages (
  id                uuid primary key default gen_random_uuid(),
  contact_id        uuid references public.contacts(id) on delete cascade,
  wa_message_id     text unique,                        -- WA's message id (wamid.xxx)
  direction         text not null check (direction in ('inbound','outbound')),
  type              text not null,                      -- text | image | document | audio | video | template
  content           text,                               -- text body or media caption
  media_url         text,
  media_mime_type   text,
  status            text default 'sent',                -- sent | delivered | read | failed
  error_message     text,
  timestamp         timestamptz default now(),
  raw_payload       jsonb
);

create index if not exists idx_messages_contact     on public.messages(contact_id, timestamp desc);
create index if not exists idx_contacts_last_msg    on public.contacts(last_message_at desc);

-- ---------------------------------------------------------------------
-- Realtime: broadcast row changes to subscribed clients
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contacts'
  ) then
    alter publication supabase_realtime add table public.contacts;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Row level security
-- Authenticated users can read everything; writes go through the
-- service-role webhook / send-message API on the server.
-- ---------------------------------------------------------------------
alter table public.contacts enable row level security;
alter table public.messages enable row level security;

drop policy if exists "auth read contacts" on public.contacts;
create policy "auth read contacts"
  on public.contacts for select
  to authenticated
  using (true);

drop policy if exists "auth read messages" on public.messages;
create policy "auth read messages"
  on public.messages for select
  to authenticated
  using (true);

-- (Optional) allow authenticated UI to clear unread_count via update
drop policy if exists "auth update contacts unread" on public.contacts;
create policy "auth update contacts unread"
  on public.contacts for update
  to authenticated
  using (true)
  with check (true);
-- =====================================================================
-- 0002 — Multi-number support
-- One webhook can serve multiple WhatsApp business numbers (same WABA
-- or multiple WABAs on the same Meta app). Each contact + message tracks
-- which business number it belongs to.
-- =====================================================================

create table if not exists public.business_numbers (
  phone_number_id      text primary key,
  display_phone_number text,
  verified_name        text,
  created_at           timestamptz default now()
);

alter table public.contacts
  add column if not exists business_phone_number_id text
    references public.business_numbers(phone_number_id);

alter table public.messages
  add column if not exists business_phone_number_id text
    references public.business_numbers(phone_number_id);

create index if not exists idx_contacts_business_number
  on public.contacts(business_phone_number_id);

create index if not exists idx_messages_business_number
  on public.messages(business_phone_number_id);

-- Realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'business_numbers'
  ) then
    alter publication supabase_realtime add table public.business_numbers;
  end if;
end $$;

-- RLS
alter table public.business_numbers enable row level security;

drop policy if exists "auth read business_numbers" on public.business_numbers;
create policy "auth read business_numbers"
  on public.business_numbers for select
  to authenticated
  using (true);

-- Backfill: register the existing default business number
insert into public.business_numbers (phone_number_id, display_phone_number, verified_name)
values ('1150287611490963', '+91 90847 23091', 'URoots')
on conflict (phone_number_id) do nothing;

-- Backfill existing contacts + messages to point at it
update public.contacts
   set business_phone_number_id = '1150287611490963'
 where business_phone_number_id is null;

update public.messages
   set business_phone_number_id = '1150287611490963'
 where business_phone_number_id is null;
-- =====================================================================
-- 0003 — Contact tags + notes
-- =====================================================================

-- Simple text array on contact for tags (e.g. ['vip', 'follow-up', 'consult'])
alter table public.contacts
  add column if not exists tags text[] default array[]::text[];

-- Internal notes about a contact (visible to all agents, never to customer)
create table if not exists public.contact_notes (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid references public.contacts(id) on delete cascade,
  body            text not null,
  created_by      uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at      timestamptz default now()
);

create index if not exists idx_contact_notes_contact
  on public.contact_notes(contact_id, created_at desc);

-- Realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contact_notes'
  ) then
    alter publication supabase_realtime add table public.contact_notes;
  end if;
end $$;

-- RLS
alter table public.contact_notes enable row level security;

drop policy if exists "auth read notes"        on public.contact_notes;
drop policy if exists "auth insert own notes"  on public.contact_notes;
drop policy if exists "auth update own notes"  on public.contact_notes;
drop policy if exists "auth delete own notes"  on public.contact_notes;

create policy "auth read notes"
  on public.contact_notes for select to authenticated using (true);

create policy "auth insert own notes"
  on public.contact_notes for insert to authenticated
  with check (auth.uid() = created_by);

create policy "auth update own notes"
  on public.contact_notes for update to authenticated
  using (auth.uid() = created_by);

create policy "auth delete own notes"
  on public.contact_notes for delete to authenticated
  using (auth.uid() = created_by);

-- Broaden contacts UPDATE policy to cover tags + name edits
-- (existing "auth update contacts unread" already exists from 0001 — replace)
drop policy if exists "auth update contacts unread" on public.contacts;
drop policy if exists "auth update contacts"       on public.contacts;
create policy "auth update contacts"
  on public.contacts for update to authenticated
  using (true) with check (true);
-- =====================================================================
-- 0004 — Conversation status + assignment
-- Each conversation (contact) can be open/closed and assigned to one agent.
-- =====================================================================

alter table public.contacts
  add column if not exists status text default 'open'
    check (status in ('open', 'closed')),
  add column if not exists assigned_to uuid
    references auth.users(id) on delete set null,
  add column if not exists assigned_to_email text,
  add column if not exists assigned_at timestamptz;

create index if not exists idx_contacts_status    on public.contacts(status);
create index if not exists idx_contacts_assigned  on public.contacts(assigned_to);
-- ============================================================================
-- 0005_team.sql — team_members + role-based access foundation
-- ----------------------------------------------------------------------------
-- ⚠️  BEFORE RUNNING: replace 'info@americanhairline.com' on line 60 with the email
--     that should auto-promote to 'owner' when they first sign in via Google.
-- ----------------------------------------------------------------------------
-- What this migration does:
--   1. Creates `team_members` (one row per QHT staffer) with a role.
--   2. Adds a trigger that fires when a new auth.users row is inserted (i.e.
--      first Google sign-in) — it links a pre-invited row by email if one
--      exists, otherwise creates a new row with role 'teammate'. The
--      designated OWNER_EMAIL is auto-promoted to 'owner'.
--   3. Backfills any existing auth.users so they appear in team_members.
--   4. Enables RLS on team_members + adds a non-recursive read policy via a
--      SECURITY DEFINER helper function. Writes go through server actions
--      using the service role.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_members (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  email           text        NOT NULL,
  full_name       text,
  role            text        NOT NULL DEFAULT 'teammate'
                                CHECK (role IN ('owner', 'superadmin', 'admin', 'teammate')),
  is_active       boolean     NOT NULL DEFAULT true,
  invited_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  last_active_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_members_user_id_unique UNIQUE (user_id)
);

-- Case-insensitive uniqueness on email.
CREATE UNIQUE INDEX IF NOT EXISTS team_members_email_lower_idx
  ON public.team_members (lower(email));

CREATE INDEX IF NOT EXISTS team_members_role_idx     ON public.team_members (role);
CREATE INDEX IF NOT EXISTS team_members_active_idx   ON public.team_members (is_active);

-- ---------------------------------------------------------------------------
-- 2. updated_at auto-touch
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_members_set_updated_at ON public.team_members;
CREATE TRIGGER team_members_set_updated_at
  BEFORE UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. New-user trigger — auto-link or auto-create on first sign-in
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  -- ⚠️ Replace with the email that should be auto-promoted to 'owner'.
  v_owner_email text := lower('info@americanhairline.com');
  v_email       text := lower(NEW.email);
  v_full_name   text := COALESCE(NEW.raw_user_meta_data->>'full_name',
                                 NEW.raw_user_meta_data->>'name');
  v_existing_id uuid;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RETURN NEW;
  END IF;

  -- If admin pre-invited this email, link the auth user to that row.
  SELECT id INTO v_existing_id
    FROM public.team_members
   WHERE lower(email) = v_email
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.team_members
       SET user_id   = NEW.id,
           full_name = COALESCE(NULLIF(full_name, ''), v_full_name),
           is_active = true
     WHERE id = v_existing_id;
  ELSE
    INSERT INTO public.team_members (user_id, email, full_name, role)
    VALUES (
      NEW.id,
      v_email,
      v_full_name,
      CASE WHEN v_email = v_owner_email THEN 'owner' ELSE 'teammate' END
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- 4. Backfill any existing auth.users (so the trigger doesn't miss them)
-- ---------------------------------------------------------------------------
INSERT INTO public.team_members (user_id, email, full_name, role)
SELECT
  u.id,
  lower(u.email),
  COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
  CASE WHEN lower(u.email) = lower('info@americanhairline.com')  -- ⚠️ same email as above
       THEN 'owner' ELSE 'teammate' END
FROM auth.users u
WHERE u.email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.team_members WHERE user_id = u.id
  );

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- Helper: is the calling user an active team member?  Used by RLS policies
-- across this and other tables.  SECURITY DEFINER avoids RLS recursion.
CREATE OR REPLACE FUNCTION public.current_member_is_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members
     WHERE user_id = auth.uid() AND is_active = true
  );
$$;

-- Helper: returns the calling user's role, or NULL if not a member.
CREATE OR REPLACE FUNCTION public.current_member_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.team_members
   WHERE user_id = auth.uid() AND is_active = true
   LIMIT 1;
$$;

-- Active members can read the whole roster (UI shows colleagues).
DROP POLICY IF EXISTS team_members_select_active ON public.team_members;
CREATE POLICY team_members_select_active ON public.team_members
  FOR SELECT
  TO authenticated
  USING (public.current_member_is_active());

-- All writes go through server actions using the service role
-- (which bypasses RLS), so we deliberately add no INSERT/UPDATE/DELETE
-- policies here.

-- ---------------------------------------------------------------------------
-- 6. Sanity check (read-only, optional — uncomment to verify after running)
-- ---------------------------------------------------------------------------
-- SELECT id, email, role, is_active, user_id IS NOT NULL AS linked, created_at
--   FROM public.team_members
--  ORDER BY created_at DESC;
-- ============================================================================
-- 0006_template_assets.sql — cache the header media URL for templates
-- ----------------------------------------------------------------------------
-- Meta does not expose a public URL for the sample media a template was
-- approved with — only an opaque resumable-upload handle. To render the
-- same header preview the customer sees (in /templates list, in the
-- composer's TemplatePicker, and in the edit form), we cache our own copy
-- of the image/video/document URL at creation/edit time.
--
-- Linked by Meta's `template_id` so we don't depend on name+language
-- uniqueness across languages. Backfill not possible (we don't have URLs
-- for templates approved before this table existed) — only newly created
-- or edited templates will have entries.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.template_assets (
  template_id     text        PRIMARY KEY,
  template_name   text        NOT NULL,
  language        text        NOT NULL,
  header_format   text        NOT NULL CHECK (header_format IN ('IMAGE', 'VIDEO', 'DOCUMENT')),
  header_url      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS template_assets_name_lang_idx
  ON public.template_assets (template_name, language);

DROP TRIGGER IF EXISTS template_assets_set_updated_at ON public.template_assets;
CREATE TRIGGER template_assets_set_updated_at
  BEFORE UPDATE ON public.template_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- All writes go through server actions using the service-role client, so we
-- only enable RLS to deny by default — no user-facing policy needed for now.
ALTER TABLE public.template_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS template_assets_select_active ON public.template_assets;
CREATE POLICY template_assets_select_active ON public.template_assets
  FOR SELECT
  TO authenticated
  USING (public.current_member_is_active());
-- ============================================================================
-- 0007_template_metadata.sql — richer template message rendering
-- ----------------------------------------------------------------------------
-- Adds columns so the dashboard can render a faithful card view of an
-- outgoing template message:
--   - template_footer:  the small print line ("Type STOP to Unsubscribe")
--   - template_buttons: the buttons array (Reply Now / URL / Phone / etc.)
--   - sent_by_user_id:  which agent sent this message (FK to auth.users)
--   - sent_by_email:    cached email for hover tooltip / display
-- All four are nullable + additive — existing rows are unaffected.
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS template_footer  text,
  ADD COLUMN IF NOT EXISTS template_buttons jsonb,
  ADD COLUMN IF NOT EXISTS sent_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_by_email    text;

CREATE INDEX IF NOT EXISTS messages_sent_by_user_id_idx
  ON public.messages (sent_by_user_id);
-- ============================================================================
-- 0008_quick_replies.sql — saved snippets agents insert via /shortcut
-- ----------------------------------------------------------------------------
-- Quick replies are short text snippets the team can insert into the chat
-- composer by typing a /shortcut (e.g. typing "/hours" inserts the clinic's
-- working-hours blurb). Created and managed from the Templates page; shared
-- across all team members.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.quick_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The /shortcut name (without the leading slash). Lowercase, alphanumeric,
  -- underscores/hyphens. Unique per workspace so two agents don't define the
  -- same shortcut to mean two different things.
  shortcut    text NOT NULL,
  body        text NOT NULL,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_email text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quick_replies_shortcut_format CHECK (shortcut ~ '^[a-z0-9_-]{1,40}$'),
  CONSTRAINT quick_replies_body_len CHECK (char_length(body) BETWEEN 1 AND 4096)
);

CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_shortcut_uidx
  ON public.quick_replies (shortcut);

-- Keep updated_at fresh on edits.
CREATE OR REPLACE FUNCTION public.quick_replies_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quick_replies_touch_updated_at ON public.quick_replies;
CREATE TRIGGER quick_replies_touch_updated_at
  BEFORE UPDATE ON public.quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.quick_replies_touch_updated_at();
-- ============================================================================
-- 0009_team_member_names.sql — split agent display name into first + last
-- ----------------------------------------------------------------------------
-- The Magic Message card renders "Replied By {Name}" using the agent who
-- actually sent the message. We need a stable, agent-specific name that the
-- dashboard owns, so the message bubble doesn't accidentally credit the
-- patient (which used to happen because the n8n workflow that prototyped
-- this server populated `agentName` from `Push Name` — a WhatsApp
-- customer-side concept).
--
-- Adds first_name + last_name columns. Both are NULLABLE for now so existing
-- rows aren't broken; the dashboard will gate Magic Message sending on a
-- "complete your profile" check until the agent fills both in.
--
-- Backfill rule: if `full_name` already has a value, split on the first
-- whitespace into first + rest (single-word names land entirely in first_name).
-- ============================================================================

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name  text;

UPDATE public.team_members
SET
  first_name = COALESCE(
    first_name,
    NULLIF(split_part(trim(full_name), ' ', 1), '')
  ),
  last_name = COALESCE(
    last_name,
    NULLIF(
      btrim(substring(trim(full_name) FROM position(' ' in trim(full_name)) + 1)),
      ''
    )
  )
WHERE full_name IS NOT NULL AND trim(full_name) <> '';

CREATE INDEX IF NOT EXISTS team_members_first_last_idx
  ON public.team_members (first_name, last_name);
-- ============================================================================
-- 0010_contact_last_msg_meta.sql — denormalize last-message direction + status
-- ----------------------------------------------------------------------------
-- The contact list panel shows per-row hints that need the latest message's
-- direction and delivery status:
--   - Outbound + read   → render emerald ✓✓ next to the preview
--   - Outbound + sent/delivered → render gray ✓ / ✓✓
--   - Inbound (unread)  → render an inline "Reply" CTA chip
--
-- Computing these from the messages table on every poll would mean N
-- subqueries per contact, so we denormalize onto the contact row instead.
-- The webhook + send-message + magic-message routes write these whenever
-- they touch `last_message_preview`. Backfill below seeds existing rows.
-- ============================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS last_message_direction text
    CHECK (last_message_direction IN ('inbound', 'outbound')),
  ADD COLUMN IF NOT EXISTS last_message_status    text
    CHECK (last_message_status IN ('sent', 'delivered', 'read', 'failed', 'received'));

-- Backfill: pull the most-recent message per contact and copy its metadata
-- onto the contact row. DISTINCT ON gives us the latest per contact in one
-- pass without a window function.
WITH latest AS (
  SELECT DISTINCT ON (contact_id)
    contact_id,
    direction,
    status,
    type
  FROM public.messages
  ORDER BY contact_id, timestamp DESC
)
UPDATE public.contacts c
SET
  last_message_direction = latest.direction,
  last_message_status =
    CASE
      WHEN latest.direction = 'inbound' THEN 'received'
      ELSE latest.status
    END
FROM latest
WHERE c.id = latest.contact_id;

CREATE INDEX IF NOT EXISTS contacts_last_msg_dir_idx
  ON public.contacts (last_message_direction);
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
-- ============================================================================
-- 0012_app_credentials.sql — DB-backed secret storage
-- ----------------------------------------------------------------------------
-- Centralizes API keys / tokens / endpoints that today live in .env.local so
-- admins can rotate them from the dashboard without redeploying. The shape
-- is intentionally a flat key/value bag — UI only surfaces the keys we've
-- explicitly added (start: openai_api_key + whatsapp_access_token), but the
-- schema is ready for future additions (LSQ, Interakt, etc.).
--
-- Security model:
--   * Strict RLS — no policies are added, so non-service-role users get
--     ZERO access. Every read goes through createServiceRoleClient() in
--     server code, gated by an explicit "owner role" check at the API layer.
--   * Plaintext at rest. Acceptable for a small clinic team; if scale or
--     compliance ever demands it, swap to Supabase Vault / pgsodium and
--     point the helper at decrypted_secrets.
--   * UI masks values by default (eye-toggle to reveal).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.app_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Logical name. Use lower_snake_case (e.g. 'openai_api_key',
  -- 'whatsapp_access_token'). The credentials helper looks rows up by
  -- this column, so it has to be unique + stable.
  key          text NOT NULL UNIQUE,
  value        text NOT NULL,
  -- Optional human-readable note for the UI ("API key used by the
  -- AI auto-reply on the Automation page").
  description  text,
  -- Coarse grouping for the UI ("openai", "whatsapp", "lsq", "image_generator").
  category     text,
  updated_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- RLS lockdown — without explicit policies this denies everyone except the
-- service-role bypass. Reads/writes all flow through server-side API routes
-- that gate on owner role.
ALTER TABLE public.app_credentials ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS app_credentials_set_updated_at ON public.app_credentials;
CREATE TRIGGER app_credentials_set_updated_at
  BEFORE UPDATE ON public.app_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- ============================================================================
-- 0013_portfolios.sql — multi-Meta-app architecture
-- ----------------------------------------------------------------------------
-- The dashboard now hosts multiple WhatsApp business portfolios (one per
-- company / brand), each with its own Meta App credentials and a fleet of
-- phone numbers. Inbound + outbound on a given number must use that
-- portfolio's access token, app id, etc.
--
-- Architecture:
--   whatsapp_portfolios     — one row per Meta App / portfolio
--     ↳ access_token, app_id, business_account_id, verify_token
--   business_numbers        — gets a portfolio_id FK (every number belongs
--                             to exactly one portfolio).
--   business_numbers.portfolio_id is nullable during the transition window
--     so existing single-app installs keep functioning. The fallback path
--     in lib/portfolios.ts uses app_credentials.* when portfolio_id is null.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_portfolios (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Display name shown in the UI ("URoots", "QHT Clinic"). Doesn't need to
  -- match anything Meta-side; just for the admin's convenience.
  name                     text NOT NULL UNIQUE,
  -- Permanent System User access token for the Meta App that owns this
  -- portfolio. Stored in plaintext, locked down via RLS.
  access_token             text NOT NULL,
  -- Meta App ID — required for media-header template uploads (Resumable
  -- Upload uses /{app_id}/uploads).
  app_id                   text,
  -- Business Account ID (WABA) — used by Templates pages.
  business_account_id      text,
  -- Webhook verify handshake token. Each Meta App has its own; the
  -- webhook GET handler matches the incoming `hub.verify_token` against
  -- the verify_token of every portfolio, so a single /api/webhook URL
  -- works for all apps.
  verify_token             text NOT NULL,
  -- Optional: where the agents see this portfolio in chat headers.
  display_name             text,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_portfolios ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS whatsapp_portfolios_set_updated_at ON public.whatsapp_portfolios;
CREATE TRIGGER whatsapp_portfolios_set_updated_at
  BEFORE UPDATE ON public.whatsapp_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Wire each phone number to its parent portfolio. Nullable during the
-- transition; the helper falls back to the legacy single-app credentials.
ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS portfolio_id uuid REFERENCES public.whatsapp_portfolios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS business_numbers_portfolio_idx
  ON public.business_numbers (portfolio_id);
-- ============================================================================
-- 0014_business_number_active.sql — per-number visibility toggle
-- ----------------------------------------------------------------------------
-- Adds is_active to business_numbers so the user-menu can flip a number
-- on/off and the inbox can hide its conversations without removing it from
-- the portfolio. Webhooks keep ingesting (we don't want to silently drop
-- inbound messages); the flag only controls UI visibility.
-- ============================================================================

ALTER TABLE business_numbers
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS business_numbers_is_active_idx
  ON business_numbers (is_active)
  WHERE is_active = false;
-- =====================================================================
-- 0015 — Per-role + per-member permission overrides
-- ---------------------------------------------------------------------
-- Two tables drive the "fully customizable" access model:
--   role_permissions          → defaults per role (4 rows, editable)
--   team_member_permissions   → sparse overrides per member (NULL = inherit)
-- Effective perms = override IS NOT NULL ? override : role default.
-- Owner role is kept fully open by default; UI also short-circuits owners
-- to "all access" so they can never lock themselves out.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) role_permissions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.role_permissions (
  role                  text PRIMARY KEY
                          CHECK (role IN ('owner','superadmin','admin','teammate')),
  -- access scopes (NULL = unrestricted / all)
  allowed_number_ids    text[],
  allowed_panels        text[],
  -- privacy masks
  mask_phone_numbers    boolean NOT NULL DEFAULT false,
  mask_emails           boolean NOT NULL DEFAULT false,
  -- capabilities
  can_send_messages     boolean NOT NULL DEFAULT true,
  can_use_magic_message boolean NOT NULL DEFAULT true,
  can_export_data       boolean NOT NULL DEFAULT false,
  can_assign_contacts   boolean NOT NULL DEFAULT true,
  can_manage_templates  boolean NOT NULL DEFAULT false,
  can_manage_automation boolean NOT NULL DEFAULT false,
  can_make_calls        boolean NOT NULL DEFAULT true,
  can_view_call_history boolean NOT NULL DEFAULT true,
  can_manage_team       boolean NOT NULL DEFAULT false,
  can_manage_numbers    boolean NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Seed defaults — sensible starting point per role.
INSERT INTO public.role_permissions
  (role,         mask_phone_numbers, mask_emails, can_send_messages, can_use_magic_message,
   can_export_data, can_assign_contacts, can_manage_templates, can_manage_automation,
   can_make_calls, can_view_call_history, can_manage_team, can_manage_numbers)
VALUES
  ('owner',      false, false, true, true,  true,  true,  true,  true,  true, true, true,  true),
  ('superadmin', false, false, true, true,  true,  true,  true,  true,  true, true, true,  true),
  ('admin',      false, false, true, true,  false, true,  true,  true,  true, true, true,  false),
  ('teammate',   true,  true,  true, true,  false, false, false, false, true, true, false, false)
ON CONFLICT (role) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2) team_member_permissions — sparse override per member
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_member_permissions (
  member_id             uuid PRIMARY KEY
                          REFERENCES public.team_members(id) ON DELETE CASCADE,
  allowed_number_ids    text[],
  allowed_panels        text[],
  mask_phone_numbers    boolean,
  mask_emails           boolean,
  can_send_messages     boolean,
  can_use_magic_message boolean,
  can_export_data       boolean,
  can_assign_contacts   boolean,
  can_manage_templates  boolean,
  can_manage_automation boolean,
  can_make_calls        boolean,
  can_view_call_history boolean,
  can_manage_team       boolean,
  can_manage_numbers    boolean,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 3) updated_at triggers (reuse public.set_updated_at from 0005)
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS role_permissions_set_updated_at ON public.role_permissions;
CREATE TRIGGER role_permissions_set_updated_at
  BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS team_member_permissions_set_updated_at ON public.team_member_permissions;
CREATE TRIGGER team_member_permissions_set_updated_at
  BEFORE UPDATE ON public.team_member_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------
-- 4) RLS — active members can read; writes go through service role only
-- ---------------------------------------------------------------------
ALTER TABLE public.role_permissions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permissions_select ON public.role_permissions;
CREATE POLICY role_permissions_select ON public.role_permissions
  FOR SELECT TO authenticated
  USING (public.current_member_is_active());

DROP POLICY IF EXISTS team_member_permissions_select ON public.team_member_permissions;
CREATE POLICY team_member_permissions_select ON public.team_member_permissions
  FOR SELECT TO authenticated
  USING (public.current_member_is_active());
-- =====================================================================
-- 0016 — One contact row per (wa_id, business_phone_number_id)
-- ---------------------------------------------------------------------
-- Until now, `contacts.wa_id` was UNIQUE. That meant if the same patient
-- messaged two of our business numbers (e.g. URoots + QHT Clinic), they
-- collapsed into one row and the inbox showed a single chat card with
-- merged history — confusing for agents who need to see which number
-- each conversation is on.
--
-- This migration moves uniqueness onto (wa_id, business_phone_number_id)
-- so each business number gets its own card per patient.
-- =====================================================================

-- 1) Backfill any rows where business_phone_number_id is NULL (shouldn't
--    happen post-0002, but defensive — a NULL would let the new unique
--    constraint allow duplicates since NULL != NULL in PG).
UPDATE public.contacts
   SET business_phone_number_id = (
     SELECT phone_number_id FROM public.business_numbers
      ORDER BY created_at ASC
      LIMIT 1
   )
 WHERE business_phone_number_id IS NULL
   AND EXISTS (SELECT 1 FROM public.business_numbers);

-- 2) Drop the old single-column unique. Constraint name varies by Postgres
--    version + how the table was created — find it dynamically.
DO $$
DECLARE
  v_constraint text;
BEGIN
  SELECT conname INTO v_constraint
    FROM pg_constraint
   WHERE conrelid = 'public.contacts'::regclass
     AND contype  = 'u'
     AND pg_get_constraintdef(oid) ILIKE '%(wa_id)%'
   LIMIT 1;
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.contacts DROP CONSTRAINT %I', v_constraint);
  END IF;
END $$;

-- Drop the implicit unique index too if it exists separately.
DROP INDEX IF EXISTS public.contacts_wa_id_key;

-- 3) Add the composite unique constraint. We use a UNIQUE INDEX rather
--    than a constraint so it survives the rare case where the column
--    is NULL (matches existing tooling that uses ON CONFLICT against
--    indexes).
CREATE UNIQUE INDEX IF NOT EXISTS contacts_wa_id_business_number_idx
  ON public.contacts (wa_id, business_phone_number_id);

-- 4) Keep wa_id indexed standalone for fast lookups + LSQ-by-mobile joins.
CREATE INDEX IF NOT EXISTS contacts_wa_id_idx ON public.contacts (wa_id);
-- 0017 — Per-number Whisper transcription prompt
--
-- Operators want to seed Whisper with a context blurb (e.g. "hair-transplant
-- consultation, Hindi+English code-switching, common terms: graft, FUE,
-- DHT, telogen") so transcripts of WhatsApp call recordings come out
-- accurate without a manual edit pass. Stored alongside the AI persona
-- since both are number-level configuration.

ALTER TABLE public.automation_configs
  ADD COLUMN IF NOT EXISTS transcription_prompt text;
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
-- =====================================================================
-- 0019 — RAG knowledge base
-- ---------------------------------------------------------------------
-- The persona on automation_configs.system_prompt has grown to ~14k
-- chars (~3.6k tokens). At ~1k inbound msgs/day that's ~3.6M tokens/day
-- spent just shipping the persona to OpenAI on every reply. RAG flips
-- this on its head: store small chunks of knowledge with embeddings,
-- retrieve only the 3-5 most-relevant chunks per inbound, send a tiny
-- core prompt + those chunks. ~75% token reduction in practice.
--
-- Storage: pgvector (built into Supabase). Embedding dim = 1536 to
-- match OpenAI text-embedding-3-small. Cosine similarity for retrieval.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------
-- 1) Chunks table — one row per knowledge unit (FAQ, pricing block,
--    procedure description, etc.). Per business number so two clinics
--    on the same workspace don't bleed knowledge into each other.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_phone_number_id text NOT NULL
                              REFERENCES public.business_numbers(phone_number_id)
                              ON DELETE CASCADE,
  -- Free-text label so the operator can group / filter chunks
  -- ("Pricing", "Procedures", "Refund policy", etc.).
  source                   text NOT NULL DEFAULT 'general',
  chunk_text               text NOT NULL,
  -- 1536-dim vector for OpenAI text-embedding-3-small. Nullable so a
  -- chunk can be saved before embedding completes (async re-embed).
  embedding                vector(1536),
  -- Cached token count from the embedding API response — used for
  -- cost dashboards and to refuse oversized chunks (>8k tokens).
  token_count              int,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_business_idx
  ON public.knowledge_chunks(business_phone_number_id);

-- Vector similarity index. ivfflat is the right choice while we have
-- <100k chunks per business; rebuild with `lists = sqrt(rows)` later
-- if cardinality grows.
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON public.knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

DROP TRIGGER IF EXISTS knowledge_chunks_set_updated_at ON public.knowledge_chunks;
CREATE TRIGGER knowledge_chunks_set_updated_at
  BEFORE UPDATE ON public.knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------
-- 2) Similarity search RPC — called from lib/rag.ts on every inbound
--    when use_rag is on. Cosine similarity (1 - distance) so higher
--    score = more relevant.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  query_embedding   vector(1536),
  target_business_id text,
  match_count       int DEFAULT 5
)
RETURNS TABLE (
  id         uuid,
  source     text,
  chunk_text text,
  similarity float
)
LANGUAGE sql STABLE AS $$
  SELECT
    id,
    source,
    chunk_text,
    1 - (embedding <=> query_embedding) AS similarity
  FROM public.knowledge_chunks
  WHERE business_phone_number_id = target_business_id
    AND embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ---------------------------------------------------------------------
-- 3) RLS — active members can read, writes via service role only.
-- ---------------------------------------------------------------------
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_chunks_select ON public.knowledge_chunks;
CREATE POLICY knowledge_chunks_select ON public.knowledge_chunks
  FOR SELECT TO authenticated
  USING (public.current_member_is_active());

-- ---------------------------------------------------------------------
-- 4) RAG toggles on automation_configs.
--    use_rag       — main switch. Off = legacy full-prompt behaviour.
--    rag_top_k     — how many chunks to retrieve per query.
--    rag_core_prompt — small persona prompt used INSTEAD of the long
--                      system_prompt when RAG is on. Operator writes
--                      the rules + tone here; knowledge lives in chunks.
-- ---------------------------------------------------------------------
ALTER TABLE public.automation_configs
  ADD COLUMN IF NOT EXISTS use_rag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rag_top_k int NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS rag_core_prompt text;
-- =====================================================================
-- 0020 — Owner approval flow for new signups
-- ---------------------------------------------------------------------
-- Until now any auth.users insert (Google sign-in OR email signup) ran
-- the handle_new_auth_user trigger, which auto-created an active
-- team_members row. That meant strangers could create their own
-- accounts and walk into the workspace.
--
-- New flow:
--   1. New auth user → row created with is_active=FALSE, pending_approval=TRUE
--      (UNLESS they match a pre-invite — those still go through, since
--      the owner already vouched for them by email when they invited.)
--   2. Login is blocked for pending rows (UI shows "awaiting approval").
--   3. Owner / superadmin sees the pending row at the top of Settings →
--      Team and clicks Approve (sets is_active=true, pending_approval=
--      false) or Reject (deletes the row + the auth user can sign up
--      again later if invited).
-- =====================================================================

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS pending_approval boolean NOT NULL DEFAULT false;

-- Re-create the trigger function with the new branch.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  -- ⚠️ Replace with the email that should be auto-promoted to 'owner'.
  v_owner_email text := lower('info@americanhairline.com');
  v_email       text := lower(NEW.email);
  v_full_name   text := COALESCE(NEW.raw_user_meta_data->>'full_name',
                                 NEW.raw_user_meta_data->>'name');
  v_existing_id uuid;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RETURN NEW;
  END IF;

  -- Pre-invited path: owner / admin already invited this email via the
  -- Team UI. Link the auth user to that row and keep it active — the
  -- approval was implicit at invite time.
  SELECT id INTO v_existing_id
    FROM public.team_members
   WHERE lower(email) = v_email
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.team_members
       SET user_id          = NEW.id,
           full_name        = COALESCE(NULLIF(full_name, ''), v_full_name),
           is_active        = true,
           pending_approval = false
     WHERE id = v_existing_id;
  ELSE
    -- Fresh signup. Owner email is auto-approved (bootstrapping the
    -- workspace would be impossible otherwise). Everyone else lands in
    -- the "pending approval" queue.
    INSERT INTO public.team_members (
      user_id, email, full_name, role, is_active, pending_approval
    )
    VALUES (
      NEW.id,
      v_email,
      v_full_name,
      CASE WHEN v_email = v_owner_email THEN 'owner' ELSE 'teammate' END,
      CASE WHEN v_email = v_owner_email THEN true   ELSE false END,
      CASE WHEN v_email = v_owner_email THEN false  ELSE true  END
    );
  END IF;

  RETURN NEW;
END;
$$;
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
-- Outbound webhooks per business phone number.
--
-- Operators register one or more URLs against a phone number; whenever
-- an event lands on that number (inbound message of any type, status
-- update, call event, campaign progress) the app fires a fire-and-forget
-- POST to each enabled URL with an HMAC-SHA256 signature header so the
-- receiver can verify the source.
--
-- This is independent of the inbound Meta webhook (which is fixed at
-- /api/webhook). It's a *fan-out* mechanism so external automations
-- (n8n, Make, custom servers) can listen to anything that happens on a
-- given number.

create table if not exists outbound_webhooks (
  id                          uuid primary key default gen_random_uuid(),
  business_phone_number_id    text not null,
  label                       text,
  url                         text not null,
  -- HMAC secret. Generated server-side on insert; the receiver verifies
  -- the X-QHT-Signature header against `sha256(secret, raw_body)`.
  secret                      text not null,
  -- Fire-and-forget delivery: when off the row is kept (history) but
  -- nothing is sent.
  enabled                     boolean not null default true,
  -- Last-attempt diagnostics — useful to debug a misconfigured URL
  -- without spelunking through server logs.
  last_attempt_at             timestamptz,
  last_status_code            int,
  last_error                  text,
  delivery_count              bigint not null default 0,
  failure_count               bigint not null default 0,
  created_at                  timestamptz not null default now(),
  created_by_user_id          uuid references auth.users(id) on delete set null
);

create index if not exists outbound_webhooks_bpid_idx
  on outbound_webhooks(business_phone_number_id)
  where enabled = true;

alter table outbound_webhooks enable row level security;

-- Authenticated users (admin+ enforced at the API layer) can read all
-- webhooks. Writes are gated by the API too — RLS just stops anon /
-- direct-from-client manipulation.
create policy "outbound_webhooks read for authenticated"
  on outbound_webhooks for select
  using (auth.role() = 'authenticated');
-- API tokens per business phone number.
--
-- An API token is the authorisation an external automation (n8n, Make,
-- a custom server) presents to our /api/v1/* endpoints. The token maps
-- to exactly one business_phone_number_id; the relay then uses that
-- portfolio's Meta access token (which never leaves the server) to
-- actually call Meta. So integrators never see Meta credentials.
--
-- Distinct from `outbound_webhooks.secret`:
--   • outbound_webhooks.secret       — HMAC key, used to VERIFY messages we send out
--   • api_tokens.token               — Bearer token, used to AUTHENTICATE inbound API calls
--
-- Separating the two means rotating one doesn't break the other.

create table if not exists api_tokens (
  id                          uuid primary key default gen_random_uuid(),
  business_phone_number_id    text not null,
  name                        text not null,
  -- The actual Bearer value. Plain so the operator can reveal+copy it
  -- from the UI (we don't have a "show only at creation" flow yet).
  -- Lookup is by exact string match — see the index below.
  token                       text not null unique,
  enabled                     boolean not null default true,
  last_used_at                timestamptz,
  request_count               bigint not null default 0,
  created_at                  timestamptz not null default now(),
  created_by_user_id          uuid references auth.users(id) on delete set null
);

create index if not exists api_tokens_token_idx
  on api_tokens(token)
  where enabled = true;

create index if not exists api_tokens_bpid_idx
  on api_tokens(business_phone_number_id);

alter table api_tokens enable row level security;

-- Authenticated users can read; admin+ writes are gated by the API
-- routes themselves. RLS just blocks anon / direct-from-client edits.
create policy "api_tokens read for authenticated"
  on api_tokens for select
  using (auth.role() = 'authenticated');
-- Fine-grained per-tab access for /settings/* (Team, Permissions,
-- Numbers, Capabilities, Notice, Portfolios, API, Data).
--
-- Storage convention matches the existing `allowed_panels` /
-- `allowed_number_ids` columns:
--   NULL       → unrestricted (all settings tabs visible)
--   '{}'::text[] → explicitly NO tabs (the role/member has zero access
--                  to the Settings area)
--   '{team,permissions,…}' → only the listed tabs are visible
--
-- Owner always gets unrestricted access regardless of this column
-- (enforced in lib/permission-types.ts → ownerPermissions()).

ALTER TABLE public.role_permissions
  ADD COLUMN IF NOT EXISTS allowed_settings_tabs text[] DEFAULT NULL;

ALTER TABLE public.team_member_permissions
  ADD COLUMN IF NOT EXISTS allowed_settings_tabs text[] DEFAULT NULL;
-- Per-contact LSQ sync visibility.
--
-- ensure-lead is fire-and-forget from the webhook; until now its
-- outcome was opaque — if Source / Sub Source didn't apply or the
-- create call failed, the operator had no way to see why. These
-- columns capture the last sync attempt so the dashboard can surface
-- "LSQ: ✓ created with Source=URoots" / "LSQ: ✗ Attribute does not
-- exist" right next to the chat.
--
-- Status values used:
--   'created'  → new LSQ lead was inserted with our defaults
--   'linked'   → lead already existed, we just cached its prospect_id
--   'skipped'  → flag off / not configured / contact missing
--   'error'    → LSQ call failed; see lsq_last_sync_error for details

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lsq_last_sync_at     timestamptz,
  ADD COLUMN IF NOT EXISTS lsq_last_sync_status text,
  ADD COLUMN IF NOT EXISTS lsq_last_sync_error  text,
  ADD COLUMN IF NOT EXISTS lsq_last_sync_fields text[];
-- Per-number controls for updating EXISTING LSQ leads when a new
-- WhatsApp inbound arrives. Default behaviour is unchanged (linked
-- only — original attribution preserved). Operator opts in when they
-- want re-attribution.
--
--   update_existing_lead_source        — master toggle, OFF by default.
--   update_existing_lead_max_age_days  — only re-attribute leads whose
--     LSQ CreatedOn is within this many days. NULL = no age cap (any
--     age allowed if the toggle is on). 0 / negative = same as NULL.

alter table public.automation_configs
  add column if not exists update_existing_lead_source boolean
    not null default false;

alter table public.automation_configs
  add column if not exists update_existing_lead_max_age_days integer;
-- Chat import sessions. Tracks a single bulk-load of historical
-- contacts + messages from another platform (Interakt, old Supabase,
-- etc.) into a target WhatsApp business number on this workspace.
--
-- Why a job row instead of just streaming POSTs:
--   • 50k+ messages can't fit in one request — caller batches in chunks
--     of ~500 and we credit each chunk against the same job_id.
--   • Resume support — if the upload script dies mid-stream, the operator
--     can pick up from `processed_messages` and retry without dupes
--     (wa_message_id unique constraint protects us).
--   • UI progress bar reads the counters directly.

create table if not exists public.chat_import_jobs (
  id                       uuid primary key default gen_random_uuid(),
  target_bpid              text not null,           -- business_phone_number_id rows land under
  label                    text,                    -- operator-supplied note ("Interakt URoots Sep'25")
  status                   text not null default 'pending'
    check (status in ('pending','running','completed','failed','cancelled')),
  source_format            text,                    -- 'json' | 'csv' | 'script' | other
  total_messages           int not null default 0,  -- expected count (caller declares up-front; informational)
  total_contacts           int not null default 0,
  processed_messages       int not null default 0,  -- creditted across batches
  processed_contacts       int not null default 0,
  inserted_messages        int not null default 0,  -- actually inserted (excludes idempotent skips)
  inserted_contacts        int not null default 0,
  errors                   jsonb default '[]'::jsonb,  -- [{batch, msg}, ...] capped at ~50 entries
  created_by               text,                    -- email of operator who started it
  created_at               timestamptz not null default now(),
  finished_at              timestamptz,
  cancelled_at             timestamptz
);

create index if not exists idx_chat_import_jobs_target_bpid
  on public.chat_import_jobs(target_bpid, created_at desc);

create index if not exists idx_chat_import_jobs_status
  on public.chat_import_jobs(status, created_at desc);

-- Service-role only — there is no end-user-facing RLS read path. The
-- UI talks to a /api/import/chats endpoint that authenticates the
-- operator and uses the service-role client to read/write this table.
alter table public.chat_import_jobs enable row level security;
-- Add template_name to messages so per-agent reports can split
-- "regular template sends" from "magic message" sends. Previously
-- both shared type='template' with no distinguishing key, forcing
-- fragile content / button heuristics. The column is nullable so old
-- rows stay valid and only outbound template inserts moving forward
-- will populate it.

alter table public.messages
  add column if not exists template_name text;

create index if not exists messages_template_name_idx
  on public.messages (template_name)
  where template_name is not null;
-- KRA / KPA targets + per-day activity tracking.
--
-- Three tables:
--   • agent_targets_role     — per-role defaults (owner sets a baseline
--     for every Admin / Teammate).
--   • agent_targets_member   — per-member overrides. NULL columns mean
--     "inherit role default". Mirrors the role_permissions /
--     team_member_permissions pattern already used elsewhere.
--   • user_activity_days     — one row per (user, day). Updated by the
--     /api/heartbeat ping every 30s while a tab is focused. We track
--     BOTH a "working window" (first_seen → last_seen, includes breaks)
--     AND the active-focus seconds inside that window (calibrated by
--     heartbeat hits) so reports can show login time + idle time.

create table if not exists public.agent_targets_role (
  role                       text primary key
    check (role in ('owner','superadmin','admin','teammate')),
  magic_messages_per_day     int     not null default 0,
  calls_per_day              int     not null default 0,
  text_replies_per_day       int     not null default 0,
  template_sends_per_day     int     not null default 0,
  /** Max acceptable idle hours per working day. Score penalises
      anything above this. */
  max_idle_hours_per_day     numeric not null default 4,
  /** Minimum expected login hours per day. */
  min_login_hours_per_day    numeric not null default 6,
  updated_at                 timestamptz not null default now()
);

-- Seed sensible role defaults — operators can edit these from the UI.
insert into public.agent_targets_role (role, magic_messages_per_day, calls_per_day, text_replies_per_day, template_sends_per_day, max_idle_hours_per_day, min_login_hours_per_day)
  values
    ('owner',      0, 0, 0, 0, 24, 0),
    ('superadmin', 0, 0, 0, 0, 24, 0),
    ('admin',      5, 5, 30, 5, 4, 6),
    ('teammate',  10, 10, 50, 10, 3, 7)
  on conflict (role) do nothing;

create table if not exists public.agent_targets_member (
  member_id                  uuid primary key
    references public.team_members(id) on delete cascade,
  magic_messages_per_day     int,
  calls_per_day              int,
  text_replies_per_day       int,
  template_sends_per_day     int,
  max_idle_hours_per_day     numeric,
  min_login_hours_per_day    numeric,
  /** When true, this member can view EVERYONE'S scores + Reports
      (otherwise sees only their own). Owner always can. */
  can_view_team_scores       boolean not null default false,
  updated_at                 timestamptz not null default now()
);

create table if not exists public.user_activity_days (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  email             text,
  day               date not null,
  first_seen_at     timestamptz not null,
  last_seen_at      timestamptz not null,
  /** Heartbeat-derived focus seconds. Cumulative throughout the day. */
  active_seconds    int not null default 0,
  /** last_seen - first_seen — total span including breaks. */
  window_seconds    int not null default 0,
  unique (user_id, day)
);

create index if not exists idx_user_activity_days_email_day
  on public.user_activity_days (email, day desc);

create index if not exists idx_user_activity_days_day
  on public.user_activity_days (day desc);

-- RLS: only service-role reads/writes; client always talks via the
-- /api/heartbeat + /api/reports endpoints so we never expose raw rows
-- to non-admin users.
alter table public.agent_targets_role    enable row level security;
alter table public.agent_targets_member  enable row level security;
alter table public.user_activity_days    enable row level security;
-- Teams — operator-defined groupings (e.g. HT Done, Welcome, Sales,
-- Date Align). Every team_member can belong to AT MOST one team. Teams
-- are workspace-wide; there is no per-team RLS (rows are visible to
-- anyone with read access to team_members).

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  /** Optional Tailwind colour key (e.g. "emerald") used to tint the
      chip rendered in member lists. NULL falls back to a hashed colour. */
  color       text,
  /** Optional one-line description visible in the Teams tab. */
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists teams_name_lower_idx
  on public.teams (lower(name));

-- Seed the four QHT teams.
insert into public.teams (name, color)
  values
    ('HT Done',     'emerald'),
    ('Welcome',     'sky'),
    ('Sales',       'violet'),
    ('Date Align',  'amber')
  on conflict (lower(name)) do nothing;

alter table public.team_members
  add column if not exists team_id uuid
    references public.teams(id) on delete set null;

create index if not exists team_members_team_id_idx
  on public.team_members (team_id);

alter table public.teams enable row level security;
-- Track whether a business number still exists on Meta's WhatsApp
-- Business API. When an operator removes a number from Meta, the local
-- row should visibly flag "Removed from Meta" so it's obvious why
-- inbound stopped — and prompt a purge.
--
--   meta_status     — 'connected' | 'removed' | 'unknown'
--                     ('unknown' = never checked yet)
--   meta_checked_at — last time we probed Meta's Graph API for it.

alter table public.business_numbers
  add column if not exists meta_status text not null default 'unknown'
    check (meta_status in ('connected', 'removed', 'unknown'));

alter table public.business_numbers
  add column if not exists meta_checked_at timestamptz;
-- Per-number WABA id.
--
-- One Meta business portfolio can own MULTIPLE WhatsApp Business
-- Accounts (WABAs), and templates live at the WABA level — so two
-- numbers under the same portfolio can have completely different
-- template libraries.
--
-- The portfolio config in .env.local only carries ONE
-- business_account_id, which is wrong for any number whose WABA
-- differs. Storing waba_id on the number lets the templates API fetch
-- the correct library: it uses business_numbers.waba_id for the WABA
-- and the owning portfolio's access_token for auth.
--
-- NULL = fall back to the portfolio's business_account_id (single-WABA
-- portfolios keep working with no change).

alter table public.business_numbers
  add column if not exists waba_id text;
-- Global contact labels. Workspace-defined set (e.g. "VIP",
-- "Follow-up", "Cold lead") that any team member can assign to a
-- contact. Max 3 per contact — enforced at the API layer so the UI can
-- still render a 3-label cap badge.
--
-- Why a separate table + array column (not many-to-many):
--   • Most queries need ALL labels for a contact, every read. An array
--     column with a single JOIN keeps the contact-list query cheap.
--   • Labels are a small set (dozens), so the join table overhead isn't
--     worth the normalisation gain.
--
-- contacts.label_ids stores the uuids ordered as the operator picked
-- them — the chip strip honours that order.

create table if not exists public.contact_labels (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  /** Tailwind colour key — emerald / sky / violet / amber / rose /
      teal / slate. NULL falls back to slate. */
  color       text,
  /** Optional one-line description shown in the Labels settings tab. */
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists contact_labels_name_lower_idx
  on public.contact_labels (lower(name));

alter table public.contacts
  add column if not exists label_ids uuid[] not null default '{}';

-- GIN index — fast "contacts with this label" filters from the inbox.
create index if not exists contacts_label_ids_idx
  on public.contacts using gin (label_ids);

alter table public.contact_labels enable row level security;
-- Granular permission for deleting workspace contact labels.
--
-- Background: anyone can CREATE / RENAME / recolor a label (the
-- operator wanted teammates to manage labels inline without sending
-- them into Settings). DELETE is the one destructive action that
-- needed a gate — pulls the label off every contact it was assigned
-- to, irreversible.
--
-- Defaults: owner / superadmin / admin = true, teammate = false. The
-- per-member override column lets the owner exempt a specific
-- teammate (or revoke an admin's right) without changing role rules.

alter table public.role_permissions
  add column if not exists can_delete_labels boolean not null default false;

-- Seed sensible role defaults for any existing rows.
update public.role_permissions
   set can_delete_labels = true
 where role in ('owner', 'superadmin', 'admin')
   and can_delete_labels = false;

alter table public.team_member_permissions
  add column if not exists can_delete_labels boolean;
-- Message edit, delete, and quoted-reply support.
--
-- reply_to_wa_message_id  — the wamid this message quotes. Populated by
--   /api/send-message (outbound) and the inbound webhook (when the
--   customer swipe-replies).
-- reply_to_content        — cached snippet of the quoted message body so
--   the bubble can render the quote header without a per-row lookup.
-- reply_to_direction      — 'inbound' | 'outbound' — drives styling of
--   the quote header (sender attribution).
-- edited_at               — non-null when the operator edited the text
--   via Meta's edit API. Drives the "(edited)" footer + greys out the
--   inline-edit button after the 15-minute window.
-- deleted_at              — non-null when "delete for everyone" was
--   called via Meta. The row stays so the chat thread keeps its order;
--   UI renders a "🗑 This message was deleted" placeholder.
-- original_content        — pre-edit text, kept for audit. NULL when
--   the row was never edited.

alter table public.messages
  add column if not exists reply_to_wa_message_id text;

alter table public.messages
  add column if not exists reply_to_content text;

alter table public.messages
  add column if not exists reply_to_direction text
    check (reply_to_direction in ('inbound', 'outbound'));

alter table public.messages
  add column if not exists edited_at timestamptz;

alter table public.messages
  add column if not exists deleted_at timestamptz;

alter table public.messages
  add column if not exists original_content text;

-- Index the quoted-reply pointer — the dashboard chat loader joins on
-- this when reconciling thread context.
create index if not exists messages_reply_to_wamid_idx
  on public.messages (reply_to_wa_message_id)
  where reply_to_wa_message_id is not null;
-- Per-user "hide this number" preference. The UserMenu toggle used to
-- flip business_numbers.is_active, which is global — flipping it for one
-- operator hid the number from everyone. This column moves that toggle
-- to the team_members row so each operator controls their own inbox
-- visibility without affecting teammates.
--
-- Stored as a text[] of phone_number_ids the user has chosen to hide.
-- Empty array (default) = show everything they have access to.

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS hidden_number_ids text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS team_members_hidden_number_ids_idx
  ON public.team_members USING gin (hidden_number_ids);
-- Free-form "memo" / operator note per business number. Kept separate
-- from `nickname` (which is the display label across the dashboard).
-- Memo is purely a memory aid — "what is this number for" — and shows
-- up as a subtitle on the Numbers settings card + the user-menu list.

ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS memo text;
-- Adds the "provider" axis to business_numbers so the same table can
-- hold both Meta Cloud API numbers (the existing flow, default
-- `provider='meta'`) and Evolution API numbers (unofficial / Baileys-
-- based, `provider='evolution'`). All existing rows are backfilled to
-- 'meta' via the column DEFAULT — no migration of historical data.
--
-- Evolution-specific columns are NULLABLE and only filled when
-- provider='evolution'. They mirror the shape Evolution returns from
-- /instance/create + the connection-state response:
--   • instance_name   — caller-chosen identifier (used in URL path)
--   • instance_api_key — per-instance key Evolution issues at create
--   • jid             — WhatsApp JID once the QR is scanned
--                       (e.g. "919876543210@s.whatsapp.net")
--   • connection_state — last known state ('open' / 'connecting' /
--                        'close') so the dashboard can show a live
--                        status pill without polling Evolution on each
--                        page load.
--
-- A partial unique index on instance_name (where not null) prevents
-- two rows pointing at the same Evolution instance. Meta rows keep
-- their existing uniqueness on phone_number_id (PK).

ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'evolution')),
  ADD COLUMN IF NOT EXISTS evolution_instance_name text,
  ADD COLUMN IF NOT EXISTS evolution_api_key text,
  ADD COLUMN IF NOT EXISTS evolution_jid text,
  ADD COLUMN IF NOT EXISTS evolution_connection_state text
    CHECK (evolution_connection_state IN ('open', 'connecting', 'close') OR evolution_connection_state IS NULL),
  ADD COLUMN IF NOT EXISTS evolution_last_state_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS business_numbers_evolution_instance_name_idx
  ON public.business_numbers (evolution_instance_name)
  WHERE evolution_instance_name IS NOT NULL;

-- Provider lookup is on every webhook + send dispatch — index it.
CREATE INDEX IF NOT EXISTS business_numbers_provider_idx
  ON public.business_numbers (provider);
-- Evolution disconnect log — every `connection.update` event with
-- state='close' coming from Evolution lands one row here. The
-- evolution-number health badge ("good / unstable / at-risk") is derived
-- from the row count + the most-recent reason code:
--   • 401  → Baileys was logged out (number unlinked from Linked Devices
--            or banned by WhatsApp). The number is effectively dead until
--            re-scanned.
--   • 408 / 500 / 503 → transient network blips. Harmless in small numbers,
--            warning if frequent.
--   • 515  → "stream errored" — Baileys couldn't reach the WA gateway.
--            Often network/IP related.
--
-- Schema is tiny so we don't need to age out rows aggressively — the
-- health window query just selects WHERE occurred_at > now() - 24h.
-- A nightly prune of rows older than 7d keeps the table from growing
-- forever; deferred to a future migration when row counts justify it.

create table if not exists evolution_disconnects (
  id                          uuid primary key default gen_random_uuid(),
  business_phone_number_id    text not null references business_numbers(phone_number_id) on delete cascade,
  reason_code                 int  not null,
  occurred_at                 timestamptz not null default now()
);

create index if not exists evolution_disconnects_bpid_ts_idx
  on evolution_disconnects (business_phone_number_id, occurred_at desc);
-- Log of WhatsApp Status posts the operator has pushed via the
-- dashboard. Each row mirrors what was sent to Evolution + when the
-- 24-hour window expires, so the Post Status modal can show a
-- "Recent statuses" list without round-tripping to Evolution.
--
-- Note: this is OUR log, not Evolution's source of truth. If the operator
-- posts a status from their phone directly, it won't appear here.

create table if not exists evolution_status_posts (
  id                          uuid primary key default gen_random_uuid(),
  business_phone_number_id    text not null references business_numbers(phone_number_id) on delete cascade,
  posted_by_user_id           uuid references auth.users(id) on delete set null,
  posted_by_email             text,
  type                        text not null check (type in ('text','image','video','audio')),
  content_preview             text,
  media_url                   text,
  background_color            text,
  wa_message_id               text,
  posted_at                   timestamptz not null default now(),
  expires_at                  timestamptz not null default (now() + interval '24 hours')
);

create index if not exists evolution_status_posts_bpid_ts_idx
  on evolution_status_posts (business_phone_number_id, posted_at desc);
-- Cache the WhatsApp profile picture URL for each business number.
-- Populated from Evolution's CONNECTION_UPDATE webhook (state=open
-- payload) and from on-demand fetches via /chat/fetchProfilePictureUrl
-- when the operator opens the Numbers page. Meta numbers don't expose
-- profile pic via Cloud API, so this stays null for them.
alter table business_numbers
  add column if not exists profile_pic_url text;
-- Adds two capability flags used by the LSQ-aware inbox flow:
--   • lsq_assigned_visibility_only — when ON for a role/member, the
--     inbox only surfaces contacts whose LSQ lead owner email matches
--     this user's email. Gives junior agents a focused queue.
--   • can_sync_lsq_owner — when ON, dashboard contact assignment also
--     pushes the new owner to LSQ so the lead owner field there stays
--     in sync with the dashboard's assigned_to_email.
--
-- Defaults mirror existing behaviour:
--   • lsq_assigned_visibility_only defaults FALSE everywhere (no
--     change to existing visibility).
--   • can_sync_lsq_owner defaults TRUE only for owner / superadmin
--     (matches how other "sync to upstream" capabilities default).
-- Operators can later flip these per-role or per-member from
-- Settings → Permissions like every other capability.

alter table role_permissions
  add column if not exists lsq_assigned_visibility_only boolean not null default false,
  add column if not exists can_sync_lsq_owner          boolean not null default false;

alter table team_member_permissions
  add column if not exists lsq_assigned_visibility_only boolean,
  add column if not exists can_sync_lsq_owner          boolean;

-- Owner + superadmin: full sync, no visibility restriction.
update role_permissions
  set can_sync_lsq_owner = true
  where role in ('owner','superadmin');

-- contacts.lsq_owner_email caches the LSQ lead owner's email so the
-- inbox visibility query (per-row filter) doesn't have to hit LSQ on
-- every page load. Refreshed by the existing LSQ ensure-lead /
-- update flows + the new sync helper.
alter table contacts
  add column if not exists lsq_owner_email text;

create index if not exists contacts_lsq_owner_email_idx
  on contacts (lsq_owner_email)
  where lsq_owner_email is not null;
-- API request audit log. Every authenticated v1 endpoint hit lands a
-- row here so the API tokens page can show per-day request counts +
-- a "where are these calls actually coming from" breakdown (token
-- name, user-agent → derived platform label).
--
-- Kept lean: status code + duration + a short truncated user_agent.
-- Bodies / response payloads are NOT logged (they contain customer
-- PII / message content; the existing messages table already captures
-- the business-relevant data).
--
-- token_id is nullable because some routes (webhook callbacks, etc.)
-- might be in scope later but don't carry a token.

create table if not exists api_request_log (
  id                          uuid primary key default gen_random_uuid(),
  token_id                    uuid references api_tokens(id) on delete set null,
  token_name                  text,
  business_phone_number_id    text,
  method                      text not null,
  path                        text not null,
  status                      int  not null,
  duration_ms                 int,
  user_agent                  text,
  source_ip                   text,
  occurred_at                 timestamptz not null default now()
);

create index if not exists api_request_log_token_ts_idx
  on api_request_log (token_id, occurred_at desc);
create index if not exists api_request_log_ts_idx
  on api_request_log (occurred_at desc);
create index if not exists api_request_log_bpid_ts_idx
  on api_request_log (business_phone_number_id, occurred_at desc);
-- Track the last time we asked Meta / Evolution for a profile pic on
-- this number. The background cron uses this to round-robin across
-- numbers that haven't been checked in a while, rather than re-trying
-- the same null-pic numbers every 5 minutes forever.
--
-- NULL means "never checked" — those go first.

alter table business_numbers
  add column if not exists profile_pic_checked_at timestamptz;

create index if not exists business_numbers_profile_pic_checked_idx
  on business_numbers (profile_pic_checked_at nulls first)
  where profile_pic_url is null;
-- Failed-login throttling. Records each email/password attempt (success
-- or fail) so the login action can lock out an email OR IP after too
-- many failures in a short window.
--
-- Lockout policy (enforced in app code, not SQL):
--   - 5 failed attempts in the last 15 minutes for the same email  → blocked
--   - 5 failed attempts in the last 15 minutes for the same IP     → blocked
-- A successful login does NOT reset the count — we just stop counting
-- because the user is in. Old rows age out via the time-window query.

create table if not exists auth_attempts (
  id          bigserial primary key,
  email       text,
  ip          text,
  success     boolean not null,
  created_at  timestamptz not null default now()
);

create index if not exists auth_attempts_email_recent_idx
  on auth_attempts (email, created_at desc) where success = false;

create index if not exists auth_attempts_ip_recent_idx
  on auth_attempts (ip, created_at desc) where success = false;

-- Keep the table small — drop anything older than 24 hours daily. We
-- only look at the last 15 min so older rows are pure dead weight.
-- Run this via a Supabase scheduled function or a cron in the host; the
-- statement is idempotent and cheap.
--   delete from auth_attempts where created_at < now() - interval '24 hours';

-- Service-role only. The login server action uses the service-role
-- client (or a server-side client with insert/select grants) — no row
-- the end user should ever read.
alter table auth_attempts enable row level security;
-- No policies = no anon/authenticated access. Service role bypasses RLS.
-- Read-only SQL escape hatch for the in-app AI assistant.
--
-- Supabase JS doesn't expose raw SQL — every read goes through the
-- PostgREST builder, which can't represent ad-hoc joins / aggregations
-- the assistant might need for one-off questions ("top contacts by
-- inbound messages this month grouped by tag"). This function gives
-- the service-role client a single RPC to run an arbitrary SELECT and
-- get back a JSONB array of rows.
--
-- Safety rails (enforced both here AND in the API route):
--   • The query MUST start with SELECT or WITH (case-insensitive).
--   • The query MUST NOT contain a semicolon except as a trailing
--     character — blocks classic stacked-statement injection.
--   • Implicit row cap of 200 (via LIMIT 200 wrapper if the caller's
--     query doesn't already have a LIMIT).
--   • SECURITY DEFINER + revoke from public so only the service role
--     can execute it.

create or replace function public.assistant_run_select(query_text text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
  cleaned text := btrim(query_text);
begin
  if cleaned is null or length(cleaned) = 0 then
    raise exception 'empty query';
  end if;
  -- strip a single trailing semicolon if present
  if right(cleaned, 1) = ';' then
    cleaned := btrim(left(cleaned, length(cleaned) - 1));
  end if;
  if position(';' in cleaned) > 0 then
    raise exception 'semicolons not allowed in query body';
  end if;
  if not (lower(left(cleaned, 6)) = 'select' or lower(left(cleaned, 4)) = 'with') then
    raise exception 'only SELECT / WITH queries are allowed';
  end if;
  -- Wrap into json_agg so the result is always a single JSONB array.
  -- Hard cap at 200 rows so the assistant can't accidentally pull a
  -- million message bodies into the model context.
  execute format(
    'select coalesce(jsonb_agg(row_to_json(t)), ''[]''::jsonb) from (%s limit 200) t',
    cleaned
  ) into result;
  return result;
exception when others then
  -- Surface the Postgres error message to the caller so the assistant
  -- can correct itself rather than retrying the same broken query.
  raise exception '%', sqlerrm;
end
$$;

revoke all on function public.assistant_run_select(text) from public;
revoke all on function public.assistant_run_select(text) from anon;
revoke all on function public.assistant_run_select(text) from authenticated;
-- service_role automatically has execute since it inherits everything,
-- but be explicit for future-proofing.
grant execute on function public.assistant_run_select(text) to service_role;
-- Track how many recipients have viewed each posted WhatsApp Status.
--
-- WhatsApp returns "seen" receipts per status broadcast (the eye icon
-- in Status → Seen by). Evolution surfaces these via the userReceipt
-- array on the underlying message row. We fetch and cache the
-- aggregate count here so the dashboard can show "X views" without
-- round-tripping for every render.
--
-- seen_by holds the JIDs that viewed, so a future "who viewed this?"
-- detail view can render names without another fetch.

alter table evolution_status_posts
  add column if not exists seen_count int not null default 0,
  add column if not exists seen_by jsonb not null default '[]'::jsonb,
  add column if not exists last_views_synced_at timestamptz;

-- Speed up the "most-recently-synced first" panel ordering.
create index if not exists evolution_status_posts_posted_at_idx
  on evolution_status_posts (posted_at desc);
-- Per-member, per-number inbox visibility mode.
--
-- The existing `team_member_permissions.lsq_assigned_visibility_only`
-- flag is GLOBAL: ON means the user sees only LSQ-assigned chats
-- across every number they have access to. Operators wanted finer
-- control — "for number A give Riya FULL access, but for number B
-- only the leads LSQ owner = riya@qhtclinic.com". That can't be
-- expressed by a single per-user boolean, so we side-table it here.
--
-- Resolution rule (enforced in lib/permissions.ts):
--   1. If a row exists for (member_id, bpid) → use its `mode`.
--   2. Else → fall back to the global lsq_assigned_visibility_only:
--      true  → 'assigned_only'
--      false → 'full'
--   3. Owners always get 'full' regardless.
--
-- Zero rows = current behavior preserved. App ALSO behaves correctly
-- when this migration hasn't been run yet — the resolver swallows the
-- "relation does not exist" error and returns an empty map.

create table if not exists member_number_access (
  member_id                   uuid not null
    references team_members(id) on delete cascade,
  business_phone_number_id    text not null
    references business_numbers(phone_number_id) on delete cascade,
  mode                        text not null
    check (mode in ('full', 'assigned_only'))
    default 'full',
  created_at                  timestamptz not null default now(),
  primary key (member_id, business_phone_number_id)
);

create index if not exists member_number_access_member_idx
  on member_number_access (member_id);

alter table member_number_access enable row level security;
-- No policies = service role only. The team-permissions API uses the
-- service role client (same as every other team_member_permissions write).
-- Team-group permission overrides.
--
-- Each row mirrors the shape of `team_member_permissions` but is
-- keyed by team_id, so an admin can say "everyone in the Sales team
-- gets these capabilities" without touching individual members. All
-- fields are nullable; NULL means "inherit role default", same
-- semantics as the per-member override table.
--
-- Resolution order (enforced in lib/permissions.ts):
--   1. Role default
--   2. Team override   (member.team_id  → team_permissions[team_id])
--   3. Member override (team_member_permissions row for the member)
--
-- A NULL field in a layer means "pass through" to the previous layer.

create table if not exists team_permissions (
  team_id                       uuid primary key references teams(id) on delete cascade,
  allowed_number_ids            text[],
  allowed_panels                text[],
  allowed_settings_tabs         text[],
  mask_phone_numbers            boolean,
  mask_emails                   boolean,
  can_send_messages             boolean,
  can_use_magic_message         boolean,
  can_export_data               boolean,
  can_assign_contacts           boolean,
  can_manage_templates          boolean,
  can_manage_automation         boolean,
  can_make_calls                boolean,
  can_view_call_history         boolean,
  can_manage_team               boolean,
  can_manage_numbers            boolean,
  can_delete_labels             boolean,
  lsq_assigned_visibility_only  boolean,
  can_sync_lsq_owner            boolean,
  updated_at                    timestamptz not null default now()
);

alter table team_permissions enable row level security;
-- Service role only. The team-permissions API uses the service-role
-- client (same as the member override path).
-- Application-level session ledger.
--
-- Supabase ships a refresh-token table internally but it's not query-
-- friendly: no geo, no friendly user-agent labelling, no way to revoke
-- a single session from our own UI without forcing a full sign-out via
-- the admin API.
--
-- This table records one row per successful sign-in (server-side, from
-- signInAction + the OAuth callback). We refresh `last_seen_at` on the
-- HeartbeatTracker tick so "active" can be computed as "last_seen
-- within the last 5 min". Logout-all flow ALSO writes here so the
-- "revoke this session" button has something to act against.
--
-- Geo (city / country) is populated best-effort from a free IP→geo
-- lookup at insert time; failures don't block the sign-in.

create table if not exists user_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  member_id       uuid references team_members(id) on delete cascade,
  ip              text,
  user_agent      text,
  city            text,
  region          text,
  country         text,   -- ISO-2
  started_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_reason  text
);

create index if not exists user_sessions_user_recent_idx
  on user_sessions (user_id, last_seen_at desc);
create index if not exists user_sessions_active_idx
  on user_sessions (user_id) where revoked_at is null;

alter table user_sessions enable row level security;
-- No anon/authenticated policies — the API uses the service-role
-- client throughout. Admins read other users' sessions via that
-- same path so RLS would have to be permissive to be useful, and the
-- API already does its own role gating.
-- Reusable Magic Message presets, scoped per team.
--
-- The /quick-replies table is workspace-wide and meant for short
-- slash-shortcut snippets. Magic Message bodies are longer
-- (greeting + 3-4 line pitch) and operators wanted these saved per
-- TEAM (e.g. "Sales" team has Sales-specific outreach copy; "HT Done"
-- has follow-up scripts). A NULL team_id row is workspace-wide,
-- available to everyone — useful for org-level boilerplate.

create table if not exists magic_message_templates (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid references teams(id) on delete cascade,
  title       text not null,
  body        text not null,
  created_by  uuid references team_members(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists magic_message_templates_team_idx
  on magic_message_templates (team_id, created_at desc);

alter table magic_message_templates enable row level security;
-- Service role only. The API does its own scope filtering by joining
-- to the caller's team_members.team_id.
-- Workspace-wide key/value settings.
--
-- A tiny catch-all for single-instance config that doesn't deserve its
-- own table — currently the editable AI chat-summary prompt. Reads and
-- writes always go through the service role (API routes mediate access
-- + role checks), so RLS is left enabled with no policies = deny-all to
-- anon/authenticated clients.

create table if not exists public.app_settings (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
-- WhatsApp group support (read-only viewing).
--
-- Until now the app ingested only 1:1 customer chats. Group chats
-- (@g.us JIDs from Evolution) are now stored too — as a `contacts`
-- row flagged `is_group`, with each message carrying the participant's
-- name in `sender_name`. The inbox keeps groups out of the normal
-- filters and surfaces them under a dedicated "Groups" filter.

alter table public.contacts
  add column if not exists is_group boolean not null default false;

-- Per-message sender — for group messages this is the participant who
-- sent it (1:1 messages leave it null; the contact IS the sender).
alter table public.messages
  add column if not exists sender_name text;

-- The inbox lists groups and 1:1 chats separately — index the flag so
-- the filtered query stays fast.
create index if not exists idx_contacts_is_group
  on public.contacts(is_group);
-- Automation config: photo-stage + image-response columns.
--
-- The /api/automation/config PUT route (and the Automation panel UI)
-- have been writing these three columns, but no migration ever created
-- them. Every save from the panel hit "column does not exist" and 500'd
-- — so persona / model / any field edit silently failed to persist.
--
-- `if not exists` keeps this safe to run even where the columns were
-- already added by hand.

alter table public.automation_configs
  add column if not exists photo_lead_stage_target text,
  add column if not exists photo_lead_stage_allowed_from text[],
  add column if not exists image_response_triggers jsonb not null default '[]'::jsonb;
-- =====================================================================
-- 0057 — contacts.imported flag
-- ---------------------------------------------------------------------
-- Chats brought in through the chat-import tool are historical: they're
-- a one-time dump of a WhatsApp export, not a live conversation. The
-- inbox should mark these so agents instantly know "this is a past
-- chat, not an active thread".
--
-- Going forward the import batch route sets `imported = true` on the
-- contacts it upserts. The backfill below catches everything already
-- imported: a contact counts as imported when it HAS messages and
-- every one of them carries a synthesised `import:<sha>` wa_message_id
-- (the id the batch route generates when the export had no real wamid).
-- A contact with even one live message is left alone.
-- =====================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS imported boolean NOT NULL DEFAULT false;

UPDATE public.contacts c
   SET imported = true
 WHERE EXISTS (
         SELECT 1 FROM public.messages m WHERE m.contact_id = c.id
       )
   AND NOT EXISTS (
         SELECT 1 FROM public.messages m
          WHERE m.contact_id = c.id
            AND COALESCE(m.wa_message_id, '') NOT LIKE 'import:%'
       );

-- Partial index — the inbox only ever asks "is this one imported?".
CREATE INDEX IF NOT EXISTS contacts_imported_idx
  ON public.contacts (imported) WHERE imported;
-- =====================================================================
-- 0058 — Automation inbound debounce
-- ---------------------------------------------------------------------
-- Today the AI fires immediately on every inbound message. Patients
-- often send 3-4 messages back-to-back; that produced 3-4 separate
-- replies and visible races against the next inbound.
--
-- New flow: the webhook sets `contacts.automation_pending_at` to
-- `now() + debounce` instead of running the LLM. Every subsequent
-- inbound within the window resets the timestamp. A worker route
-- (/api/automation/process-pending) hit by cron every few seconds
-- atomically picks contacts whose timestamp has elapsed and fires the
-- run ONCE — the LLM sees the whole batch in its context window and
-- produces a single consolidated reply.
-- =====================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS automation_pending_at timestamptz;

-- Partial index — the worker only scans rows whose timer is armed, so
-- a sparse partial index keeps the planner fast even on 100k contacts.
CREATE INDEX IF NOT EXISTS contacts_automation_pending_at_idx
  ON public.contacts (automation_pending_at)
  WHERE automation_pending_at IS NOT NULL;

ALTER TABLE public.automation_configs
  ADD COLUMN IF NOT EXISTS inbound_debounce_seconds int NOT NULL DEFAULT 10;
-- =====================================================================
-- 0059 — Per-reply quality rating on automation_logs
-- ---------------------------------------------------------------------
-- World-class bot quality isn't a feature — it's a daily review loop.
-- The operator looks at each automated reply, marks it good / needs
-- review / wrong, and (over weeks) refines the persona + knowledge
-- chunks based on the patterns. These columns capture the rating.
-- =====================================================================

ALTER TABLE public.automation_logs
  ADD COLUMN IF NOT EXISTS quality_rating text
    CHECK (quality_rating IN ('good', 'needs_review', 'wrong')),
  ADD COLUMN IF NOT EXISTS quality_note text,
  ADD COLUMN IF NOT EXISTS quality_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS quality_reviewed_by text;

-- The review queue queries by (rating IS NULL, created_at desc) — a
-- partial index on unrated rows keeps it instant even at millions of
-- logs (rated rows never need to surface in the queue).
CREATE INDEX IF NOT EXISTS automation_logs_unrated_idx
  ON public.automation_logs (created_at DESC)
  WHERE quality_rating IS NULL;
-- =====================================================================
-- 0060 — Evolution number groups (Delhi / Noida / Haridwar clinic …)
-- ---------------------------------------------------------------------
-- Portfolios are Meta-side concepts; the Baileys (Evolution) numbers
-- don't belong to portfolios at all. As the unofficial fleet grows the
-- operator wants their own clustering — typically by clinic / city —
-- so the Numbers screen and the Automation picker can group them
-- meaningfully. This adds a small CRUD table + a nullable FK on
-- business_numbers.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.evolution_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  color       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS evolution_groups_name_lower_idx
  ON public.evolution_groups (lower(name));

ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS evolution_group_id uuid
    REFERENCES public.evolution_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS business_numbers_evolution_group_idx
  ON public.business_numbers (evolution_group_id)
  WHERE evolution_group_id IS NOT NULL;

ALTER TABLE public.evolution_groups ENABLE ROW LEVEL SECURITY;
-- =====================================================================
-- 0061 — Atomic claim for runAutomation
-- ---------------------------------------------------------------------
-- Two cron-driven invokers can fire runAutomation for the same inbound
-- trigger_message_id at the same time:
--   1. /api/automation/process-pending  (debounced worker)
--   2. /api/automation/sweep            (safety-net for missed inbounds)
-- The pre-send "any AI reply yet?" guard wasn't atomic — both runs
-- could pass the check before either had INSERTed, producing two AI
-- replies for one patient message.
--
-- This partial unique index turns the FIRST automation_logs insert
-- with status IN ('processing','success') into the atomic claim. A
-- parallel runAutomation hits 23505 and bails before the LLM call.
-- ---------------------------------------------------------------------
-- 1) Allow 'processing' as a status — the claim sentinel runAutomation
--    inserts at start. Drop + recreate the CHECK constraint (Postgres
--    has no "ADD VALUE" for CHECK; only for ENUM types).
ALTER TABLE public.automation_logs
  DROP CONSTRAINT IF EXISTS automation_logs_status_check;
ALTER TABLE public.automation_logs
  ADD CONSTRAINT automation_logs_status_check
  CHECK (status IN ('processing', 'success', 'failed', 'skipped'));

-- 2) Only one in-flight or successful AI reply per trigger message.
--    The partial WHERE leaves room for 'skipped' / 'failed' rows since
--    those don't represent a send and shouldn't block a future claim.
CREATE UNIQUE INDEX IF NOT EXISTS automation_logs_trigger_claim_idx
  ON public.automation_logs (trigger_message_id)
  WHERE status IN ('processing', 'success');
-- =====================================================================
-- 0062 — Tasks (admin-assigned work items per agent)
-- ---------------------------------------------------------------------
-- Owner / superadmin / admin can assign tasks to any team member. The
-- panel reports pending / completed / overdue counts per agent and
-- powers the small "Tasks · N" chip in the TopBar.
--
-- Free-form (title + description) with optional linkage to a contact
-- (so the assignee can jump straight to the chat) and/or a WhatsApp
-- business number (so number-scoped tasks group cleanly in reports).
-- Status + priority enums kept conservative — most operator workflows
-- map to one of these. Comments thread lives in a sibling table.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description     text,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  priority        text NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low','normal','high','urgent')),

  -- Assignment
  assigned_to     uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES public.team_members(id) ON DELETE SET NULL,

  -- Optional linkage so a task can deep-link into the right surface
  contact_id                uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  business_phone_number_id  text,

  due_at          timestamptz,
  completed_at    timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Hot path: "what's open for me right now?"
CREATE INDEX IF NOT EXISTS tasks_assigned_open_idx
  ON public.tasks (assigned_to)
  WHERE status NOT IN ('done','cancelled');

-- Reports & dashboards: status-based aggregations with due-date order.
CREATE INDEX IF NOT EXISTS tasks_status_due_idx
  ON public.tasks (status, due_at);

CREATE INDEX IF NOT EXISTS tasks_created_by_idx
  ON public.tasks (created_by);

CREATE INDEX IF NOT EXISTS tasks_contact_id_idx
  ON public.tasks (contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_bpid_idx
  ON public.tasks (business_phone_number_id)
  WHERE business_phone_number_id IS NOT NULL;

-- Activity / comments thread per task.
CREATE TABLE IF NOT EXISTS public.task_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  /** Kind separates plain comments from auto-generated audit lines
   *  ("status changed open → done", "reassigned to X") so the UI can
   *  render them differently without a second table. */
  kind            text NOT NULL DEFAULT 'comment'
                    CHECK (kind IN ('comment','status_change','assignee_change','due_change')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_comments_task_id_idx
  ON public.task_comments (task_id, created_at DESC);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;
-- =====================================================================
-- 0063 — RAG chunk audit trail + per-number guardrails
-- ---------------------------------------------------------------------
-- 1) automation_logs.rag_chunks — JSONB array of the actual knowledge
--    chunks retrieved for this run (id, source, similarity, snippet).
--    Lets the operator see WHICH knowledge the bot leaned on in the
--    Activity feed so they can tune the chunks that matter and prune
--    the noisy ones. Nullable because:
--      • RAG-disabled numbers never have chunks.
--      • Image-trigger runs skip RAG by design.
--      • Old runs from before this column existed.
--
-- 2) automation_configs.guardrails_text — operator-defined "never do
--    this" list injected into the system prompt as a strict-rules
--    block. Example: "Never quote prices over phone; never promise
--    same-day delivery." The model is told these are non-negotiable.
--    nullable so existing rows behave unchanged when blank.
-- =====================================================================

ALTER TABLE public.automation_logs
  ADD COLUMN IF NOT EXISTS rag_chunks jsonb;

ALTER TABLE public.automation_configs
  ADD COLUMN IF NOT EXISTS guardrails_text text;
-- =====================================================================
-- 0064 — Per-agent hidden LSQ stages (inbox stage strip)
-- ---------------------------------------------------------------------
-- Each agent can right-click a stage chevron to hide it from their own
-- funnel strip — names they don't deal with stop cluttering their view.
-- Per-user state lives on team_members so the preference syncs across
-- devices the agent signs into. Empty / null array = show everything.
-- =====================================================================
ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS hidden_stages text[] NOT NULL DEFAULT '{}';
-- Payment links + receipts.
--
-- Operators generate a Razorpay payment link from inside a chat. The
-- link is sent to the patient over WhatsApp; when they pay, Razorpay's
-- webhook hits us and we flip the row to 'paid'. Receipts can be auto-
-- sent on payment OR sent manually later from the contact details
-- panel.

create table if not exists public.payments (
  id                          uuid primary key default gen_random_uuid(),
  contact_id                  uuid not null
                              references public.contacts(id) on delete cascade,
  business_phone_number_id    text references public.business_numbers(phone_number_id)
                              on delete set null,
  -- Amount stored in MINOR units (paise for INR) to match Razorpay's
  -- API exactly and avoid float rounding when comparing.
  amount_minor                bigint not null check (amount_minor > 0),
  currency                    text not null default 'INR',
  description                 text,
  -- Razorpay's identifiers + short URL we share with the patient.
  razorpay_payment_link_id    text unique,
  short_url                   text,
  -- Lifecycle: created → sent → paid | cancelled | expired | failed
  -- 'sent' = link forwarded to the patient via WhatsApp.
  status                      text not null default 'created'
                              check (status in
                                ('created','sent','paid','cancelled',
                                 'expired','failed')),
  paid_at                     timestamptz,
  -- Razorpay-generated receipt URL (PDF). Filled by the webhook on
  -- payment_link.paid. Manual "send receipt" uses this same URL.
  receipt_url                 text,
  -- Track whether the auto-receipt WhatsApp send has fired yet so we
  -- don't double-send if the webhook retries.
  receipt_sent_at             timestamptz,
  -- Audit columns.
  created_by                  text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists payments_contact_id_idx
  on public.payments(contact_id, created_at desc);
create index if not exists payments_status_idx
  on public.payments(status);
create index if not exists payments_bpid_idx
  on public.payments(business_phone_number_id, created_at desc);

-- RLS — workspace-internal, same model as the rest of the schema.
-- Service role bypasses RLS for webhook + server-side writes; user-
-- scoped clients read via the existing dashboard auth.
alter table public.payments enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'payments' and policyname = 'payments_all_authenticated'
  ) then
    create policy payments_all_authenticated
      on public.payments
      for all
      to authenticated
      using (true)
      with check (true);
  end if;
end$$;
-- Make the payments table provider-agnostic. The original 0065 design
-- assumed Razorpay; we now also support PayU. Each row records which
-- gateway minted it so the webhook + manual receipt path can dispatch
-- correctly.
--
--   provider              — 'razorpay' | 'payu'. Required going
--                            forward; backfilled to 'razorpay' for
--                            rows created before the rename.
--   provider_link_id      — generic name for the gateway link id.
--                            Already populated for Razorpay via
--                            razorpay_payment_link_id; we keep that
--                            old column for backward compat and copy
--                            its value into the new one.
--   provider_txnid        — for PayU we generate our own txnid and
--                            send it along; PayU returns mihpayid on
--                            payment which we'll stash in
--                            razorpay_payment_link_id too (since the
--                            semantics align: gateway's internal id).
--
-- Existing rows: their provider stays 'razorpay' and provider_link_id
-- copies from razorpay_payment_link_id, so the dashboard + webhook
-- handlers can immediately switch to the new columns without losing
-- history.

alter table public.payments
  add column if not exists provider text;

update public.payments
  set provider = 'razorpay'
  where provider is null;

alter table public.payments
  alter column provider set not null,
  alter column provider set default 'razorpay';

-- Replace the CHECK on Razorpay-only with a generic enum.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payments_provider_check'
  ) then
    alter table public.payments
      add constraint payments_provider_check
        check (provider in ('razorpay', 'payu'));
  end if;
end$$;

alter table public.payments
  add column if not exists provider_link_id text,
  add column if not exists provider_txnid   text;

-- Backfill provider_link_id from razorpay_payment_link_id for old rows.
update public.payments
  set provider_link_id = razorpay_payment_link_id
  where provider_link_id is null
    and razorpay_payment_link_id is not null;

create index if not exists payments_provider_link_id_idx
  on public.payments(provider, provider_link_id);
create index if not exists payments_provider_txnid_idx
  on public.payments(provider, provider_txnid);
-- Multi-account payment gateway storage.
--
-- Up to this migration the workspace had exactly ONE Razorpay + ONE
-- PayU account, both read straight out of .env.local. Operators with
-- multiple sub-brands or test/live keys want to store several accounts,
-- label them, and flip the active one from the UI.
--
-- Schema:
--   provider     — 'razorpay' | 'payu'
--   label        — operator-supplied display name (e.g. "QHT Main",
--                  "Hairmed Live"). Required so the dashboard can
--                  show "which account am I about to send from".
--   credentials  — JSONB of the provider-specific keys. Razorpay:
--                  { key_id, key_secret, webhook_secret }. PayU:
--                  { merchant_key, merchant_salt, env? }.
--   is_active    — exactly one row across the whole table may be true.
--                  A partial unique index enforces that — flipping
--                  a different row to active requires the caller to
--                  unset the previous winner inside the same txn.
--
-- Secrets are stored unencrypted; access is service-role only.
-- Owner/superadmin-only routes are the only callers. Add column-level
-- encryption later if we go multi-tenant.

create table if not exists public.payment_accounts (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null check (provider in ('razorpay', 'payu')),
  label        text not null,
  credentials  jsonb not null default '{}'::jsonb,
  is_active    boolean not null default false,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists payment_accounts_provider_idx
  on public.payment_accounts(provider);

-- Only one active account workspace-wide. Partial unique = lets us
-- have many is_active=false rows alongside the single active winner.
create unique index if not exists payment_accounts_one_active
  on public.payment_accounts((true))
  where is_active = true;

alter table public.payment_accounts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'payment_accounts'
      and policyname = 'payment_accounts_authenticated_select'
  ) then
    create policy payment_accounts_authenticated_select
      on public.payment_accounts
      for select
      to authenticated
      using (true);
  end if;
end$$;
-- Single-shot home-page stats aggregation.
--
-- The TypeScript implementation in lib/home-stats.ts paginated through
-- all 39k+ contacts + every inbound message in the last 48 h to
-- compute the counters the /home dashboard shows. End-to-end took
-- 6-10 s on production. This function does the same work in Postgres
-- with proper aggregations + indexes — runs in <300 ms.
--
-- bpid_filter NULL = workspace-wide (owner view).
-- bpid_filter [] / non-null = scope to that allow-list (teammate view).
-- Returning JSONB lets the TS layer pick fields without managing a
-- composite row type.

create or replace function public.get_home_stats(bpid_filter text[])
returns jsonb
language plpgsql
stable
as $$
declare
  cutoff_inbound  timestamptz := now() - interval '48 hours';
  warn_cutoff     timestamptz := now() - interval '18 hours';   -- 24-6h window
  closed_cutoff   timestamptz := now() - interval '24 hours';
  result jsonb;
  -- scope helper: true when filter is null OR row's bpid is in filter
  -- (Postgres treats `x = any(null)` as null, so we explicit-test).
begin
  with
  -- Per-contact stats — single scan over `contacts`.
  scoped_contacts as (
    select
      c.id,
      c.wa_id,
      c.name,
      c.profile_name,
      coalesce(c.status, 'open') as status,
      coalesce(c.unread_count, 0) as unread_count,
      c.tags,
      c.business_phone_number_id,
      c.assigned_to
    from public.contacts c
    where bpid_filter is null
       or c.business_phone_number_id = any(bpid_filter)
  ),
  -- Latest inbound timestamp per contact, last 48 h only.
  latest_inbound as (
    select
      m.contact_id,
      max(m.timestamp) as latest_at
    from public.messages m
    where m.direction = 'inbound'
      and m.timestamp >= cutoff_inbound
      and (bpid_filter is null
           or m.business_phone_number_id = any(bpid_filter))
    group by m.contact_id
  ),
  -- Top-line counters.
  counters as (
    select
      count(*) filter (where status = 'open') as open_count,
      count(*) filter (where status = 'closed') as closed_count,
      count(*) as total_conversations,
      count(*) filter (where unread_count > 0) as unread_conversations,
      coalesce(sum(unread_count), 0) as unread_messages,
      count(*) filter (
        where status = 'open' and assigned_to is null
      ) as unassigned_open
    from scoped_contacts
  ),
  -- 24-h window expiry split, joined per-contact.
  window_split as (
    select
      count(*) filter (
        where li.latest_at between warn_cutoff and now()
        and (warn_cutoff + (now() - li.latest_at)) <= warn_cutoff + interval '6 hours'
        and (now() - li.latest_at) <= interval '6 hours'
      ) as windows_expiring_soon_unused, -- placeholder; we recompute below
      0 as placeholder
    from scoped_contacts sc
    left join latest_inbound li on li.contact_id = sc.id
  ),
  -- Simpler & accurate window computation:
  --   windows_expiring_soon: latest_at within (now-24h .. now-18h], i.e.
  --      6h or less remaining in the 24 h customer-care window.
  --   windows_closed: latest_at <= now-24h OR no inbound in 48h.
  window_counts as (
    select
      count(*) filter (
        where li.latest_at is not null
          and li.latest_at >= closed_cutoff
          and li.latest_at <= warn_cutoff
      ) as windows_expiring_soon,
      count(*) filter (
        where sc.status = 'open'
          and (li.latest_at is null or li.latest_at < closed_cutoff)
      ) as windows_closed
    from scoped_contacts sc
    left join latest_inbound li on li.contact_id = sc.id
  ),
  -- Per-business-number breakdown.
  per_number as (
    select
      sc.business_phone_number_id,
      bn.verified_name,
      bn.display_phone_number,
      count(*) as total_count,
      count(*) filter (where sc.status = 'open') as open_count,
      count(*) filter (where sc.unread_count > 0) as unread_conversations,
      coalesce(sum(sc.unread_count), 0) as unread_messages
    from scoped_contacts sc
    left join public.business_numbers bn
      on bn.phone_number_id = sc.business_phone_number_id
    where sc.business_phone_number_id is not null
    group by sc.business_phone_number_id, bn.verified_name, bn.display_phone_number
    order by open_count desc, total_count desc
    limit 20
  ),
  -- Top tags via unnest.
  tag_rows as (
    select
      unnest(coalesce(sc.tags, '{}'::text[])) as tag,
      sc.unread_count
    from scoped_contacts sc
  ),
  top_tags as (
    select
      tag,
      count(*) as total_count,
      count(*) filter (where unread_count > 0) as unread_count
    from tag_rows
    where tag is not null and tag <> ''
    group by tag
    order by total_count desc
    limit 12
  ),
  -- Recent 8 inbound messages (lightweight).
  recent_msgs as (
    select
      m.contact_id,
      m.content,
      m.timestamp,
      m.business_phone_number_id
    from public.messages m
    where m.direction = 'inbound'
      and (bpid_filter is null
           or m.business_phone_number_id = any(bpid_filter))
    order by m.timestamp desc
    limit 8
  ),
  recent_activity as (
    select
      rm.contact_id,
      sc.wa_id,
      coalesce(nullif(trim(sc.name), ''), nullif(trim(sc.profile_name), ''), sc.wa_id) as display_name,
      rm.content as preview,
      rm.timestamp,
      rm.business_phone_number_id
    from recent_msgs rm
    join scoped_contacts sc on sc.id = rm.contact_id
    order by rm.timestamp desc
  )
  select jsonb_build_object(
    'openCount',            (select open_count from counters),
    'closedCount',          (select closed_count from counters),
    'totalConversations',   (select total_conversations from counters),
    'unreadConversations',  (select unread_conversations from counters),
    'unreadMessages',       (select unread_messages from counters),
    'unassignedOpen',       (select unassigned_open from counters),
    'windowsExpiringSoon',  (select windows_expiring_soon from window_counts),
    'windowsClosed',        (select windows_closed from window_counts),
    'perNumber', coalesce(
      (select jsonb_agg(jsonb_build_object(
        'business_phone_number_id', business_phone_number_id,
        'verified_name', verified_name,
        'display_phone_number', display_phone_number,
        'totalCount', total_count,
        'openCount', open_count,
        'unreadConversations', unread_conversations,
        'unreadMessages', unread_messages
      )) from per_number),
      '[]'::jsonb
    ),
    'topTags', coalesce(
      (select jsonb_agg(jsonb_build_object(
        'tag', tag,
        'totalCount', total_count,
        'unreadCount', unread_count
      )) from top_tags),
      '[]'::jsonb
    ),
    'recentActivity', coalesce(
      (select jsonb_agg(jsonb_build_object(
        'contact_id', contact_id,
        'wa_id', wa_id,
        'display_name', display_name,
        'preview', preview,
        'timestamp', timestamp,
        'business_phone_number_id', business_phone_number_id
      )) from recent_activity),
      '[]'::jsonb
    )
  )
  into result;

  return result;
end$$;

-- Indexes the function relies on. Most exist already from earlier
-- migrations; CREATE IF NOT EXISTS keeps this idempotent.
create index if not exists messages_inbound_timestamp_idx
  on public.messages (timestamp desc)
  where direction = 'inbound';
create index if not exists contacts_bpid_status_idx
  on public.contacts (business_phone_number_id, status);

-- Allow the public.authenticated and service-role to execute. RLS on
-- the underlying tables still enforces row visibility for callers.
grant execute on function public.get_home_stats(text[]) to authenticated, service_role;
-- Call routing + atomic claim columns.
--
-- WhatsApp inbound calls were broadcasting to every operator who
-- happened to be on the dashboard, and the row stayed visible even
-- after someone picked up — so the entire team kept seeing a banner
-- for an already-answered call. This migration adds:
--
--   lsq_owner_email — cached at ring-time so we can route the banner
--                     to the LSQ lead-owner first. Falls back to "any
--                     operator with access to this business number"
--                     when the owner isn't on the platform.
--
--   claim_token     — guaranteed-unique value the accept handler
--                     conditional-UPDATEs against, so two simultaneous
--                     clicks can't both win. The losing operator gets
--                     an empty-update response and the UI tells them
--                     "Already picked up".
--
-- handled_by_user_id / handled_by_email already exist (see
-- db/migrations/whatsapp_calls_recording.sql) — those columns stay
-- the canonical "who answered" record.

alter table public.whatsapp_calls
  add column if not exists lsq_owner_email text;

create index if not exists whatsapp_calls_owner_email_idx
  on public.whatsapp_calls (lsq_owner_email)
  where status in ('ringing', 'accepted');

-- Index supporting the active-call lookup filter — we read by
-- business_phone_number_id and current status, so a partial index on
-- live calls only is the right shape.
create index if not exists whatsapp_calls_active_bpid_idx
  on public.whatsapp_calls (business_phone_number_id, start_at desc)
  where status in ('ringing', 'accepted');

notify pgrst, 'reload schema';
-- import_chats_from_table — direct table → contacts+messages import.
--
-- The CSV upload flow had to ship 2M+ row tables through the operator's
-- browser, which choked on large files and required psql tricks to even
-- download. This function pulls the same data INSIDE Postgres without
-- ever leaving the DB.
--
-- Caller (the run API route) validates the source table + column map
-- and passes everything in as parameters. The function builds a safe
-- dynamic SQL using `format()` quoting, runs the contacts upsert + the
-- messages upsert, and returns a JSON summary the API ships back.
--
-- Helper function for column discovery — also used by /preview when
-- supabase-js can't read information_schema directly.

create or replace function public.get_columns(schema_name text, tbl_name text)
returns table(column_name text)
language sql
stable
as $$
  select c.column_name::text
  from information_schema.columns c
  where c.table_schema = schema_name
    and c.table_name = tbl_name;
$$;

grant execute on function public.get_columns(text, text) to authenticated, service_role;

create or replace function public.list_public_tables()
returns table(table_name text)
language sql
stable
as $$
  select t.table_name::text
  from information_schema.tables t
  where t.table_schema = 'public'
    and t.table_type = 'BASE TABLE';
$$;

grant execute on function public.list_public_tables() to authenticated, service_role;

create or replace function public.import_chats_from_table(
  src_table     text,
  target_bpid   text,
  col_wa_id     text,
  col_direction text,
  col_type      text,
  col_content   text,
  col_media_url text,
  col_timestamp text,
  has_type      boolean default false,
  has_media_url boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  inserted_contacts int := 0;
  inserted_messages int := 0;
  skipped_messages  int := 0;
  total_in_source   int := 0;
begin
  -- Large archives (2M+ rows) run past the default 8s PostgREST
  -- statement timeout. Disable it for the duration of this function
  -- — the inserts are bulk anyway, and the operator's UI is willing
  -- to wait. Reset on function exit happens automatically.
  perform set_config('statement_timeout', '0', true);
  -- Step 1: distinct contacts. wa_id digits-only, range 7..14 to keep
  -- WhatsApp LIDs / garbage out.
  execute format(
    $f$
    with src as (
      select distinct
        regexp_replace(%I::text, '\D', '', 'g') as wa_id
      from public.%I
      where %I is not null
    )
    insert into public.contacts (wa_id, business_phone_number_id, status, imported)
    select wa_id, %L, 'open', true
    from src
    where length(wa_id) between 7 and 14
    on conflict (wa_id, business_phone_number_id) do nothing
    $f$,
    col_wa_id, src_table, col_wa_id, target_bpid
  );
  get diagnostics inserted_contacts = row_count;

  -- Step 2: messages. Synthetic wa_message_id ('import:<sha>') guards
  -- against duplicates on re-run via the wa_message_id unique index.
  -- Type / media_url are optional — we substitute 'text' / NULL when
  -- the source doesn't have those columns.
  execute format(
    $f$
    insert into public.messages (
      contact_id, wa_message_id, direction, type, content, media_url,
      status, timestamp, business_phone_number_id
    )
    select
      c.id,
      'import:' || encode(
        digest(c.id::text || '|' || s.%I::text || '|' || s.%I::text || '|' || coalesce(s.%I, ''), 'sha256'),
        'hex'
      ),
      s.%I,
      %s,
      s.%I,
      %s,
      'delivered',
      s.%I,
      %L
    from public.%I s
    join public.contacts c
      on c.wa_id = regexp_replace(s.%I::text, '\D', '', 'g')
     and c.business_phone_number_id = %L
    where s.%I is not null
      and length(regexp_replace(s.%I::text, '\D', '', 'g')) between 7 and 14
    on conflict (wa_message_id) do nothing
    $f$,
    col_timestamp, col_direction, col_content,
    col_direction,
    case when has_type then format('coalesce(s.%I, %L)', col_type, 'text') else quote_literal('text') end,
    col_content,
    case when has_media_url then format('s.%I', col_media_url) else 'NULL' end,
    col_timestamp,
    target_bpid,
    src_table,
    col_wa_id,
    target_bpid,
    col_wa_id,
    col_wa_id
  );
  get diagnostics inserted_messages = row_count;

  -- Step 3: count source rows for the "skipped" delta.
  execute format('select count(*) from public.%I', src_table) into total_in_source;
  skipped_messages := greatest(0, coalesce(total_in_source, 0) - inserted_messages);

  -- Step 4: refresh contact last_message_* for target number.
  update public.contacts c
  set last_message_at      = sub.ts,
      last_message_preview = left(coalesce(sub.content, ''), 120),
      last_message_direction = sub.direction,
      last_message_status    = sub.status
  from (
    select distinct on (contact_id)
      contact_id, timestamp as ts, content, direction, status
    from public.messages
    where business_phone_number_id = target_bpid
    order by contact_id, timestamp desc
  ) sub
  where sub.contact_id = c.id
    and c.business_phone_number_id = target_bpid;

  return jsonb_build_object(
    'inserted_contacts', inserted_contacts,
    'inserted_messages', inserted_messages,
    'skipped_messages',  skipped_messages
  );
end$$;

grant execute on function public.import_chats_from_table(
  text, text, text, text, text, text, text, text, boolean, boolean
) to authenticated, service_role;

-- pgcrypto for digest() — already enabled in most Supabase projects,
-- but harmless if re-enabled.
create extension if not exists pgcrypto;
-- =====================================================================
-- 0071 — refund_requests
-- ---------------------------------------------------------------------
-- Operator-submitted refund requests, raised from the contact-details
-- panel. The form pre-fills agent + patient + lead from session/LSQ and
-- the operator types in the package + amount fields (which live in
-- LSQ as AI-summary text today, so they're freeform).
--
-- Each row references the chat (`contact_id`) so the admin queue can
-- jump straight back to the conversation. `payment_screenshot_url`
-- points at a Supabase Storage object uploaded at form-submit time.
-- =====================================================================

create table if not exists public.refund_requests (
  id                        uuid primary key default gen_random_uuid(),

  -- Who raised the request + which chat it came from
  contact_id                uuid not null references public.contacts(id) on delete cascade,
  requested_by_user_id      uuid references auth.users(id) on delete set null,
  requested_by_email        text,            -- cached agent email for display
  requested_by_name         text,            -- cached agent display name

  -- Patient / lead identifiers (auto-filled from LSQ at form-fill time
  -- but stored on the row so a later LSQ change doesn't rewrite history)
  lsq_lead_number           text,            -- "#432029"
  lsq_prospect_id           text,            -- LSQ ProspectAutoId
  patient_name              text,

  -- Package fields (typed by operator from the AI Package-Shared summary)
  booking_date              date,
  per_graft_rate            numeric(10, 2),  -- ₹ per graft
  estimated_grafts          integer,
  booking_amount            numeric(12, 2),
  refundable_amount         numeric(12, 2),

  -- Reason (dropdown choice + optional free-text "Other" detail)
  reason_code               text not null,
  reason_other              text,

  -- Supporting evidence — uploaded at submit time to Supabase Storage
  payment_screenshot_url    text,
  payment_screenshot_path   text,            -- bucket path for delete-on-undo

  -- Admin workflow
  status                    text not null default 'pending'
                              check (status in ('pending','approved','rejected','paid','cancelled')),
  admin_notes               text,
  processed_by_user_id      uuid references auth.users(id) on delete set null,
  processed_by_email        text,
  processed_at              timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists refund_requests_contact_id_idx
  on public.refund_requests (contact_id);
create index if not exists refund_requests_status_created_idx
  on public.refund_requests (status, created_at desc);
create index if not exists refund_requests_lead_number_idx
  on public.refund_requests (lsq_lead_number)
  where lsq_lead_number is not null;

-- Updated-at trigger
create or replace function public.refund_requests_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists refund_requests_set_updated_at on public.refund_requests;
create trigger refund_requests_set_updated_at
  before update on public.refund_requests
  for each row execute function public.refund_requests_set_updated_at();

-- RLS — same model as the rest of the dashboard: authenticated users
-- can read + create; admin role gates write of admin workflow fields
-- at the API layer (this table doesn't have its own role model).
alter table public.refund_requests enable row level security;

drop policy if exists "auth read refund_requests" on public.refund_requests;
create policy "auth read refund_requests"
  on public.refund_requests for select
  to authenticated
  using (true);

drop policy if exists "auth insert refund_requests" on public.refund_requests;
create policy "auth insert refund_requests"
  on public.refund_requests for insert
  to authenticated
  with check (true);

drop policy if exists "auth update refund_requests" on public.refund_requests;
create policy "auth update refund_requests"
  on public.refund_requests for update
  to authenticated
  using (true)
  with check (true);

grant select, insert, update on public.refund_requests to authenticated;
-- =====================================================================
-- 0072 — Per-business-number quick replies
-- ---------------------------------------------------------------------
-- Quick replies used to be global across the workspace. We now scope
-- each row to a list of business phone numbers — empty array means
-- "all numbers" (the prior behaviour, preserved for existing rows).
--
-- The old `(shortcut)` UNIQUE index becomes invalid once two numbers
-- can each have their own "/hours" snippet. Drop it; the API is the
-- one enforcing uniqueness within the per-number scope.
-- =====================================================================

alter table public.quick_replies
  add column if not exists business_phone_number_ids text[] not null default '{}';

-- Drop the old single-column shortcut uniqueness. Two numbers' snippets
-- routinely collide (e.g. /hours for both clinic numbers) — operator
-- picks which numbers a snippet covers when creating it.
drop index if exists quick_replies_shortcut_uidx;

-- Fast-path filter: contains-any on business_phone_number_ids. Used by
-- the GET endpoint to scope the list to the active number tab.
create index if not exists quick_replies_bpids_gin
  on public.quick_replies using gin (business_phone_number_ids);
-- Scope payment_accounts per clinic (American Hairline, Alchemane, …).
--
-- Up to this migration every account was workspace-global — exactly
-- one row could be `is_active = true` across the whole table. Now that
-- the composer's clinic chooser supports American Hairline + Alchemane, each clinic
-- needs its own active Razorpay / PayU binding.
--
--   clinic       — 'americanhairline' | 'alchemane'. NOT NULL, defaults to 'americanhairline' so
--                  every existing row backfills cleanly.
--   active scope — replaces the workspace-global partial unique index
--                  with one scoped to (clinic) so each clinic can have
--                  its own active winner independently.

alter table public.payment_accounts
  add column if not exists clinic text;

update public.payment_accounts
  set clinic = 'americanhairline'
  where clinic is null;

alter table public.payment_accounts
  alter column clinic set not null,
  alter column clinic set default 'americanhairline';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payment_accounts_clinic_check'
  ) then
    alter table public.payment_accounts
      add constraint payment_accounts_clinic_check
        check (clinic in ('americanhairline', 'alchemane'));
  end if;
end$$;

create index if not exists payment_accounts_clinic_idx
  on public.payment_accounts(clinic);

-- Replace the workspace-global one-active index with a per-clinic one.
drop index if exists payment_accounts_one_active;

create unique index if not exists payment_accounts_one_active_per_clinic
  on public.payment_accounts(clinic)
  where is_active = true;
-- Ozonetel CloudAgent click-to-call wiring.
--
-- Two pieces of config:
--   1. ozonetel_settings — one workspace-wide account (CloudAgent
--      userName + apiKey + the campaign every dial runs through + the
--      API data-centre base URL). Exactly ONE row may be is_active so
--      the dial route can resolve it without an id. Mirrors the
--      payment_accounts "one active" pattern.
--   2. per-agent binding on team_members — each operator has their own
--      CloudAgent agentID and the phone (or WebRTC SIP id) calls land
--      on. AgentManualDial needs the agentID of whoever clicked.

create table if not exists public.ozonetel_settings (
  id            uuid primary key default gen_random_uuid(),
  -- API data-centre base, e.g. https://in1-ccaas-api.ozonetel.com
  base_url      text not null default 'https://in1-ccaas-api.ozonetel.com',
  user_name     text not null,
  api_key       text not null,
  -- The CloudAgent campaign every manual dial is placed through.
  campaign_name text not null,
  is_active     boolean not null default true,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- At most one active account workspace-wide.
create unique index if not exists ozonetel_settings_one_active
  on public.ozonetel_settings(is_active)
  where is_active = true;

-- Per-operator CloudAgent identity. NULL = operator hasn't been wired
-- for Ozonetel yet; the dial route blocks with a clear message.
alter table public.team_members
  add column if not exists ozonetel_agent_id text,
  add column if not exists ozonetel_phone text;
-- =====================================================================
-- 0074 — Interakt (WhatsApp BSP) provider
-- ---------------------------------------------------------------------
-- A second, parallel inbound/outbound routing alongside Meta + Evolution.
-- Interakt POSTs every event to our /api/interakt/webhook/<secret> route;
-- we ingest into the SAME contacts / messages tables so the existing
-- inbox renders Interakt chats with zero UI changes.
--
-- Nothing here touches the Meta or Evolution code paths — additive only:
--   • widen business_numbers.provider to allow 'interakt'
--   • per-number Interakt API key (nullable; falls back to the
--     workspace-level key in app_settings)
-- The webhook secret + default API key live in app_settings
-- ('interakt_webhook_secret', 'interakt_api_key').
-- =====================================================================

-- Widen the provider CHECK (originally meta|evolution from 0039).
ALTER TABLE public.business_numbers
  DROP CONSTRAINT IF EXISTS business_numbers_provider_check;
ALTER TABLE public.business_numbers
  ADD CONSTRAINT business_numbers_provider_check
  CHECK (provider IN ('meta', 'evolution', 'interakt'));

-- Optional per-number Interakt API key. NULL ⇒ use the workspace-level
-- key stored in app_settings('interakt_api_key').
ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS interakt_api_key text;
-- Tata Tele (Smartflo) click-to-call wiring. Mirrors the Ozonetel
-- shape from 0074.
--
--   tatatele_settings — one workspace-wide account: the Smartflo API
--     token (used raw as the Authorization header), the caller_id /
--     pilot DID shown to the customer, and the API base host.
--   per-agent binding — team_members.tatatele_agent_number is the
--     Smartflo agent the call rings first before bridging the customer.

create table if not exists public.tatatele_settings (
  id          uuid primary key default gen_random_uuid(),
  base_url    text not null default 'https://api-smartflo.tatateleservices.com',
  -- Smartflo portal API token. Sent verbatim as `Authorization: <token>`.
  api_token   text not null,
  -- DID / pilot number shown to the customer as the caller ID.
  caller_id   text not null,
  is_active   boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists tatatele_settings_one_active
  on public.tatatele_settings(is_active)
  where is_active = true;

alter table public.team_members
  add column if not exists tatatele_agent_number text;
-- =====================================================================
-- 0076 — Interakt: multiple numbers (per-number webhook secret)
-- ---------------------------------------------------------------------
-- Each Interakt account = one business_numbers row (provider='interakt')
-- carrying its OWN api key (0074) + webhook secret. Interakt's webhook
-- payload only contains the customer number, so the secret in the
-- /api/interakt/webhook/<secret> URL is what identifies which number an
-- event belongs to.
-- =====================================================================

ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS interakt_webhook_secret text;

CREATE UNIQUE INDEX IF NOT EXISTS business_numbers_interakt_secret_uidx
  ON public.business_numbers(interakt_webhook_secret)
  WHERE interakt_webhook_secret IS NOT NULL;

-- NOTE: the single-number remap/guard triggers (added live during the
-- old-code transition) must be dropped once this multi-number code is
-- deployed — they force every Interakt event onto one number:
--   DROP TRIGGER IF EXISTS remap_interakt_bpid_contacts ON public.contacts;
--   DROP TRIGGER IF EXISTS remap_interakt_bpid_messages ON public.messages;
--   DROP TRIGGER IF EXISTS guard_interakt_business_number ON public.business_numbers;
-- =====================================================================
-- 0077 — Campaign UTM attribution on contacts
-- ---------------------------------------------------------------------
-- When a campaign's wa.me?text=... link carries utm_* / source_id in the
-- pre-filled message, the lead's FIRST inbound arrives with that marker.
-- The webhook parses it (lib/utm.ts) and stamps it here, once — the
-- first-touch source is preserved (we never overwrite a set utm_source).
--
--   • utm_source — best-effort single label for display/filtering
--   • utm_params — the full parsed bag (utm_medium, utm_campaign,
--                  source_id, ref, etc.) for LSQ push / reporting
-- =====================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS utm_params jsonb;
-- =====================================================================
-- 0077 — Trigger flows (rule-based automation) — Phase 1 schema
-- ---------------------------------------------------------------------
-- A per-number flow: an inbound keyword (or schedule / external webhook)
-- fires an ordered chain of action nodes (send message, assign, tag,
-- condition branch, webhook, delay, …). Phase 1 runs nodes linearly via
-- next_node_id; Phase 2's visual canvas reuses the same tables + edges.
-- =====================================================================

-- 1) Flows --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trigger_flows (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_phone_number_id  text NOT NULL
                              REFERENCES public.business_numbers(phone_number_id) ON DELETE CASCADE,
  name                      text NOT NULL,
  enabled                   boolean NOT NULL DEFAULT false,
  trigger_type              text NOT NULL DEFAULT 'keyword'
                              CHECK (trigger_type IN ('keyword', 'schedule', 'webhook')),
  -- keyword:  { phrases: [..], match: 'exact'|'contains'|'starts' }
  -- schedule: { time: 'HH:MM', days: [..] }  webhook: { secret: '..' }
  trigger_config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Lower number = checked first when several flows could match.
  priority                  int NOT NULL DEFAULT 100,
  -- Entry node of the flow's chain.
  start_node_id             uuid,
  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trigger_flows_number_idx
  ON public.trigger_flows(business_phone_number_id, enabled);
-- Webhook-trigger lookup by secret.
CREATE UNIQUE INDEX IF NOT EXISTS trigger_flows_webhook_secret_uidx
  ON public.trigger_flows((trigger_config->>'secret'))
  WHERE trigger_type = 'webhook' AND (trigger_config->>'secret') IS NOT NULL;

DROP TRIGGER IF EXISTS trigger_flows_set_updated_at ON public.trigger_flows;
CREATE TRIGGER trigger_flows_set_updated_at
  BEFORE UPDATE ON public.trigger_flows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2) Nodes (steps) ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trigger_nodes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id      uuid NOT NULL REFERENCES public.trigger_flows(id) ON DELETE CASCADE,
  node_type    text NOT NULL,   -- message_text | message_buttons | message_image | message_video
                                -- | message_list | message_carousel | wa_form | condition | webhook
                                -- | update_field_tag | assign_agent | payment_link
                                -- | conversion_event | clear_variable | calculate | delay
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Linear chaining (Phase 1). condition nodes use trigger_edges for branches.
  next_node_id uuid,
  -- Canvas coords (Phase 2).
  position     jsonb,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trigger_nodes_flow_idx
  ON public.trigger_nodes(flow_id, sort_order);

-- 3) Edges (branching — Phase 2) ---------------------------------------
CREATE TABLE IF NOT EXISTS public.trigger_edges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id      uuid NOT NULL REFERENCES public.trigger_flows(id) ON DELETE CASCADE,
  from_node_id uuid NOT NULL REFERENCES public.trigger_nodes(id) ON DELETE CASCADE,
  to_node_id   uuid NOT NULL REFERENCES public.trigger_nodes(id) ON DELETE CASCADE,
  -- e.g. condition branch label: 'true' | 'false' | a list/button option id.
  branch_label text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trigger_edges_from_idx
  ON public.trigger_edges(from_node_id);

-- 4) Runs (execution log) ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.trigger_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id         uuid NOT NULL REFERENCES public.trigger_flows(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'stopped')),
  current_node_id uuid,
  -- For delay / wait-for-reply nodes — when the worker should resume.
  resume_at       timestamptz,
  error_message   text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trigger_runs_flow_idx
  ON public.trigger_runs(flow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS trigger_runs_resume_idx
  ON public.trigger_runs(status, resume_at) WHERE status = 'waiting';

DROP TRIGGER IF EXISTS trigger_runs_set_updated_at ON public.trigger_runs;
CREATE TRIGGER trigger_runs_set_updated_at
  BEFORE UPDATE ON public.trigger_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5) Per-run variables (Update Field / Calculate / Clear Variable) ------
CREATE TABLE IF NOT EXISTS public.trigger_run_vars (
  run_id     uuid NOT NULL REFERENCES public.trigger_runs(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, key)
);

-- 6) RLS — active members read; writes via service role (worker/API) ----
ALTER TABLE public.trigger_flows    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trigger_nodes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trigger_edges    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trigger_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trigger_run_vars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trigger_flows_select ON public.trigger_flows;
CREATE POLICY trigger_flows_select ON public.trigger_flows
  FOR SELECT TO authenticated USING (public.current_member_is_active());
DROP POLICY IF EXISTS trigger_nodes_select ON public.trigger_nodes;
CREATE POLICY trigger_nodes_select ON public.trigger_nodes
  FOR SELECT TO authenticated USING (public.current_member_is_active());
DROP POLICY IF EXISTS trigger_edges_select ON public.trigger_edges;
CREATE POLICY trigger_edges_select ON public.trigger_edges
  FOR SELECT TO authenticated USING (public.current_member_is_active());
DROP POLICY IF EXISTS trigger_runs_select ON public.trigger_runs;
CREATE POLICY trigger_runs_select ON public.trigger_runs
  FOR SELECT TO authenticated USING (public.current_member_is_active());
-- =====================================================================
-- 0078 — Trigger flows: add 'template_reply' trigger type
-- ---------------------------------------------------------------------
-- Fires when a patient replies right after a template was sent to them.
-- trigger_config: { template_name?: '<name>' }  (blank = any template)
-- =====================================================================

ALTER TABLE public.trigger_flows DROP CONSTRAINT IF EXISTS trigger_flows_trigger_type_check;
ALTER TABLE public.trigger_flows
  ADD CONSTRAINT trigger_flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'schedule', 'webhook', 'template_reply'));
-- =====================================================================
-- 0080 — Hot-path performance indexes
-- ---------------------------------------------------------------------
-- Three seq-scans verified missing in the perf audit, each on a path that
-- runs on every inbound webhook or every inbox mount:
--
--   1. campaign_recipients — the per-inbound "did this number reply to a
--      recent campaign?" lookup filters on wa_id alone, but the only
--      index touching wa_id is the composite (campaign_id, wa_id), useless
--      for a wa_id-only scan. (webhook/route.ts)
--   2. messages — the auto-close "most-recent inbound" sweep filters
--      direction='inbound' ordered by timestamp over 3.8M rows; the only
--      messages index is (contact_id, timestamp). (actions.ts)
--   3. contacts — stage-counts groups by lsq_stage per business number;
--      no lsq_stage index exists.
--
-- NOTE: the messages index touches a 3.8M-row table. Run during low
-- traffic, or create it with CREATE INDEX CONCURRENTLY (outside a
-- transaction) to avoid briefly locking writes while it builds.
-- =====================================================================

CREATE INDEX IF NOT EXISTS campaign_recipients_wa_id_sent_at_idx
  ON public.campaign_recipients (wa_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_inbound_timestamp
  ON public.messages (timestamp DESC)
  WHERE direction = 'inbound';

CREATE INDEX IF NOT EXISTS idx_contacts_bpid_lsq_stage
  ON public.contacts (business_phone_number_id, lsq_stage);
-- =====================================================================
-- 0081 — get_stage_counts RPC (replaces the 136-round-trip JS paginator)
-- ---------------------------------------------------------------------
-- /api/lsq/stage-counts was looping `range(from, from+999)` over the whole
-- contacts table (135k+ rows = ~136 sequential round-trips, every 30s, from
-- two pollers) and tallying lsq_stage in JS — the "data calculation" stall.
--
-- This does it in ONE indexed GROUP BY. allowed_bpids NULL = owner (no
-- number filter); hidden_bpids excludes numbers toggled off in the UI.
-- Pairs with the contacts(business_phone_number_id, lsq_stage) index (0080)
-- for an index scan on the scoped case. Runs SECURITY INVOKER so contacts
-- RLS still applies.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_stage_counts(
  allowed_bpids text[] DEFAULT NULL,
  hidden_bpids  text[] DEFAULT '{}'
)
RETURNS TABLE(lsq_stage text, cnt bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT c.lsq_stage, count(*)::bigint AS cnt
  FROM public.contacts c
  WHERE (allowed_bpids IS NULL OR c.business_phone_number_id = ANY(allowed_bpids))
    AND NOT (c.business_phone_number_id = ANY(hidden_bpids))
  GROUP BY c.lsq_stage;
$$;
-- Agent-productivity reports were pulling EVERY outbound + inbound message
-- for the date range into Node in 1000-row pages (see app/api/reports/agents
-- fetchAll) and grouping in JS — on a busy 30-day window that's 100k+ rows
-- across 100+ sequential round-trips, which made the Reports page hang.
--
-- This RPC does all of it in one DB call: per-agent outbound rollup, per-agent
-- call rollup, per-day inbound/outbound, and inbound totals (distinct patients).
-- The route then only does scoring + label joins in JS over ~tens of rows.
--
-- p_bpids = NULL  -> all numbers (owner/superadmin). Otherwise restrict.
-- p_since / p_until = NULL -> open-ended (range='all').

create or replace function public.get_agent_reports(
  p_since  timestamptz,
  p_until  timestamptz,
  p_bpids  text[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with out_msgs as (
    select
      sent_by_email                                                            as email,
      count(*) filter (where type = 'text')                                    as text_replies,
      count(*) filter (where type = 'template')                                as template_sends,
      count(*) filter (where type = 'template' and template_name = 'magic_message')
                                                                               as magic_messages
    from messages
    where direction = 'outbound'
      and sent_by_email is not null
      and (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by sent_by_email
  ),
  call_stats as (
    select
      handled_by_email                       as email,
      count(*)                               as calls_handled,
      coalesce(sum(duration_seconds), 0)     as talk_time_seconds
    from whatsapp_calls
    where handled_by_email is not null
      and (p_since is null or start_at >= p_since)
      and (p_until is null or start_at <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by handled_by_email
  ),
  daily as (
    select
      to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')                       as day,
      count(*) filter (where direction = 'inbound')                             as patient_messages,
      count(*) filter (where direction = 'outbound')                            as outbound,
      count(distinct contact_id) filter (where direction = 'inbound')           as unique_patients
    from messages
    where (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by 1
  ),
  inbound_tot as (
    select
      count(*)                       as patient_messages,
      count(distinct contact_id)     as unique_patients
    from messages
    where direction = 'inbound'
      and (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
  )
  select jsonb_build_object(
    'outbound',       coalesce((select jsonb_agg(to_jsonb(o)) from out_msgs o), '[]'::jsonb),
    'calls',          coalesce((select jsonb_agg(to_jsonb(c)) from call_stats c), '[]'::jsonb),
    'daily',          coalesce((select jsonb_agg(to_jsonb(d) order by d.day desc) from daily d), '[]'::jsonb),
    'inbound_totals', coalesce((select to_jsonb(t) from inbound_tot t),
                               jsonb_build_object('patient_messages', 0, 'unique_patients', 0))
  );
$$;

grant execute on function public.get_agent_reports(timestamptz, timestamptz, text[])
  to anon, authenticated, service_role;
-- get_agent_reports (0082) removed the 100-round-trip fan-out, but for the
-- owner viewing ALL numbers it still scanned ~122k outbound rows in 8.4 s —
-- because sent_by_email / type / template_name / contact_id live only in the
-- heap, so every matched row needed a random heap fetch.
--
-- Fix: covering PARTIAL indexes that carry those columns in the index payload,
-- so the per-agent + per-day rollups become index-only scans. Plus rewrite the
-- daily CTE into direction-split sub-queries so each side can use its partial
-- index (a single all-direction scan can't use a partial index).
--
-- NOTE: messages is the largest table — create these with CREATE INDEX
-- CONCURRENTLY (run each statement on its own, outside a transaction). The
-- plain messages_timestamp_idx added during debugging is unused (the planner
-- never picks it) and is dropped here.

drop index concurrently if exists public.messages_timestamp_idx;

create index concurrently if not exists messages_rep_outbound_idx
  on public.messages (timestamp)
  include (sent_by_email, type, template_name)
  where direction = 'outbound';

create index concurrently if not exists messages_rep_inbound_idx
  on public.messages (timestamp)
  include (contact_id)
  where direction = 'inbound';

create or replace function public.get_agent_reports(
  p_since  timestamptz,
  p_until  timestamptz,
  p_bpids  text[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with out_msgs as (
    select
      sent_by_email                                                            as email,
      count(*) filter (where type = 'text')                                    as text_replies,
      count(*) filter (where type = 'template')                                as template_sends,
      count(*) filter (where type = 'template' and template_name = 'magic_message')
                                                                               as magic_messages
    from messages
    where direction = 'outbound'
      and sent_by_email is not null
      and (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by sent_by_email
  ),
  call_stats as (
    select
      handled_by_email                   as email,
      count(*)                           as calls_handled,
      coalesce(sum(duration_seconds), 0) as talk_time_seconds
    from whatsapp_calls
    where handled_by_email is not null
      and (p_since is null or start_at >= p_since)
      and (p_until is null or start_at <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by handled_by_email
  ),
  daily_in as (
    select
      to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') as day,
      count(*)                                            as patient_messages,
      count(distinct contact_id)                          as unique_patients
    from messages
    where direction = 'inbound'
      and (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by 1
  ),
  daily_out as (
    select
      to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') as day,
      count(*)                                            as outbound
    from messages
    where direction = 'outbound'
      and (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by 1
  ),
  daily as (
    select
      coalesce(i.day, o.day)               as day,
      coalesce(i.patient_messages, 0)      as patient_messages,
      coalesce(o.outbound, 0)              as outbound,
      coalesce(i.unique_patients, 0)       as unique_patients
    from daily_in i
    full join daily_out o on i.day = o.day
  ),
  inbound_tot as (
    select
      count(*)                   as patient_messages,
      count(distinct contact_id) as unique_patients
    from messages
    where direction = 'inbound'
      and (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
  )
  select jsonb_build_object(
    'outbound',       coalesce((select jsonb_agg(to_jsonb(o)) from out_msgs o), '[]'::jsonb),
    'calls',          coalesce((select jsonb_agg(to_jsonb(c)) from call_stats c), '[]'::jsonb),
    'daily',          coalesce((select jsonb_agg(to_jsonb(d) order by d.day desc) from daily d), '[]'::jsonb),
    'inbound_totals', coalesce((select to_jsonb(t) from inbound_tot t),
                               jsonb_build_object('patient_messages', 0, 'unique_patients', 0))
  );
$$;

grant execute on function public.get_agent_reports(timestamptz, timestamptz, text[])
  to anon, authenticated, service_role;
-- Atomic unread bump. The webhooks were doing SELECT unread_count -> +1 ->
-- UPDATE, which loses an increment whenever two inbound messages for the same
-- contact race between the read and the write. One atomic statement fixes it.

create or replace function public.bump_unread(p_contact_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.contacts
     set unread_count = coalesce(unread_count, 0) + 1
   where id = p_contact_id;
$$;

grant execute on function public.bump_unread(uuid) to anon, authenticated, service_role;
-- Calendar booking / "Date Align" feature.
--   • Agent opens a contact → picks an available date directly, OR shares a
--     public link (/book/<token>) so the patient picks one themselves.
--   • Availability is read from the clinic's Google Calendar (all-day
--     holiday/closed events block a day) + a per-day capacity enforced here.
--   • On confirm: a Google Calendar event is created, the date is pushed to
--     LSQ, and an approved WhatsApp template is sent to the patient.
--
-- Google creds, capacity, booking window, template name and the LSQ
-- field/stage all live in app_settings (see lib/bookings) so they can be
-- configured without a migration.

create table if not exists public.bookings (
  id                        uuid primary key default gen_random_uuid(),
  -- Opaque public-link token. The patient opens /book/<token>.
  token                     text not null unique,
  contact_id                uuid references public.contacts(id) on delete cascade,
  business_phone_number_id  text,
  wa_id                     text,
  patient_name              text,
  -- NULL until a date is actually chosen.
  booking_date              date,
  status                    text not null default 'pending'
                              check (status in ('pending','confirmed','cancelled','expired')),
  -- Who chose the date — the agent (aligned directly) or the patient (link).
  source                    text check (source in ('agent','patient')),
  created_by_user_id        uuid,
  created_by_email          text,
  -- Google Calendar event id, once the event is written.
  gcal_event_id             text,
  lsq_synced                boolean not null default false,
  confirmed_at              timestamptz,
  -- Pending link expiry (e.g. 7 days) so stale links don't linger.
  expires_at                timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists bookings_contact_idx on public.bookings (contact_id, created_at desc);
-- Per-day capacity counting reads confirmed bookings by date.
create index if not exists bookings_date_idx
  on public.bookings (booking_date) where status = 'confirmed';
create index if not exists bookings_status_idx on public.bookings (status, created_at desc);
-- Permission flag for the "Date Align" composer action (booking links + setting
-- a patient's date). Default ON for owner/superadmin/admin, OFF for teammate —
-- admins grant it to specific teammates via the per-member override.

alter table public.role_permissions
  add column if not exists can_align_dates boolean not null default true;
update public.role_permissions set can_align_dates = false where role = 'teammate';

-- Team + member overrides: nullable = inherit.
alter table public.team_permissions
  add column if not exists can_align_dates boolean;
alter table public.team_member_permissions
  add column if not exists can_align_dates boolean;
-- The "assigned-only inbox" visibility filter matched contacts.lsq_owner_email
-- against the agent's (lower-cased) auth email with a case-SENSITIVE compare,
-- but lsq_owner_email was stored verbatim from LSQ's OwnerIdEmailAddress (often
-- mixed-case) — so agents saw zero chats on their assigned-only numbers.
--
-- Normalise existing data to lower(trim()). Going forward the writers also
-- normalise (see lib/lsq, lib/lsq-webhook, lib/lsq-owner-sync, the webhook and
-- backfill routes), and the read filter lower-cases the email.

update public.contacts
   set lsq_owner_email = lower(trim(lsq_owner_email))
 where lsq_owner_email is not null
   and lsq_owner_email <> lower(trim(lsq_owner_email));
-- 0088_rls_hardening.sql
-- Security audit remediation (see SECURITY_AUDIT.md — C2, C3, H2).
--
-- Closes direct public-anon-key access to sensitive tables via PostgREST.
-- The app writes everything through the service role (which BYPASSES RLS),
-- and the dashboard reads some tables directly with the anon key + the
-- logged-in user's JWT (role = 'authenticated'). So the pattern below is:
--   * enable RLS                                  -> blocks the anon role
--   * add a SELECT policy "to authenticated"      -> keeps dashboard reads
--   * add NO insert/update/delete policy          -> writes stay service-role
-- This is non-breaking: anon (no login) is denied; logged-in reads keep
-- working; all writes continue through the server.
--
-- Run in the Supabase SQL editor (project qflroespjasgcnsidpcj). Idempotent.

-- ---------------------------------------------------------------------------
-- C2 — 11 tables that never enabled RLS (were anon-readable AND anon-writable)
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'automation_configs',
    'automation_logs',
    'bookings',
    'whatsapp_calls',
    'whatsapp_call_permissions',
    'quick_replies',
    'api_request_log',
    'evolution_disconnects',
    'evolution_status_posts',
    'ozonetel_settings',
    'tatatele_settings'
  ];
begin
  foreach t in array tables loop
    -- Skip any table that doesn't exist in this database (defensive).
    if to_regclass('public.' || t) is null then
      raise notice 'skip: table public.% does not exist', t;
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_select_authenticated', t
    );
    raise notice 'RLS enabled + authenticated SELECT policy on public.%', t;
  end loop;
end$$;

-- NOTE: tables that are purely server-mediated (api_request_log,
-- automation_logs, evolution_disconnects, evolution_status_posts,
-- ozonetel_settings, tatatele_settings, whatsapp_call_permissions) do not
-- actually need the authenticated SELECT policy — they can be tightened to
-- service-role-only by dropping their *_select_authenticated policy once you
-- confirm nothing in the dashboard reads them directly with the anon key.

-- ---------------------------------------------------------------------------
-- C3 — payments: replace FOR ALL/using(true) with read-only for authenticated.
-- Any authenticated user could previously INSERT/UPDATE/DELETE every payment
-- straight through PostgREST. Writes must go through the server (service role).
-- ---------------------------------------------------------------------------
drop policy if exists payments_all_authenticated on public.payments;
drop policy if exists payments_select_authenticated on public.payments;
create policy payments_select_authenticated
  on public.payments
  for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- H2 — api_tokens: plaintext bearer tokens were readable by ANY authenticated
-- user. Restrict reads to admin/superadmin/owner. (Writes already go through
-- admin-gated API routes using the service role.)
-- ---------------------------------------------------------------------------
drop policy if exists "api_tokens read for authenticated" on public.api_tokens;
drop policy if exists api_tokens_admin_read on public.api_tokens;
create policy api_tokens_admin_read
  on public.api_tokens
  for select
  to authenticated
  using (public.current_member_role() in ('owner', 'superadmin', 'admin'));

-- ---------------------------------------------------------------------------
-- Verify (optional): each should return 'true' for relrowsecurity.
--   select relname, relrowsecurity from pg_class
--    where relname in ('payments','api_tokens','bookings','whatsapp_calls',
--      'automation_configs','automation_logs','quick_replies','api_request_log',
--      'evolution_disconnects','evolution_status_posts','ozonetel_settings',
--      'tatatele_settings','whatsapp_call_permissions');
-- ---------------------------------------------------------------------------
-- 0089_protect_business_number_secrets.sql
-- Defense-in-depth for the provider secrets stored on business_numbers:
--   evolution_api_key, interakt_api_key, interakt_webhook_secret
--
-- Even with RLS, a logged-in user could `select evolution_api_key from
-- business_numbers` over PostgREST (RLS is row-level, not column-level) and
-- harvest every instance key. A plain column REVOKE is a no-op while a
-- table-level SELECT grant exists, so we revoke the table grant and re-grant
-- SELECT on only the NON-secret columns.
--
-- Safe / non-breaking: the app reads the secret columns exclusively via the
-- service role (which these grants don't touch). The only authenticated-role
-- readers of this table are the dashboard page and the home-stats query, and
-- both select a subset of the columns granted below.
--
-- Run in the Supabase SQL editor (project qflroespjasgcnsidpcj).
-- Reversible with:  grant select on public.business_numbers to authenticated;

revoke select on public.business_numbers from anon, authenticated;

grant select (
  phone_number_id,
  display_phone_number,
  verified_name,
  nickname,
  memo,
  is_active,
  created_at,
  meta_status,
  meta_checked_at,
  waba_id,
  provider,
  evolution_instance_name,
  evolution_jid,
  evolution_connection_state,
  evolution_group_id,
  profile_pic_url
) on public.business_numbers to authenticated;

-- Verify (optional): should list ONLY the non-secret columns above, never
-- evolution_api_key / interakt_api_key / interakt_webhook_secret.
--   select grantee, column_name from information_schema.column_privileges
--    where table_name = 'business_numbers' and grantee = 'authenticated'
--    order by column_name;
-- 0090_lock_secret_tables_to_service_role.sql
-- Follow-up to the security audit. Three tables hold provider secrets and are
-- read by the app ONLY via the service role (verified: lib/payment-accounts.ts,
-- lib/ozonetel.ts, lib/tatatele.ts all use createServiceRoleClient; no client
-- or authenticated-context code reads them). Yet each still had a
-- `to authenticated using(true)` SELECT policy, so any logged-in user could
-- read the secrets directly over PostgREST:
--   * payment_accounts.credentials  -> Razorpay/PayU key_secret, salt, webhook_secret
--   * ozonetel_settings.api_key
--   * tatatele_settings.api_token
--
-- Dropping the authenticated SELECT policy leaves RLS enabled with NO policy,
-- which denies anon AND authenticated while the service role (BYPASSRLS) keeps
-- full access. Non-breaking. Reversible by recreating the dropped policy.
--
-- Run in the Supabase SQL editor (project qflroespjasgcnsidpcj).

-- Guarded so a table that doesn't exist in this DB (e.g. tatatele_settings was
-- never migrated) is skipped instead of aborting the whole batch.
do $$
begin
  if to_regclass('public.payment_accounts') is not null then
    execute 'drop policy if exists payment_accounts_authenticated_select on public.payment_accounts';
  end if;
  if to_regclass('public.ozonetel_settings') is not null then
    execute 'drop policy if exists ozonetel_settings_select_authenticated on public.ozonetel_settings';
  end if;
  if to_regclass('public.tatatele_settings') is not null then
    execute 'drop policy if exists tatatele_settings_select_authenticated on public.tatatele_settings';
  end if;
end$$;

-- Verify (optional): each should still report relrowsecurity = true and now
-- have zero authenticated/anon SELECT policies.
--   select tablename, policyname, roles from pg_policies
--    where tablename in ('payment_accounts','ozonetel_settings','tatatele_settings');
-- 0091_team_lead.sql
-- Per-team reporting: mark 1-2 members of a team as Team Lead (TL). A TL can
-- view the agent-productivity report for their OWN team (team_members.team_id)
-- and set those members' KRA (agent_targets_member). Owner/admin keep
-- workspace-wide access. Toggled by owner/admin in Team settings.

alter table public.team_members
  add column if not exists is_team_lead boolean not null default false;

-- Quick lookup of a team's leads.
create index if not exists team_members_team_lead_idx
  on public.team_members (team_id)
  where is_team_lead = true;
-- 0092_mask_source_subsource.sql
-- New permission: hide the lead's Source / Sub-source pills in Contact details.
-- Mirrors mask_phone_numbers / mask_emails. Default ON for teammates.

alter table public.role_permissions
  add column if not exists mask_source_subsource boolean not null default false;

-- Teammates get it ON by default (admins/superadmins/owner see everything).
update public.role_permissions
  set mask_source_subsource = true
  where role = 'teammate';

-- Per-member + per-team overrides: nullable = inherit the role default.
alter table public.team_member_permissions
  add column if not exists mask_source_subsource boolean;

alter table public.team_permissions
  add column if not exists mask_source_subsource boolean;
-- campaign_recipients.error_code was written by the campaign worker
-- (lib/campaigns.ts) and read by the Failure Breakdown UI, but the column
-- was never created — so EVERY failed send's "mark failed" update errored
-- out, leaving recipients stuck in 'sending' forever (the worker only
-- re-picks 'pending'). Add the column so failures record their Meta error
-- code (132012, 131026, …) and the breakdown can group by it.

alter table public.campaign_recipients
  add column if not exists error_code text;
-- The campaign worker / webhook write button_clicked, button_clicked_at and
-- reply_text onto campaign_recipients (for CTR + reply-text display), but the
-- columns were never created — so the "mark replied" update failed silently
-- and Replied count + CTR stayed at 0. Add them.
alter table public.campaign_recipients
  add column if not exists button_clicked     text,
  add column if not exists button_clicked_at  timestamptz,
  add column if not exists reply_text         text;
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
-- =====================================================================
-- 0096 — Drip trigger: match on any LSQ field (Brand / NDR / utm / Source)
-- ---------------------------------------------------------------------
-- A drip can now enroll on stage PLUS an exact value of any LSQ lead
-- field — e.g. trigger_field='mx_Brand', trigger_value='QHT' targets
-- hair-transplant leads (whose Source is "URoots" but Brand is "QHT").
-- trigger_field NULL = stage-only (old behaviour). trigger_source stays
-- for back-compat but new drips use trigger_field/value.
-- =====================================================================
ALTER TABLE public.drip_campaigns
  ADD COLUMN IF NOT EXISTS trigger_field text,   -- LSQ schema name, e.g. mx_Brand
  ADD COLUMN IF NOT EXISTS trigger_value text;   -- exact value (case-insensitive)
-- =====================================================================
-- 0097 — Drip multi-field trigger conditions
-- ---------------------------------------------------------------------
-- A drip can enroll on stage PLUS several LSQ field conditions, all of
-- which must match (AND). Stored as a JSON array:
--   [{"field":"mx_Brand","value":"QHT"},
--    {"field":"mx_NDR_Reason","value":"URoots"}]
-- An empty value matches "any non-empty". Supersedes the single
-- trigger_field/trigger_value (kept for back-compat).
-- =====================================================================
ALTER TABLE public.drip_campaigns
  ADD COLUMN IF NOT EXISTS trigger_conditions jsonb NOT NULL DEFAULT '[]'::jsonb;
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
-- =====================================================================
-- 0099 — Conversion values on contacts (for campaign LSQ conversions)
-- ---------------------------------------------------------------------
-- The campaign "LSQ conversions" card buckets recipients by their CURRENT
-- lsq_stage (kept fresh by the LSQ webhook) and shows a value. Storing the
-- value locally lets the card read ALL recipients cheaply (no per-lead LSQ
-- call) so it can auto-refresh. Filled from the webhook payload, or
-- backfilled by a bounded LSQ fetch when missing.
-- =====================================================================
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lsq_total_package numeric,   -- HT Done / Order Placed package value
  ADD COLUMN IF NOT EXISTS lsq_order_value   numeric,   -- Order Confirmed order value (Revenue)
  ADD COLUMN IF NOT EXISTS lsq_sales_notes   text;      -- package notes / review
-- =====================================================================
-- 0100 — Booking value on contacts (campaign "Booked" conversions)
-- ---------------------------------------------------------------------
-- The conversions card also shows WHO booked — any recipient with a
-- Booking Amount (mx_Booking_Amount) / Booking Date, regardless of stage.
-- Stored locally so the card reads all recipients cheaply + auto-syncs.
-- =====================================================================
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lsq_booking_amount numeric,
  ADD COLUMN IF NOT EXISTS lsq_booking_date   text;
-- 0101_remove_evolution_call_contacts.sql
--
-- Evolution call events are now DISABLED in the webhook (they created a
-- contact for every @lid / WhatsApp-privacy caller — non-real "numbers" that
-- cluttered the inbox). This one-off cleanup removes the rows those call
-- events already created:
--
--   1. Contacts that exist ONLY because of a call log (no real message) —
--      these are the weird call-only numbers. FK cascade drops their
--      messages / whatsapp_calls / payments automatically.
--   2. The leftover "📞 voice/video call" log rows on contacts that DID have
--      a real conversation (keep the contact, drop the noisy call rows).
--
-- Re-running is harmless (idempotent).

BEGIN;

-- 1. Drop contacts whose every message is an Evolution call log.
DELETE FROM public.contacts c
WHERE EXISTS (
  SELECT 1 FROM public.messages m
  WHERE m.contact_id = c.id
    AND m.wa_message_id LIKE 'evo-call-%'
)
AND NOT EXISTS (
  SELECT 1 FROM public.messages m
  WHERE m.contact_id = c.id
    AND (m.wa_message_id IS NULL OR m.wa_message_id NOT LIKE 'evo-call-%')
);

-- 2. Remove the remaining call-log rows (on contacts kept above).
DELETE FROM public.messages WHERE wa_message_id LIKE 'evo-call-%';

COMMIT;
-- =====================================================================
-- 0101 — Stage-based AI personas
-- ---------------------------------------------------------------------
-- A per-number map of { "<LSQ stage>": "<persona text>" }. At reply time
-- the engine appends the persona matching the contact's CURRENT lsq_stage
-- to the base system_prompt — so a Prospect lead gets the Prospect
-- scenario, an HT Done lead gets the HT Done scenario, etc. Empty / no
-- match → just the base persona (back-compat).
-- =====================================================================
ALTER TABLE public.automation_configs
  ADD COLUMN IF NOT EXISTS stage_personas jsonb NOT NULL DEFAULT '{}'::jsonb;
-- =====================================================================
-- 0102 — Lead Distribution
-- ---------------------------------------------------------------------
-- Round-robin-ish assignment of incoming LSQ leads to sales agents,
-- honouring working hours, region (national / international), per-agent
-- daily cap, priority, and weekly off. Config + agents managed from the
-- Lead Distribution page; the engine (Phase 2) runs in the webhook.
-- =====================================================================

-- Single config row (id = true so there's only ever one).
CREATE TABLE IF NOT EXISTS public.lead_distribution_config (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled             boolean NOT NULL DEFAULT false,
  webhook_secret      text,
  -- LSQ stages whose leads should be distributed (empty = all).
  stages              jsonb NOT NULL DEFAULT '[]'::jsonb,
  working_start       text NOT NULL DEFAULT '10:00',  -- IST HH:MM
  working_end         text NOT NULL DEFAULT '18:30',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Sales agents pool — mirrors the n8n `haridwar_sales_agents` table so the
-- existing agent data can be imported as-is. lsq_id = the LSQ user ID
-- (OwnerId target). `international_lead` tags the international routing
-- bucket ("English International" / "Hindi International" / null).
CREATE TABLE IF NOT EXISTS public.haridwar_sales_agents (
  lsq_id              text PRIMARY KEY,
  agent_name          text,
  agent_email         text,
  priority            text,                     -- stored as text (CAST to int when sorting)
  leads_today         int4 NOT NULL DEFAULT 0,
  daily_cap           int4 NOT NULL DEFAULT 20,
  week_off            text,                     -- 'Monday' … 'Sunday', or null
  is_active           boolean NOT NULL DEFAULT true,
  last_assigned_at    timestamp,
  international_lead   text                      -- import "International Lead" → here
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_haridwar_agents_email
  ON public.haridwar_sales_agents (lower(agent_email));

-- Off-hours queue — leads that arrived outside working hours, held until
-- the next working window (Phase 2 drains this).
CREATE TABLE IF NOT EXISTS public.lead_distribution_pending (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile              text,
  region              text,
  lead                jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','assigned','skipped')),
  assigned_agent      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ld_pending_status ON public.lead_distribution_pending (status, created_at);
-- 0102_move_interakt_919045454046_to_meta.sql
--
-- ONE-OFF data merge (run once in the Supabase SQL editor — NOT a schema
-- change). The number +91 90454 54046 exists twice:
--   SOURCE (retire) : business_phone_number_id = 'interakt:919045454046'  (75 chats / 179 msgs, old Interakt connection)
--   TARGET (keep)   : business_phone_number_id = '1131773160025041'        (real Meta number, WABA 1430966558794990)
--
-- This moves every chat + message from the Interakt number onto the Meta
-- number so nothing is lost. AFTER running this (and verifying the counts
-- below), remove the now-empty Interakt number from the UI
-- (Numbers → that card → "Danger zone — remove this number").
--
-- Safe to re-run: every statement is guarded by the source id, so a second
-- run finds nothing and no-ops.

BEGIN;

-- 1. Conflicts — a wa_id that already exists on the Meta number too (e.g. the
--    Meta number's test chat is the same customer). Move that Meta-side
--    contact's messages onto the Interakt-side contact (lossless), then drop
--    the now-empty Meta-side duplicate so the flip in step 2 doesn't trip the
--    unique (wa_id, business_phone_number_id) constraint. (A freshly-connected
--    Meta number's test contact has only messages — no notes/payments — so the
--    delete loses nothing but the duplicate row itself.)
UPDATE public.messages m
   SET contact_id = src.id
  FROM public.contacts src
  JOIN public.contacts tgt
    ON tgt.wa_id = src.wa_id
 WHERE src.business_phone_number_id = 'interakt:919045454046'
   AND tgt.business_phone_number_id = '1131773160025041'
   AND m.contact_id = tgt.id;

DELETE FROM public.contacts tgt
 WHERE tgt.business_phone_number_id = '1131773160025041'
   AND tgt.wa_id IN (
     SELECT wa_id
       FROM public.contacts
      WHERE business_phone_number_id = 'interakt:919045454046'
   );

-- 2. Flip every remaining Interakt contact + message onto the Meta number.
UPDATE public.contacts
   SET business_phone_number_id = '1131773160025041'
 WHERE business_phone_number_id = 'interakt:919045454046';

UPDATE public.messages
   SET business_phone_number_id = '1131773160025041'
 WHERE business_phone_number_id = 'interakt:919045454046';

COMMIT;

-- 3. Verify — SOURCE should now be 0, TARGET should hold the merged total.
SELECT business_phone_number_id,
       count(*) AS chats
  FROM public.contacts
 WHERE business_phone_number_id IN ('interakt:919045454046', '1131773160025041')
 GROUP BY business_phone_number_id;
-- 0103_date_align_off_by_default.sql
--
-- Date Align (can_align_dates) is now OFF for everyone by default. Access is
-- granted explicitly PER MEMBER from Settings → Members → the "Date Align /
-- send booking link" toggle. Owners always keep it (code bypass in
-- ownerPermissions()), so the owner can still align dates + grant access.
--
-- Run once in the Supabase SQL editor. Idempotent.

-- 1. Every role's default → OFF (covers teammate, admin and any other role).
UPDATE public.role_permissions SET can_align_dates = false;

-- 2. Clear any per-member override that currently GRANTS it, so nobody is
--    left enabled. NULL = inherit the role default (now false). Re-enable the
--    chosen team's members explicitly (UI toggle, or a follow-up UPDATE).
UPDATE public.team_member_permissions
   SET can_align_dates = NULL
 WHERE can_align_dates IS TRUE;
-- =====================================================================
-- 0103 — Lead Distribution: per-stage agent groups
-- ---------------------------------------------------------------------
-- Each group maps a set of LSQ stages to a set of agents, so e.g.
-- "Photos Received" leads route ONLY to the agents in that group. A lead
-- is matched against every enabled group (lowest `priority` first); the
-- first group whose `stages` include the lead's stage owns it. When no
-- group matches, the engine falls back to the global active-agent pool.
-- agent_ids holds haridwar_sales_agents.lsq_id values.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.lead_distribution_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL DEFAULT 'Stage group',
  stages      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- LSQ stage names
  agent_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- haridwar_sales_agents.lsq_id[]
  enabled     boolean NOT NULL DEFAULT true,
  priority    int NOT NULL DEFAULT 100,             -- lower wins on overlap
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- 0104_enable_date_align_for_team.sql
--
-- Grant Date Align (can_align_dates) to EVERY member of the "Date Align" team.
-- Run after 0103 (which turned it OFF for everyone). Idempotent — re-running
-- just keeps them enabled. Upsert so members without an override row get one.

INSERT INTO public.team_member_permissions (member_id, can_align_dates)
SELECT m.id, TRUE
  FROM public.team_members m
  JOIN public.teams t ON t.id = m.team_id
 WHERE lower(t.name) = 'date align'
ON CONFLICT (member_id)
DO UPDATE SET can_align_dates = TRUE, updated_at = now();

-- Verify — these members now have Date Align access:
SELECT m.id, m.email, m.full_name, m.is_active
  FROM public.team_members m
  JOIN public.teams t ON t.id = m.team_id
 WHERE lower(t.name) = 'date align'
 ORDER BY m.email;
-- =====================================================================
-- 0104 — Lead Distribution: brand filter
-- ---------------------------------------------------------------------
-- Only distribute leads whose mx_Brand is in this list. Empty = all
-- brands (no brand filter). Lets e.g. only "American Hairline" leads be auto-assigned
-- while other brands' leads are left untouched.
-- =====================================================================
ALTER TABLE public.lead_distribution_config
  ADD COLUMN IF NOT EXISTS brands jsonb NOT NULL DEFAULT '[]'::jsonb;
-- =====================================================================
-- 0105 — Lead Distribution: lead-source filter
-- ---------------------------------------------------------------------
-- Only distribute leads whose Source is in this list. Empty = all
-- sources (no source filter). Mirrors the brand filter (0104).
-- =====================================================================
ALTER TABLE public.lead_distribution_config
  ADD COLUMN IF NOT EXISTS sources jsonb NOT NULL DEFAULT '[]'::jsonb;
-- =====================================================================
-- 0106 — Lead Distribution: distinct lead-sources helper
-- ---------------------------------------------------------------------
-- Returns every distinct lead Source we've stored on contacts, so the
-- Lead-source filter dropdown can list them all (LSQ's metadata API does
-- not expose Source options).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.lead_distribution_sources()
RETURNS TABLE(source text)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT trim(lsq_source) AS source
  FROM public.contacts
  WHERE lsq_source IS NOT NULL AND trim(lsq_source) <> ''
  ORDER BY 1
$$;
-- =====================================================================
-- 0107 — Lead Distribution: prospect_id for dedup
-- ---------------------------------------------------------------------
-- The webhook can now fire on BOTH Lead Creation and Lead Stage Change,
-- so the same lead arrives twice. Storing the LSQ ProspectID lets the
-- engine assign each lead only once (skip if already assigned).
-- =====================================================================
ALTER TABLE public.lead_distribution_pending
  ADD COLUMN IF NOT EXISTS prospect_id text;

CREATE INDEX IF NOT EXISTS idx_ld_pending_prospect
  ON public.lead_distribution_pending (prospect_id);
-- =====================================================================
-- 0108 — LSQ owner × stage counts (for the Lead Distribution view)
-- ---------------------------------------------------------------------
-- The "LSQ live assignment" tab was built off the webhook event log, which
-- only carries the stages LSQ happens to push there (e.g. Photo Awaited but
-- not Photos Received). This aggregates the REAL current state straight from
-- contacts (lsq_owner_email × lsq_stage), so every stage shows.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.lsq_owner_stage_counts()
RETURNS TABLE(owner_email text, owner_name text, stage text, n bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT
    lower(trim(lsq_owner_email))                       AS owner_email,
    max(lsq_owner_name)                                AS owner_name,
    coalesce(nullif(trim(lsq_stage), ''), 'Unknown')   AS stage,
    count(*)::bigint                                   AS n
  FROM public.contacts
  WHERE lsq_owner_email IS NOT NULL AND trim(lsq_owner_email) <> ''
  GROUP BY 1, 3
$$;
-- GST tax invoices (Tally-synced).
--
-- Operators raise a GST tax invoice from a contact/booking. The flow:
--   draft  -> we compute the GST breakup (inclusive total -> taxable +
--             CGST/SGST or IGST) and freeze a party snapshot.
--   syncing-> the voucher is pushed to Tally (cloud gateway over HTTPS).
--   synced -> Tally assigns + returns the official invoice number; we
--             stamp it, render the branded PDF and send it to the
--             patient on WhatsApp (same document rail as receipts).
--   failed -> Tally import errored; tally_error holds the reason, the
--             operator can retry.
--
-- Tally connection details + ledger names live in app_settings (see
-- lib/tally) so they can be reconfigured without a migration. The
-- supplier (QHT Mediways, Haridwar — single GSTIN) is constant in the
-- PDF builder.

create table if not exists public.tax_invoices (
  id                          uuid primary key default gen_random_uuid(),
  contact_id                  uuid references public.contacts(id) on delete set null,
  business_phone_number_id    text references public.business_numbers(phone_number_id)
                              on delete set null,
  -- Optional linkage if the invoice was raised off a payment/booking.
  payment_id                  uuid references public.payments(id) on delete set null,

  -- Official Tally voucher number. NULL until the voucher is imported
  -- and Tally assigns + returns it (number-first flow).
  invoice_number              text,
  -- IST calendar date the invoice is dated for.
  invoice_date                date not null
                              default (now() at time zone 'Asia/Kolkata')::date,

  -- Party (patient) snapshot — frozen on the invoice so later edits to
  -- the contact never mutate an issued tax document.
  party_name                  text not null,
  party_address               text,
  party_state                 text not null default 'Uttarakhand',
  party_state_code            text not null default '05',
  party_gstin                 text,
  place_of_supply             text not null default 'Uttarakhand',
  place_of_supply_code        text not null default '05',

  -- Single-line booking invoice mirroring sample #528.
  description                 text not null default 'BOOKING FOR HAIR TRANSPLANT',
  hsn_sac                     text not null default '999722',
  gst_rate                    numeric(5,2) not null default 5,

  -- Money in rupees, 2 dp. taxable + cgst + sgst + igst + round_off = total.
  taxable_value               numeric(12,2) not null,
  cgst                        numeric(12,2) not null default 0,
  sgst                        numeric(12,2) not null default 0,
  igst                        numeric(12,2) not null default 0,
  round_off                   numeric(12,2) not null default 0,
  total                       numeric(12,2) not null,
  amount_in_words             text not null,

  -- Lifecycle.
  status                      text not null default 'draft'
                              check (status in
                                ('draft','syncing','synced','failed')),
  tally_voucher_id            text,   -- Tally MASTERID/GUID of the voucher
  tally_company               text,   -- SVCURRENTCOMPANY used at import
  tally_synced_at             timestamptz,
  tally_error                 text,   -- last import error, for retry UX

  -- Patient delivery.
  pdf_url                     text,
  pdf_path                    text,
  whatsapp_message_id         text,
  whatsapp_sent_at            timestamptz,

  -- Audit.
  created_by                  text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists tax_invoices_contact_idx
  on public.tax_invoices(contact_id, created_at desc);
create index if not exists tax_invoices_status_idx
  on public.tax_invoices(status, created_at desc);
-- An issued invoice number must be unique once assigned (NULLs allowed
-- while draft/syncing).
create unique index if not exists tax_invoices_number_uidx
  on public.tax_invoices(invoice_number)
  where invoice_number is not null;

-- RLS — same workspace-internal model as payments/bookings. Service
-- role bypasses for server-side writes (Tally sync, PDF send).
alter table public.tax_invoices enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tax_invoices'
      and policyname = 'tax_invoices_all_authenticated'
  ) then
    create policy tax_invoices_all_authenticated
      on public.tax_invoices
      for all
      to authenticated
      using (true)
      with check (true);
  end if;
end$$;
-- =====================================================================
-- 0109 — LSQ owner × stage counts: optional date range
-- ---------------------------------------------------------------------
-- Adds a [p_from, p_to) filter on contacts.created_at so the LSQ assignment
-- view can be filtered by day / month / year. NULL bounds = all time.
-- =====================================================================
DROP FUNCTION IF EXISTS public.lsq_owner_stage_counts();

CREATE OR REPLACE FUNCTION public.lsq_owner_stage_counts(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(owner_email text, owner_name text, stage text, n bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT
    lower(trim(lsq_owner_email))                       AS owner_email,
    max(lsq_owner_name)                                AS owner_name,
    coalesce(nullif(trim(lsq_stage), ''), 'Unknown')   AS stage,
    count(*)::bigint                                   AS n
  FROM public.contacts
  WHERE lsq_owner_email IS NOT NULL AND trim(lsq_owner_email) <> ''
    AND (p_from IS NULL OR created_at >= p_from)
    AND (p_to   IS NULL OR created_at <  p_to)
  GROUP BY 1, 3
$$;
-- =====================================================================
-- 0110 — Stage groups: optional brand filter
-- ---------------------------------------------------------------------
-- A stage group can now also be scoped to specific brand(s) (mx_Brand).
-- Empty = any brand. So e.g. "Photos Received + American Hairline" routes only American Hairline
-- Photos-Received leads to the group's agents.
-- =====================================================================
ALTER TABLE public.lead_distribution_groups
  ADD COLUMN IF NOT EXISTS brands jsonb NOT NULL DEFAULT '[]'::jsonb;
-- =====================================================================
-- 0111 — Lead Distribution: store brand on each webhook lead
-- ---------------------------------------------------------------------
-- The webhook payload rarely carries mx_Brand, so the Executions brand
-- filter had nothing to match on. We now resolve + store the brand per
-- lead at ingest (from the payload, else a one-time LSQ lookup) so the
-- filter works for every event.
-- =====================================================================
ALTER TABLE public.lead_distribution_pending
  ADD COLUMN IF NOT EXISTS brand text;
-- "Monitor" team members.
--
-- Some users only WATCH leads (don't reply). Leads sit parked under a
-- monitor's LSQ ownership and get reassigned to a real working agent
-- overnight. While a lead is owned by a monitor it should count as
-- "unassigned / available" in the inbox so a full-access agent can pick
-- it up — see the Unassigned filter in app/api/contacts.
--
-- Marked from Settings → Team (per member). Default false = normal
-- working agent.

alter table public.team_members
  add column if not exists is_monitor boolean not null default false;

-- The Unassigned filter looks up monitor emails on every fetch; a small
-- partial index keeps that lookup trivial.
create index if not exists team_members_is_monitor_idx
  on public.team_members (is_monitor)
  where is_monitor = true;
-- =====================================================================
-- 0112 — Lead Distribution: daily cap reset marker
-- ---------------------------------------------------------------------
-- haridwar_sales_agents.leads_today is the per-DAY counter the cap checks
-- against. It must reset at IST midnight, else every agent stays "full"
-- after their first 20. We store the last reset date (IST YYYY-MM-DD) on
-- the config; the scheduler tick resets all counters when the date rolls.
-- =====================================================================
ALTER TABLE public.lead_distribution_config
  ADD COLUMN IF NOT EXISTS leads_reset_date text;
-- =====================================================================
-- 0113 — Stage groups: per-group working hours
-- ---------------------------------------------------------------------
-- Working hours move from the global config onto each stage group, so a
-- group (e.g. "Photos Received + QHT") can have its own IST window. A
-- lead matched to a group uses that group's hours; outside the window it
-- stays pending until it opens.
-- =====================================================================
ALTER TABLE public.lead_distribution_groups
  ADD COLUMN IF NOT EXISTS working_start text NOT NULL DEFAULT '10:00',
  ADD COLUMN IF NOT EXISTS working_end   text NOT NULL DEFAULT '18:30';
-- =====================================================================
-- 0114 — Lead Distribution: denormalised summary columns (perf)
-- ---------------------------------------------------------------------
-- The Executions / LSQ-assignment lists were selecting the full `lead`
-- jsonb for every row (~900ms for 200 rows). We pull the few fields the
-- lists actually need onto plain columns so the queries don't touch the
-- heavy payload.
-- =====================================================================
ALTER TABLE public.lead_distribution_pending
  ADD COLUMN IF NOT EXISTS stage       text,
  ADD COLUMN IF NOT EXISTS lead_name   text,
  ADD COLUMN IF NOT EXISTS owner_email text,
  ADD COLUMN IF NOT EXISTS lead_number text;

CREATE INDEX IF NOT EXISTS idx_ld_pending_owner_email ON public.lead_distribution_pending (lower(owner_email));
CREATE INDEX IF NOT EXISTS idx_ld_pending_stage ON public.lead_distribution_pending (stage);

-- Backfill the new columns from the existing `lead` payload (handles the
-- raw top-level shape and the After/body-wrapped shape).
UPDATE public.lead_distribution_pending p
SET
  stage       = NULLIF(TRIM(COALESCE(l->>'ProspectStage', l->>'Stage', '')), ''),
  lead_name   = NULLIF(TRIM(COALESCE(l->>'FirstName', l->>'Name', '')), ''),
  owner_email = NULLIF(LOWER(TRIM(COALESCE(l->>'OwnerIdEmailAddress', l->>'OwnerEmailAddress', ''))), ''),
  lead_number = NULLIF(TRIM(COALESCE(l->>'ProspectAutoId', l->>'leadnumber', '')), '')
FROM (
  SELECT id, COALESCE(lead->'After', lead->'body', lead) AS l
  FROM public.lead_distribution_pending
) src
WHERE p.id = src.id;
-- =====================================================================
-- 0115 — Lead Distribution: automation registry
-- ---------------------------------------------------------------------
-- A local tracker for the LSQ automations the operator has wired to the
-- distribution webhook. LSQ doesn't expose its automation list to us, so
-- the operator records each one here (name + trigger type) — the panel
-- then shows them like LSQ's own Automation screen, with the webhook to
-- paste into each automation's Webhook action.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.lead_distribution_automations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  trigger_type  text NOT NULL DEFAULT 'New Lead',
  scope         text NOT NULL DEFAULT 'Global',
  status        text NOT NULL DEFAULT 'Draft',
  note          text,
  -- Full trigger build (lead_field, change_from/to, run_once, exit_condition,
  -- conditions[]) captured from the scratch builder — mirrors LSQ's trigger.
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Back-fill the column if the table already existed without it.
ALTER TABLE public.lead_distribution_automations
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_ld_automations_created_at
  ON public.lead_distribution_automations (created_at DESC);
-- Off-topic / personal-intent guard for the AI bot.
--
-- The bot only handles hair-loss / hair-transplant topics. When a patient
-- repeatedly pushes personal / friendship / romance / casual chat, the bot
-- issues 3 escalating warnings and then BLOCKS itself for that contact:
-- it stops replying entirely (a human can still chat manually). The block
-- surfaces in the chat composer as "Chat blocked due to app guidelines".
--
--   offtopic_strikes  — count of consecutive off-topic patient messages
--   bot_blocked_at    — when the bot was auto-blocked (NULL = not blocked)
--   bot_blocked_reason— why ("off_topic_guidelines")

alter table contacts
  add column if not exists offtopic_strikes integer not null default 0,
  add column if not exists bot_blocked_at timestamptz,
  add column if not exists bot_blocked_reason text;
-- Per-number reply length cap (words). The bot keeps replies to this many
-- words; if a generated reply runs longer it's compressed to one short line.
-- 0 = no limit (don't compress). Default 15 to match the anti-spam policy.

alter table automation_configs
  add column if not exists reply_word_limit integer not null default 15;
-- Patient's preferred reply language. The bot greets, asks the patient which
-- language they prefer, stores the choice here (and pushes it to LSQ's
-- mx_Religion field), then replies in that language on every turn.
-- NULL = not chosen yet → bot asks in its greeting and matches their language
-- meanwhile.

alter table contacts
  add column if not exists preferred_language text;
-- Dedup ledger for the Lead Automation execution engine. When an LSQ
-- webhook fires a published automation's action (e.g. "send template"), we
-- record (automation, prospect, node) here so the same action never fires
-- twice for the same lead — even if LSQ re-sends the stage-change event.

create table if not exists lead_automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null,
  prospect_id text not null,
  node_id text not null,
  sent_at timestamptz not null default now(),
  unique (automation_id, prospect_id, node_id)
);

create index if not exists lead_automation_runs_prospect_idx
  on lead_automation_runs (prospect_id);
-- Scheduler queue for Lead Automation "Wait" nodes. When a flow hits a Wait,
-- the engine enqueues a continuation here (resume from the node after the wait
-- at run_at = now + wait duration) instead of blocking. The process-pending
-- cron picks due rows and resumes the flow — so waits of any length (seconds
-- → days) work and survive restarts.

create table if not exists lead_automation_pending (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null,
  prospect_id text not null,
  resume_node_id text not null,
  lead jsonb not null,          -- snapshot used to resume (mobile, fields, …)
  run_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (automation_id, prospect_id, resume_node_id)
);

create index if not exists lead_automation_pending_due_idx
  on lead_automation_pending (run_at);
-- Add the recipient's phone to the automation-run ledger so the Lead
-- Automations report can show how many people got the message and which
-- numbers. Existing rows stay NULL (no backfill); new sends record it.

alter table lead_automation_runs
  add column if not exists mobile text;

-- Rich quick replies: optional media (image/video) + a single URL button, on
-- top of the existing text body. When set, the snippet is sent as a WhatsApp
-- interactive cta_url message (media header + body + button) instead of plain
-- text. All nullable — a quick reply stays text-only unless these are filled.

alter table public.quick_replies
  add column if not exists media_url   text,
  add column if not exists media_kind  text,   -- 'image' | 'video'
  add column if not exists button_text text,
  add column if not exists button_url  text;
-- Multi-button quick replies. A `buttons` array replaces the single
-- button_text/button_url pair. Each button: { type: 'quick_reply' | 'url',
-- text, url? }. WhatsApp free-form only supports reply buttons (max 3) OR one
-- URL button — Phone / Copy-Code buttons are template-only, so not stored here.
-- button_text/button_url stay for back-compat reads of older rows.

alter table public.quick_replies
  add column if not exists buttons jsonb not null default '[]'::jsonb;
-- 0125 — LSQ push failures + retry queue.
--
-- When a Source/Sub-source backfill push fails (almost always an LSQ rate
-- limit), we record it here instead of silently dropping it. A 2-minute
-- heartbeat (/api/cron/lsq-push-retry) re-attempts every `pending` row whose
-- next_retry_at has passed, and the LSQ settings panel shows the queue so an
-- operator can see what failed and whether the retry eventually pushed.

create table if not exists public.lsq_push_failures (
  id                uuid primary key default gen_random_uuid(),
  lead_number       text not null,
  prospect_id       text,
  phone             text,
  first_chat_number text,
  fields            jsonb not null default '[]'::jsonb,   -- [{Attribute, Value}]
  status            text  not null default 'pending',     -- pending | pushed | failed
  attempts          int   not null default 0,
  last_error        text,
  source            text,                                  -- bulk_firstchat | bulk_source
  next_retry_at     timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  pushed_at         timestamptz,
  unique (lead_number)
);

create index if not exists idx_lsq_push_failures_due
  on public.lsq_push_failures (status, next_retry_at);
-- 0126 — LSQ webhook event log (full payloads).
--
-- The global lsq_webhook_last_payload only keeps the LATEST payload and is
-- overwritten on every hit, so a form-submission payload is gone the moment the
-- next event lands. This table keeps the FULL payload of recent events per
-- webhook (ring-buffered to the last 50) so they can actually be inspected.

create table if not exists public.lsq_webhook_events (
  id                uuid primary key default gen_random_uuid(),
  webhook_id        text,
  webhook_name      text,
  received_at       timestamptz not null default now(),
  notable_event     text,                 -- After.NotableEvent (the trigger)
  activity          text,                 -- ProspectActivityName_Max
  prospect_id       text,
  prospect_auto_id  text,                 -- LSQ lead number
  phone             text,
  stage             text,                 -- After.ProspectStage
  source            text,
  payload           jsonb not null,       -- FULL payload (untruncated)
  created_at        timestamptz not null default now()
);

create index if not exists idx_lsq_webhook_events_recent
  on public.lsq_webhook_events (received_at desc);
create index if not exists idx_lsq_webhook_events_hook
  on public.lsq_webhook_events (webhook_id, received_at desc);
-- 0127 — allow the new flow triggers: 'new_contact' (first message from a
-- never-engaged number) and 'first_message' (new conversation after a gap).
-- The 0078 check constraint only listed keyword/schedule/webhook/template_reply,
-- so saving a flow with either new trigger failed with
-- trigger_flows_trigger_type_check.

ALTER TABLE public.trigger_flows DROP CONSTRAINT IF EXISTS trigger_flows_trigger_type_check;

ALTER TABLE public.trigger_flows
  ADD CONSTRAINT trigger_flows_trigger_type_check
  CHECK (trigger_type IN (
    'keyword', 'schedule', 'webhook', 'template_reply', 'new_contact', 'first_message'
  ));
-- Per-number override for the Interakt magic-message UTILITY template.
-- When set, magic messages sent FROM this number use this approved template
-- name instead of the workspace default ("magic_message_llp"). Lets a single
-- Interakt number (e.g. Sahil Ayyan 73 → shahil_magic_message) carry its own
-- branded magic card without touching any other number.
alter table business_numbers
  add column if not exists magic_message_template text;

-- Sahil Ayyan 73 (Interakt) magic messages use its own branded utility template.
update business_numbers
  set magic_message_template = 'shahil_magic_message'
  where phone_number_id = 'interakt:918279405973';

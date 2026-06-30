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

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

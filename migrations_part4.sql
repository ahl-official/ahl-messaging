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
-- traffic, or create it with CREATE INDEX (outside a
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

drop index if exists public.messages_timestamp_idx;

create index if not exists messages_rep_outbound_idx
  on public.messages (timestamp)
  include (sent_by_email, type, template_name)
  where direction = 'outbound';

create index if not exists messages_rep_inbound_idx
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

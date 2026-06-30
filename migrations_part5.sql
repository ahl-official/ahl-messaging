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

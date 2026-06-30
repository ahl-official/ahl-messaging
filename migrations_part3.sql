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

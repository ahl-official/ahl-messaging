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

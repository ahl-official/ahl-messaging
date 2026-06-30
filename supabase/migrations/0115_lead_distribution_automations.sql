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

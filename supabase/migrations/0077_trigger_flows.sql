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

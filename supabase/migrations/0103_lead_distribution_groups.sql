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

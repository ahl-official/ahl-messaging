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

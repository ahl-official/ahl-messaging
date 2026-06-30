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

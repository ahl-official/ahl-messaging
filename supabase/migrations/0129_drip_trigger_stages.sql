-- Multi-stage drip triggers: one campaign can enroll leads in several
-- LSQ stages (e.g. Leak 3 = Warm + Cold1 + Cold2 + Deferred) without
-- cloning the same step sequence N times.
--
-- `trigger_stage` stays as the primary/display stage (first of the list)
-- for back-compat with older UI + rows. `trigger_stages` is the full set.

ALTER TABLE public.drip_campaigns
  ADD COLUMN IF NOT EXISTS trigger_stages text[] NOT NULL DEFAULT '{}';

-- Backfill: existing single-stage drips → one-element array.
UPDATE public.drip_campaigns
SET trigger_stages = ARRAY[trigger_stage]
WHERE (trigger_stages IS NULL OR cardinality(trigger_stages) = 0)
  AND trigger_stage IS NOT NULL
  AND btrim(trigger_stage) <> '';

CREATE INDEX IF NOT EXISTS drip_campaigns_trigger_stages_gin
  ON public.drip_campaigns USING gin (trigger_stages);

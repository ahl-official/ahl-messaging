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

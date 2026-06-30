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

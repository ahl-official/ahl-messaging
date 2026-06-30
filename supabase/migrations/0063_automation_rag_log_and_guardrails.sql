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

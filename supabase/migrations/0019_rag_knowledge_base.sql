-- =====================================================================
-- 0019 — RAG knowledge base
-- ---------------------------------------------------------------------
-- The persona on automation_configs.system_prompt has grown to ~14k
-- chars (~3.6k tokens). At ~1k inbound msgs/day that's ~3.6M tokens/day
-- spent just shipping the persona to OpenAI on every reply. RAG flips
-- this on its head: store small chunks of knowledge with embeddings,
-- retrieve only the 3-5 most-relevant chunks per inbound, send a tiny
-- core prompt + those chunks. ~75% token reduction in practice.
--
-- Storage: pgvector (built into Supabase). Embedding dim = 1536 to
-- match OpenAI text-embedding-3-small. Cosine similarity for retrieval.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------
-- 1) Chunks table — one row per knowledge unit (FAQ, pricing block,
--    procedure description, etc.). Per business number so two clinics
--    on the same workspace don't bleed knowledge into each other.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_phone_number_id text NOT NULL
                              REFERENCES public.business_numbers(phone_number_id)
                              ON DELETE CASCADE,
  -- Free-text label so the operator can group / filter chunks
  -- ("Pricing", "Procedures", "Refund policy", etc.).
  source                   text NOT NULL DEFAULT 'general',
  chunk_text               text NOT NULL,
  -- 1536-dim vector for OpenAI text-embedding-3-small. Nullable so a
  -- chunk can be saved before embedding completes (async re-embed).
  embedding                vector(1536),
  -- Cached token count from the embedding API response — used for
  -- cost dashboards and to refuse oversized chunks (>8k tokens).
  token_count              int,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_business_idx
  ON public.knowledge_chunks(business_phone_number_id);

-- Vector similarity index. ivfflat is the right choice while we have
-- <100k chunks per business; rebuild with `lists = sqrt(rows)` later
-- if cardinality grows.
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON public.knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

DROP TRIGGER IF EXISTS knowledge_chunks_set_updated_at ON public.knowledge_chunks;
CREATE TRIGGER knowledge_chunks_set_updated_at
  BEFORE UPDATE ON public.knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------
-- 2) Similarity search RPC — called from lib/rag.ts on every inbound
--    when use_rag is on. Cosine similarity (1 - distance) so higher
--    score = more relevant.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  query_embedding   vector(1536),
  target_business_id text,
  match_count       int DEFAULT 5
)
RETURNS TABLE (
  id         uuid,
  source     text,
  chunk_text text,
  similarity float
)
LANGUAGE sql STABLE AS $$
  SELECT
    id,
    source,
    chunk_text,
    1 - (embedding <=> query_embedding) AS similarity
  FROM public.knowledge_chunks
  WHERE business_phone_number_id = target_business_id
    AND embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ---------------------------------------------------------------------
-- 3) RLS — active members can read, writes via service role only.
-- ---------------------------------------------------------------------
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_chunks_select ON public.knowledge_chunks;
CREATE POLICY knowledge_chunks_select ON public.knowledge_chunks
  FOR SELECT TO authenticated
  USING (public.current_member_is_active());

-- ---------------------------------------------------------------------
-- 4) RAG toggles on automation_configs.
--    use_rag       — main switch. Off = legacy full-prompt behaviour.
--    rag_top_k     — how many chunks to retrieve per query.
--    rag_core_prompt — small persona prompt used INSTEAD of the long
--                      system_prompt when RAG is on. Operator writes
--                      the rules + tone here; knowledge lives in chunks.
-- ---------------------------------------------------------------------
ALTER TABLE public.automation_configs
  ADD COLUMN IF NOT EXISTS use_rag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rag_top_k int NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS rag_core_prompt text;

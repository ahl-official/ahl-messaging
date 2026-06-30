// RAG retrieval helpers — turn an inbound user message into a small
// list of relevant knowledge chunks that get injected into the LLM
// prompt. Used by lib/automation.ts when automation_configs.use_rag
// is true. When false / on retrieval failure, the pipeline falls
// back to the full system_prompt so a misconfigured RAG never makes
// the bot silent.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { embedText } from "@/lib/embeddings";

export interface RetrievedChunk {
  id: string;
  source: string;
  chunk_text: string;
  /** Cosine similarity 0..1, higher = closer match. */
  similarity: number;
}

const DEFAULT_TOP_K = 5;
const MIN_SIMILARITY = 0.2; // Drop near-random matches.

export async function retrieveRelevantChunks(
  userQuery: string,
  businessPhoneNumberId: string,
  topK: number = DEFAULT_TOP_K,
): Promise<RetrievedChunk[]> {
  const query = (userQuery ?? "").trim();
  if (!query) return [];

  let queryVector: number[];
  try {
    const embed = await embedText(query);
    queryVector = embed.vector;
  } catch (e) {
    console.warn("[rag] query-embed failed:", e instanceof Error ? e.message : e);
    return [];
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin.rpc("match_knowledge_chunks", {
    query_embedding: queryVector,
    target_business_id: businessPhoneNumberId,
    match_count: Math.max(1, Math.min(20, topK)),
  });
  if (error) {
    console.warn("[rag] match RPC failed:", error.message);
    return [];
  }

  return ((data ?? []) as RetrievedChunk[]).filter(
    (c) => c.similarity >= MIN_SIMILARITY,
  );
}

/**
 * Build the final system prompt sent to the LLM when RAG is on.
 * Keeps the operator's core persona / rules at the top, then dumps the
 * retrieved chunks as a "RELEVANT KNOWLEDGE" section the model can lean
 * on — same shape as a typical RAG implementation.
 */
export function buildRagPrompt(
  corePrompt: string,
  chunks: RetrievedChunk[],
): string {
  const trimmedCore = (corePrompt ?? "").trim();
  if (chunks.length === 0) return trimmedCore;

  const knowledgeBlock = chunks
    .map(
      (c, i) =>
        `[${i + 1}] (${c.source} · score=${c.similarity.toFixed(2)})\n${c.chunk_text}`,
    )
    .join("\n\n");

  return [
    trimmedCore,
    "",
    "# RELEVANT KNOWLEDGE",
    "Use ONLY the facts in the chunks below to answer factual questions",
    "about pricing, procedures, hours, locations, and policies. If the",
    "answer isn't in the chunks, say you'll get back to them rather than",
    "guessing.",
    "",
    knowledgeBlock,
  ].join("\n");
}

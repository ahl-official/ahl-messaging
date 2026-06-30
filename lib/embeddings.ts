// OpenAI embeddings helper — used by the RAG pipeline to:
//   1. Embed knowledge_chunks at write time (admin UI saves a chunk →
//      this runs and stores the vector alongside the row).
//   2. Embed the inbound user query at retrieval time so we can do a
//      cosine-similarity search against the stored chunks.
//
// Model: text-embedding-3-small (1536 dim). $0.02 per 1M tokens — at
// ~14k chars persona we'd pay ~$0.00007 to embed the whole thing once,
// and pennies per day on inbound query embeddings.

import { requireCredential } from "@/lib/credentials";

export interface EmbedResult {
  vector: number[];
  /** Total tokens reported by the embedding API. Saved on each chunk
   *  for cost dashboards. */
  tokens: number;
}

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

export async function embedText(input: string): Promise<EmbedResult> {
  const text = (input ?? "").trim();
  if (!text) {
    throw new Error("Cannot embed empty text.");
  }
  if (text.length > 32_000) {
    // Hard guardrail — OpenAI accepts ~8k tokens (~32k chars). Refuse
    // bigger inputs at the helper layer so a runaway chunk doesn't
    // burn cost.
    throw new Error(`Text too long for embedding (${text.length} chars, max 32000).`);
  }

  const apiKey = await requireCredential("openai_api_key", "OpenAI API key");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
    usage?: { total_tokens?: number };
  };
  const vector = json.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding response missing or wrong size (${vector?.length ?? "null"})`,
    );
  }

  return {
    vector,
    tokens: json.usage?.total_tokens ?? 0,
  };
}

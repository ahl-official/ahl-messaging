// Embeddings helper — used by the RAG pipeline to:
//   1. Embed knowledge_chunks at write time (admin UI saves a chunk →
//      this runs and stores the vector alongside the row).
//   2. Embed the inbound user query at retrieval time so we can do a
//      cosine-similarity search against the stored chunks.
//
// Priority:  OPENROUTER_API_KEY → direct OpenAI key (from DB credentials).
// OpenRouter supports the same /embeddings endpoint and model names with
// the openai/ prefix, so no schema changes are needed.

import { requireCredential } from "@/lib/credentials";

export interface EmbedResult {
  vector: number[];
  /** Total tokens reported by the embedding API. Saved on each chunk
   *  for cost dashboards. */
  tokens: number;
}

const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIM = 1536;

async function resolveEmbedConfig(): Promise<{ apiKey: string; baseUrl: string; model: string; extraHeaders: Record<string, string> }> {
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    return {
      apiKey: openRouterKey,
      baseUrl: "https://openrouter.ai/api/v1",
      model: OPENROUTER_EMBEDDING_MODEL,
      extraHeaders: {
        "HTTP-Referer": "https://wa.hairscalptradingco.com",
        "X-Title": "AHL Messaging",
      },
    };
  }
  const apiKey = await requireCredential("openai_api_key", "OpenAI API key");
  return {
    apiKey,
    baseUrl: "https://api.openai.com/v1",
    model: OPENAI_EMBEDDING_MODEL,
    extraHeaders: {},
  };
}

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

  const { apiKey, baseUrl, model, extraHeaders } = await resolveEmbedConfig();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Connection: "close",
        ...extraHeaders,
      },
      body: JSON.stringify({ model, input: text }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding API HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
    usage?: { total_tokens?: number };
  };
  const vector = json.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding response missing or wrong size (got ${vector?.length ?? "null"}, expected ${EMBEDDING_DIM})`,
    );
  }

  return {
    vector,
    tokens: json.usage?.total_tokens ?? 0,
  };
}

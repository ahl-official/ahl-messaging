// Minimal OpenAI Chat Completions wrapper. Server-only — never import from
// a client component (would leak the API key into the bundle).
//
// We talk to OpenAI directly via fetch instead of pulling in the official
// SDK because all we need is a single endpoint and our own retry/timeout
// behaviour.

import { requireCredential } from "@/lib/credentials";

/** Vision-aware content part — gpt-4o(-mini) accepts a content array
 *  of `{type: "text"|"image_url"}` blocks alongside plain string. We
 *  use the array form only when the inbound message has an image, so
 *  the LLM can actually look at the photo. */
export type ChatContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
    >;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface ChatCompletionResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
  durationMs: number;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  error?: { message?: string; type?: string; code?: string };
}

export async function chatCompletion(opts: {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Per-call abort timeout in ms. Defaults to 30s. */
  timeoutMs?: number;
  /** Force OpenAI to return strict JSON. Used by the extraction
   *  pipeline so we never get markdown-fenced or chatty replies. */
  jsonMode?: boolean;
}): Promise<ChatCompletionResponse> {
  // Pulled from app_credentials (with .env.local fallback) so admins can
  // rotate the key from Settings → Credentials without redeploying.
  const apiKey = await requireCredential("openai_api_key", "OpenAI API key");

  const startedAt = Date.now();
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 800,
  };
  if (opts.jsonMode) {
    body.response_format = { type: "json_object" };
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });

  const json = (await res.json()) as OpenAIChatResponse;
  if (!res.ok || json.error) {
    throw new Error(
      json.error?.message || `OpenAI API ${res.status} ${res.statusText}`,
    );
  }

  const text = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error("OpenAI returned empty content");
  }

  return {
    text,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    model: json.model ?? opts.model,
    durationMs: Date.now() - startedAt,
  };
}

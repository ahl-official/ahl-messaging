// Ollama client — talks to a local Ollama server via its OpenAI-
// compatible chat completions endpoint. Same response shape as OpenAI,
// so we reuse the `ChatMessage` / `ChatCompletionResponse` types from
// lib/openai.ts and the upstream automation pipeline doesn't need to
// know which provider is in use.
//
// Configure with two env vars in .env.local:
//   OLLAMA_BASE_URL   — defaults to http://localhost:11434
//   OLLAMA_MODEL      — fallback model when a config row doesn't pin one
//
// No API key — Ollama is unauthenticated by default. If you proxy it
// through ngrok / Tailscale and add Bearer auth, we send the same
// header (set OLLAMA_API_KEY).

import type { ChatMessage, ChatCompletionResponse } from "@/lib/openai";

interface OllamaChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string; type?: string };
}

export interface OllamaConfig {
  baseUrl: string;
  apiKey: string | null;
  defaultModel: string;
  configured: boolean;
}

export function getOllamaConfig(): OllamaConfig {
  const baseUrl = (process.env.OLLAMA_BASE_URL || "http://localhost:11434")
    .replace(/\/$/, "")
    .trim();
  const apiKey = (process.env.OLLAMA_API_KEY || "").trim() || null;
  const defaultModel = (process.env.OLLAMA_MODEL || "llama3.1:8b").trim();
  return {
    baseUrl,
    apiKey,
    defaultModel,
    configured: !!baseUrl,
  };
}

export async function ollamaChatCompletion(opts: {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Per-call abort. Defaults to 60s — local LLMs are slower than OpenAI. */
  timeoutMs?: number;
}): Promise<ChatCompletionResponse> {
  const cfg = getOllamaConfig();
  if (!cfg.configured) {
    throw new Error("Ollama not configured. Set OLLAMA_BASE_URL in .env.local.");
  }

  const startedAt = Date.now();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 800,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (e) {
    // Ollama not running, network error, etc. Wrap with a hint so the
    // automation log surfaces the actionable message.
    const reason = e instanceof Error ? e.message : "network error";
    throw new Error(
      `Ollama unreachable at ${cfg.baseUrl} — is the server running? (${reason})`,
    );
  }

  const json = (await res.json()) as OllamaChatResponse;
  if (!res.ok || json.error) {
    throw new Error(
      json.error?.message || `Ollama API ${res.status} ${res.statusText}`,
    );
  }

  const text = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error("Ollama returned empty content");
  }

  return {
    text,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    model: json.model ?? opts.model,
    durationMs: Date.now() - startedAt,
  };
}

// Lightweight health check — calls Ollama's /api/tags endpoint. Returns
// the list of installed models so the UI can populate a dropdown
// dynamically. Falls back to {ok:false, error} on failure so the
// "Ollama is running" pill can render an actionable message.
export interface OllamaHealth {
  ok: boolean;
  base_url: string;
  models: string[];
  error: string | null;
  duration_ms: number;
}

export async function ollamaHealth(): Promise<OllamaHealth> {
  const cfg = getOllamaConfig();
  const started = Date.now();
  if (!cfg.configured) {
    return {
      ok: false,
      base_url: cfg.baseUrl,
      models: [],
      error: "OLLAMA_BASE_URL not set",
      duration_ms: 0,
    };
  }
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  try {
    const res = await fetch(`${cfg.baseUrl}/api/tags`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        base_url: cfg.baseUrl,
        models: [],
        error: `HTTP ${res.status} ${res.statusText}`,
        duration_ms: Date.now() - started,
      };
    }
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (json.models ?? [])
      .map((m) => m.name?.trim())
      .filter((n): n is string => !!n)
      .sort();
    return {
      ok: true,
      base_url: cfg.baseUrl,
      models,
      error: null,
      duration_ms: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false,
      base_url: cfg.baseUrl,
      models: [],
      error: e instanceof Error ? e.message : "Network error",
      duration_ms: Date.now() - started,
    };
  }
}

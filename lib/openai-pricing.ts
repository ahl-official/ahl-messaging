// OpenAI per-model pricing (USD per million tokens). Used by the Usage
// panel on the Automation page to estimate spend from automation_logs.
//
// Update this table when OpenAI changes prices. Sources:
//   - https://openai.com/api/pricing
//   - https://platform.openai.com/docs/pricing
//
// Last reviewed: 2026-04. If a model isn't listed, the helper returns
// zero cost (and the UI labels it "unpriced").

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  "gpt-4o-mini":      { input: 0.15, output: 0.60 },
  "gpt-4o":           { input: 2.50, output: 10.00 },
  "gpt-4.1-mini":     { input: 0.40, output: 1.60 },
  "gpt-4.1":          { input: 2.00, output: 8.00 },
};

export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  // OpenAI returns model strings like "gpt-4o-mini-2024-07-18" — strip date
  // suffix and try again so versioned responses still match the table.
  const trimmed = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return MODEL_PRICING[trimmed] ?? null;
}

export function estimateCostUsd(
  model: string | null | undefined,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (promptTokens / 1_000_000) * p.input +
    (completionTokens / 1_000_000) * p.output
  );
}

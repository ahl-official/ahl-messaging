// POST /api/automation/test
// Per-number "agent trainer" preview. Sends a single user message to the
// configured LLM with the saved system_prompt + provider + model and
// returns the reply. Does NOT log to automation_logs (no contact
// involvement) and does NOT send to WhatsApp — purely for iterating on
// the persona before going live.
//
// Body: { business_phone_number_id: string, user_message: string }
// Returns: { reply: string, latency_ms: number, model: string,
//            prompt_tokens?: number, completion_tokens?: number }
//
// Auth: any team member (read-equivalent — same surface as /config GET).

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { chatCompletion as openaiChatCompletion, type ChatMessage } from "@/lib/openai";
import { ollamaChatCompletion } from "@/lib/ollama";

export const runtime = "nodejs";

interface Body {
  business_phone_number_id?: string;
  user_message?: string;
  /** Optional prior turns so the trainer can maintain a multi-turn
   *  conversation. Each entry is just `{role: "user"|"assistant", content: string}`. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const phoneId = body.business_phone_number_id?.trim();
  const userMsg = body.user_message?.toString().trim();
  if (!phoneId) {
    return NextResponse.json({ error: "business_phone_number_id is required" }, { status: 400 });
  }
  if (!userMsg) {
    return NextResponse.json({ error: "user_message is required" }, { status: 400 });
  }
  if (userMsg.length > 4000) {
    return NextResponse.json({ error: "user_message too long (4000 max)" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: config, error } = await admin
    .from("automation_configs")
    .select("system_prompt, model, temperature, provider")
    .eq("business_phone_number_id", phoneId)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!config) {
    return NextResponse.json(
      { error: "No automation config saved for this number yet. Save the persona first." },
      { status: 400 },
    );
  }

  const systemPrompt = (config.system_prompt ?? "").toString().trim();
  if (!systemPrompt) {
    return NextResponse.json(
      { error: "System prompt is empty. Add a persona before testing." },
      { status: 400 },
    );
  }

  const provider = config.provider === "ollama" ? "ollama" : "openai";
  const history: ChatMessage[] = [];
  if (Array.isArray(body.history)) {
    for (const h of body.history.slice(-50)) {
      if (
        (h.role === "user" || h.role === "assistant") &&
        typeof h.content === "string" &&
        h.content.trim().length > 0
      ) {
        history.push({ role: h.role, content: h.content });
      }
    }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMsg },
  ];

  const startedAt = Date.now();
  try {
    const resp =
      provider === "ollama"
        ? await ollamaChatCompletion({
            messages,
            model: config.model,
            temperature: Number(config.temperature),
          })
        : await openaiChatCompletion({
            messages,
            model: config.model,
            temperature: Number(config.temperature),
          });
    return NextResponse.json({
      reply: resp.text,
      model: resp.model,
      latency_ms: resp.durationMs ?? Date.now() - startedAt,
      prompt_tokens: resp.promptTokens ?? null,
      completion_tokens: resp.completionTokens ?? null,
      provider,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : `${provider} call failed`;
    return NextResponse.json(
      { error: msg, provider, latency_ms: Date.now() - startedAt },
      { status: 502 },
    );
  }
}

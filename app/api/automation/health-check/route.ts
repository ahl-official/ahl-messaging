// POST /api/automation/health-check
// Live API probe — actually calls the configured LLM provider with a
// tiny 5-token "ping" prompt and returns whether it succeeded right now.
// Replaces reading stale automation_logs rows for the trainer's status
// chip — those rows can be hours old and show false negatives long
// after the operator has fixed billing or rotated keys.
//
// Body: { business_phone_number_id: string }
// Returns:
//   200 { ok: true, model: string, latency_ms: number, provider: string }
//   200 { ok: false, error: string, latency_ms: number, provider: string }
//
// Auth: any authenticated team member.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { chatCompletion as openaiChatCompletion, type ChatMessage } from "@/lib/openai";
import { ollamaChatCompletion } from "@/lib/ollama";

export const runtime = "nodejs";

interface Body {
  business_phone_number_id?: string;
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
  if (!phoneId) {
    return NextResponse.json(
      { error: "business_phone_number_id is required" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { data: config } = await admin
    .from("automation_configs")
    .select("model, provider")
    .eq("business_phone_number_id", phoneId)
    .maybeSingle();

  const provider = config?.provider === "ollama" ? "ollama" : "openai";
  const model =
    (config?.model as string | undefined) ?? (provider === "ollama" ? "llama3" : "gpt-4o-mini");

  const messages: ChatMessage[] = [
    { role: "system", content: "Reply with exactly: ok" },
    { role: "user", content: "ping" },
  ];

  const startedAt = Date.now();
  try {
    const resp =
      provider === "ollama"
        ? await ollamaChatCompletion({ messages, model, temperature: 0 })
        : await openaiChatCompletion({ messages, model, temperature: 0 });
    return NextResponse.json({
      ok: true,
      provider,
      model: resp.model,
      latency_ms: resp.durationMs ?? Date.now() - startedAt,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      provider,
      latency_ms: Date.now() - startedAt,
      error: e instanceof Error ? e.message : `${provider} call failed`,
    });
  }
}

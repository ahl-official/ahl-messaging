// POST /api/contacts/[id]/summary
// Generates an AI summary of the whole WhatsApp conversation with this
// contact. The system prompt is operator-editable in Settings → AI.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { chatCompletion } from "@/lib/openai";
import { getAiSummaryPrompt } from "@/lib/app-settings";

export const runtime = "nodejs";

interface MsgRow {
  direction: "inbound" | "outbound";
  type: string | null;
  content: string | null;
  timestamp: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("messages")
    .select("direction, type, content, timestamp")
    .eq("contact_id", id)
    .order("timestamp", { ascending: true })
    .limit(400);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as MsgRow[];
  // Render each message as "Patient: …" / "Agent: …". Media-only rows
  // become a "[image]" style placeholder so context isn't lost.
  const lines = rows
    .map((m) => {
      const who = m.direction === "inbound" ? "Patient" : "Agent";
      const text = (m.content ?? "").trim();
      const body = text || (m.type && m.type !== "text" ? `[${m.type}]` : "");
      return body ? `${who}: ${body}` : null;
    })
    .filter((l): l is string => l !== null);

  if (lines.length === 0) {
    return NextResponse.json(
      { error: "No conversation to summarise yet." },
      { status: 400 },
    );
  }

  // Output language — chosen by the agent in the widget.
  let language: "english" | "hinglish" = "english";
  try {
    const body = (await request.json()) as { language?: string };
    if (body.language === "hinglish") language = "hinglish";
  } catch {
    /* no body → default English */
  }
  const langInstruction =
    language === "hinglish"
      ? "\n\nWrite the summary in Hinglish — conversational Hindi in Roman (English) script, e.g. \"Patient ne order confirm kiya\". Natural and casual, not formal Hindi."
      : "\n\nWrite the summary in clear, simple English.";

  const systemPrompt = (await getAiSummaryPrompt()) + langInstruction;
  // Cap the transcript so a very long history doesn't blow the context
  // window — keep the most recent slice, which is what matters.
  const transcript = lines.slice(-300).join("\n");

  try {
    const result = await chatCompletion({
      model: "gpt-4o-mini",
      temperature: 0.3,
      maxTokens: 500,
      timeoutMs: 45_000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Conversation transcript:\n\n${transcript}` },
      ],
    });
    return NextResponse.json({
      summary: result.text.trim(),
      messageCount: lines.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Summary failed" },
      { status: 502 },
    );
  }
}

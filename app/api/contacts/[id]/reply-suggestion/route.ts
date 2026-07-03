// POST /api/contacts/[id]/reply-suggestion
// Analyses the whole conversation and drafts the next message the agent
// should send — tuned to move the client toward booking. The system
// prompt is operator-editable in Settings → AI.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { chatCompletion } from "@/lib/openai";
import { getAiReplyPrompt } from "@/lib/app-settings";

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
  const lines = rows
    .map((m) => {
      const who = m.direction === "inbound" ? "Client" : "Agent";
      const text = (m.content ?? "").trim();
      const body = text || (m.type && m.type !== "text" ? `[${m.type}]` : "");
      return body ? `${who}: ${body}` : null;
    })
    .filter((l): l is string => l !== null);

  if (lines.length === 0) {
    return NextResponse.json(
      { error: "No conversation to work from yet." },
      { status: 400 },
    );
  }

  // Output language — explicit choice from the panel widget, or "auto"
  // (the one-click composer button) which mirrors the client.
  let language: "english" | "hinglish" | "auto" = "auto";
  try {
    const body = (await request.json()) as { language?: string };
    if (body.language === "hinglish") language = "hinglish";
    else if (body.language === "english") language = "english";
  } catch {
    /* no body → auto */
  }
  const langInstruction =
    language === "hinglish"
      ? "\n\nWrite the suggested message in Hinglish — conversational Hindi in Roman (English) script. Natural and casual, how a real agent texts."
      : language === "english"
        ? "\n\nWrite the suggested message in clear, simple English."
        : "\n\nWrite the suggested message in the same language and script the client is using in the conversation (if they write Hinglish, reply in Hinglish; if English, reply in English).";

  const systemPrompt = (await getAiReplyPrompt()) + langInstruction;
  const transcript = lines.slice(-300).join("\n");

  try {
    const result = await chatCompletion({
      model: "gpt-4o-mini",
      temperature: 0.6,
      maxTokens: 400,
      timeoutMs: 45_000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Conversation transcript:\n\n${transcript}` },
      ],
    });
    return NextResponse.json({ reply: result.text.trim() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Suggestion failed" },
      { status: 502 },
    );
  }
}

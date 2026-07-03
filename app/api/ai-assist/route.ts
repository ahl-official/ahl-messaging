// POST /api/ai-assist
//
// One-shot text generation endpoint behind the ✨ buttons attached to
// every long textarea (persona, image system prompt, transcription
// context, RAG core prompt). The operator types what they want in
// natural language; the model writes the field for them.
//
// Field-aware: each `kind` has its own system prompt that knows how
// the field is used downstream so the output respects format
// constraints (e.g. transcription_prompt is fed to Whisper as <1000
// char hint, RAG core prompt is short rules + tone, etc.).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { requireCredential } from "@/lib/credentials";

export const runtime = "nodejs";
export const maxDuration = 60;

type AssistKind =
  | "persona"
  | "image_system_prompt"
  | "transcription_prompt"
  | "rag_core_prompt"
  | "knowledge_chunk"
  | "magic_campaign_brief";

interface Body {
  kind?: AssistKind;
  /** Operator's natural-language brief — "write a Hindi-speaking
   *  hair-clinic counselor that always asks for photos before quoting". */
  instruction?: string;
  /** Optional current value of the field — model rewrites/extends it
   *  rather than starting from a blank slate. */
  existing?: string;
  /** Free-text business context (e.g. "QHT Salon, hair treatments,
   *  Dehradun") so the model doesn't write generic filler. */
  context?: string;
}

const SYSTEM_PROMPTS: Record<AssistKind, string> = {
  persona: `You write the SYSTEM PROMPT for a WhatsApp customer-support AI agent. The output goes verbatim to OpenAI on every reply, so it must be detailed and unambiguous. Include:
- Identity (who the bot is, where it works)
- Language rules (mirror the user's language; never default)
- Tone (warm, concise, professional)
- Hard rules (never reveal it's an AI, escalate if X, never quote prices without photos, etc.)
- Reply length cap (e.g. <200 words)

Output ONLY the prompt body — no preamble, no markdown headings unless they help the model. Aim for 800-3000 words depending on complexity.`,

  image_system_prompt: `You write the IMAGE-MODE SYSTEM PROMPT used INSTEAD of the main persona whenever the inbound message is a photo. Focus on:
- Acknowledging the photo
- Asking the right follow-up questions
- Setting expectations ("our medical team will review and call you")
- Refusing to give medical advice from a photo alone

Output ONLY the prompt body, no preamble. Keep it shorter than the main persona — usually 200-600 words.`,

  transcription_prompt: `You write a SHORT context blurb (max 200 words, ideally 50-100) that gets fed to OpenAI Whisper as the \`prompt\` parameter so it spells domain-specific terms correctly. Format:
- One sentence describing the conversation type
- Comma-separated list of common terms / brand names / Hinglish phrases that come up
- No instructions to the transcriber, just terminology hints

Output ONLY the blurb. No quotes, no markdown.`,

  rag_core_prompt: `You write a SHORT system prompt (200-500 words max) used in RAG mode. The operator's full knowledge base is retrieved separately as chunks; this prompt only needs to set:
- Identity + tone
- Language rules
- Hard rules (escalate, never reveal AI, etc.)
- An explicit instruction to use ONLY the facts in the "RELEVANT KNOWLEDGE" section that follows

Do NOT include any factual content (pricing, procedures, hours) — those live in chunks. Output ONLY the prompt body.`,

  knowledge_chunk: `You write ONE knowledge chunk for a RAG knowledge base. A chunk is a self-contained 200-500 char block that answers a specific question or covers a specific topic (e.g. "Hair treatment pricing", "Refund policy", "Operating hours"). Output ONLY the chunk text — no source label, no metadata. Keep it factual and concise.`,

  magic_campaign_brief: `You write the BRIEF for a Magic Message campaign — a short instruction the AI will read once per recipient to generate their personalized WhatsApp message. Write the brief AS IF it were the message itself, in proper WhatsApp form, so the operator can read it like a real message and adjust.

Format the output with REAL line breaks, broken into 2-4 short paragraphs separated by blank lines:

  Line 1 — greeting using {{name}} (e.g. "Hi {{name}},")
  Line 2 — blank
  Body  — 1-2 short paragraphs (40-60 words total) explaining what to say
  Line  — blank
  CTA   — soft call to action (Reply YES, share photos, book, etc.)

Other rules:
- Reference the recipient by {{name}} when greeting.
- Mention CSV columns by {{column_name}} ({{date}}, {{doctor}}, {{clinic}}) when relevant.
- Sentences under 18 words. No markdown, no asterisks, no bullets.
- Never include exact prices.
- Mirror the operator's intended language (Hinglish / English / Hindi).
- Cap output at 80 words total.

Output ONLY the brief itself — no preamble, no headings, no surrounding quotes. Use real "\\n" newlines so paragraphs render correctly when pasted into the textarea.`,
};

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const kind = body.kind;
  if (!kind || !(kind in SYSTEM_PROMPTS)) {
    return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
  }
  const instruction = (body.instruction ?? "").trim();
  if (!instruction) {
    return NextResponse.json({ error: "instruction is required" }, { status: 400 });
  }
  if (instruction.length > 4000) {
    return NextResponse.json({ error: "instruction too long" }, { status: 400 });
  }

  const apiKey = await requireCredential("openai_api_key", "OpenAI API key");

  const system = SYSTEM_PROMPTS[kind];
  const userParts: string[] = [];
  if (body.context && body.context.trim()) {
    userParts.push(`Business context:\n${body.context.trim()}`);
  }
  if (body.existing && body.existing.trim()) {
    userParts.push(`Existing value (rewrite / extend, do NOT discard unless asked):\n"""\n${body.existing.trim().slice(0, 8000)}\n"""`);
  }
  userParts.push(`What I want:\n${instruction}`);

  let resp: Response;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.6,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userParts.join("\n\n") },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Network error" },
      { status: 502 },
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return NextResponse.json(
      { error: `OpenAI HTTP ${resp.status}: ${text.slice(0, 200)}` },
      { status: 502 },
    );
  }
  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const text = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "Empty response from OpenAI" }, { status: 502 });
  }
  return NextResponse.json({
    text,
    usage: json.usage ?? null,
  });
}

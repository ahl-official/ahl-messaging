// POST /api/automation/split-system-prompt   { text }
//
// Takes a single big "bot training" system message and asks GPT to split
// it into the three slots the Automation panel actually exposes:
//
//   • system_prompt         — main persona / behaviour for chat replies
//   • image_system_prompt   — instructions for handling customer-sent images
//   • rag_core_prompt       — guidance for using retrieved KB chunks
//
// The operator pastes a long prompt; this endpoint returns the three
// pieces so the UI can pre-fill the form. They can edit + Save normally.
//
// Owner / superadmin / admin only.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { chatCompletion } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface Chunk {
  source: string;
  content: string;
}
interface Result {
  system_prompt: string;
  image_system_prompt: string;
  rag_core_prompt: string;
  chunks: Chunk[];
}

const SPLITTER_SYSTEM = `You are a careful assistant that organises a WhatsApp-bot's full training document into 4 buckets. The operator will paste their entire bot system message; split it without inventing content.

Buckets:
1. "system_prompt"        — the main persona, tone, role, behaviour rules, conversation policies, and reply style. This is the bot's BASE instruction for every chat reply. Keep ONLY the "how to behave" / "how to talk" content here; factual knowledge belongs in "chunks".
2. "image_system_prompt"  — instructions that apply ONLY when the customer sends a photo/image (e.g. how to analyse a hair-loss photo, what to ask next, what counts as a clear photo). If the input has no such section, return an empty string.
3. "rag_core_prompt"      — a short instruction (2-5 sentences) telling the bot HOW to use the retrieved knowledge chunks at runtime. If the input already has such a "use the context"/"refer to knowledge" section, lift it verbatim. If it doesn't — and you are extracting any chunks below — WRITE a fresh one in the same language/tone as bucket 1. It must include: (a) "use only the facts in the RELEVANT KNOWLEDGE / context block to answer factual questions"; (b) "if the answer isn't there, say you'll get back to them — don't invent facts"; (c) keep the persona's voice (Hinglish persona → Hinglish prompt, English persona → English). Return an empty string ONLY when there are zero chunks AND no RAG instructions in the input.
4. "chunks"               — an array of self-contained knowledge units extracted from the input. Each chunk is a small block of FACTS the bot needs to answer customer questions accurately: pricing tables, procedure descriptions, policy details, FAQ answers, clinic hours / location / contact info, treatment options, package details, refund/cancellation rules, etc. Split aggressively by topic — 1 topic = 1 chunk. Each chunk should be readable on its own without needing the others. Aim for 50-400 words per chunk. Use a short "source" label that names the topic (e.g. "Pricing", "FUE procedure", "Refund policy", "Clinic hours"). If the input has no factual knowledge to extract, return an empty array.

Rules:
- Preserve the operator's wording verbatim wherever possible. Light reorganisation + minor connective phrases are fine; rewriting facts is not.
- Don't drop content. Behavioural rules → bucket 1, image-only → 2, RAG-usage → 3, factual knowledge → chunks. Anything that's both behavioural and contains a fact can be light-duplicated.
- Don't invent rules, prices, examples, or sections that aren't in the input.
- Output STRICT JSON: { "system_prompt": "...", "image_system_prompt": "...", "rag_core_prompt": "...", "chunks": [{ "source": "...", "content": "..." }, ...] }. No commentary.`;

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role === "teammate") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { text?: string };
  try {
    body = (await request.json()) as { text?: string };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "Empty input" }, { status: 400 });
  }
  if (text.length > 60_000) {
    return NextResponse.json(
      { error: "Input too long (max ~60k characters)." },
      { status: 400 },
    );
  }

  try {
    const res = await chatCompletion({
      // Bigger response budget — between the 3 prompts and N knowledge
      // chunks the JSON can easily run past 4k output tokens.
      model: "gpt-4o-mini",
      temperature: 0,
      maxTokens: 8000,
      timeoutMs: 90_000,
      jsonMode: true,
      messages: [
        { role: "system", content: SPLITTER_SYSTEM },
        { role: "user", content: text },
      ],
    });

    let parsed: Partial<Result>;
    try {
      parsed = JSON.parse(res.text) as Partial<Result>;
    } catch {
      return NextResponse.json(
        { error: "Model didn't return valid JSON. Try again." },
        { status: 502 },
      );
    }

    const rawChunks = Array.isArray(parsed.chunks) ? parsed.chunks : [];
    const chunks = rawChunks
      .map((c) => ({
        source: String((c as Chunk)?.source ?? "general").trim() || "general",
        content: String((c as Chunk)?.content ?? "").trim(),
      }))
      .filter((c) => c.content.length > 0);

    // Safety net — when we DID extract chunks but the model left
    // rag_core_prompt empty, the bot wouldn't know to use those chunks
    // at runtime. Fall back to a sensible default so the install is
    // never silently half-wired.
    let ragCore = (parsed.rag_core_prompt ?? "").trim();
    if (!ragCore && chunks.length > 0) {
      ragCore =
        "Use ONLY the facts in the RELEVANT KNOWLEDGE block below to answer factual questions. If the answer isn't there, say you'll get back to them — don't invent facts, prices, or policies.";
    }

    return NextResponse.json({
      system_prompt: (parsed.system_prompt ?? "").trim(),
      image_system_prompt: (parsed.image_system_prompt ?? "").trim(),
      rag_core_prompt: ragCore,
      chunks,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Split failed" },
      { status: 500 },
    );
  }
}

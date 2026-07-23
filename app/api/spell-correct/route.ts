// POST /api/spell-correct
//
// Cleans up typos / grammar in the operator's draft reply BEFORE it goes
// out on WhatsApp. Strictly conservative: only fixes spelling, grammar,
// punctuation, and capitalisation. Does NOT rewrite tone, change meaning,
// translate, or add new content. Language is preserved (English, Hindi,
// Hinglish all pass through with their original character set).
//
// Uses the same OpenAI credential as /api/ai-assist so no extra setup.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { requireCredential } from "@/lib/credentials";

export const runtime = "nodejs";
export const maxDuration = 30;

interface Body {
  text?: string;
  /** "spell" (default) = conservative typo/grammar fix, language preserved.
   *  "professional" = translate Hinglish/Hindi/casual into clean, professional
   *  business English. */
  mode?: "spell" | "professional";
}

const SYSTEM_SPELL = `You are a strict text cleaner for a WhatsApp customer-support draft.

Rules:
- Fix only: spelling, grammar, punctuation, capitalisation, obvious typos.
- Preserve the original language exactly — English stays English, Hindi stays Hindi (Devanagari), Hinglish stays Hinglish. Never translate.
- Preserve meaning, tone, length, and voice. Do NOT rephrase, summarise, expand, or add new sentences.
- Preserve emojis, URLs, phone numbers, names, prices, line breaks, and any /shortcut tokens exactly as written.
- If the input is already clean, return it byte-for-byte unchanged.

Output ONLY the corrected text — no preamble, no quotes, no explanation.`;

const SYSTEM_PROFESSIONAL = `You rewrite a customer-support agent's rough draft into clear, professional ENGLISH for a business WhatsApp reply (American Hairline, a non-surgical hair replacement clinic replying to leads).

Rules:
- Translate Hinglish / Hindi / casual text into natural, polished, professional English.
- Keep the original meaning and intent. Preserve every concrete detail exactly: names, prices, dates, times, URLs, phone numbers, /shortcut tokens.
- Warm but professional tone — concise, courteous, no slang, no filler, no over-formality.
- Keep it roughly the same length. Do NOT add new information or invent facts.
- Preserve line breaks; keep at most the emojis that genuinely fit.

Output ONLY the rewritten English message — no preamble, no quotes, no explanation.`;

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const text = (body.text ?? "").toString();
  if (!text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > 4000) {
    return NextResponse.json({ error: "text too long (max 4000 chars)" }, { status: 400 });
  }

  const apiKey = await requireCredential("openai_api_key", "OpenAI API key");
  const professional = body.mode === "professional";

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
        // Spell = deterministic (0). Professional rewrite = a touch of warmth.
        temperature: professional ? 0.4 : 0,
        messages: [
          {
            role: "system",
            content: professional ? SYSTEM_PROFESSIONAL : SYSTEM_SPELL,
          },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Network error" },
      { status: 502 },
    );
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    return NextResponse.json(
      { error: `OpenAI HTTP ${resp.status}: ${txt.slice(0, 200)}` },
      { status: 502 },
    );
  }
  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const corrected = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!corrected) {
    return NextResponse.json({ error: "Empty response from OpenAI" }, { status: 502 });
  }
  return NextResponse.json({ text: corrected });
}

// POST /api/refund-requests/extract  { prospect_id, crm? }
//
// AI auto-fill for the refund form. Fetches the LSQ lead's package
// fields (the same set the "Package Shared" section displays) and asks
// gpt-4o-mini to map them into the refund form's structured columns.
// Returns the extracted values as JSON so the form can prefill them.
//
// Defensive parsing — model output is forced to JSON and re-parsed
// here; on any failure we return null fields rather than crashing the
// form (operator can still type manually).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getLsqConfig, getLsqConfig2, lsqGetLeadById } from "@/lib/lsq";
import { chatCompletion } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Match the same fields the Package Shared section already surfaces.
const PACKAGE_RE =
  /graft|package|\bprp\b|inclus|technique|surgery|booking|\boffer\b|discount|quotation|installment|payment|refund|amount/i;
const EXCLUDE_RE = /disposition|screenshot|stage|status|date_align/i;

const SYSTEM = `You extract refund-form fields from a LeadSquared lead's package fields.

Return STRICT JSON with these keys (use null when unknown — never invent):
{
  "booking_date":      string | null,   // YYYY-MM-DD if you can parse it
  "per_graft_rate":    number | null,   // INR per graft, digits only
  "estimated_grafts":  number | null,   // count of grafts the patient was quoted
  "booking_amount":    number | null,   // INR the patient ALREADY PAID for booking
  "refundable_amount": number | null    // INR refundable (often = booking_amount unless stated)
}

Rules:
- Numbers: digits only, no commas, no currency symbol.
- If multiple grafts numbers exist, prefer "Actual Grafts" > "Number Of Graft" > "Estimated".
- booking_amount = booking advance the patient paid (NOT the total package).
- If refundable_amount isn't stated, mirror booking_amount.
- Dates: ISO date only ("2025-12-30"), strip times.
- Output ONLY the JSON object — no preamble, no markdown fence.`;

interface Extracted {
  booking_date: string | null;
  per_graft_rate: number | null;
  estimated_grafts: number | null;
  booking_amount: number | null;
  refundable_amount: number | null;
}

const EMPTY: Extracted = {
  booking_date: null,
  per_graft_rate: null,
  estimated_grafts: null,
  booking_amount: null,
  refundable_amount: null,
};

function humanise(key: string): string {
  return key.replace(/^mx_/i, "").replace(/_/g, " ").trim();
}

function parseExtracted(text: string): Extracted {
  // Strip possible ```json fences the model sometimes wraps with.
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    const j = JSON.parse(cleaned) as Partial<Extracted>;
    return {
      booking_date:
        typeof j.booking_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(j.booking_date)
          ? j.booking_date
          : null,
      per_graft_rate: typeof j.per_graft_rate === "number" ? j.per_graft_rate : null,
      estimated_grafts:
        typeof j.estimated_grafts === "number" ? Math.round(j.estimated_grafts) : null,
      booking_amount: typeof j.booking_amount === "number" ? j.booking_amount : null,
      refundable_amount:
        typeof j.refundable_amount === "number" ? j.refundable_amount : null,
    };
  } catch {
    return EMPTY;
  }
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { prospect_id?: string; crm?: string };
  try {
    body = (await request.json()) as { prospect_id?: string; crm?: string };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const prospectId = body.prospect_id?.trim();
  if (!prospectId) {
    return NextResponse.json({ error: "prospect_id is required" }, { status: 400 });
  }

  const cfg = body.crm === "secondary" ? getLsqConfig2() : getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json(
      { error: `${cfg.label} is not connected.` },
      { status: 400 },
    );
  }

  const lead = await lsqGetLeadById(prospectId, cfg);
  if (!lead.ok) {
    return NextResponse.json(
      { error: lead.error ?? "Couldn't fetch the CRM lead." },
      { status: 502 },
    );
  }

  const pkgFields = Object.entries(lead.fields).filter(
    ([k, v]) => PACKAGE_RE.test(k) && !EXCLUDE_RE.test(k) && v && String(v).trim(),
  );
  if (pkgFields.length === 0) {
    return NextResponse.json({ extracted: EMPTY, source: "empty" });
  }

  const userMsg = `LeadSquared lead — package fields:\n\n${pkgFields
    .map(([k, v]) => `${humanise(k)}: ${v}`)
    .join("\n")}`;

  try {
    const ai = await chatCompletion({
      model: "gpt-4o-mini",
      temperature: 0,
      maxTokens: 300,
      timeoutMs: 25_000,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg },
      ],
    });
    const extracted = parseExtracted(ai.text);
    return NextResponse.json({ extracted, source: "ai" });
  } catch (e) {
    return NextResponse.json(
      {
        extracted: EMPTY,
        source: "error",
        error: e instanceof Error ? e.message : "AI extraction failed",
      },
      { status: 200 },
    );
  }
}

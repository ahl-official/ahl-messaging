// POST /api/lsq/notes-summary  { prospect_id, crm }
//
// Powers the "Package Shared" section. Returns, for one CRM's lead:
//   • package  — AI summary of the quoted package (from lead fields)
//   • sharedBy — who moved the lead to the "Package Shared" stage
//   • notes    — AI summary of the lead's full activity / notes log
// The two summaries render side by side in the contact panel.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import {
  getLsqConfig,
  getLsqConfig2,
  lsqGetLeadById,
  lsqGetLeadActivities,
} from "@/lib/lsq";
import { chatCompletion } from "@/lib/openai";
import {
  getAiPackagePrompt,
  getAiOutputLanguage,
  aiLanguageInstruction,
} from "@/lib/app-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lead fields that describe the quoted package — matched on field name.
const PACKAGE_RE =
  /graft|package|\bprp\b|inclus|technique|surgery|booking|\boffer\b|discount|quotation|installment|payment/i;
const EXCLUDE_RE = /disposition|screenshot|stage|status|date_align/i;

const NOTES_PROMPT = `You are a CRM assistant for American Hairline, a hair care salon. You are given a lead's activity / notes log from the CRM (newest first).

Give an ULTRA-SHORT status — only what an agent must know right now.

Rules:
- 2 to 3 bullet points MAXIMUM, one short line each. Nothing more.
- Cover the current stage and the single next step. Skip history and detail.
- No preamble, no closing line. Use only what is in the log.`;

/** "mx_Number_Of_Graft" → "Number Of Service" */
function humanise(key: string): string {
  return key.replace(/^mx_/i, "").replace(/_/g, " ").trim();
}

async function runAi(system: string, user: string): Promise<string | null> {
  try {
    const ai = await chatCompletion({
      model: "gpt-4o-mini",
      temperature: 0.2,
      maxTokens: 600,
      timeoutMs: 45_000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return ai.text.trim() || null;
  } catch {
    return null;
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

  // Lead fields (package) + activity log (notes) in one round of calls.
  const [lead, acts, packagePrompt, language] = await Promise.all([
    lsqGetLeadById(prospectId, cfg),
    lsqGetLeadActivities(prospectId, 120, cfg),
    getAiPackagePrompt(),
    getAiOutputLanguage(),
  ]);

  if (!lead.ok) {
    return NextResponse.json(
      { error: lead.error ?? "Couldn't fetch the CRM lead." },
      { status: 502 },
    );
  }
  const langInstr = aiLanguageInstruction(language);
  const activities = acts.ok ? acts.activities : [];

  // Who moved the lead into the "Package Shared" stage.
  let sharedBy: string | null = null;
  for (const a of activities) {
    const d = a.data ?? [];
    const isPkgStage = d.some(
      (x) => /currentstage/i.test(x.key) && /package shared/i.test(x.value),
    );
    if (isPkgStage) {
      sharedBy =
        d.find((x) => /^createdby$/i.test(x.key))?.value ?? null;
      break;
    }
  }

  // Package fields with a value.
  const pkgFields = Object.entries(lead.fields).filter(
    ([k]) => PACKAGE_RE.test(k) && !EXCLUDE_RE.test(k),
  );

  // Activity log → readable dated lines.
  const noteLines = activities
    .map((a) => {
      const date = a.created_on ? a.created_on.slice(0, 10) : "";
      const detail = (a.data ?? [])
        .filter((x) => x.value && x.value.trim())
        .map((x) => `${x.key}: ${x.value}`)
        .join("; ");
      const note = (a.note ?? "").trim();
      const body = [note, detail].filter(Boolean).join(" — ");
      return `[${date}] ${a.event_name}${body ? `: ${body}` : ""}`;
    })
    .slice(0, 100);

  // Two AI summaries in parallel.
  const [packageText, notesText] = await Promise.all([
    pkgFields.length > 0
      ? runAi(
          packagePrompt + langInstr,
          `CRM lead — package fields:\n\n${pkgFields
            .map(([k, v]) => `${humanise(k)}: ${v}`)
            .join("\n")}`,
        )
      : Promise.resolve(null),
    noteLines.length > 0
      ? runAi(
          NOTES_PROMPT + langInstr,
          `CRM activity / notes log:\n\n${noteLines.join("\n")}`,
        )
      : Promise.resolve(null),
  ]);

  return NextResponse.json({
    package: packageText,
    sharedBy,
    notes: notesText,
    label: cfg.label,
  });
}

// POST /api/interakt/backfill-templates  (internal token)
// One-off: re-render Interakt template messages that were ingested before
// the template-card support landed (stored as a plain "📋 Template · …"
// label). Reads each row's raw_payload, renders the full template, and
// updates type/content/header/footer/buttons so the chat shows the card.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import { renderInteraktTemplate } from "@/lib/interakt-format";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const expected = await getCredential("webhook_internal_token");
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || auth !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("messages")
    .select("id, raw_payload, type")
    .like("business_phone_number_id", "interakt:%")
    .not("raw_payload", "is", null)
    .neq("type", "template")
    .limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let updated = 0;
  let scanned = 0;
  for (const row of data ?? []) {
    const payload = row.raw_payload as { data?: { message?: Record<string, unknown> } } | null;
    const m = payload?.data?.message;
    if (!m) continue;
    const isTemplate =
      m.is_template_message === true ||
      String(m.message_content_type ?? "").toLowerCase() === "template";
    if (!isTemplate) continue;
    scanned++;

    const tpl = renderInteraktTemplate(m.raw_template, m.message, (m.media_url as string) ?? null);
    if (!tpl) continue;

    const { error: upErr } = await admin
      .from("messages")
      .update({
        type: "template",
        content: tpl.body || null,
        media_url: tpl.headerUrl,
        media_mime_type: tpl.headerUrl ? "image/*" : null,
        template_name: tpl.name,
        template_footer: tpl.footer,
        template_buttons: tpl.buttons && tpl.buttons.length > 0 ? tpl.buttons : null,
      })
      .eq("id", row.id);
    if (!upErr) updated++;
  }

  return NextResponse.json({ ok: true, scanned, updated });
}

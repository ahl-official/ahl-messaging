// GET /api/interakt/inspect?wa=<digits>  (internal token) — one-off debug.
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const expected = await getCredential("webhook_internal_token");
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || auth !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const wa = request.nextUrl.searchParams.get("wa")?.replace(/\D/g, "") ?? "";
  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id")
    .eq("wa_id", wa)
    .like("business_phone_number_id", "interakt:%")
    .maybeSingle();
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });

  const { data: msgs } = await admin
    .from("messages")
    .select("type, content, template_name, media_url, raw_payload")
    .eq("contact_id", contact.id)
    .order("timestamp", { ascending: false })
    .limit(3);

  const out = (msgs ?? []).map((m) => {
    const mm = (m.raw_payload as { data?: { message?: Record<string, unknown> } } | null)?.data?.message ?? {};
    return {
      type: m.type,
      content: m.content,
      template_name: m.template_name,
      has_media: !!m.media_url,
      is_template_message: mm.is_template_message ?? null,
      message_content_type: mm.message_content_type ?? null,
      raw_template_present: !!mm.raw_template,
      raw_template_head: typeof mm.raw_template === "string" ? (mm.raw_template as string).slice(0, 200) : mm.raw_template ? "(object)" : null,
      message_field: typeof mm.message === "string" ? (mm.message as string).slice(0, 120) : null,
    };
  });
  return NextResponse.json({ messages: out });
}

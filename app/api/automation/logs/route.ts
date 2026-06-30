import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { formatPhone } from "@/lib/phone";

export const runtime = "nodejs";

// =====================================================================
// GET /api/automation/logs?limit=50
// Latest automation runs (success / skipped / failed) for the activity
// feed on the Automation settings page.
// =====================================================================
export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = Math.min(
    Math.max(parseInt(request.nextUrl.searchParams.get("limit") ?? "50", 10) || 50, 1),
    200,
  );
  // Optional ?business_phone_number_id=X to scope the activity feed to a
  // single number — used by the Automation page when an admin picks a
  // number from the dropdown.
  const phoneNumberId = request.nextUrl.searchParams.get("business_phone_number_id");
  // Quality-review queue: only successful replies that haven't been
  // rated yet.
  const unreviewed = request.nextUrl.searchParams.get("unreviewed") === "1";

  const admin = createServiceRoleClient();
  let query = admin
    .from("automation_logs")
    .select(
      "id, contact_id, business_phone_number_id, status, skip_reason, model, prompt_tokens, completion_tokens, duration_ms, cleaned_output, error_message, created_at, quality_rating, quality_note, quality_reviewed_at, quality_reviewed_by, rag_chunks",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (phoneNumberId) {
    query = query.eq("business_phone_number_id", phoneNumberId);
  }
  if (unreviewed) {
    query = query.eq("status", "success").is("quality_rating", null);
  }
  const { data: logs, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Decorate with contact display name + wa_id so the UI doesn't need
  // a second round-trip per row.
  const contactIds = [...new Set((logs ?? []).map((l) => l.contact_id).filter(Boolean))];
  const { data: contacts } = await admin
    .from("contacts")
    .select("id, name, profile_name, wa_id")
    .in("id", contactIds.length > 0 ? contactIds : ["00000000-0000-0000-0000-000000000000"]);
  const byId = new Map((contacts ?? []).map((c) => [c.id, c]));

  // Latest inbound message per contact — the trigger context the
  // operator needs to judge whether the bot's reply was good. One
  // query, then dedupe to first-seen per contact (rows arrive in
  // newest-first order).
  const latestInboundByContact = new Map<
    string,
    { content: string | null; type: string; timestamp: string }
  >();
  if (contactIds.length > 0) {
    const { data: inboundMsgs } = await admin
      .from("messages")
      .select("contact_id, content, type, timestamp")
      .in("contact_id", contactIds)
      .eq("direction", "inbound")
      .order("timestamp", { ascending: false })
      .limit(500);
    for (const m of (inboundMsgs ?? []) as Array<{
      contact_id: string;
      content: string | null;
      type: string;
      timestamp: string;
    }>) {
      if (!latestInboundByContact.has(m.contact_id)) {
        latestInboundByContact.set(m.contact_id, {
          content: m.content,
          type: m.type,
          timestamp: m.timestamp,
        });
      }
    }
  }

  const decorated = (logs ?? []).map((log) => ({
    ...log,
    contact:
      log.contact_id && byId.has(log.contact_id)
        ? {
            id: log.contact_id,
            display:
              byId.get(log.contact_id)!.name?.trim() ||
              byId.get(log.contact_id)!.profile_name?.trim() ||
              formatPhone(byId.get(log.contact_id)!.wa_id),
            wa_id: byId.get(log.contact_id)!.wa_id,
          }
        : null,
    trigger_inbound: log.contact_id
      ? latestInboundByContact.get(log.contact_id) ?? null
      : null,
  }));

  return NextResponse.json({ logs: decorated });
}

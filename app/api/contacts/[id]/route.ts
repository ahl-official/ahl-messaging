// DELETE /api/contacts/[id]?mode=history|contact
//   mode=history → delete all messages for this contact, keep the contact row
//   mode=contact → delete the contact entirely (cascades messages + notes + logs)
//
// PATCH  /api/contacts/[id]   body: { status?: 'open' | 'closed', lsq_stage?: string | null }
//   Toggle open/closed and/or update the cached pipeline stage on the
//   contact row. Any logged-in operator who can see the contact may
//   update these fields.
//
// Owner-only DELETE. Logged to console for the audit trail. Used by the
// Settings → Data page.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { ALL_LEAD_STAGES } from "@/lib/lead-stages";

const ALLOWED_STAGES = new Set<string>(ALL_LEAD_STAGES);

export const runtime = "nodejs";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  let body: { status?: string; lsq_stage?: string | null };
  try {
    body = (await request.json()) as { status?: string; lsq_stage?: string | null };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const updates: Record<string, string | null> = {};

  if (body.status !== undefined) {
    const status = body.status.trim();
    if (status !== "open" && status !== "closed") {
      return NextResponse.json(
        { error: "status must be 'open' or 'closed'" },
        { status: 400 },
      );
    }
    updates.status = status;
  }

  if (body.lsq_stage !== undefined) {
    if (body.lsq_stage === null || body.lsq_stage === "") {
      updates.lsq_stage = null;
    } else {
      const stage = String(body.lsq_stage).trim();
      if (!ALLOWED_STAGES.has(stage)) {
        return NextResponse.json({ error: "Invalid lsq_stage" }, { status: 400 });
      }
      updates.lsq_stage = stage;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("contacts")
    .update(updates)
    .eq("id", id)
    .select("id, status, lsq_stage")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  return NextResponse.json({
    ok: true,
    status: data.status,
    lsq_stage: data.lsq_stage,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const mode = request.nextUrl.searchParams.get("mode") ?? "history";

  const admin = createServiceRoleClient();

  // Lookup wa_id for the audit log line.
  const { data: contactRow } = await admin
    .from("contacts")
    .select("wa_id, name")
    .eq("id", id)
    .maybeSingle();
  if (!contactRow) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  if (mode === "contact") {
    // Cascade: messages, notes, automation_logs all FK to contact_id with
    // ON DELETE CASCADE / SET NULL — Postgres handles cleanup.
    const { error } = await admin.from("contacts").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    console.log(
      `[data] Deleted contact ${contactRow.wa_id} (${contactRow.name ?? "—"}) by ${member.email}`,
    );
    return NextResponse.json({ ok: true, mode: "contact" });
  }

  // mode === "history" — delete messages only, reset contact preview.
  const { error: mErr, count } = await admin
    .from("messages")
    .delete({ count: "exact" })
    .eq("contact_id", id);
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });

  // Wipe contact preview + unread so the chat list reflects the cleared state.
  // Also reset the LSQ cache (prospect_id + lead snapshot fields) — when an
  // operator clears a chat they're starting that contact fresh, so the next
  // inbound msg should re-run ensure-lead and pick up whatever lead exists
  // (or create a new one) rather than trusting potentially stale state from
  // before. This also covers the case where the CRM lead was deleted in the
  // CRM separately and the operator is "resetting" this end too.
  await admin
    .from("contacts")
    .update({
      last_message_at: null,
      last_message_preview: null,
      unread_count: 0,
      lsq_prospect_id: null,
      lsq_synced_at: null,
      lsq_stage: null,
      lsq_lead_number: null,
      lsq_owner_name: null,
    })
    .eq("id", id);

  // Also wipe automation_logs for this contact so the activity feed doesn't
  // reference deleted messages. trigger_message_id / reply_message_id are
  // ON DELETE SET NULL so the log rows themselves stay valid, but the user
  // wanting a "clear chat history" almost certainly wants logs gone too.
  await admin.from("automation_logs").delete().eq("contact_id", id);

  console.log(
    `[data] Cleared chat history for ${contactRow.wa_id} (${count ?? 0} messages) by ${member.email}`,
  );
  return NextResponse.json({ ok: true, mode: "history", deleted_messages: count ?? 0 });
}

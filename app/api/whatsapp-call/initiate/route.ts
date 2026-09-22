// POST /api/whatsapp-call/initiate
//
// Step 1 of the outbound dial flow. We try to send a Call Permission
// Request (CPR) to the contact. Three outcomes:
//
//   1. CPR sent successfully            → permission_state="pending"
//      The user must tap Allow before we can dial. UI shows
//      "Waiting for permission".
//
//   2. Meta replies with error #138017  → permission_state="granted"
//      ("the business account can already call this consumer").
//      We're free to dial right away — UI proceeds straight to the
//      WebRTC offer flow via /api/whatsapp-call/dial.
//
//   3. Any other error                  → permission_state="error"
//      Usually a misconfiguration. Surface to the operator.
//
// Either way we drop a synthetic "permission request" row into the
// messages table so the chat thread shows the request was sent.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { sendCallPermissionRequest } from "@/lib/whatsapp";
import { getWindowState } from "@/lib/whatsapp-window";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: { contact_id?: string; body?: string };
  try {
    payload = (await request.json()) as { contact_id?: string; body?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const contactId = payload.contact_id;
  if (!contactId) {
    return NextResponse.json({ error: "contact_id required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id, business_phone_number_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact || !contact.wa_id) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  if (!contact.business_phone_number_id) {
    return NextResponse.json(
      { error: "Contact has no business number associated" },
      { status: 400 },
    );
  }

  // 24h customer service window must be open — Meta rejects CPR with
  // "Re-engagement message" (#131047) otherwise. Cheaper to bail here
  // than to ship a ghost bubble that webhook-flips to failed.
  const { data: recent } = await admin
    .from("messages")
    .select("direction, timestamp")
    .eq("contact_id", contact.id)
    .order("timestamp", { ascending: false })
    .limit(50);
  const window = getWindowState((recent ?? []).reverse());
  if (!window.isOpen) {
    return NextResponse.json(
      {
        ok: false,
        permission_state: "error",
        error: "24h window closed — send a Magic Message first to call.",
      },
      { status: 409 },
    );
  }

  const body =
    payload.body?.trim() ||
    "We'd like to call you on WhatsApp. Tap Allow to receive the call.";

  let waMessageId: string | null = null;
  let permissionState: "pending" | "granted" | "error" = "pending";
  let error: string | null = null;

  // Short-circuit when the client has ALREADY accepted a prior CPR.
  // Without this, every "Call" click fires another CPR — eventually
  // tripping Meta's per-pair rate limit (#138009) and locking the
  // operator out of dialing even though permission is on file.
  // The webhook's call_permission_reply handler keeps this row in
  // sync; we honour expires_at so a lapsed grant falls through to a
  // fresh CPR rather than dialing into a definitely-rejected call.
  const { data: existingPermission } = await admin
    .from("whatsapp_call_permissions")
    .select("state, expires_at")
    .eq("contact_id", contact.id)
    .maybeSingle();
  const grantStillValid =
    existingPermission?.state === "granted" &&
    (!existingPermission.expires_at ||
      new Date(existingPermission.expires_at).getTime() > Date.now());

  if (grantStillValid) {
    permissionState = "granted";
  } else {
    try {
      const res = await sendCallPermissionRequest(
        contact.wa_id,
        body,
        contact.business_phone_number_id,
      );
      waMessageId = res.messages?.[0]?.id ?? null;
      await admin
        .from("whatsapp_call_permissions")
        .upsert(
          {
            contact_id: contact.id,
            state: "pending",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "contact_id" },
        );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // #138017 — "can already call this consumer". Mark granted.
      // #138009 — "Limit reached for call permission request sends".
      // We only hit the limit because earlier CPRs went through;
      // typically one of those was accepted. Treat as granted and
      // attempt the dial; if Meta rejects the dial, that surfaces as
      // a separate /dial error which the operator can act on.
      if (/138017/.test(msg) || /can already call/i.test(msg)) {
        permissionState = "granted";
        await admin
          .from("whatsapp_call_permissions")
          .upsert(
            {
              contact_id: contact.id,
              state: "granted",
              granted_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "contact_id" },
          );
      } else if (/138009/.test(msg) || /limit reached/i.test(msg)) {
        permissionState = "granted";
      } else {
        permissionState = "error";
        error = msg;
      }
    }
  }

  // Drop a synthetic outbound row in messages so the chat thread
  // surfaces the action. The bubble shows up beside the operator's
  // other outbound messages with a phone glyph + status copy.
  if (waMessageId || permissionState === "granted") {
    const nowIso = new Date().toISOString();
    const preview =
      permissionState === "granted"
        ? "📞 Calling on WhatsApp…"
        : "📞 Call permission requested";
    await admin.from("messages").insert({
      contact_id: contact.id,
      wa_message_id: waMessageId,
      direction: "outbound",
      type: "call_permission_request",
      content:
        permissionState === "granted"
          ? "🔔 Permission already granted — dialing now…"
          : "🔔 Sent a WhatsApp call permission request. Waiting for the client to tap Allow.",
      status: "sent",
      timestamp: nowIso,
      business_phone_number_id: contact.business_phone_number_id,
      sent_by_user_id: member.user_id,
      sent_by_email: member.email,
    });
    // A call is also a conversation — bump the contact so the inbox
    // sort surfaces it. Without this, even after multiple CPRs the
    // contact stays buried under unrelated chats with newer messages.
    await admin
      .from("contacts")
      .update({
        last_message_at: nowIso,
        last_message_preview: preview,
        last_message_direction: "outbound",
        last_message_status: "sent",
      })
      .eq("id", contact.id);
  }

  if (permissionState === "error") {
    return NextResponse.json(
      { ok: false, permission_state: "error", error },
      { status: 502 },
    );
  }
  return NextResponse.json({
    ok: true,
    permission_state: permissionState,
    wa_message_id: waMessageId,
  });
}

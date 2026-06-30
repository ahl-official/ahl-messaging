// POST /api/whatsapp-call/dial
//
// Step 2 of the outbound dial flow. Browser has already collected
// mic audio and produced an SDP offer; we hand that to Meta's
// /{phoneNumberId}/calls endpoint with action=connect, get back a
// call_id, and seed a `whatsapp_calls` row so the overlay + history
// page see the leg.
//
// The server NEVER touches the SDP — it's an opaque payload going
// straight to Meta. Our role here is auth + audit + bridging the
// browser to the server-only access token.
//
// Body: { contact_id: string, sdp_offer: string }

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { initiateOutboundCall } from "@/lib/whatsapp";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: { contact_id?: string; sdp_offer?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!payload.contact_id || !payload.sdp_offer) {
    return NextResponse.json(
      { error: "contact_id and sdp_offer required" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id, business_phone_number_id")
    .eq("id", payload.contact_id)
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

  const result = await initiateOutboundCall(
    contact.wa_id,
    payload.sdp_offer,
    contact.business_phone_number_id,
  );
  if (!result.ok || !result.callId) {
    // Surface Meta's exact reason in PM2 logs so we can diagnose why
    // outbound calls are silently failing (CallOverlay only shows a
    // short toast; the raw Meta error body never reached the operator
    // or the support inbox without this log line).
    console.error(
      `[whatsapp-call/dial] Meta rejected outbound call wa_id=${contact.wa_id} bpid=${contact.business_phone_number_id} error="${result.error ?? "unknown"}" raw=${JSON.stringify(result.raw)?.slice(0, 500)}`,
    );

    // Drop a visible "Call failed" bubble in the chat thread so the
    // operator sees WHY without digging into DevTools / PM2 logs.
    // Uses a synthetic wa_message_id so re-dialing right after this
    // doesn't deduplicate against the original.
    const errMsg = result.error ?? "Dial failed (no reason from Meta)";
    await admin.from("messages").insert({
      contact_id: contact.id,
      wa_message_id: `local:dial-fail:${Date.now()}`,
      direction: "outbound",
      type: "text",
      content: `📞 Call failed — ${errMsg}`,
      status: "failed",
      error_message: errMsg,
      timestamp: new Date().toISOString(),
      business_phone_number_id: contact.business_phone_number_id,
      sent_by_user_id: member.user_id,
      sent_by_email: member.email,
    });

    return NextResponse.json(
      { ok: false, error: result.error ?? "Dial failed", raw: result.raw },
      { status: 502 },
    );
  }

  const now = new Date().toISOString();
  await admin.from("whatsapp_calls").upsert(
    {
      wa_call_id: result.callId,
      contact_id: contact.id,
      business_phone_number_id: contact.business_phone_number_id,
      direction: "outbound",
      status: "ringing",
      sdp_offer: payload.sdp_offer,
      start_at: now,
      handled_by_user_id: member.user_id,
      handled_by_email: member.email,
    },
    { onConflict: "wa_call_id" },
  );

  return NextResponse.json({ ok: true, wa_call_id: result.callId });
}

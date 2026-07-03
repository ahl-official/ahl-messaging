// POST /api/whatsapp-call/respond
//
// Server-side signaling pass-through for an active call. The browser
// (WebRTC client) calls us with the call_id, the action it wants to
// take, and (for accept) the SDP answer it generated locally. We
// forward to Meta's /messages endpoint with the bearer token —
// the token never leaves the server, so the browser never sees
// portfolio creds.
//
// Body: {
//   call_id: string,
//   action: "pre_accept" | "accept" | "reject" | "terminate",
//   sdp_answer?: string,
// }
//
// The ringing → accepted/rejected/terminated DB transitions are
// driven by the WEBHOOK, not this route — Meta echoes whatever
// state changes back to us, so we let the webhook be authoritative
// instead of double-writing here.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { respondToCallSignal } from "@/lib/whatsapp";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: {
    call_id?: string;
    action?: "pre_accept" | "accept" | "reject" | "terminate";
    sdp_answer?: string;
  };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!payload.call_id || !payload.action) {
    return NextResponse.json(
      { error: "call_id and action are required" },
      { status: 400 },
    );
  }

  // Look up the original call leg so we know which phone_number_id
  // to use for the response — calls are scoped per business number.
  const admin = createServiceRoleClient();
  const { data: leg } = await admin
    .from("whatsapp_calls")
    .select(
      "business_phone_number_id, handled_by_user_id, handled_by_email, status, contact_id, raw_payload",
    )
    .eq("wa_call_id", payload.call_id)
    .maybeSingle();
  if (!leg?.business_phone_number_id) {
    return NextResponse.json(
      { error: "Call leg not found — cannot determine business number" },
      { status: 404 },
    );
  }

  // Atomic claim BEFORE forwarding to Meta — two operators clicking
  // Accept at the same millisecond would otherwise both signal `accept`
  // to Meta and both pin themselves on the row. Whoever wins the
  // conditional UPDATE owns the call; the loser gets told to back off.
  if (payload.action === "accept") {
    if (leg.handled_by_user_id && leg.handled_by_user_id !== member.user_id) {
      return NextResponse.json(
        {
          ok: false,
          error: "already_claimed",
          claimed_by: leg.handled_by_email,
        },
        { status: 409 },
      );
    }
    const { data: claimed, error: claimErr } = await admin
      .from("whatsapp_calls")
      .update({
        handled_by_user_id: member.user_id,
        handled_by_email: member.email,
      })
      .eq("wa_call_id", payload.call_id)
      .is("handled_by_user_id", null)
      .select("wa_call_id")
      .maybeSingle();
    if (claimErr) {
      return NextResponse.json({ error: claimErr.message }, { status: 500 });
    }
    if (!claimed) {
      // Race lost — another operator's row update beat ours.
      const { data: winner } = await admin
        .from("whatsapp_calls")
        .select("handled_by_email")
        .eq("wa_call_id", payload.call_id)
        .maybeSingle();
      return NextResponse.json(
        {
          ok: false,
          error: "already_claimed",
          claimed_by: winner?.handled_by_email ?? null,
        },
        { status: 409 },
      );
    }
  }

  const result = await respondToCallSignal(payload.call_id, payload.action, {
    sdpAnswer: payload.sdp_answer,
    phoneNumberId: leg.business_phone_number_id,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error ?? "Signal failed" },
      { status: 502 },
    );
  }

  // Terminal actions — stamp status locally NOW instead of waiting for
  // Meta's webhook echo. Meta sometimes drops or delays the terminate
  // event, leaving the row stuck on 'accepted'/'ringing' and the
  // CallOverlay card refusing to disappear. The webhook still lands
  // later and updates duration_seconds correctly — this just gives the
  // operator's UI an instant exit.
  if (payload.action === "terminate" || payload.action === "reject") {
    const endIso = new Date().toISOString();
    const { data: row } = await admin
      .from("whatsapp_calls")
      .select("status, accepted_at, start_at")
      .eq("wa_call_id", payload.call_id)
      .maybeSingle();
    const wasAccepted =
      row?.status === "accepted" || !!row?.accepted_at;
    const nextStatus =
      payload.action === "reject"
        ? "rejected"
        : wasAccepted
          ? "terminated"
          : "missed";
    const anchor = row?.accepted_at ?? null;
    const durationSeconds = anchor
      ? Math.max(
          0,
          Math.round(
            (new Date(endIso).getTime() - new Date(anchor).getTime()) / 1000,
          ),
        )
      : 0;
    await admin
      .from("whatsapp_calls")
      .update({
        status: nextStatus,
        end_at: endIso,
        duration_seconds: durationSeconds,
      })
      .eq("wa_call_id", payload.call_id);
  }

  // Stamp the operator who answered onto the row so the history page
  // can show "answered by <agent>". Also flip status → accepted +
  // record accepted_at: Meta does not always echo our own accept as
  // a separate webhook event, and without this the subsequent
  // `terminate` would resolve to "missed" because the row is still
  // sitting at "ringing".
  if (payload.action === "accept") {
    const acceptedAt = new Date().toISOString();
    // Compute ring_seconds against the existing start_at so the
    // history page can show "rang for 6s, talked for 1m04s".
    const { data: row } = await admin
      .from("whatsapp_calls")
      .select("start_at")
      .eq("wa_call_id", payload.call_id)
      .maybeSingle();
    const ringSeconds = row?.start_at
      ? Math.max(
          0,
          Math.round(
            (new Date(acceptedAt).getTime() -
              new Date(row.start_at).getTime()) /
              1000,
          ),
        )
      : null;
    // handled_by_* already stamped by the atomic claim above.
    await admin
      .from("whatsapp_calls")
      .update({
        status: "accepted",
        accepted_at: acceptedAt,
        ring_seconds: ringSeconds,
      })
      .eq("wa_call_id", payload.call_id);

    // Unknown caller — call leg has no contact_id because the client
    // had never messaged this business number before. Auto-create the
    // contact row so the agent can click through to a real chat thread
    // post-call, and back-link it on the call row. The wa_id comes
    // from the raw Meta payload we captured at ring time.
    if (!leg.contact_id) {
      const raw = leg.raw_payload as { from?: string; to?: string } | null;
      const waId = (raw?.from ?? raw?.to ?? "").replace(/\D/g, "");
      if (waId.length >= 7) {
        const { data: existing } = await admin
          .from("contacts")
          .select("id")
          .eq("wa_id", waId)
          .eq("business_phone_number_id", leg.business_phone_number_id)
          .maybeSingle();
        let contactId = existing?.id ?? null;
        if (!contactId) {
          const { data: created } = await admin
            .from("contacts")
            .insert({
              wa_id: waId,
              business_phone_number_id: leg.business_phone_number_id,
              status: "open",
            })
            .select("id")
            .single();
          contactId = created?.id ?? null;
        }
        if (contactId) {
          await admin
            .from("whatsapp_calls")
            .update({ contact_id: contactId })
            .eq("wa_call_id", payload.call_id);
        }
      }
    }
  }

  return NextResponse.json({ ok: true, raw: result.raw });
}

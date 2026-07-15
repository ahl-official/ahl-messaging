import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

// WAHA sends one message per webhook call, not arrays like Evolution
// This handler normalises WAHA payloads and processes them

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ session: string }> },
) {
  const { session } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const event = body.event as string;
  const payload = body.payload as Record<string, unknown> | undefined;

  if (!event || !payload) {
    return NextResponse.json({ ok: true });
  }

  const supabase = createServiceRoleClient();

  // Look up the business number by WAHA session name
  const { data: bizNumber } = await supabase
    .from("business_numbers")
    .select("phone_number_id, display_phone_number, evolution_instance_name")
    .eq("evolution_instance_name", session)
    .in("provider", ["evolution", "waha"])
    .single();

  if (!bizNumber) {
    console.error(`[WAHA webhook] No business number found for session: ${session}`);
    return NextResponse.json({ ok: true });
  }

  const bpid = bizNumber.phone_number_id;

  // Handle each WAHA event type
  switch (event) {
    case "session.status": {
      // WAHA: { status: "WORKING"|"STOPPED"|"FAILED", me: { id, pushName } }
      const status = payload.status as string;
      const me = payload.me as { id?: string; pushName?: string } | undefined;

      const connectionState =
        status === "WORKING"
          ? "open"
          : status === "STOPPED" || status === "FAILED"
            ? "close"
            : "connecting";

      await supabase
        .from("business_numbers")
        .update({
          evolution_connection_state: connectionState,
          evolution_last_state_at: new Date().toISOString(),
          ...(me?.id ? { evolution_jid: me.id } : {}),
          ...(me?.pushName ? { verified_name: me.pushName } : {}),
        })
        .eq("phone_number_id", bpid);

      if (connectionState === "close") {
        await supabase.from("evolution_disconnects").insert({
          business_phone_number_id: bpid,
          reason_code: 0,
          occurred_at: new Date().toISOString(),
        });
      }
      break;
    }

    case "message":
    case "message.any": {
      // WAHA inbound message
      // payload: { id, timestamp, from, fromMe, to, body, hasMedia, ack, ackName }
      const fromMe = payload.fromMe as boolean;
      const from = payload.from as string;
      const to = payload.to as string;
      const body_text = payload.body as string | undefined;
      const msgId = payload.id as string;
      const timestamp = payload.timestamp as number;
      const hasMedia = payload.hasMedia as boolean;

      // Skip messages sent by us (fromMe) unless it's message.any and we want outbound tracking
      if (event === "message" && fromMe) break;

      // Skip group messages, broadcasts, newsletters for now
      if (
        from?.includes("@g.us") ||
        from?.includes("@broadcast") ||
        from?.includes("@newsletter")
      ) {
        break;
      }

      // WAHA sometimes sends @lid (Linked Device ID) instead of real phone number
      // Real phone number is in _data.Info.SenderAlt for inbound
      // or _data.Info.RecipientAlt for outbound
      const rawData = payload._data as Record<string, unknown> | undefined;
      const info = rawData?.Info as Record<string, unknown> | undefined;

      function extractPhone(jid: string | undefined): string {
        if (!jid) return "";
        return jid.replace(/@.*$/, "").replace(/\D/g, "");
      }

      let contactWaId: string;
      if (fromMe) {
        // Outbound — the contact is the recipient
        const recipientAlt = info?.RecipientAlt as string | undefined;
        contactWaId = extractPhone(recipientAlt || to);
      } else {
        // Inbound — the contact is the sender
        // Prefer SenderAlt (real phone) over from (which may be @lid)
        const senderAlt = info?.SenderAlt as string | undefined;
        const fromPhone = from?.includes("@lid") ? senderAlt : from;
        contactWaId = extractPhone(fromPhone || from);
      }

      // Also get push name
      const pushName = (payload.pushName || info?.PushName) as string | undefined;

      const now = new Date().toISOString();
      const msgTimestamp = timestamp
        ? new Date(timestamp * 1000).toISOString()
        : now;

      // Upsert contact, then SELECT — PostgREST upsert+select can omit the
      // row on conflict, leaving contact.id undefined for later updates.
      await supabase.from("contacts").upsert(
        {
          wa_id: contactWaId,
          business_phone_number_id: bpid,
          last_message_at: msgTimestamp,
          last_message_preview: body_text?.slice(0, 200) || "",
          last_message_direction: fromMe ? "outbound" : "inbound",
          ...(pushName ? { profile_name: pushName } : {}),
        },
        {
          onConflict: "wa_id,business_phone_number_id",
          ignoreDuplicates: false,
        },
      );
      const { data: contact } = await supabase
        .from("contacts")
        .select("id, unread_count")
        .eq("wa_id", contactWaId)
        .eq("business_phone_number_id", bpid)
        .single();

      if (!contact) break;

      // Update unread count for inbound messages
      if (!fromMe) {
        await supabase
          .from("contacts")
          .update({ unread_count: (contact.unread_count || 0) + 1 })
          .eq("id", contact.id);
      }

      // Auto-create lead in AHL Firebase CRM for new inbound contacts
      if (!fromMe && contact) {
        try {
          const { ahlEnsureLeadForContact } = await import("@/lib/ahl-crm");
          await ahlEnsureLeadForContact(supabase, {
            contactId: contact.id,
            mobileNo: contactWaId,
            clientName: pushName || undefined,
          });
        } catch (e) {
          console.error(
            "[waha-webhook] ahl-crm import/ensure failed:",
            e instanceof Error ? e.message : e,
          );
        }
      }

      // Determine message type
      let msgType = "text";
      if (hasMedia) {
        const mimeType = (payload.mimetype as string) || "";
        if (mimeType.startsWith("image/")) msgType = "image";
        else if (mimeType.startsWith("video/")) msgType = "video";
        else if (mimeType.startsWith("audio/")) msgType = "audio";
        else msgType = "document";
      }

      // Insert message
      await supabase.from("messages").upsert(
        {
          wa_message_id: msgId,
          contact_id: contact.id,
          business_phone_number_id: bpid,
          direction: fromMe ? "outbound" : "inbound",
          type: msgType,
          content: body_text || null,
          status: fromMe ? "sent" : null,
          timestamp: msgTimestamp,
          wa_id: contactWaId,
          sender_name: pushName || null,
          raw_payload: payload,
        },
        { onConflict: "wa_message_id", ignoreDuplicates: true },
      );

      // Trigger AI automation for inbound messages
      if (!fromMe) {
        await supabase
          .from("contacts")
          .update({ automation_pending_at: now })
          .eq("id", contact.id);
      }

      break;
    }

    case "message.ack": {
      // WAHA: { id, from, fromMe, ack, ackName }
      // ack: 1=PENDING, 2=SERVER, 3=DELIVERY_ACK, 4=READ, 5=PLAYED
      const msgId = payload.id as string;
      const ack = payload.ack as number;

      const statusMap: Record<number, string> = {
        1: "sent",
        2: "delivered",
        3: "delivered",
        4: "read",
        5: "played",
      };

      const newStatus = statusMap[ack] || "sent";

      await supabase
        .from("messages")
        .update({ status: newStatus })
        .eq("wa_message_id", msgId);

      break;
    }

    case "message.revoked": {
      // WAHA: message deleted by sender
      const key = payload.key as { id?: string } | undefined;
      const msgId = (payload.id as string) || key?.id;
      if (msgId) {
        await supabase
          .from("messages")
          .update({ deleted_at: new Date().toISOString() })
          .eq("wa_message_id", msgId);
      }
      break;
    }

    default:
      // Log unhandled events for debugging
      console.log(
        `[WAHA webhook] Unhandled event: ${event} for session: ${session}`,
      );
  }

  return NextResponse.json({ ok: true });
}

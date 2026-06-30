// GET /api/contacts/[id]/photos
//
// All media exchanged with a contact (photos + voice notes / audio),
// both directions, newest-first. Despite the route name we include
// audio too so the right-rail "Media" strip shows the full WhatsApp-
// style media gallery — patient-sent and team-sent alike. The
// component renders thumbnails for photos and a compact audio chip
// for voice notes. Source is the local `messages` table — same
// Supabase Storage bucket the webhook caches into.
//
// Auth: any signed-in team member.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isEphemeralWhatsAppMedia } from "@/lib/media-url";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: contactId } = await params;
  if (!contactId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("messages")
    .select(
      "id, direction, type, media_url, media_mime_type, content, transcript, timestamp, wa_message_id, business_phone_number_id",
    )
    .eq("contact_id", contactId)
    .in("type", ["image", "audio", "voice"])
    .not("media_url", "is", null)
    .order("timestamp", { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    photos: (data ?? []).map((m) => {
      const mime = (m.media_mime_type ?? "") as string;
      // Classify by MIME first (the type field has been wrong before
      // — Meta saving video as image, etc.). Falls back to msg.type
      // for legacy rows that pre-date the mime-first webhook.
      const kind = mime.startsWith("audio/")
        ? "audio"
        : mime.startsWith("image/")
          ? "image"
          : (m.type as string) === "audio" || (m.type as string) === "voice"
            ? "audio"
            : "image";
      // Media now lands in Supabase Storage at webhook time (permanent
      // public url). Only legacy rows still hold the encrypted WhatsApp
      // CDN url — for those we fall back to the live decrypt proxy.
      const bpid = (m.business_phone_number_id as string | null) ?? "";
      const wamid = m.wa_message_id as string | null;
      const rawUrl = (m.media_url as string | null) ?? "";
      const url =
        bpid.startsWith("evo:") && wamid && isEphemeralWhatsAppMedia(rawUrl)
          ? `/api/evolution/media/${encodeURIComponent(wamid)}`
          : rawUrl;
      return {
        id: m.id,
        direction: (m.direction as "inbound" | "outbound") ?? "inbound",
        kind,
        url,
        mime: mime || (kind === "audio" ? "audio/ogg" : "image/jpeg"),
        caption: (m.content ?? "") as string,
        transcript: (m.transcript ?? null) as string | null,
        timestamp: m.timestamp as string,
      };
    }),
  });
}

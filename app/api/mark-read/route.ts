import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { markMessageRead } from "@/lib/whatsapp";

export const runtime = "nodejs";

interface Body {
  contact_id: string;
  /** When true, also show "typing…" on the user's WhatsApp for ~25s. */
  typing?: boolean;
}

// =====================================================================
// POST /api/mark-read
//
// Marks the most recent inbound WhatsApp message for a contact as read on
// Meta's side (delivers blue ticks). Optional `typing: true` piggy-backs the
// "typing…" indicator on the same call — Meta only exposes that behaviour
// alongside a read receipt, so the two share an endpoint.
// =====================================================================
export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.contact_id) {
    return NextResponse.json({ error: "contact_id required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();

  // Find the latest inbound message we have for this contact. We need its
  // `wa_message_id` (the wamid Meta gave us) — without it the API call has
  // nothing to ack.
  const { data: latest } = await admin
    .from("messages")
    .select("wa_message_id, business_phone_number_id")
    .eq("contact_id", body.contact_id)
    .eq("direction", "inbound")
    .not("wa_message_id", "is", null)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest?.wa_message_id) {
    // First-time conversation with no inbound yet (e.g. agent reaching out
    // proactively via template). Nothing to mark — silent no-op.
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Interakt numbers don't use Meta's graph (no creds for an "interakt:" id)
  // and Interakt exposes no read-receipt API — skip the Meta call so it
  // doesn't 502. The local unread badge is already cleared client-side.
  if (latest.business_phone_number_id?.startsWith("interakt:")) {
    return NextResponse.json({ ok: true, skipped: true, provider: "interakt" });
  }

  try {
    await markMessageRead(latest.wa_message_id, {
      typing: !!body.typing,
      phoneNumberId: latest.business_phone_number_id ?? undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "mark-read failed" },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}

// DELETE /api/evolution/status/[id]
//
// Removes a logged status post from our DB and asks Evolution to revoke
// it on WhatsApp's side too (status broadcasts use the same
// deleteMessageForEveryone path with the status@broadcast JID). The
// Evolution call is best-effort — if it fails (status already expired,
// network blip) we still drop the local row so the dashboard list
// matches what the operator expects.
//
// Auth: admin+ — same gate as posting.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { deleteMessage as evolutionDeleteMessage } from "@/lib/evolution";

export const runtime = "nodejs";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: row } = await admin
    .from("evolution_status_posts")
    .select("id, business_phone_number_id, wa_message_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "Status post not found" }, { status: 404 });
  }

  // Look up Evolution credentials for the owning number.
  const { data: bn } = await admin
    .from("business_numbers")
    .select("evolution_instance_name, evolution_api_key, provider")
    .eq("phone_number_id", row.business_phone_number_id)
    .maybeSingle();

  let revokeWarning: string | null = null;
  if (
    row.wa_message_id &&
    bn?.evolution_instance_name &&
    bn?.evolution_api_key &&
    bn.provider === "evolution"
  ) {
    try {
      await evolutionDeleteMessage({
        instanceName: bn.evolution_instance_name,
        apiKey: bn.evolution_api_key,
        // WhatsApp status broadcasts are addressed to the status JID.
        remoteJid: "status@broadcast",
        messageId: row.wa_message_id,
        fromMe: true,
      });
    } catch (e) {
      revokeWarning = e instanceof Error ? e.message : "Revoke on WhatsApp failed";
    }
  }

  const { error } = await admin
    .from("evolution_status_posts")
    .delete()
    .eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, revoke_warning: revokeWarning });
}

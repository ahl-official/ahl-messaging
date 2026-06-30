// DELETE /api/messages/[id]
//
// Soft-deletes the local row (sets deleted_at). The row stays so the
// chat thread keeps its order; UI renders a "🗑 This message was
// deleted" tombstone.
//
// IMPORTANT: WhatsApp Cloud API does NOT support deleting sent
// messages on the customer's phone — "delete for everyone" is a
// WhatsApp client feature only. The message will keep showing on the
// recipient's phone until Meta adds API support. We still attempt the
// Meta call so the wiring is ready, but the failure is non-fatal and
// the local soft-delete proceeds either way.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { deleteSentMessage } from "@/lib/whatsapp";
import { deleteMessage as evolutionDeleteMessage, waIdToJid } from "@/lib/evolution";
import { getCurrentEffectivePermissions } from "@/lib/permissions";
import { numberAllowed } from "@/lib/permission-types";

export const runtime = "nodejs";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "message id required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data: msg } = await admin
    .from("messages")
    .select(
      "id, contact_id, direction, wa_message_id, business_phone_number_id, deleted_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (!msg) return NextResponse.json({ error: "Message not found" }, { status: 404 });
  if (msg.direction !== "outbound") {
    return NextResponse.json(
      { error: "Only your own messages can be deleted." },
      { status: 400 },
    );
  }
  if (msg.deleted_at) {
    return NextResponse.json({ ok: true, already_deleted: true });
  }

  // Per-number gate — restricted teammates must not be able to soft-
  // delete (or trigger delete-for-everyone on the upstream provider)
  // for messages on a number outside their assigned scope. Owner
  // bypasses.
  if (msg.business_phone_number_id) {
    const ctx = await getCurrentEffectivePermissions();
    if (
      ctx &&
      ctx.member.role !== "owner" &&
      !numberAllowed(ctx.perms, msg.business_phone_number_id)
    ) {
      return NextResponse.json(
        { error: "Forbidden — number not in your allowed list" },
        { status: 403 },
      );
    }
  }

  // Try delete-for-everyone on the upstream provider. Failures are
  // non-fatal — the operator clearly wanted it gone from the dashboard,
  // so we soft-delete locally regardless and surface a warning.
  let providerWarning: string | null = null;
  if (msg.wa_message_id) {
    const { data: contact } = await admin
      .from("contacts")
      .select("wa_id")
      .eq("id", msg.contact_id)
      .maybeSingle();
    if (contact?.wa_id) {
      const { data: providerRow } = await admin
        .from("business_numbers")
        .select("provider, evolution_instance_name, evolution_api_key")
        .eq("phone_number_id", msg.business_phone_number_id ?? "")
        .maybeSingle();
      const isEvolution =
        providerRow?.provider === "evolution" &&
        !!providerRow?.evolution_instance_name &&
        !!providerRow?.evolution_api_key;
      try {
        if (isEvolution) {
          await evolutionDeleteMessage({
            instanceName: providerRow!.evolution_instance_name!,
            apiKey: providerRow!.evolution_api_key!,
            remoteJid: waIdToJid(contact.wa_id),
            messageId: msg.wa_message_id,
            fromMe: true,
          });
        } else {
          await deleteSentMessage(
            contact.wa_id,
            msg.wa_message_id,
            msg.business_phone_number_id ?? undefined,
          );
        }
      } catch (e) {
        providerWarning = e instanceof Error ? e.message : "Provider delete failed";
      }
    }
  }

  const { data: updated, error: uErr } = await admin
    .from("messages")
    .update({
      deleted_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    message: updated,
    meta_warning: providerWarning,
  });
}

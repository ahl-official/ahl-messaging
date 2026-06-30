// POST /api/messages/[id]/edit
// Body: { text: string }
//
// Edits a previously-sent OUTBOUND text message via Meta. Meta only
// allows editing TEXT messages within 15 minutes of the original send.
// Caller responsibilities:
//   • text type only (we 400 on anything else)
//   • outbound only (no editing the customer's messages)
//   • not yet deleted (deleted rows are tombstones)
//
// On success we:
//   • PATCH the local row (content + edited_at + original_content)
//   • return the updated row so the UI can swap the bubble inline

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { editTextMessage } from "@/lib/whatsapp";
import { editMessage as evolutionEditMessage, waIdToJid } from "@/lib/evolution";
import { getCurrentEffectivePermissions } from "@/lib/permissions";
import { numberAllowed } from "@/lib/permission-types";

export const runtime = "nodejs";

const EDIT_WINDOW_MINUTES = 15;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "message id required" }, { status: 400 });

  let body: { text?: string };
  try {
    body = (await request.json()) as { text?: string };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const newText = body.text?.trim();
  if (!newText) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (newText.length > 4096) {
    return NextResponse.json({ error: "text too long (4096 max)" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: msg, error } = await admin
    .from("messages")
    .select(
      "id, contact_id, direction, type, wa_message_id, content, business_phone_number_id, timestamp, deleted_at, original_content",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!msg) return NextResponse.json({ error: "Message not found" }, { status: 404 });

  if (msg.direction !== "outbound") {
    return NextResponse.json(
      { error: "Only your own messages can be edited." },
      { status: 400 },
    );
  }
  if (msg.type !== "text") {
    return NextResponse.json(
      { error: "Only text messages can be edited. Send a new message instead." },
      { status: 400 },
    );
  }
  if (msg.deleted_at) {
    return NextResponse.json(
      { error: "This message was already deleted." },
      { status: 400 },
    );
  }
  if (!msg.wa_message_id) {
    return NextResponse.json(
      { error: "This message was never delivered to Meta — nothing to edit." },
      { status: 400 },
    );
  }

  // Per-number gate — operators restricted to specific numbers must
  // not be able to mutate messages on numbers they can't see. Owner
  // bypasses (matches the send-message + delete + export routes).
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

  // 15-min window guard (Meta will also reject; we pre-check so the
  // operator gets a clearer error instead of Meta's terse code).
  const ageMin = (Date.now() - new Date(msg.timestamp).getTime()) / 60_000;
  if (ageMin > EDIT_WINDOW_MINUTES) {
    return NextResponse.json(
      {
        error: `Edit window expired (${Math.round(ageMin)} min old, max ${EDIT_WINDOW_MINUTES}).`,
      },
      { status: 400 },
    );
  }

  // Lookup the wa_id on the contact so we can pass it to Meta.
  const { data: contact } = await admin
    .from("contacts")
    .select("wa_id")
    .eq("id", msg.contact_id)
    .maybeSingle();
  if (!contact?.wa_id) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  // Resolve provider — Evolution numbers route through Baileys' update
  // chat endpoint, Meta numbers go through Cloud API's `edit` payload.
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
      await evolutionEditMessage({
        instanceName: providerRow!.evolution_instance_name!,
        apiKey: providerRow!.evolution_api_key!,
        remoteJid: waIdToJid(contact.wa_id),
        messageId: msg.wa_message_id,
        newText,
      });
    } else {
      await editTextMessage(
        contact.wa_id,
        msg.wa_message_id,
        newText,
        msg.business_phone_number_id ?? undefined,
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Edit failed" },
      { status: 502 },
    );
  }

  const { data: updated, error: uErr } = await admin
    .from("messages")
    .update({
      content: newText,
      edited_at: new Date().toISOString(),
      // Preserve the pre-edit copy on the FIRST edit only; subsequent
      // edits keep the original-original.
      original_content: msg.original_content ?? msg.content,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, message: updated });
}

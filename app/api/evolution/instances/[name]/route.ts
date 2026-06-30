// DELETE /api/evolution/instances/[name]
// Logs out + deletes the Evolution instance and removes the
// business_numbers row. Owner / superadmin only.
//
// POST   /api/evolution/instances/[name]   (action=logout|restart)
// Soft operations — keep the row + instance but cycle the session.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  deleteInstance,
  logoutInstance,
  reconnectInstance,
  setInstanceWebhook,
  webhookUrlFor,
} from "@/lib/evolution";

export const runtime = "nodejs";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (member.role !== "owner" && member.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name } = await params;
  if (!name) {
    return NextResponse.json(
      { error: "instance name required" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { data: row } = await admin
    .from("business_numbers")
    .select("phone_number_id, provider")
    .eq("evolution_instance_name", name)
    .maybeSingle();
  if (!row || row.provider !== "evolution") {
    return NextResponse.json(
      { error: "Evolution instance not found" },
      { status: 404 },
    );
  }

  // Best-effort logout + delete on Evolution side. If the call fails
  // (e.g. instance was already removed manually), proceed to drop the
  // local row anyway — otherwise the operator can't get rid of a
  // half-broken entry.
  try {
    await logoutInstance(name);
  } catch {
    /* ignore */
  }
  try {
    await deleteInstance(name);
  } catch {
    /* ignore */
  }

  const { error } = await admin
    .from("business_numbers")
    .delete()
    .eq("phone_number_id", row.phone_number_id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (member.role !== "owner" && member.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name } = await params;
  let body: { action?: string } = {};
  try {
    body = (await request.json()) as { action?: string };
  } catch {
    /* empty body fine */
  }
  const action = body.action ?? "reconnect";

  if (action === "logout") {
    try {
      await logoutInstance(name);
      const admin = createServiceRoleClient();
      await admin
        .from("business_numbers")
        .update({
          evolution_connection_state: "close",
          evolution_last_state_at: new Date().toISOString(),
        })
        .eq("evolution_instance_name", name);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Logout failed" },
        { status: 502 },
      );
    }
  }

  if (action === "reconnect") {
    try {
      const r = await reconnectInstance(name);
      return NextResponse.json({ ok: true, qr_base64: r.base64 ?? null });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Reconnect failed" },
        { status: 502 },
      );
    }
  }

  if (action === "refresh-webhook") {
    // Push the current WEBHOOK_EVENTS list to this instance. Idempotent —
    // safe to fire on every page load if needed. Used to backfill new
    // event subscriptions (e.g. CALL) on instances that were created
    // before we added them.
    const admin = createServiceRoleClient();
    const { data: bn } = await admin
      .from("business_numbers")
      .select("evolution_api_key")
      .eq("evolution_instance_name", name)
      .maybeSingle();
    if (!bn?.evolution_api_key) {
      return NextResponse.json(
        { error: "Instance not found or missing API key" },
        { status: 404 },
      );
    }
    try {
      await setInstanceWebhook({
        instanceName: name,
        apiKey: bn.evolution_api_key,
        url: webhookUrlFor(name),
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Webhook refresh failed" },
        { status: 502 },
      );
    }
  }

  return NextResponse.json(
    { error: `Unknown action: ${action}` },
    { status: 400 },
  );
}

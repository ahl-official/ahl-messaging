// DELETE /api/business-numbers/[bpid]/purge
//
// Hard-deletes a WhatsApp business number and EVERYTHING tied to it —
// used when a number is removed from Meta and the operator wants it
// gone locally too. Owner-only. Irreversible.
//
// Most child tables store `business_phone_number_id` as plain text with
// no FK cascade, so we delete them explicitly, in dependency order:
//   messages → contacts → calls → automation → tokens → webhooks →
//   import jobs → the business_numbers row itself (campaigns +
//   campaign_recipients cascade off that last delete via their FK).
//
// Returns a per-table deleted-row count so the UI can show exactly what
// was removed.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { deleteInstance, isEvolutionConfigured } from "@/lib/evolution";

export const runtime = "nodejs";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ bpid: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json(
      { error: "Owner only — this permanently deletes all data for the number." },
      { status: 403 },
    );
  }

  const { bpid } = await params;
  if (!bpid) {
    return NextResponse.json({ error: "bpid required" }, { status: 400 });
  }

  // Require the caller to echo the bpid in the body as a typed
  // confirmation — same shape the Data tab uses for destructive ops.
  let body: { confirm?: string } = {};
  try {
    body = (await request.json()) as { confirm?: string };
  } catch {
    /* empty body */
  }
  if (body.confirm !== bpid) {
    return NextResponse.json(
      { error: "Confirmation mismatch — type the exact phone number id to confirm." },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();

  // Verify the number exists first so we can 404 cleanly.
  const { data: number } = await admin
    .from("business_numbers")
    .select("phone_number_id, verified_name, display_phone_number, provider, evolution_instance_name")
    .eq("phone_number_id", bpid)
    .maybeSingle();
  if (!number) {
    return NextResponse.json({ error: "Number not found" }, { status: 404 });
  }

  const deleted: Record<string, number> = {};
  const errors: string[] = [];

  // Tear down the Evolution-side instance first so deleting the local
  // row doesn't leave an orphan running on the Evolution server (which
  // keeps consuming WhatsApp sessions + can fire stale webhooks). Fire
  // and continue — Evolution being unreachable shouldn't block the
  // local purge.
  if (
    number.provider === "evolution" &&
    number.evolution_instance_name &&
    isEvolutionConfigured()
  ) {
    try {
      await deleteInstance(number.evolution_instance_name);
      console.log(
        `[purge] evolution instance deleted: ${number.evolution_instance_name}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 404 = instance already gone on the Evolution side. Treat as
      // success so re-deletes after a prior partial purge don't block
      // the local cleanup (operator's intent is "make it disappear").
      if (
        /\b404\b/.test(msg) ||
        /not\s*found/i.test(msg) ||
        /does\s*not\s*exist/i.test(msg)
      ) {
        console.log(
          `[purge] evolution instance ${number.evolution_instance_name} already gone — treating as deleted`,
        );
      } else {
        errors.push(`evolution_instance: ${msg}`);
        console.warn(
          `[purge] evolution deleteInstance failed for ${number.evolution_instance_name}:`,
          msg,
        );
      }
    }
  }

  // Helper — delete by a column match, capture count, never throw (so
  // one missing table doesn't abort the whole purge).
  async function purge(table: string, column: string) {
    const { error, count } = await admin
      .from(table)
      .delete({ count: "exact" })
      .eq(column, bpid);
    if (error) {
      errors.push(`${table}: ${error.message}`);
      deleted[table] = 0;
    } else {
      deleted[table] = count ?? 0;
    }
  }

  // Order matters where there are FKs. messages → contacts FK is
  // ON DELETE CASCADE (migration 0001), but we delete messages first
  // explicitly anyway so the count is reported separately.
  await purge("messages", "business_phone_number_id");
  await purge("contacts", "business_phone_number_id");
  await purge("whatsapp_calls", "business_phone_number_id");
  await purge("automation_configs", "business_phone_number_id");
  await purge("automation_logs", "business_phone_number_id");
  await purge("api_tokens", "business_phone_number_id");
  await purge("outbound_webhooks", "business_phone_number_id");
  await purge("chat_import_jobs", "target_bpid");

  // Finally the number row itself. campaigns + campaign_recipients have
  // FK ON DELETE CASCADE to business_numbers.phone_number_id, so they
  // get cleaned up automatically here.
  {
    const { error, count } = await admin
      .from("business_numbers")
      .delete({ count: "exact" })
      .eq("phone_number_id", bpid);
    if (error) {
      errors.push(`business_numbers: ${error.message}`);
      // If the number row itself couldn't be deleted, surface a 500 —
      // the child data is gone but the number is orphaned, operator
      // should know.
      return NextResponse.json(
        { error: `Number row delete failed: ${error.message}`, deleted, errors },
        { status: 500 },
      );
    }
    deleted["business_numbers"] = count ?? 0;
  }

  console.log(
    `[purge] owner=${me.email} removed bpid=${bpid} (${number.verified_name ?? number.display_phone_number ?? "—"}) →`,
    JSON.stringify(deleted),
  );

  return NextResponse.json({
    ok: true,
    bpid,
    label: number.verified_name ?? number.display_phone_number ?? bpid,
    deleted,
    errors: errors.length > 0 ? errors : undefined,
  });
}

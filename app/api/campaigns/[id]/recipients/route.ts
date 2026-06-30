// POST /api/campaigns/[id]/recipients
// Bulk-add recipients. Two source modes:
//   • { from: "tags", tags: [...] }            → query contacts table
//   • { from: "csv",  rows: [{wa_id, vars}…] } → import direct
// Idempotent on (campaign_id, wa_id) — duplicates dropped.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";
export const maxDuration = 60;

interface CsvRow {
  wa_id: string;
  display_name?: string;
  variables?: Record<string, string>;
}

interface PostBody {
  from?: "tags" | "csv" | "all" | "lsq";
  tags?: string[];
  rows?: CsvRow[];
  /** LSQ filters — only used when from='lsq'. AND-combined. */
  lsq_stages?: string[];
  lsq_owners?: string[];
  created_after?: string;        // ISO timestamp
  created_before?: string;       // ISO timestamp
  /** When from='tags' or 'all': only contacts on this business number.
   *  Auto-resolved from the campaign row if omitted. */
  business_phone_number_id?: string;
  /** Static template variable values applied to every recipient built
   *  from tags / lsq / all (csv rows already carry their own). */
  variable_defaults?: Record<string, string>;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { id } = await params;
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("status, business_phone_number_id")
    .eq("id", id)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!["draft", "scheduled"].includes(campaign.status)) {
    return NextResponse.json(
      { error: `Cannot add recipients to a ${campaign.status} campaign.` },
      { status: 400 },
    );
  }

  const bpid = body.business_phone_number_id ?? campaign.business_phone_number_id;
  let toInsert: Array<{
    campaign_id: string;
    contact_id: string | null;
    wa_id: string;
    display_name: string | null;
    variables: Record<string, string>;
  }> = [];

  if (body.from === "csv") {
    if (!Array.isArray(body.rows)) {
      return NextResponse.json({ error: "rows is required for csv mode" }, { status: 400 });
    }
    toInsert = body.rows
      .filter((r) => r && typeof r.wa_id === "string" && /^\d{6,}$/.test(r.wa_id.trim()))
      .map((r) => ({
        campaign_id: id,
        contact_id: null,
        wa_id: r.wa_id.trim(),
        display_name: r.display_name?.trim() || null,
        variables: r.variables ?? {},
      }));
  } else {
    // tags / all / lsq → pull from contacts table with the right filter set.
    let q = admin
      .from("contacts")
      .select("id, wa_id, name, profile_name, tags, lsq_stage, lsq_owner_name, created_at");
    if (bpid) q = q.eq("business_phone_number_id", bpid);
    if (body.from === "tags") {
      const tags = (body.tags ?? []).filter((t) => typeof t === "string" && t.trim());
      if (tags.length === 0) {
        return NextResponse.json({ error: "tags is required" }, { status: 400 });
      }
      q = q.overlaps("tags", tags);
    }
    if (body.from === "lsq") {
      const stages = (body.lsq_stages ?? []).filter(
        (s) => typeof s === "string" && s.trim(),
      );
      const owners = (body.lsq_owners ?? []).filter(
        (o) => typeof o === "string" && o.trim(),
      );
      if (stages.length === 0 && owners.length === 0 && !body.created_after && !body.created_before) {
        return NextResponse.json(
          { error: "LSQ filter needs at least one of: stages, owners, or date range." },
          { status: 400 },
        );
      }
      if (stages.length > 0) q = q.in("lsq_stage", stages);
      if (owners.length > 0) q = q.in("lsq_owner_name", owners);
      if (body.created_after) q = q.gte("created_at", body.created_after);
      if (body.created_before) q = q.lte("created_at", body.created_before);
    }
    const { data: contacts, error } = await q.limit(20000);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    toInsert = (contacts ?? []).map((c) => ({
      campaign_id: id,
      contact_id: c.id as string,
      wa_id: c.wa_id as string,
      display_name:
        ((c.name as string | null)?.trim() ||
          (c.profile_name as string | null)?.trim() ||
          null),
      variables: body.variable_defaults ?? {},
    }));
  }

  if (toInsert.length === 0) {
    return NextResponse.json({ ok: true, added: 0, total_recipients: 0 });
  }

  // Filter out unsubscribed wa_ids upfront so we don't pay storage for
  // recipients we'll just skip later.
  const { data: optOuts } = await admin
    .from("campaign_unsubscribes")
    .select("wa_id")
    .eq("business_phone_number_id", bpid);
  const optOutSet = new Set((optOuts ?? []).map((r) => r.wa_id as string));
  toInsert = toInsert.filter((r) => !optOutSet.has(r.wa_id));

  // Chunked upsert (Supabase rejects huge payloads).
  const CHUNK = 500;
  let added = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const slice = toInsert.slice(i, i + CHUNK);
    const { error, count } = await admin
      .from("campaign_recipients")
      .upsert(slice, { onConflict: "campaign_id,wa_id", ignoreDuplicates: true, count: "exact" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    added += count ?? 0;
  }

  // Refresh total_recipients on the campaign.
  const { count: total } = await admin
    .from("campaign_recipients")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", id);
  await admin
    .from("campaigns")
    .update({ total_recipients: total ?? 0 })
    .eq("id", id);

  return NextResponse.json({ ok: true, added, total_recipients: total ?? 0 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { id } = await params;
  const recipientId = request.nextUrl.searchParams.get("recipient_id");
  const admin = createServiceRoleClient();
  if (recipientId) {
    await admin
      .from("campaign_recipients")
      .delete()
      .eq("campaign_id", id)
      .eq("id", recipientId);
  } else {
    await admin.from("campaign_recipients").delete().eq("campaign_id", id);
  }
  return NextResponse.json({ ok: true });
}

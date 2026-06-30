// GET /api/whatsapp-call/list?cursor=<iso>&limit=50&q=<text>&direction=&status=
//
// Paged history feed for the /calls page. Newest first by start_at,
// keyset-paginated on start_at so adding new calls during scroll
// doesn't shift the offset. Joins the contact for display name +
// avatar; handler info is denormalised onto the row at accept time
// so no second join is needed.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Capability flag + number scope. Owner bypasses both.
  let allowedNumberIds: string[] | null = null;
  if (member.role !== "owner") {
    const perms = await getEffectivePermissionsFor(member);
    if (!perms.can_view_call_history) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    allowedNumberIds = perms.allowed_number_ids;
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const limit = Math.min(Math.max(1, limitRaw), 200);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const direction = url.searchParams.get("direction");
  const status = url.searchParams.get("status");

  const admin = createServiceRoleClient();
  let query = admin
    .from("whatsapp_calls")
    .select(
      "id, wa_call_id, contact_id, business_phone_number_id, direction, status, start_at, accepted_at, end_at, duration_seconds, ring_seconds, recording_url, recording_mime, transcript, transcript_status, handled_by_email, contacts:contact_id ( id, name, profile_name, wa_id, avatar_url )",
    )
    .order("start_at", { ascending: false })
    .limit(limit + 1);

  if (cursor) query = query.lt("start_at", cursor);
  if (direction === "inbound" || direction === "outbound") {
    query = query.eq("direction", direction);
  }
  if (status && status !== "all") {
    query = query.eq("status", status);
  }
  if (allowedNumberIds !== null) {
    // Empty list = no numbers allowed → return nothing rather than
    // letting Postgres treat .in("…", []) as "match all".
    if (allowedNumberIds.length === 0) {
      return NextResponse.json({ calls: [], next_cursor: null });
    }
    query = query.in("business_phone_number_id", allowedNumberIds);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  let rows = data ?? [];

  // Search on the joined contact's name/wa_id is awkward in PostgREST,
  // so we filter the page in-memory. Acceptable while page size <= 200.
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) => {
      const c = r.contacts as
        | { name?: string | null; profile_name?: string | null; wa_id?: string | null }
        | null;
      const haystack = [
        c?.name,
        c?.profile_name,
        c?.wa_id,
        r.handled_by_email,
        r.transcript,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = hasMore ? page[page.length - 1].start_at : null;

  return NextResponse.json({ calls: page, next_cursor: nextCursor });
}

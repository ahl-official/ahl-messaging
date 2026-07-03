// GET /api/bird-eye?n=12
//   Returns the N most-recently-active conversations plus each one's last ~15
//   messages — the data for the live multi-chat "bird's eye" wall. Polled by
//   the BirdEyeView grid every few seconds.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentEffectivePermissions } from "@/lib/permissions";

export const runtime = "nodejs";

const PER_CHAT = 15;

export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const n = Math.min(Math.max(Number(request.nextUrl.searchParams.get("n")) || 12, 1), 24);
  // Multi-select filters (comma-separated) — combined with AND. Falls back to
  // the legacy single `filter` param.
  const filters = (request.nextUrl.searchParams.get("filters") || request.nextUrl.searchParams.get("filter") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "all");
  const search = (request.nextUrl.searchParams.get("q") || "").trim().replace(/[%,()]/g, "");
  const sort = request.nextUrl.searchParams.get("sort") || "new"; // new | old
  const admin = createServiceRoleClient();

  // Respect the operator's number visibility — the same gate the inbox uses:
  // the per-user hide-toggle (hidden_number_ids) plus, for non-owners, their
  // allowed-number scope. So the wall shows ONLY the numbers they've toggled on.
  const ctx = await getCurrentEffectivePermissions();
  const hiddenIds = ctx?.member.hidden_number_ids ?? [];
  const allowedNumberIds = ctx && ctx.member.role !== "owner" ? ctx.perms.allowed_number_ids : null;
  if (allowedNumberIds !== null && allowedNumberIds.length === 0) {
    return NextResponse.json({ chats: [] });
  }

  // Most recently active conversations, filtered/sorted like the inbox chips.
  let q = admin
    .from("contacts")
    .select("id, name, profile_name, wa_id, avatar_url, last_message_at, last_message_direction, unread_count, status, is_group, lsq_lead_number, assigned_to, assigned_to_email, lsq_owner_email, business_phone_number_id")
    .not("last_message_at", "is", null)
    .order("last_message_at", { ascending: sort === "old" })
    .limit(n);
  if (hiddenIds.length > 0) q = q.not("business_phone_number_id", "in", `(${hiddenIds.join(",")})`);
  if (allowedNumberIds !== null) q = q.in("business_phone_number_id", allowedNumberIds);
  for (const f of filters) {
    if (f === "unreplied") q = q.eq("last_message_direction", "inbound");
    else if (f === "unread") q = q.gt("unread_count", 0);
    else if (f === "unassigned") q = q.is("assigned_to", null);
    else if (f === "active") q = q.or("status.eq.open,status.is.null");
    else if (f === "closed") q = q.eq("status", "closed");
    else if (f === "groups") q = q.eq("is_group", true);
    else if (f === "mine") {
      const email = (user.email ?? "").trim().toLowerCase();
      q = email ? q.or(`assigned_to.eq.${user.id},lsq_owner_email.eq.${email}`) : q.eq("assigned_to", user.id);
    }
  }
  // Search by phone (wa_id) or CRM lead number.
  if (search) q = q.or(`wa_id.ilike.%${search}%,lsq_lead_number.ilike.%${search}%`);
  const { data: contacts, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (contacts ?? []).map((c) => c.id as string);
  const byContact = new Map<string, Array<Record<string, unknown>>>();
  if (ids.length > 0) {
    // Pull recent messages for all chats in one query, newest first, then
    // group + keep the last PER_CHAT each (chronological).
    const { data: msgs } = await admin
      .from("messages")
      .select("id, contact_id, direction, content, type, media_url, timestamp")
      .in("contact_id", ids)
      .order("timestamp", { ascending: false })
      .limit(n * PER_CHAT * 2);
    for (const m of msgs ?? []) {
      const cid = m.contact_id as string;
      const arr = byContact.get(cid) ?? [];
      if (arr.length < PER_CHAT) arr.push(m);
      byContact.set(cid, arr);
    }
  }

  const dayAgo = Date.now() - 24 * 60 * 60_000;
  const chats = (contacts ?? []).map((c) => {
    const msgs = (byContact.get(c.id as string) ?? []).slice().reverse(); // chronological
    // 24h window is OPEN if the client sent something in the last 24h.
    const lastInbound = msgs.filter((m) => m.direction === "inbound").pop();
    const windowOpen = lastInbound?.timestamp ? Date.parse(lastInbound.timestamp as string) > dayAgo : false;
    return {
      id: c.id,
      name: (c.name as string) || (c.profile_name as string) || (c.wa_id as string) || "Unknown",
      wa_id: c.wa_id,
      avatar_url: c.avatar_url,
      last_message_at: c.last_message_at,
      last_message_direction: c.last_message_direction,
      unread_count: c.unread_count ?? 0,
      window_open: windowOpen,
      lsq_lead_number: c.lsq_lead_number,
      assigned_to_email: c.assigned_to_email,
      business_phone_number_id: c.business_phone_number_id,
      messages: msgs,
    };
  });

  return NextResponse.json({ chats });
}

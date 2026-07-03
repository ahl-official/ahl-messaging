// GET /api/contacts/search?q=...
// Searches contacts by wa_id (digits), name, or profile_name across
// the full DB (not just the loaded inbox page). Used by:
//   1. The inbox search box — falls back here whenever the local
//      199-row paginated slice doesn't match what the operator typed,
//      so a phone search like "9045454045" finds matches across all
//      39k+ contacts.
//   2. Settings → Data page (owner-only destructive action — gated
//      below).
//
// Permissioned: non-owner callers see only contacts on their allowed
// business numbers. Owners see everything.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getCurrentEffectivePermissions } from "@/lib/permissions";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve number scope so non-owners only see their accessible chats.
  let allowedBpids: string[] | null = null;
  if (member.role !== "owner") {
    const ctx = await getCurrentEffectivePermissions();
    allowedBpids = ctx?.perms.allowed_number_ids ?? null;
    // Explicit deny — empty allow-list means no access to any number.
    if (allowedBpids !== null && allowedBpids.length === 0) {
      return NextResponse.json({ contacts: [] });
    }
  }

  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 3) {
    return NextResponse.json({ contacts: [] });
  }

  const admin = createServiceRoleClient();

  // Strip non-digits for wa_id matching — user might paste "+91 90847 23091"
  // but stored value is "919084723091".
  const digits = q.replace(/\D/g, "");

  // Sanitize before interpolating into a PostgREST .or() filter string:
  // commas separate conditions and parentheses group them, so an unescaped
  // value could inject extra filters (e.g. "x,status.eq.y"). Strip the
  // metacharacters that have meaning in the filter grammar.
  const safeQ = q.replace(/[,()\\]/g, " ").trim();

  // Build OR filter: wa_id / CRM lead number contain the digits, OR name /
  // profile_name / lead number / prospect id ilike the raw query. The LSQ
  // lead number is the operator's main "find this lead" handle, so a lead-id
  // search (e.g. "9045454045") must hit it even when that contact is outside
  // the loaded inbox page — the bug this fixes.
  const filters: string[] = [];
  if (digits.length >= 4) {
    filters.push(`wa_id.ilike.%${digits}%`);
    filters.push(`lsq_lead_number.ilike.%${digits}%`);
  }
  if (safeQ) {
    filters.push(`name.ilike.%${safeQ}%`);
    filters.push(`profile_name.ilike.%${safeQ}%`);
    filters.push(`lsq_lead_number.ilike.%${safeQ}%`);
    filters.push(`lsq_prospect_id.ilike.%${safeQ}%`);
  }
  // Nothing searchable left after sanitizing (e.g. query was only symbols).
  if (filters.length === 0) {
    return NextResponse.json({ contacts: [] });
  }

  let query = admin
    .from("contacts")
    .select(
      "id, wa_id, name, profile_name, status, last_message_at, last_message_preview, last_message_direction, last_message_status, unread_count, business_phone_number_id, assigned_to, tags, lsq_stage, lsq_lead_number, lsq_prospect_id, lsq_owner_name, label_ids, avatar_url, is_group",
    )
    .or(filters.join(","))
    .order("last_message_at", { ascending: false })
    .limit(30);
  // Permission scoping — non-owner sees only their allowed numbers.
  if (allowedBpids !== null) {
    query = query.in("business_phone_number_id", allowedBpids);
  }
  // Workspace toggle scoping — numbers the operator switched OFF in the
  // user-menu (team_members.hidden_number_ids) are excluded, same as the main
  // /api/contacts list. Applies to every role (incl. owner); without it,
  // searching leaks chats on numbers the operator has toggled off.
  const hiddenIds = member.hidden_number_ids ?? [];
  if (hiddenIds.length > 0) {
    query = query.not(
      "business_phone_number_id",
      "in",
      `(${hiddenIds.join(",")})`,
    );
  }
  const { data: contacts, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // For each match, count messages so the UI can show "X messages → delete".
  const contactIds = (contacts ?? []).map((c) => c.id);
  const counts = new Map<string, number>();
  if (contactIds.length > 0) {
    const { data: msgRows } = await admin
      .from("messages")
      .select("contact_id")
      .in("contact_id", contactIds);
    for (const m of msgRows ?? []) {
      counts.set(m.contact_id, (counts.get(m.contact_id) ?? 0) + 1);
    }
  }

  // Annotate each row with the business number's display label — same
  // client can have one contact row per connected number, and without
  // this label the operator can't tell those rows apart.
  const bpids = Array.from(
    new Set(
      ((contacts ?? [])
        .map((c) => c.business_phone_number_id)
        .filter(Boolean) as string[]),
    ),
  );
  const numberLabelByBpid = new Map<string, string>();
  if (bpids.length > 0) {
    const { data: bn } = await admin
      .from("business_numbers")
      .select("phone_number_id, nickname, verified_name, display_phone_number")
      .in("phone_number_id", bpids);
    for (const r of (bn ?? []) as Array<{
      phone_number_id: string;
      nickname: string | null;
      verified_name: string | null;
      display_phone_number: string | null;
    }>) {
      const label =
        r.nickname?.trim() ||
        r.verified_name?.trim() ||
        r.display_phone_number ||
        r.phone_number_id;
      numberLabelByBpid.set(r.phone_number_id, label);
    }
  }

  const enriched = (contacts ?? []).map((c) => ({
    ...c,
    message_count: counts.get(c.id) ?? 0,
    business_number_label: c.business_phone_number_id
      ? numberLabelByBpid.get(c.business_phone_number_id) ?? null
      : null,
  }));

  return NextResponse.json({ contacts: enriched });
}

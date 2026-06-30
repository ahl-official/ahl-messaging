// GET /api/whatsapp-call/active
//
// Returns the most recent live call leg (ringing or accepted) that
// THIS user should see — visibility rules:
//
//   1. Number access — every operator sees only calls on business
//      numbers their permissions allow (owners bypass).
//
//   2. Ringing route — if the call carries an lsq_owner_email AND that
//      email belongs to an active team_member on the platform, ONLY
//      that operator's panel rings. The rest of the number's operators
//      get nothing. If the owner isn't on the platform, the ring
//      broadcasts to every operator with access to the number (legacy
//      "all-on-this-number" fallback).
//
//   3. Accepted state — once someone clicks Accept, the row stamps
//      handled_by_user_id. From that moment on, ONLY the handler's
//      panel sees the call. Everyone else's banner instantly clears.
//
// Polled by CallNotificationWatcher; the realtime subscription in
// CallOverlay also goes through this endpoint via revalidation so the
// rules live in one place.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getCurrentEffectivePermissions } from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve which business numbers the caller can act on. Owners see
  // everything; everyone else is scoped to allowed_number_ids.
  let allowedBpids: string[] | null = null;
  if (member.role !== "owner") {
    const ctx = await getCurrentEffectivePermissions();
    allowedBpids = ctx?.perms.allowed_number_ids ?? null;
    if (allowedBpids !== null && allowedBpids.length === 0) {
      return NextResponse.json({ call: null });
    }
  }

  // Per-operator number toggle from the user menu. `hidden_number_ids`
  // is the set of business numbers this operator has flipped OFF — a
  // call on any of those should NOT ring this user, even if the chat
  // is assigned to them. Lets people mute calls per number without
  // losing permission to see the chat.
  const hiddenBpids = new Set(member.hidden_number_ids ?? []);

  const admin = createServiceRoleClient();

  // Pull a handful of recent active legs — we apply the per-user
  // routing rules in app code because they can't be expressed as a
  // single SELECT WHERE clause (involves cross-checking team_members
  // for the lsq_owner_email).
  let q = admin
    .from("whatsapp_calls")
    .select(
      "id, wa_call_id, contact_id, business_phone_number_id, direction, status, sdp_offer, sdp_answer, start_at, end_at, lsq_owner_email, handled_by_user_id, handled_by_email, contacts:contact_id ( id, name, profile_name, wa_id, avatar_url, lsq_lead_number, assigned_to )",
    )
    .in("status", ["ringing", "accepted"])
    .order("start_at", { ascending: false })
    .limit(10);
  if (allowedBpids !== null) {
    q = q.in("business_phone_number_id", allowedBpids);
  }
  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    return NextResponse.json({ call: null });
  }

  // Build a single-shot lookup of active team_members keyed by email
  // so we can decide "is the LSQ owner actually on the platform?".
  // Skipped if no row has lsq_owner_email — saves a query for the
  // common case of legacy / no-CRM workspaces.
  const ownerEmails = Array.from(
    new Set(
      rows
        .map((r) => (r.lsq_owner_email ?? "").trim().toLowerCase())
        .filter((s): s is string => Boolean(s)),
    ),
  );
  const activeMemberByEmail = new Map<string, { user_id: string }>();
  if (ownerEmails.length > 0) {
    const { data: members } = await admin
      .from("team_members")
      .select("email, user_id, is_active")
      .in("email", ownerEmails);
    for (const m of (members ?? []) as Array<{
      email: string;
      user_id: string | null;
      is_active: boolean | null;
    }>) {
      if (m.is_active === false) continue;
      if (m.user_id) activeMemberByEmail.set(m.email.toLowerCase(), { user_id: m.user_id });
    }
  }

  const myEmailLower = (member.email ?? "").toLowerCase();
  for (const row of rows) {
    // Per-user number toggle — if the operator has flipped this
    // number OFF in their user menu, suppress the ring entirely
    // (even for chats they're assigned to or own in LSQ).
    if (
      row.business_phone_number_id &&
      hiddenBpids.has(row.business_phone_number_id)
    ) {
      continue;
    }
    // handled_by_user_id takes precedence over LSQ routing in BOTH
    // ringing and accepted states:
    //   - Outbound calls: /dial sets handled_by at dial time, so only
    //     the dialer should see the ring + the accepted leg. (Routing
    //     by LSQ owner would hide an outbound call from the dialer if
    //     they aren't the lead's CRM owner.)
    //   - Inbound calls that have been picked up: the claim stamps
    //     handled_by, and the row drops off everyone else's screen.
    if (row.handled_by_user_id) {
      if (row.handled_by_user_id !== member.user_id) continue;
      return NextResponse.json({ call: row });
    }

    // Inbound, still unclaimed — apply assignment routing.
    if (row.status === "accepted") {
      // No handler stamped but already accepted — shouldn't really
      // happen, but if it does, show to everyone (legacy fallback).
      return NextResponse.json({ call: row });
    }

    // Routing priority (operator-requested strict mode):
    //   1. contacts.assigned_to — the dashboard owner of this chat
    //   2. lsq_owner_email — the CRM owner
    // The first match WINS — if either points at a real platform user
    // and that user isn't me, I don't see the ring. Only when neither
    // identifies a responsible operator do we fall through to the
    // legacy "broadcast to everyone with number access" path (so a
    // truly unassigned call still rings somewhere).
    const contactRow = row.contacts as { assigned_to?: string | null } | null;
    const assignedTo = contactRow?.assigned_to ?? null;
    if (assignedTo) {
      if (assignedTo !== member.user_id) continue;
      return NextResponse.json({ call: row });
    }

    const ownerEmail = (row.lsq_owner_email ?? "").trim().toLowerCase();
    if (ownerEmail) {
      const owner = activeMemberByEmail.get(ownerEmail);
      if (owner) {
        // Owner is on the platform — ring ONLY them.
        if (ownerEmail !== myEmailLower) continue;
        return NextResponse.json({ call: row });
      }
      // Owner email is set but they're not a platform user → fall through
      // and ring everyone with access to this number (legacy broadcast).
    }
    return NextResponse.json({ call: row });
  }
  return NextResponse.json({ call: null });
}

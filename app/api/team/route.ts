// Team management — GET (list) / POST (invite) / PUT (update) / DELETE.
// All routes require at least admin role; owner/superadmin can manage
// higher-ranked members per `canManageRole` rules.

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  getCurrentMember,
  ROLES,
  canManageRole,
  isAtLeast,
  type Role,
  type TeamMember,
} from "@/lib/team";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// GET — list everyone (any signed-in member)
// ---------------------------------------------------------------------------
export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const base =
    "id, user_id, email, full_name, first_name, last_name, role, is_active, pending_approval, last_active_at, created_at, updated_at, team_id, is_team_lead";
  const first = await admin
    .from("team_members")
    .select(`${base}, is_monitor`)
    .order("created_at", { ascending: true });
  let rows: Record<string, unknown>[] | null = first.data;
  let error = first.error;
  // If the optional is_monitor column isn't there yet (migration not run on
  // this DB), don't brick the whole page — refetch without it, default false.
  if (error && /is_monitor/.test(error.message)) {
    const retry = await admin
      .from("team_members")
      .select(base)
      .order("created_at", { ascending: true });
    error = retry.error;
    rows = (retry.data ?? []).map((r) => ({ ...r, is_monitor: false }));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ members: (rows ?? []) as unknown as TeamMember[], me });
}

// ---------------------------------------------------------------------------
// POST — invite by email. Creates a placeholder team_members row with no
// user_id; the trigger in 0005_team.sql links it on first Google sign-in.
// Body: { email, role }
// ---------------------------------------------------------------------------
interface PostBody {
  email?: string;
  role?: Role;
  first_name?: string;
  last_name?: string;
  /** Optional team assignment at invite time. Null / undefined = no team. */
  team_id?: string | null;
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins and above only" }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const role = body.role;
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }
  if (!role || !ROLES.includes(role)) {
    return NextResponse.json({ error: "Valid role required" }, { status: 400 });
  }
  if (!canManageRole(me.role, role)) {
    return NextResponse.json(
      { error: `You can't invite a ${role}.` },
      { status: 403 },
    );
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("team_members")
    .insert({
      email,
      role,
      first_name: body.first_name?.trim() || null,
      last_name: body.last_name?.trim() || null,
      invited_by: me.user_id,
      team_id: body.team_id ?? null,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "A member with that email already exists" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Send the Supabase invite email. The trigger in migration 0020 will
  // link the new auth.users row to the team_members row above (matched
  // by email). After clicking the link, the user lands on
  // /reset-password?invite=1 to set their initial password.
  // Failure here is non-fatal — the team_members row already exists,
  // and the inviter can resend the email later if needed.
  let inviteSent = false;
  let inviteWarning: string | null = null;
  try {
    const h = await headers();
    const proto = h.get("x-forwarded-proto") ?? "https";
    const host = h.get("host") ?? "";
    const origin =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
      (host ? `${proto}://${host}` : "");
    const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      // Direct to /reset-password — the page bootstraps the session
      // from the URL fragment client-side. /auth/callback can't help
      // here because invite tokens come back as fragments, not query
      // codes.
      redirectTo: `${origin}/reset-password?invite=1`,
      data: {
        full_name: [body.first_name, body.last_name].filter(Boolean).join(" ") || null,
        invited_role: role,
      },
    });
    if (inviteErr) {
      // Most common: the email already has an auth user (re-invite).
      // Bubble a warning but keep the team_members row so the owner can
      // resend manually from the Team UI.
      inviteWarning = inviteErr.message;
    } else {
      inviteSent = true;
    }
  } catch (e) {
    inviteWarning = e instanceof Error ? e.message : "Invite email failed";
  }

  return NextResponse.json({
    ok: true,
    member: data,
    invite_sent: inviteSent,
    invite_warning: inviteWarning,
  });
}

// ---------------------------------------------------------------------------
// PUT — change role / activate / deactivate / rename. Body: { id, role?,
// is_active?, first_name?, last_name? }.
// ---------------------------------------------------------------------------
interface PutBody {
  id?: string;
  role?: Role;
  is_active?: boolean;
  first_name?: string;
  last_name?: string;
  /** Move the member into a different team. NULL clears assignment. */
  team_id?: string | null;
  /** Mark/unmark as Team Lead — can view their team's report + set their
   *  team members' KRA. Owner/admin only (this whole route is admin+). */
  is_team_lead?: boolean;
  /** Mark/unmark as Monitor — a watch-only user whose owned leads count
   *  as unassigned/available in the inbox. */
  is_monitor?: boolean;
  /** Approve a pending self-signup. Sets pending_approval=false +
   *  is_active=true. Owner / superadmin / admin can approve teammates;
   *  superadmin can approve admins; owner can approve everyone. */
  approve?: boolean;
}

export async function PUT(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins and above only" }, { status: 403 });
  }

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const id = body.id?.trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data: target, error: fetchErr } = await admin
    .from("team_members")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!target) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const t = target as TeamMember;

  // No one can demote/deactivate the last owner — guard against bricking ourselves.
  if (t.role === "owner" && (body.role && body.role !== "owner" || body.is_active === false)) {
    const { count } = await admin
      .from("team_members")
      .select("*", { count: "exact", head: true })
      .eq("role", "owner")
      .eq("is_active", true);
    if ((count ?? 0) <= 1) {
      return NextResponse.json(
        { error: "Can't change the last active owner" },
        { status: 400 },
      );
    }
  }

  if (body.role && body.role !== t.role) {
    if (!canManageRole(me.role, t.role)) {
      return NextResponse.json(
        { error: `You can't change a ${t.role}.` },
        { status: 403 },
      );
    }
    if (!canManageRole(me.role, body.role)) {
      return NextResponse.json(
        { error: `You can't promote to ${body.role}.` },
        { status: 403 },
      );
    }
  }
  if (body.is_active === false && !canManageRole(me.role, t.role)) {
    return NextResponse.json(
      { error: `You can't deactivate a ${t.role}.` },
      { status: 403 },
    );
  }

  const update: Record<string, unknown> = {};
  if (body.role !== undefined) update.role = body.role;
  if (body.is_active !== undefined) update.is_active = body.is_active;
  if (body.first_name !== undefined) update.first_name = body.first_name?.trim() || null;
  if (body.last_name !== undefined) update.last_name = body.last_name?.trim() || null;
  if (body.team_id !== undefined) update.team_id = body.team_id ?? null;
  if (body.is_team_lead !== undefined) update.is_team_lead = body.is_team_lead;
  if (body.is_monitor !== undefined) update.is_monitor = body.is_monitor;
  if (body.approve === true) {
    // Approving requires the same management permission as deactivating.
    if (!canManageRole(me.role, t.role)) {
      return NextResponse.json(
        { error: `You can't approve a ${t.role}.` },
        { status: 403 },
      );
    }
    update.pending_approval = false;
    update.is_active = true;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true, member: target });
  }

  const { data, error } = await admin
    .from("team_members")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, member: data });
}

// ---------------------------------------------------------------------------
// DELETE — remove a member entirely. Owner-only as a safety rail.
// ---------------------------------------------------------------------------
export async function DELETE(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data: target } = await admin
    .from("team_members")
    .select("role, is_active, pending_approval")
    .eq("id", id)
    .maybeSingle();

  // Owner-only for normal members; admin+ can reject pending self-signups
  // (they aren't real members yet, no auth.users cleanup risk).
  const targetIsPending = target?.pending_approval === true;
  if (targetIsPending) {
    if (!isAtLeast(me.role, "admin")) {
      return NextResponse.json({ error: "Admin or above only" }, { status: 403 });
    }
  } else if (me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  if (target?.role === "owner") {
    const { count } = await admin
      .from("team_members")
      .select("*", { count: "exact", head: true })
      .eq("role", "owner")
      .eq("is_active", true);
    if ((count ?? 0) <= 1) {
      return NextResponse.json(
        { error: "Can't delete the last owner" },
        { status: 400 },
      );
    }
  }

  // Capture user_id before deleting the row so we can clean up the
  // auth.users entry afterwards (only for pending rejections — normal
  // owner deletes leave auth.users alone, admins can re-invite later).
  let authUserIdForCleanup: string | null = null;
  if (targetIsPending) {
    const { data: targetRow } = await admin
      .from("team_members")
      .select("user_id")
      .eq("id", id)
      .maybeSingle();
    authUserIdForCleanup = (targetRow?.user_id as string | null) ?? null;
  }

  const { error } = await admin.from("team_members").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (authUserIdForCleanup) {
    // Best-effort delete of the supabase auth user so the rejected
    // person can be invited later from a clean slate. Failure here is
    // non-fatal — the team_members row is already gone.
    try {
      await admin.auth.admin.deleteUser(authUserIdForCleanup);
    } catch (e) {
      console.warn("[team] auth.admin.deleteUser failed:", e);
    }
  }
  return NextResponse.json({ ok: true });
}

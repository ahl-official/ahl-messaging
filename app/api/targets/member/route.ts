// GET  /api/targets/member               — list member overrides
// PUT  /api/targets/member                — upsert one member override
//                                            (null fields = inherit)
// DELETE /api/targets/member?member_id=X  — drop override (back to role)
//
// Owner manages everyone. A Team Lead manages ONLY their own team's members
// (KRA targets). The `can_view_team_scores` grant stays owner-only.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import type { TeamMember } from "@/lib/team-types";
import { TARGET_FIELDS } from "@/lib/agent-targets";

export const runtime = "nodejs";

/** Owner = full scope. Team Lead (with a team) = scoped to team_id. Anyone
 *  else has no access. */
function scopeOf(member: TeamMember): { isOwner: boolean; leadTeamId: string | null } {
  const isOwner = member.role === "owner";
  const leadTeamId =
    !isOwner && member.is_team_lead ? member.team_id ?? null : null;
  return { isOwner, leadTeamId };
}

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { isOwner, leadTeamId } = scopeOf(member);
  if (!isOwner && !leadTeamId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createServiceRoleClient();
  let query = admin.from("agent_targets_member").select("*");
  if (leadTeamId) {
    const { data: teamMembers } = await admin
      .from("team_members")
      .select("id")
      .eq("team_id", leadTeamId);
    const ids = (teamMembers ?? []).map((m) => (m as { id: string }).id);
    if (ids.length === 0) return NextResponse.json({ rows: [] });
    query = query.in("member_id", ids);
  }
  const { data } = await query;
  return NextResponse.json({ rows: data ?? [] });
}

interface PutBody {
  member_id?: string;
  magic_messages_per_day?: number | null;
  calls_per_day?: number | null;
  text_replies_per_day?: number | null;
  template_sends_per_day?: number | null;
  max_idle_hours_per_day?: number | null;
  min_login_hours_per_day?: number | null;
  can_view_team_scores?: boolean;
}

/** True if `memberId` belongs to `teamId`. Used to keep a Team Lead inside
 *  their own team. */
async function memberInTeam(
  admin: ReturnType<typeof createServiceRoleClient>,
  memberId: string,
  teamId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("team_members")
    .select("team_id")
    .eq("id", memberId)
    .maybeSingle();
  return !!data && (data as { team_id: string | null }).team_id === teamId;
}

export async function PUT(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { isOwner, leadTeamId } = scopeOf(me);
  if (!isOwner && !leadTeamId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.member_id) {
    return NextResponse.json({ error: "member_id required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();

  // A Team Lead may only edit targets for members in their own team.
  if (leadTeamId && !(await memberInTeam(admin, body.member_id, leadTeamId))) {
    return NextResponse.json(
      { error: "That member isn't in your team" },
      { status: 403 },
    );
  }

  const row: Record<string, unknown> = { member_id: body.member_id };
  for (const f of TARGET_FIELDS) {
    const v = (body as Record<string, unknown>)[f];
    if (v === null) row[f] = null;
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0) row[f] = v;
  }
  // Granting team-wide score visibility is an owner-level action — a Team
  // Lead can't hand it out.
  if (isOwner && typeof body.can_view_team_scores === "boolean") {
    row.can_view_team_scores = body.can_view_team_scores;
  }
  row.updated_at = new Date().toISOString();
  const { data, error } = await admin
    .from("agent_targets_member")
    .upsert(row, { onConflict: "member_id" })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ row: data });
}

export async function DELETE(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { isOwner, leadTeamId } = scopeOf(me);
  if (!isOwner && !leadTeamId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const memberId = request.nextUrl.searchParams.get("member_id")?.trim();
  if (!memberId) {
    return NextResponse.json({ error: "member_id required" }, { status: 400 });
  }
  const admin = createServiceRoleClient();
  if (leadTeamId && !(await memberInTeam(admin, memberId, leadTeamId))) {
    return NextResponse.json(
      { error: "That member isn't in your team" },
      { status: 403 },
    );
  }
  const { error } = await admin
    .from("agent_targets_member")
    .delete()
    .eq("member_id", memberId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

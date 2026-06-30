// GET /api/reports/me?day=YYYY-MM-DD
//
// Returns the current user's score + breakdown for the given day
// (defaults to today). Powers the top-right ScoreBadge.
//
// Score = computeScore(resolveTargets(role default, member override),
//                      actuals from messages + calls + activity).

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import {
  computeScore,
  resolveTargets,
  ROLE_TARGETS_FALLBACK,
  type AgentActuals,
  type AgentTargets,
} from "@/lib/agent-targets";
import type { Role } from "@/lib/team-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const day =
    request.nextUrl.searchParams.get("day")?.trim() ||
    new Date().toISOString().slice(0, 10);
  const dayStart = `${day}T00:00:00.000Z`;
  const dayEnd = `${day}T23:59:59.999Z`;

  const admin = createServiceRoleClient();

  // Targets: role default + member override (NULL columns inherit).
  const [{ data: roleRow }, { data: memberRow }] = await Promise.all([
    admin
      .from("agent_targets_role")
      .select("*")
      .eq("role", member.role)
      .maybeSingle(),
    admin
      .from("agent_targets_member")
      .select("*")
      .eq("member_id", member.id)
      .maybeSingle(),
  ]);
  const roleDefaults: AgentTargets =
    (roleRow as AgentTargets | null) ??
    ROLE_TARGETS_FALLBACK[member.role as Role];
  const targets = resolveTargets(
    roleDefaults,
    memberRow as Partial<AgentTargets> | null,
  );

  // Actuals: messages + calls + activity for THIS day, scoped to this
  // user's email.
  const [{ data: msgs }, { data: calls }, { data: activity }] = await Promise.all([
    admin
      .from("messages")
      .select("type, template_name")
      .eq("direction", "outbound")
      .eq("sent_by_email", member.email)
      .gte("timestamp", dayStart)
      .lte("timestamp", dayEnd),
    admin
      .from("whatsapp_calls")
      .select("duration_seconds")
      .eq("handled_by_email", member.email)
      .gte("start_at", dayStart)
      .lte("start_at", dayEnd),
    admin
      .from("user_activity_days")
      .select("active_seconds, window_seconds")
      .eq("user_id", user.id)
      .eq("day", day)
      .maybeSingle(),
  ]);

  let text_replies = 0;
  let template_sends = 0;
  let magic_messages = 0;
  for (const m of msgs ?? []) {
    if (m.type === "template") {
      template_sends += 1;
      if (m.template_name === "magic_message") magic_messages += 1;
    } else if (m.type === "text") {
      text_replies += 1;
    }
  }
  const callsHandled = (calls ?? []).length;
  const activeSec = (activity?.active_seconds as number | undefined) ?? 0;
  const windowSec = (activity?.window_seconds as number | undefined) ?? 0;
  const loginHours = windowSec / 3600;
  const idleHours = Math.max(0, (windowSec - activeSec) / 3600);

  const actuals: AgentActuals = {
    magic_messages,
    calls: callsHandled,
    text_replies,
    template_sends,
    login_hours: Number(loginHours.toFixed(2)),
    idle_hours: Number(idleHours.toFixed(2)),
  };

  const breakdown = computeScore(targets, actuals);
  return NextResponse.json({
    day,
    targets,
    actuals,
    ...breakdown,
  });
}

// GET /api/reports/agents?range=7d|30d|all
//             &from=YYYY-MM-DD&to=YYYY-MM-DD
//             &q=<name/email substring>
//
// Per-agent productivity rollup. Joins four sources:
//   • messages          → text replies, templates, magic messages
//   • whatsapp_calls    → handled count + total / average talk-time
//   • user_activity_days → login hours + idle hours per day
//   • team_members      → display name + role for the row labels
// Plus computes the daily KRA score using lib/agent-targets.
//
// Owner / superadmin / admin only. allowed_number_ids is enforced when
// the caller has a restriction set — admins who only manage one number
// see aggregates scoped to that number.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import {
  computeScore,
  resolveTargets,
  ROLE_TARGETS_FALLBACK,
  type AgentTargets,
} from "@/lib/agent-targets";
import type { Role } from "@/lib/team-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AgentReport {
  email: string;
  /** team_members.id — needed to set this agent's KRA from the report.
   *  null for non-member senders (system / API). */
  member_id: string | null;
  full_name: string | null;
  role: string | null;
  text_replies: number;
  template_sends: number;
  magic_messages: number;
  calls_handled: number;
  talk_time_seconds: number;
  avg_call_seconds: number;
  login_hours: number;
  idle_hours: number;
  score: number;
  tier: "green" | "yellow" | "red";
}

function rangeStart(range: string): string | null {
  if (range === "all") return null;
  const now = Date.now();
  const days = range === "30d" ? 30 : 7;
  return new Date(now - days * 86_400_000).toISOString();
}

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const isAdmin = isAtLeast(member.role, "admin");
  const isLead = member.is_team_lead === true;
  if (!isAdmin && !isLead) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const range = request.nextUrl.searchParams.get("range") ?? "30d";
  const fromParam = request.nextUrl.searchParams.get("from"); // YYYY-MM-DD
  const toParam = request.nextUrl.searchParams.get("to");
  const qParam = (request.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();

  // Explicit from/to wins; otherwise fall back to the named range.
  const sinceIso = fromParam
    ? `${fromParam}T00:00:00.000Z`
    : rangeStart(range);
  const untilIso = toParam ? `${toParam}T23:59:59.999Z` : null;
  const admin = createServiceRoleClient();

  // Team Lead (non-admin): scope the report to their OWN team's members. A
  // lead with no team assigned has nothing to report on. Leads are scoped by
  // PEOPLE (team membership), not by number, so we skip the per-number scope
  // for them and filter the output down to their team's emails below.
  const leadTeamId = !isAdmin && isLead ? member.team_id : null;
  if (!isAdmin && isLead && !leadTeamId) {
    return NextResponse.json({ agents: [], range, since: sinceIso });
  }

  // Number scope (admins might be restricted; owner/superadmin = unrestricted).
  let allowedNumberIds: string[] | null = null;
  if (member.role !== "owner" && !leadTeamId) {
    const perms = await getEffectivePermissionsFor(member);
    allowedNumberIds = perms.allowed_number_ids;
  }
  if (allowedNumberIds !== null && allowedNumberIds.length === 0) {
    return NextResponse.json({ agents: [], range, since: sinceIso });
  }

  // Pull team members once for label lookup (and so agents that haven't
  // sent yet still appear, with zero counters). Plus the role + member
  // targets so we can compute scores per agent.
  const [{ data: members }, { data: roleTargetRows }, { data: memberTargetRows }] =
    await Promise.all([
      admin
        .from("team_members")
        .select("id, email, full_name, role, is_active, team_id")
        .eq("is_active", true),
      admin.from("agent_targets_role").select("*"),
      admin.from("agent_targets_member").select("*"),
    ]);

  // For a Team Lead, the set of emails belonging to their team — the report
  // output is filtered to exactly these. null = no team scoping (admins).
  const teamEmails: Set<string> | null = leadTeamId
    ? new Set(
        ((members ?? []) as Array<{ email: string; team_id: string | null }>)
          .filter((m) => m.team_id === leadTeamId && m.email)
          .map((m) => m.email.toLowerCase()),
      )
    : null;

  const roleTargets = new Map<string, AgentTargets>();
  for (const r of (roleTargetRows ?? []) as Array<AgentTargets & { role: string }>) {
    roleTargets.set(r.role, r);
  }
  const memberTargets = new Map<string, Partial<AgentTargets>>();
  for (const r of (memberTargetRows ?? []) as Array<
    Partial<AgentTargets> & { member_id: string }
  >) {
    memberTargets.set(r.member_id, r);
  }
  const memberByEmail = new Map<
    string,
    { id: string; full_name: string | null; role: string | null }
  >();
  for (const m of (members ?? []) as Array<{
    id: string;
    email: string;
    full_name: string | null;
    role: string | null;
  }>) {
    if (m.email) memberByEmail.set(m.email.toLowerCase(), m);
  }

  // All per-agent + per-day rollups run in ONE Postgres call (migration
  // 0082's get_agent_reports) instead of paging 100k+ raw messages into Node
  // and grouping in JS — that fan-out is what made the Reports page hang.
  // p_bpids NULL = all numbers; otherwise restrict to the caller's set.
  const { data: rpcData, error: rpcError } = await admin.rpc("get_agent_reports", {
    p_since: sinceIso,
    p_until: untilIso,
    p_bpids: allowedNumberIds,
  });
  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }
  const report = (rpcData ?? {}) as {
    outbound?: Array<{
      email: string;
      text_replies: number;
      template_sends: number;
      magic_messages: number;
    }>;
    calls?: Array<{ email: string; calls_handled: number; talk_time_seconds: number }>;
    daily?: Array<{
      day: string;
      patient_messages: number;
      outbound: number;
      unique_patients: number;
    }>;
    inbound_totals?: { patient_messages: number; unique_patients: number };
  };
  const outboundAgg = report.outbound ?? [];
  const callsAgg = report.calls ?? [];
  const dailyAgg = report.daily ?? [];
  const inboundTot = report.inbound_totals ?? {
    patient_messages: 0,
    unique_patients: 0,
  };

  // Activity windows for login + idle time.
  let activityQuery = admin
    .from("user_activity_days")
    .select("email, day, active_seconds, window_seconds");
  if (sinceIso) {
    activityQuery = activityQuery.gte("day", sinceIso.slice(0, 10));
  }
  if (untilIso) {
    activityQuery = activityQuery.lte("day", untilIso.slice(0, 10));
  }
  const { data: activity } = await activityQuery;

  // Aggregate.
  const byEmail = new Map<string, AgentReport>();
  const ensure = (email: string): AgentReport => {
    let row = byEmail.get(email);
    if (!row) {
      const m = memberByEmail.get(email.toLowerCase());
      row = {
        email,
        member_id: m?.id ?? null,
        full_name: m?.full_name ?? null,
        role: m?.role ?? null,
        text_replies: 0,
        template_sends: 0,
        magic_messages: 0,
        calls_handled: 0,
        talk_time_seconds: 0,
        avg_call_seconds: 0,
        login_hours: 0,
        idle_hours: 0,
        score: 100,
        tier: "green",
      };
      byEmail.set(email, row);
    }
    return row;
  };

  for (const o of outboundAgg) {
    if (!o.email) continue;
    const row = ensure(o.email);
    row.text_replies = Number(o.text_replies ?? 0);
    row.template_sends = Number(o.template_sends ?? 0);
    row.magic_messages = Number(o.magic_messages ?? 0);
  }

  for (const c of callsAgg) {
    if (!c.email) continue;
    const row = ensure(c.email);
    row.calls_handled = Number(c.calls_handled ?? 0);
    row.talk_time_seconds = Number(c.talk_time_seconds ?? 0);
  }

  for (const a of activity ?? []) {
    const email = (a.email as string | null)?.toLowerCase();
    if (!email) continue;
    // Match the original-cased email from the team_members table when
    // available so the row keys stay consistent with msgs / calls.
    const m = memberByEmail.get(email);
    const key = m ? (m as { id: string }).id : email;
    void key;
    const row = ensure(email);
    row.login_hours += Number(a.window_seconds ?? 0) / 3600;
    row.idle_hours +=
      Math.max(0, Number(a.window_seconds ?? 0) - Number(a.active_seconds ?? 0)) /
      3600;
  }

  // Compute averages + add zero-row entries for team members who haven't
  // acted in this period (so the operator sees the full team list).
  for (const m of (members ?? []) as Array<{ email: string }>) {
    if (!m.email) continue;
    if (!byEmail.has(m.email)) {
      ensure(m.email);
    }
  }
  for (const row of byEmail.values()) {
    row.avg_call_seconds = row.calls_handled
      ? Math.round(row.talk_time_seconds / row.calls_handled)
      : 0;
    row.login_hours = Number(row.login_hours.toFixed(2));
    row.idle_hours = Number(row.idle_hours.toFixed(2));

    // Score uses the resolved per-agent targets. Range == days span,
    // so we divide targets by N days for the multi-day window.
    const m = memberByEmail.get(row.email.toLowerCase());
    const fallbackRole = (row.role ?? "teammate") as Role;
    const baseRoleTargets =
      roleTargets.get(fallbackRole) ?? ROLE_TARGETS_FALLBACK[fallbackRole];
    const override = m ? memberTargets.get(m.id) ?? null : null;
    const resolved = resolveTargets(baseRoleTargets, override);

    // Span = days covered by the query (defaults to 30, or whatever the
    // explicit from→to says). Used to scale daily targets to the
    // selected window.
    let daysSpan = 1;
    if (fromParam && toParam) {
      daysSpan = Math.max(
        1,
        Math.round(
          (Date.parse(`${toParam}T00:00:00Z`) -
            Date.parse(`${fromParam}T00:00:00Z`)) /
            86_400_000,
        ) + 1,
      );
    } else if (range === "30d") daysSpan = 30;
    else if (range === "7d") daysSpan = 7;
    else if (range === "all") daysSpan = 30; // fudge: score against 30d worth

    const scaled = {
      ...resolved,
      magic_messages_per_day: resolved.magic_messages_per_day * daysSpan,
      calls_per_day: resolved.calls_per_day * daysSpan,
      text_replies_per_day: resolved.text_replies_per_day * daysSpan,
      template_sends_per_day: resolved.template_sends_per_day * daysSpan,
      min_login_hours_per_day: resolved.min_login_hours_per_day * daysSpan,
      max_idle_hours_per_day: resolved.max_idle_hours_per_day * daysSpan,
    };
    const breakdown = computeScore(scaled, {
      magic_messages: row.magic_messages,
      calls: row.calls_handled,
      text_replies: row.text_replies,
      template_sends: row.template_sends,
      login_hours: row.login_hours,
      idle_hours: row.idle_hours,
    });
    row.score = breakdown.score;
    row.tier = breakdown.tier;
  }

  // Optional name/email search.
  let agents = Array.from(byEmail.values());
  // Team Lead: hard-scope the output to their own team's members (totals
  // below are derived from this filtered list, so they stay team-only too).
  if (teamEmails) {
    agents = agents.filter((a) => teamEmails.has(a.email.toLowerCase()));
  }
  if (qParam) {
    agents = agents.filter(
      (a) =>
        a.email.toLowerCase().includes(qParam) ||
        (a.full_name ?? "").toLowerCase().includes(qParam),
    );
  }
  // Sort: most active first, by combined send + call count.
  agents.sort((a, b) => {
    const av = a.text_replies + a.template_sends + a.calls_handled;
    const bv = b.text_replies + b.template_sends + b.calls_handled;
    return bv - av;
  });

  // Workspace-wide totals — handy for the hero KPIs on the Reports page.
  const totals = agents.reduce(
    (acc, r) => ({
      text_replies: acc.text_replies + r.text_replies,
      template_sends: acc.template_sends + r.template_sends,
      magic_messages: acc.magic_messages + r.magic_messages,
      calls_handled: acc.calls_handled + r.calls_handled,
      talk_time_seconds: acc.talk_time_seconds + r.talk_time_seconds,
      login_hours: acc.login_hours + r.login_hours,
    }),
    {
      text_replies: 0,
      template_sends: 0,
      magic_messages: 0,
      calls_handled: 0,
      talk_time_seconds: 0,
      login_hours: 0,
    },
  );

  // Per-day breakdown + inbound totals come pre-grouped from the RPC.
  const daily = dailyAgg.map((d) => ({
    day: d.day,
    patient_messages: Number(d.patient_messages ?? 0),
    outbound: Number(d.outbound ?? 0),
    unique_patients: Number(d.unique_patients ?? 0),
  }));

  const inboundTotals = {
    patient_messages: Number(inboundTot.patient_messages ?? 0),
    unique_patients: Number(inboundTot.unique_patients ?? 0),
  };

  return NextResponse.json({
    agents,
    totals: { ...totals, ...inboundTotals },
    daily,
    range,
    since: sinceIso,
    until: untilIso,
  });
}

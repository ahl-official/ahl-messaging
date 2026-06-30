// GET /api/tasks/stats
//   Powers the TopBar Tasks chip (pending count for the current user)
//   and the Tasks → Reports tab (per-agent + workspace breakdown for
//   admin+). Cheap aggregate queries, no LLM, no external calls.

import { NextResponse } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const nowIso = new Date().toISOString();

  // Per-user pending count — the chip number in the TopBar. Counts
  // open / in_progress / blocked assigned to this member. Excludes
  // done / cancelled because those don't need action.
  const { count: mineOpen } = await admin
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("assigned_to", member.id)
    .in("status", ["open", "in_progress", "blocked"]);

  const { count: mineOverdue } = await admin
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("assigned_to", member.id)
    .in("status", ["open", "in_progress", "blocked"])
    .lt("due_at", nowIso);

  // Workspace-wide breakdown is admin+ only. Teammates only see their
  // own numbers (above).
  let workspace: {
    total: number;
    open: number;
    in_progress: number;
    blocked: number;
    done: number;
    cancelled: number;
    overdue: number;
    per_agent: Array<{
      member_id: string;
      full_name: string | null;
      email: string;
      open: number;
      done: number;
      overdue: number;
    }>;
  } | null = null;

  if (isAtLeast(member.role, "admin")) {
    const { data: all } = await admin
      .from("tasks")
      .select("id, status, assigned_to, due_at, completed_at");
    const rows = (all ?? []) as Array<{
      id: string;
      status: string;
      assigned_to: string | null;
      due_at: string | null;
      completed_at: string | null;
    }>;

    const agg = {
      total: rows.length,
      open: 0,
      in_progress: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
      overdue: 0,
    };
    const perAgent = new Map<
      string,
      { open: number; done: number; overdue: number }
    >();
    const now = Date.now();
    for (const r of rows) {
      if (r.status === "open") agg.open++;
      else if (r.status === "in_progress") agg.in_progress++;
      else if (r.status === "blocked") agg.blocked++;
      else if (r.status === "done") agg.done++;
      else if (r.status === "cancelled") agg.cancelled++;

      const isActive =
        r.status === "open" || r.status === "in_progress" || r.status === "blocked";
      const isOverdue =
        isActive && r.due_at && Date.parse(r.due_at) < now;
      if (isOverdue) agg.overdue++;

      if (r.assigned_to) {
        const cur =
          perAgent.get(r.assigned_to) ?? { open: 0, done: 0, overdue: 0 };
        if (isActive) cur.open++;
        if (r.status === "done") cur.done++;
        if (isOverdue) cur.overdue++;
        perAgent.set(r.assigned_to, cur);
      }
    }

    const ids = Array.from(perAgent.keys());
    const memberMap = new Map<
      string,
      { full_name: string | null; email: string }
    >();
    if (ids.length > 0) {
      const { data: mems } = await admin
        .from("team_members")
        .select("id, full_name, email")
        .in("id", ids);
      for (const m of mems ?? []) {
        memberMap.set(m.id as string, {
          full_name: (m.full_name as string | null) ?? null,
          email: m.email as string,
        });
      }
    }

    workspace = {
      ...agg,
      per_agent: ids
        .map((mid) => ({
          member_id: mid,
          full_name: memberMap.get(mid)?.full_name ?? null,
          email: memberMap.get(mid)?.email ?? "",
          ...perAgent.get(mid)!,
        }))
        .sort((a, b) => b.open - a.open),
    };
  }

  return NextResponse.json({
    mine: {
      open: mineOpen ?? 0,
      overdue: mineOverdue ?? 0,
    },
    workspace,
  });
}
